// Reads existing Codex metadata and visible messages; never writes its databases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const validThreadId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value);
const stamp = value => typeof value === 'number' ? value : Date.parse(value ?? '') || 0;
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);

export function visibleItem(item) {
  if (!item || !['userMessage', 'steeringUserMessage', 'agentMessage'].includes(item.type)) return null;
  if (item.type === 'steeringUserMessage' && item.status !== 'accepted') return null;
  if (item.type === 'agentMessage' && (item.delivery === 'async' || item.phase === 'analysis' || item.channel === 'analysis')) return null;
  const role = item.type === 'agentMessage' ? 'assistant' : 'user';
  const text = typeof item.text === 'string' ? item.text : (item.content ?? item.input ?? [])
    .filter(v => ['text', 'inputText', 'input_text', 'output_text'].includes(v.type)).map(v => v.text ?? '').join('\n');
  if (!text.trim()) return null;
  // Only the public user/assistant projection crosses to the phone. Reasoning,
  // developer messages and raw tool payloads stay in the official application.
  return { id: item.id ?? digest(role + text), role, text, phase: item.phase ?? null };
}

export function visibleTurns(state, limit = 100) {
  const history = state?.turnHistory?.history;
  const turns = history?.entitiesByKey ? Object.values(history.entitiesByKey) : state?.turns ?? [];
  return turns.filter(Boolean).sort((a, b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0))
    .flatMap(turn => (turn.items ?? []).map(visibleItem).filter(Boolean)).slice(-limit);
}

export function parseVisibleHistory(text, limit = 80) {
  const events = [], fallback = [];
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload;
    if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(p?.type)) {
      if (p.phase === 'analysis' || p.channel === 'analysis' || typeof p.message !== 'string') continue;
      events.push({ id: digest(line), role: p.type === 'user_message' ? 'user' : 'assistant', text: p.message });
    } else if (row.type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      if (p.role === 'assistant' && !['final', 'commentary', 'final_answer'].includes(p.channel ?? p.phase)) continue;
      const content = (p.content ?? []).filter(c => ['input_text', 'output_text', 'text'].includes(c.type)).map(c => c.text ?? '').join('\n');
      if (content) fallback.push({ id: p.id ?? digest(line), role: p.role, text: content });
    }
  }
  // Native event messages and response items can describe the same message.
  // Pick one representation instead of doubling conversation text on the phone.
  return (events.length ? events : fallback).slice(-limit);
}

export class ThreadCatalog {
  constructor(home) { this.home = home; this.paths = new Map(); this.pathsAt = 0; }
  async list(limit = 200) {
    let raw;
    try { raw = await fs.readFile(path.join(this.home, 'session_index.jsonl'), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const byId = new Map();
    for (const line of raw.split('\n')) {
      try {
        const r = JSON.parse(line);
        if (!validThreadId(r.id)) continue;
        byId.set(r.id, { id: r.id, title: r.thread_name ?? r.title ?? '未命名聊天', updatedAt: stamp(r.updated_at),
          status: 'unknown', source: 'local-index' });
      } catch {}
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }
  async refreshPaths() {
    if (Date.now() - this.pathsAt < 30000) return;
    const found = new Map();
    const walk = async (dir, depth = 0) => {
      if (depth > 6) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const m = /([a-f0-9]{8}-[a-f0-9-]{27})\.jsonl$/i.exec(entry.name);
          if (m && !found.has(m[1])) found.set(m[1], file);
        }
      }
    };
    await walk(path.join(this.home, 'sessions'));
    this.paths = found; this.pathsAt = Date.now();
  }
  async read(id, limit = 80) {
    if (!validThreadId(id)) throw Error('无效聊天标识');
    await this.refreshPaths();
    const file = this.paths.get(id);
    if (!file) return { messages: [], source: 'local-history', limited: true };
    const fd = await fs.open(file, 'r');
    try {
      const { size } = await fd.stat();
      // Load the latest bounded slice first. Long histories must not delay the
      // input box or transfer megabytes of tool output to a small phone screen.
      const count = Math.min(size, 2 * 1024 * 1024), b = Buffer.alloc(count);
      await fd.read(b, 0, count, size - count);
      const text = b.toString('utf8');
      return { messages: parseVisibleHistory(count < size ? text.slice(text.indexOf('\n') + 1) : text, limit),
        source: 'local-history', limited: count < size };
    } finally { await fd.close(); }
  }
}
