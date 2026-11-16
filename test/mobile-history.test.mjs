import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ThreadCatalog, canonicalDirectory, parseVisibleHistory, visibleItem, validThreadId } from '../mobile/history.mjs';

const NOW = Date.parse('2026-11-16T10:00:00Z'), DAY = 86400000;
const id = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const project = (name, root) => ({ id: name, name, rootPaths: [root] });
const nativeRow = (n, values = {}) => ({ id: id(n), name: 'chat ' + n, cwd: 'D:\\Project\\other',
  updated_at: Math.floor(NOW / 1000), updated_at_ms: null, title: 'original prompt', preview: null,
  source: 'vscode', archived: 0, hidden: 0, deleted: 0, project_id: null, ...values });
async function fixture(t, { rows = [], state = {}, index = [], database = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-catalog-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, '.codex-global-state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(home, 'session_index.jsonl'), index.map(row => JSON.stringify(row)).join('\n'));
  if (database) {
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, preview TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, source TEXT, archived INTEGER, hidden INTEGER, deleted INTEGER, project_id TEXT)');
      const insert = db.prepare('INSERT INTO threads (id,name,title,preview,cwd,updated_at,updated_at_ms,source,archived,hidden,deleted,project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const row of rows) insert.run(row.id, row.name, row.title, row.preview, row.cwd, row.updated_at, row.updated_at_ms, row.source, row.archived, row.hidden, row.deleted, row.project_id);
    } finally { db.close(); }
  }
  return { home, catalog: new ThreadCatalog(home, { now: () => NOW }) };
}

test('phone history excludes reasoning, developer content and raw tool output', () => {
  const row = p => JSON.stringify(p);
  const text = [
    row({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private instructions' }] } }),
    row({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning' }] } }),
    row({ type: 'event_msg', payload: { type: 'agent_message', channel: 'analysis', message: 'private reasoning event' } }),
    row({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
    row({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
    row({ type: 'event_msg', payload: { type: 'agent_message', message: 'visible reply' } }),
  ].join('\n');
  assert.deepEqual(parseVisibleHistory(text).map(v => v.text), ['hello', 'visible reply']);
});
test('live projection does not turn async question cards or reasoning into chat text', () => {
  assert.equal(visibleItem({ type: 'agentMessage', phase: 'analysis', text: 'hidden' }), null);
  assert.equal(visibleItem({ type: 'agentMessage', channel: 'analysis', text: 'hidden' }), null);
  assert.equal(visibleItem({ type: 'agentMessage', delivery: 'async', questions: [] }), null);
  assert.equal(visibleItem({ type: 'mcpToolCall', result: 'tool body' }), null);
  assert.equal(visibleItem({ type: 'agentMessage', text: 'ok' }).text, 'ok');
  assert.equal(validThreadId('../auth.json'), false);
});

test('project queries find old red-app chats beyond the global latest 200', async t => {
  const rows = Array.from({ length: 205 }, (_, i) => nativeRow(i + 1, { updated_at: NOW / 1000 - i }));
  rows.push(nativeRow(501, { name: '新 UI 还原', cwd: '\\\\?\\D:\\Project\\red-app', updated_at: (NOW - 14 * DAY) / 1000 }));
  rows.push(nativeRow(502, { name: '检查边框四个角', cwd: 'd:/project/RED-app/h5', updated_at: (NOW - 4 * DAY) / 1000 }));
  const { catalog } = await fixture(t, { rows, state: { 'local-projects': {
    'red-app': project('red-app', 'D:\\Project\\red-app'), other: project('other', 'D:\\Project\\other'),
    empty: project('empty', 'D:\\Project\\empty') } } });
  assert.equal((await catalog.list()).length, 200);
  const week = await catalog.query({ projectId: 'red-app' });
  assert.deepEqual(week.threads.map(row => row.id), [id(502)]);
  assert.equal(week.total, 1);
  assert.equal(week.complete, true);
  assert.deepEqual(week.catalog, { source: 'official-sqlite+sidebar', partial: false });
  assert.equal(week.projects.find(row => row.id === 'red-app').totalCount, 2);
  assert.equal(week.projects.find(row => row.id === 'empty').count, 0);
  const all = await catalog.query({ range: 'all', projectId: 'red-app', q: '新 UI' });
  assert.deepEqual(all.threads.map(row => row.id), [id(501)]);
  assert.equal(all.total, 1);
  assert.equal((await catalog.get(id(501))).title, '新 UI 还原');
  assert.equal(all.threads[0].status, 'unknown');
});

test('Windows path matching handles extended prefixes, case and project boundaries on Mac', () => {
  assert.equal(canonicalDirectory('\\\\?\\D:\\Project\\RED-app\\'), 'd:/project/red-app');
  assert.equal(canonicalDirectory('D:/Project/red-app/../red-app/h5'), 'd:/project/red-app/h5');
  assert.equal(canonicalDirectory('\\\\?\\UNC\\SERVER\\Share\\Red-App\\'), '//server/share/red-app');
  assert.equal(canonicalDirectory('/Users/zhang/Projects/red-app/'), '/Users/zhang/Projects/red-app');
  assert.notEqual(canonicalDirectory('/Users/zhang/Projects/red-app'), canonicalDirectory('/users/zhang/Projects/red-app'));
});

test('native project and projectless assignments take priority over cwd inference', async t => {
  const rows = [
    nativeRow(1, { cwd: 'D:\\Project\\red-app\\h5' }),
    nativeRow(2, { cwd: 'D:\\Project\\red-app-private' }),
    nativeRow(3, { cwd: 'D:\\Project\\red-app' }),
    nativeRow(4, { cwd: 'D:\\Project\\red-app', project_id: 'server-private-id' }),
    nativeRow(5, { cwd: 'D:\\Project\\red-app-backup' }),
    nativeRow(6, { cwd: 'D:\\Project\\red-app', project_id: 'unknown-native-project' }),
  ];
  const { catalog } = await fixture(t, { rows, state: {
    'local-projects': { red: project('red', 'D:\\Project\\red-app'), private: project('private', 'D:\\Project\\red-app-private') },
    'thread-project-assignments': { [id(1)]: { projectKind: 'local', projectId: 'private' }, [id(3)]: { projectKind: 'local', projectId: 'red' } },
    'projectless-thread-ids': [id(3)],
    'app-server-project-id-by-legacy-project-id-by-host': { localhost: { private: 'server-private-id' } },
  } });
  const listed = await catalog.list(1000), groups = new Map(listed.map(row => [row.id, row.projectId]));
  assert.equal(groups.get(id(1)), 'private');
  assert.equal(groups.get(id(2)), 'private');
  assert.equal(groups.get(id(3)), '__projectless__');
  assert.equal(groups.get(id(4)), 'private');
  assert.match(groups.get(id(5)), /^cwd-/);
  assert.equal(groups.get(id(6)), 'unknown-native-project');
});

test('active directory does not resurrect archived, hidden, deleted or internal chats from JSONL', async t => {
  const rows = [nativeRow(1), nativeRow(2, { archived: 1 }), nativeRow(3, { hidden: 1 }), nativeRow(4, { deleted: 1 }),
    nativeRow(5, { source: '{"subagent":{"parent_thread_id":"private"}}' })];
  const { home, catalog } = await fixture(t, { rows, index: [...rows, nativeRow(6)].map(row => ({ id: row.id, thread_name: 'index title', updated_at: new Date(NOW).toISOString() })) });
  const beforeFiles = await fs.readdir(home), dbPath = path.join(home, 'state_5.sqlite');
  const hash = async () => createHash('sha256').update(await fs.readFile(dbPath)).digest('hex');
  const beforeHash = await hash();
  assert.deepEqual((await catalog.query({ range: 'all' })).threads.map(row => row.id), [id(1)]);
  assert.equal(await catalog.get(id(2)), null);
  assert.equal(await hash(), beforeHash);
  assert.deepEqual(await fs.readdir(home), beforeFiles);
});

test('week range uses native second or millisecond timestamps and never migrated file times', async t => {
  const old = NOW - 20 * DAY;
  const { home, catalog } = await fixture(t, { rows: [
    nativeRow(1, { updated_at: old / 1000, updated_at_ms: old }),
    nativeRow(2, { updated_at: (NOW - DAY) / 1000 }),
    nativeRow(3, { updated_at: old / 1000, updated_at_ms: NOW - 2 * DAY }),
    nativeRow(4, { updated_at: (NOW - 7 * DAY) / 1000 }),
    nativeRow(5, { updated_at: (NOW - 7 * DAY - 1000) / 1000 }),
  ], index: [{ id: id(1), thread_name: 'migrated old task', updated_at: new Date(NOW).toISOString() }] });
  await fs.utimes(path.join(home, 'state_5.sqlite'), NOW / 1000, NOW / 1000);
  const result = await catalog.query();
  assert.deepEqual(result.threads.map(row => row.id), [id(2), id(3), id(4)]);
  assert.equal((await catalog.get(id(1))).updatedAt, old);
  assert.equal((await catalog.query({ range: 'all' })).total, 5);
});

test('pagination is stable for equal native timestamps and rejects a changed filter cursor', async t => {
  const { catalog } = await fixture(t, { rows: Array.from({ length: 5 }, (_, i) => nativeRow(i + 1)) });
  const first = await catalog.query({ limit: 2 });
  const second = await catalog.query({ limit: 2, cursor: first.nextCursor });
  const third = await catalog.query({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual([...first.threads, ...second.threads, ...third.threads].map(row => row.id), [1, 2, 3, 4, 5].map(id));
  assert.equal(first.total, 5);
  assert.equal(third.nextCursor, null);
  await assert.rejects(catalog.query({ range: 'all', cursor: first.nextCursor }), /分页条件已变化/);
  await assert.rejects(catalog.query({ q: 'other', cursor: first.nextCursor }), /分页条件已变化/);
  await assert.rejects(catalog.query({ cursor: '../auth.json' }), /分页条件已变化/);
});

test('metadata fallback remains searchable, marks incompleteness and preserves native ISO dates', async t => {
  const old = NOW - 20 * DAY;
  const index = Array.from({ length: 205 }, (_, i) => ({ id: id(i + 1), thread_name: 'recent', updated_at: new Date(NOW - i * 1000).toISOString() }));
  index.push({ id: id(501), thread_name: '旧 UI\n还原', cwd: 'D:\\Project\\red-app', updated_at: new Date(old).toISOString() });
  const { catalog } = await fixture(t, { database: false, index, state: { 'local-projects': { red: project('red', 'D:\\Project\\red-app') } } });
  const result = await catalog.query({ range: 'all', projectId: 'red', q: '旧ui 还原' });
  assert.equal(result.complete, false);
  assert.deepEqual(result.catalog, { source: 'session-index', partial: true });
  assert.deepEqual(result.threads.map(row => row.id), [id(501)]);
  assert.equal(result.threads[0].updatedAt, old);
  assert.equal(result.threads[0].title, '旧 UI 还原');
  assert.equal((await catalog.query({ projectId: 'red' })).projects.find(row => row.id === 'red').count, 0);
});
