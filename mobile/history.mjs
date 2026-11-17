// Reads existing Codex metadata and visible messages; never writes its databases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TodayImagesReader, shanghaiDate } from './today-images.mjs';
import { itemVisibleText, itemImageSource, itemHasImages, nativeImageContent } from './media.mjs';

export const validThreadId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value);
const stamp = value => typeof value === 'number' ? value : Date.parse(value ?? '') || 0;
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);

export function visibleItem(item, {media, threadId} = {}) {
  if (!item) return null;
  if (['mcpToolCall','imageView'].includes(item.type)) {
    if (item.phase === 'analysis' || item.channel === 'analysis' || item.delivery === 'async') return null;
    if (item.type === 'mcpToolCall') {
      if (item.status !== 'completed' || item.error != null || item.result?.isError === true || !Array.isArray(item.result?.content)) return null;
      // The native desktop displays typed MCP ImageContent directly. Project
      // just those exact blocks: tool text, arguments, metadata and arbitrary
      // nested data never become phone messages or image authorization.
      const content = item.result.content.filter(nativeImageContent).map(value=>({type:'image',data:value.data,mimeType:value.mimeType}));
      if (!content.length) return null;
      item = {type:'agentMessage',id:item.id,content};
    } else {
      if (!Number.isFinite(item.completedAtMs) || item.completedAtMs <= 0 || typeof item.path !== 'string') return null;
      item = {type:'agentMessage',id:item.id,content:[{type:'localImage',path:item.path}]};
    }
  }
  if (!['userMessage', 'steeringUserMessage', 'agentMessage', 'imageGeneration'].includes(item.type)) return null;
  if (item.type === 'steeringUserMessage' && item.status !== 'accepted') return null;
  if ((item.type === 'agentMessage' || item.type === 'imageGeneration') && (item.delivery === 'async' || item.phase === 'analysis' || item.channel === 'analysis')) return null;
  const role = ['agentMessage', 'imageGeneration'].includes(item.type) ? 'assistant' : 'user';
  const original = itemVisibleText(item), hasImages = itemHasImages(item);
  const display = media ? media.decorateItem(threadId,item) : {text:original,images:[]};
  const text = display.text, images = display.images ?? [];
  if (!text.trim() && !hasImages && !images.length) return null;
  // Media is registered on the target computer before projection. Neither
  // local paths nor inline image bytes become part of a phone snapshot.
  return { id: item.id ?? digest(role + original + (hasImages ? JSON.stringify(item.content ?? item.input ?? [item.savedPath ?? item.result]) : '')),
    role, text, phase: item.phase ?? null, ...(hasImages || images.length ? {images} : {}),
    ...(hasImages && !images.length ? {imageUnavailable:true} : {}) };
}

export function visibleTurns(state, limit = 100, options = {}) {
  const history = state?.turnHistory?.history;
  const turns = history?.entitiesByKey ? Object.values(history.entitiesByKey) : state?.turns ?? [];
  const items = turns.filter(Boolean).sort((a, b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0))
    .flatMap(turn => turn.items ?? []);
  return latestVisibleItems(items,limit,options);
}
function latestVisibleItems(items, limit, options) {
  const requested = Math.trunc(Number(limit)), maximum = requested > 0 ? requested : Infinity;
  const rows = [];
  // Project backwards until the visible page is full. This preserves filtering
  // and slice semantics without hashing/statting images outside the phone page.
  for (let index = items.length - 1; index >= 0 && rows.length < maximum; index--) {
    const row = visibleItem(items[index],options); if (row) rows.push(row);
  }
  return rows.reverse().slice(-limit);
}

function historyContent(content = []) {
  return (Array.isArray(content) ? content : []).flatMap(value => {
    if (['text','inputText','input_text','output_text'].includes(value?.type)) return [{type:'text',text:value.text ?? ''}];
    const source = itemImageSource(value);
    if (!source) return [];
    return source.startsWith('data:') || /^https?:/i.test(source) ? [{type:'image',url:source}] : [{type:'localImage',path:source}];
  });
}
function eventImages(payload) {
  return [...(Array.isArray(payload.images) ? payload.images : []), ...(Array.isArray(payload.local_images) ? payload.local_images : [])]
    .flatMap(value => typeof value === 'string' ? [{type:value.startsWith('data:') || /^https?:/i.test(value) ? 'image' : 'localImage',
      ...(value.startsWith('data:') || /^https?:/i.test(value) ? {url:value} : {path:value})}] : historyContent([value]));
}
export function parseVisibleHistory(text, limit = 80, options = {}) {
  return parseVisibleHistoryRecords(text.split('\n').map(line=>({line})),limit,options);
}
export function parseVisibleHistoryRecords(records, limit = 80, options = {}) {
  const events = [], fallback = [], toolImages = new Map();
  const addToolImages = (callId, content, order) => {
    if (typeof callId !== 'string' || !callId || callId.length > 512) return;
    for (const value of content) {
      const source = itemImageSource(value);
      if (!source?.startsWith('data:image/')) continue;
      if (!toolImages.has(callId)) toolImages.set(callId,{order,item:{type:'agentMessage',id:callId,content:[]},sources:new Set()});
      const row = toolImages.get(callId);
      // A completed MCP event and its response output record can contain the
      // same native image. Deduplicate within that exact call only; separate
      // calls or messages retain their own visible image occurrences.
      const sourceId = digest(source); if (row.sources.has(sourceId)) continue;
      row.sources.add(sourceId); row.item.content.push({type:'image',url:source});
    }
  };
  let order = 0;
  for (const record of records) {
    order++;
    let row, lineId;
    try { row = record.row ?? JSON.parse(record.line); lineId = record.lineId ?? digest(record.line ?? JSON.stringify(row)); } catch { continue; }
    const p = row.payload;
    if (p?.phase === 'analysis' || p?.channel === 'analysis') continue;
    if (row.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'McpToolCall') {
      const item = p.item;
      if (item.status === 'completed' && item.error == null && item.phase !== 'analysis' && item.channel !== 'analysis' &&
          item.result?.isError !== true && Array.isArray(item.result?.content))
        addToolImages(item.id,item.result.content.filter(nativeImageContent),order);
    } else if (row.type === 'response_item' && ['function_call_output','custom_tool_call_output'].includes(p?.type)) {
      if (Array.isArray(p.output)) addToolImages(p.call_id,p.output.filter(value=>value?.type === 'input_image' && typeof value.image_url === 'string'),order);
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(p?.type)) {
      if (p.phase === 'analysis' || p.channel === 'analysis' || typeof p.message !== 'string') continue;
      const item = {type:p.type === 'user_message' ? 'userMessage' : 'agentMessage',id:lineId,
        text:p.message,phase:p.phase,content:[{type:'text',text:p.message},...eventImages(p)]};
      events.push({order,item});
    } else if (row.type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      if (p.role === 'assistant' && !['final', 'commentary', 'final_answer'].includes(p.channel ?? p.phase)) continue;
      const content = historyContent(p.content ?? []);
      const item = {type:p.role === 'user' ? 'userMessage' : 'agentMessage',id:p.id ?? lineId,content,phase:p.phase};
      if (itemVisibleText(item) || itemHasImages(item)) fallback.push({order,item});
    }
  }
  // Event rows remain authoritative for displayed text. Their response row
  // can contain the only copy of an image, so pair by role, exact text and
  // chronological occurrence order rather than dropping all response media.
  const used = new Set(), paired = new Map();
  const signature = item => JSON.stringify([item.type,itemVisibleText(item)]);
  const groups = new Map();
  for (const [kind,rows] of [['events',events],['responses',fallback]]) for (const row of rows) {
    const key = signature(row.item);
    if (!groups.has(key)) groups.set(key,{events:[],responses:[]});
    groups.get(key)[kind].push(row);
  }
  const signatures = new Set();
  for (const [key,group] of groups) {
    if (group.events.length) signatures.add(key);
    // Repeated identical prompts must pair in chronological order. A nearest
    // match can steal the next message's photo across intervening tool rows.
    // Unequal counts are ambiguous: preserve orphan media separately below.
    if (group.events.length !== group.responses.length) continue;
    group.events.forEach((event,index)=>paired.set(event,group.responses[index]));
  }
  const rows = events.length ? events.map(event => {
    const match = paired.get(event);
    if (!match) return event;
    used.add(match);
    const sources = new Map();
    for (const value of [...(event.item.content ?? []),...(match.item.content ?? [])]) {
      const source = itemImageSource(value); if (source) sources.set(source,value);
    }
    return sources.size ? {...event,item:{...event.item,content:[{type:'text',text:itemVisibleText(event.item)},...sources.values()]}} : event;
  }) : fallback;
  if (events.length) for (const row of fallback) if (!used.has(row) && itemHasImages(row.item)) {
    // Keep the original response media when legacy event rows are incomplete,
    // without printing its body twice beside an identical event message.
    const item = signatures.has(signature(row.item)) ? {...row.item,text:'',content:(row.item.content ?? []).filter(value=>!!itemImageSource(value))} : row.item;
    rows.push({...row,item});
  }
  rows.push(...toolImages.values());
  return latestVisibleItems(rows.sort((a,b)=>a.order-b.order).map(row=>row.item),limit,options);
}

const DAY = 86400000;
const PROJECTLESS = '__projectless__', UNASSIGNED = '__unassigned__';
const regularSources = new Set(['cli', 'vscode', 'exec']);
const string = (value, max = 4096) => typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value) ? value : '';
const label = (value, max = 10000) => typeof value === 'string' && !value.includes('\0') ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const projectId = value => string(value, 512);
function timestamp(value, milliseconds = false) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
  if (number != null) return Number.isFinite(number) && number > 0 ? Math.trunc(milliseconds || number >= 1e11 ? number : number * 1000) : 0;
  const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0;
}
export function canonicalDirectory(value) {
  let directory = string(value);
  if (!directory) return '';
  directory = directory.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:)/i, '');
  const windows = /^[a-z]:[\\/]/i.test(directory) || /^\\\\/.test(directory);
  directory = (windows ? path.win32 : path.posix).normalize(directory).replace(/[\\/]+$/, '');
  if (!directory) return windows ? '' : '/';
  return windows ? directory.replace(/\\/g, '/').toLowerCase() : directory;
}
const basename = value => /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) ? path.win32.basename(value) : path.posix.basename(value);
const under = (directory, root) => directory === root || directory.startsWith(root === '/' ? root : root + '/');
const searchText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const compareRows = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

async function metadataJson(file, max = 8 * 1024 * 1024) {
  const st = await fs.stat(file); if (st.size > max) throw Error('目录元数据超过读取上限');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function projectMetadata(state) {
  const projects = new Map(), roots = [], aliases = new Map();
  const local = state?.['local-projects'];
  const rows = Array.isArray(local) ? local.map(value => [value?.id, value]) : local && typeof local === 'object' ? Object.entries(local) : [];
  for (const [key, value] of rows) {
    const id = projectId(value?.id) || projectId(key);
    if (!id || !value || typeof value !== 'object') continue;
    const paths = (Array.isArray(value.rootPaths) ? value.rootPaths : []).map(p => string(p)).filter(Boolean);
    const name = string(value.name, 2000) || basename(paths[0] ?? '') || '未命名项目';
    const entry = { id, name, path: paths[0] ?? null, rootPaths: paths, source: 'official-project' };
    projects.set(id, entry);
    for (const root of paths) { const canonical = canonicalDirectory(root); if (canonical) roots.push({ canonical, project: entry }); }
  }
  // New desktop versions store app-server IDs alongside legacy sidebar IDs.
  // Only aliases for a known saved project may merge those identities.
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    for (const [legacy, native] of Object.entries(value)) {
      if (projects.has(legacy) && projectId(native)) aliases.set(native, legacy);
      else if (native && typeof native === 'object') visit(native, depth + 1);
    }
  };
  visit(state?.['app-server-project-id-by-legacy-project-id-by-host']);
  roots.sort((a, b) => b.canonical.length - a.canonical.length);
  return { projects, roots, aliases };
}

export class ThreadCatalog {
  constructor(home, { now = () => Date.now(), todayImages = {} } = {}) {
    this.home = home; this.now = now; this.paths = new Map(); this.pathsAt = 0;
    this.todayImages = new TodayImagesReader({project:parseVisibleHistoryRecords,...todayImages});
  }
  async snapshot() {
    let state = {}, stateAvailable = false, indexAvailable = false;
    try { const value = await metadataJson(path.join(this.home, '.codex-global-state.json')); if (value && typeof value === 'object' && !Array.isArray(value)) { state = value; stateAvailable = true; } } catch {}
    const index = new Map();
    try {
      const raw = await fs.readFile(path.join(this.home, 'session_index.jsonl'), 'utf8'); indexAvailable = true;
      for (const line of raw.split('\n')) { try {
        const value = JSON.parse(line); if (!validThreadId(value.id)) continue;
        index.set(value.id, { id: value.id, title: label(value.thread_name) || label(value.title),
          cwd: string(value.cwd), updatedAt: timestamp(value.updated_at), archived: value.archived === true || value.archived === 1 });
      } catch {} }
    } catch {}
    let rows, databaseAvailable = false, truncated = false;
    try {
      const file = path.join(this.home, 'state_5.sqlite');
      await fs.access(file);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 500; BEGIN');
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
        if (!['id', 'cwd', 'updated_at', 'source', 'archived'].every(name => columns.has(name))) throw Error('官方目录格式不受支持');
        const wanted = ['id', 'name', 'title', 'preview', 'cwd', 'updated_at', 'updated_at_ms', 'source', 'archived', 'project_id', 'hidden', 'deleted'];
        const select = wanted.filter(name => columns.has(name)).join(', ');
        // Exclude internal subagent and archived rows before the safety bound;
        // their volume must not hide older ordinary project chats.
        const visible = ["source IN ('cli', 'vscode', 'exec')", 'COALESCE(archived, 0) = 0',
          ...['hidden', 'deleted'].filter(name => columns.has(name)).map(name => 'COALESCE(' + name + ', 0) = 0')].join(' AND ');
        rows = db.prepare('SELECT ' + select + ' FROM threads WHERE ' + visible + ' ORDER BY updated_at DESC LIMIT 100001').all();
        truncated = rows.length > 100000; if (truncated) rows.length = 100000;
        databaseAvailable = true;
      } finally { db.close(); }
    } catch { rows = [...index.values()]; }
    const { projects, roots, aliases } = projectMetadata(state);
    const assignments = state['thread-project-assignments'] && typeof state['thread-project-assignments'] === 'object' ? state['thread-project-assignments'] : {};
    const projectless = new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'].filter(validThreadId) : []);
    const threads = [];
    for (const row of rows ?? []) {
      if (!validThreadId(row.id) || row.archived === true || row.archived === 1 || row.hidden === 1 || row.deleted === 1) continue;
      if (databaseAvailable && !regularSources.has(row.source)) continue;
      const indexed = index.get(row.id);
      const cwd = string(row.cwd) || indexed?.cwd || '';
      let group, assigned = assignments[row.id], explicitId = assigned?.projectKind === 'local' ? projectId(assigned.projectId) : '';
      // Explicit projectless membership is an official choice, even when cwd
      // happens to be inside a saved project. Never replace it with a path guess.
      if (projectless.has(row.id)) group = { id: PROJECTLESS, name: '独立聊天', path: null, rootPaths: [], source: 'official-projectless' };
      else {
        if (!explicitId) explicitId = aliases.get(projectId(row.project_id)) || projectId(row.project_id);
        if (explicitId) group = projects.get(explicitId) || { id: explicitId, name: '未命名项目', path: null, rootPaths: [], source: 'official-assignment' };
        else {
          const canonical = canonicalDirectory(cwd), matched = canonical && roots.find(root => under(canonical, root.canonical));
          group = matched?.project;
          if (!group && canonical) group = { id: 'cwd-' + digest(canonical), name: basename(cwd) || cwd, path: cwd, rootPaths: [cwd], source: 'cwd-fallback' };
          if (!group) group = { id: UNASSIGNED, name: '未分组', path: null, rootPaths: [], source: 'unassigned' };
        }
      }
      if (!projects.has(group.id)) projects.set(group.id, group);
      const updatedAt = databaseAvailable ? timestamp(row.updated_at_ms, true) || timestamp(row.updated_at) : row.updatedAt;
      const title = label(row.name) || indexed?.title || label(row.preview) || label(row.title) || '未命名聊天';
      threads.push({ id: row.id, title, updatedAt, cwd, projectId: group.id, projectName: group.name,
        status: 'unknown', source: databaseAvailable ? 'official-local-index' : 'local-index' });
    }
    // An available official database owns archival/deletion visibility. Do not
    // resurrect index-only rows from its stale session_index file.
    threads.sort(compareRows);
    const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
    const ordered = [...projects.values()].sort((a, b) => {
      const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.name.localeCompare(b.name);
    });
    return { threads, projects: ordered, source: databaseAvailable ? 'official-sqlite+sidebar' : indexAvailable ? 'session-index' : 'unavailable',
      partial: !databaseAvailable || !stateAvailable || truncated };
  }
  async list(limit = 200) { const data = await this.snapshot(); return data.threads.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined); }
  async get(id) {
    if (!validThreadId(id)) throw Error('无效聊天标识');
    return (await this.snapshot()).threads.find(thread => thread.id === id) ?? null;
  }
  async query({ projectId: selected = '', q = '', cursor = null, limit = 50, range = 'week' } = {}) {
    if (!['week', 'all'].includes(range)) throw Error('无效时间范围');
    if (typeof q !== 'string' || q.length > 1000 || typeof selected !== 'string' || selected.length > 512) throw Error('无效目录筛选');
    const query = searchText(q), count = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    let after;
    if (cursor != null && cursor !== '') {
      try {
        if (typeof cursor !== 'string' || cursor.length > 4096) throw Error();
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.v !== 1 || value.range !== range || value.projectId !== selected || value.q !== query || !validThreadId(value.id) || !Number.isFinite(value.updatedAt)) throw Error();
        after = { id: value.id, updatedAt: value.updatedAt };
      } catch { throw Error('分页条件已变化，请重新读取目录'); }
    }
    const data = await this.snapshot(), cutoff = this.now() - 7 * DAY;
    const inRange = thread => range === 'all' || thread.updatedAt >= cutoff;
    const projects = data.projects.map(project => ({ ...project,
      count: data.threads.filter(thread => thread.projectId === project.id && inRange(thread)).length,
      totalCount: data.threads.filter(thread => thread.projectId === project.id).length }));
    const terms = query.split(' ').filter(Boolean);
    const filtered = data.threads.filter(thread => inRange(thread) && (!selected || thread.projectId === selected) && (!terms.length || (() => {
      const haystack = searchText([thread.title, thread.cwd, thread.projectName].join(' ')), compact = haystack.replace(/\s+/g, '');
      return terms.every(term => haystack.includes(term) || compact.includes(term.replace(/\s+/g, '')));
    })()));
    const remaining = after ? filtered.filter(thread => compareRows(thread, after) > 0) : filtered;
    const threads = remaining.slice(0, count), last = threads.at(-1);
    const nextCursor = remaining.length > threads.length && last ? Buffer.from(JSON.stringify({ v: 1, range, projectId: selected, q: query, id: last.id, updatedAt: last.updatedAt })).toString('base64url') : null;
    return { threads, projects, total: filtered.length, nextCursor, complete: !data.partial,
      catalog: { source: data.source, partial: data.partial } };
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
  async readTodayImages(id, {media, date = shanghaiDate(this.now()), signal} = {}) {
    if (!validThreadId(id)) throw Error('无效聊天标识');
    if (signal?.aborted) throw signal.reason ?? Error('读取已取消');
    await this.refreshPaths();
    return this.todayImages.read(this.paths.get(id),id,{media,date,signal});
  }
  async read(id, limit = 80, {media} = {}) {
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
      return { messages: parseVisibleHistory(count < size ? text.slice(text.indexOf('\n') + 1) : text, limit, {media,threadId:id}),
        source: 'local-history', limited: count < size };
    } finally { await fd.close(); }
  }
}
