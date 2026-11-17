import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ThreadCatalog, canonicalDirectory, parseVisibleHistory, visibleItem, visibleTurns, validThreadId } from '../mobile/history.mjs';

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

test('image-only public items survive projection and use opaque media descriptors', () => {
  const media = { decorateItem: (_threadId, item) => ({text: '', images: [{id: 'opaque', contentKey: 'revision', name: '图片'}]}) };
  const message = visibleItem({type:'userMessage',id:'photo',content:[{type:'localImage',path:'/private/photo.png'}]}, {media,threadId:id(1)});
  assert.deepEqual(message?.images,[{id:'opaque',contentKey:'revision',name:'图片'}]);
  assert.equal(message.text,'');
  assert.equal(JSON.stringify(message).includes('/private'),false);
});
test('history event text is enriched by its response image instead of losing or duplicating the message', () => {
  const rows = [
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'看这张图'},{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}]}},
    {type:'event_msg',payload:{type:'user_message',message:'看这张图'}},
    {type:'event_msg',payload:{type:'agent_message',message:'收到'}},
  ];
  const media = {decorateItem: (_threadId,item) => ({text:item.text ?? (item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'),images:(item.content??[]).some(c=>c.type==='image')?[{id:'photo',contentKey:'revision',name:'图片'}]:[]})};
  const messages=parseVisibleHistory(rows.map(JSON.stringify).join('\n'),80,{media,threadId:id(1)});
  assert.deepEqual(messages.map(m=>m.text),['看这张图','收到']);
  assert.equal(messages[0].images?.length,1);
});
test('native image generation projects as assistant media while private channels remain hidden', () => {
  const media={decorateItem:()=>({text:'',images:[{id:'generated',contentKey:'revision',name:'生成图片'}]})};
  assert.equal(visibleItem({type:'imageGeneration',id:'gen',savedPath:'/tmp/generated.png'},{media,threadId:id(1)})?.role,'assistant');
  assert.equal(visibleItem({type:'agentMessage',phase:'analysis',text:'![private](/tmp/private.png)'},{media,threadId:id(1)}),null);
});

test('default projections retain an image-only row without leaking its private source', () => {
  const source='data:image/png;base64,cHJpdmF0ZQ==';
  const live=visibleItem({type:'userMessage',content:[{type:'image',url:source}]});
  assert.ok(live);assert.equal(live.text,'');assert.deepEqual(live.images,[]);assert.equal(JSON.stringify(live).includes(source),false);
  const history=parseVisibleHistory(JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:source}]}}));
  assert.equal(history.length,1);assert.equal(JSON.stringify(history).includes(source),false);
});

test('media outside the visible message limit is not registered or read for live and history views', async () => {
  const calls=[];const media={decorateItem:(_thread,item)=>{calls.push(item.id);return {text:item.text??item.content?.[0]?.text??'',images:[]};}};
  const state={turns:[{items:[{type:'agentMessage',id:'old',text:'old'},{type:'agentMessage',id:'new',text:'new'},{type:'agentMessage',phase:'analysis',id:'hidden',text:'hidden'}]}]};
  const {visibleTurns}=await import('../mobile/history.mjs');
  assert.deepEqual(visibleTurns(state,1,{media,threadId:id(1)}).map(m=>m.text),['new']);assert.deepEqual(calls,['new']);
  calls.length=0;
  const rows=[{type:'event_msg',payload:{type:'agent_message',message:'old'}},{type:'event_msg',payload:{type:'agent_message',message:'new'}}];
  assert.deepEqual(parseVisibleHistory(rows.map(JSON.stringify).join('\n'),1,{media,threadId:id(1)}).map(m=>m.text),['new']);assert.equal(calls.length,1);
});

test('running conversation projects only confirmed native tool images and excludes tool text and analysis', () => {
  const captured=[];const data='aW1hZ2U=';
  const media={decorateItem:(_thread,item)=>{captured.push(item);return {text:item.text??'',images:[{id:'opaque-image',contentKey:'opaque-key',name:'图片'}]};}};
  const state={threadRuntimeStatus:{type:'active'},turns:[{items:[
    {type:'mcpToolCall',id:'photo-tool',status:'completed',arguments:{private:'arguments'},result:{content:[{type:'text',text:'private tool output'},{type:'image',data,mimeType:'image/png',_meta:{private:'metadata'}}],structuredContent:{private:'structure'}}},
    {type:'mcpToolCall',id:'running-tool',status:'inProgress',result:{content:[{type:'image',data,mimeType:'image/png'}]}},
    {type:'mcpToolCall',id:'reasoning-tool',phase:'analysis',status:'completed',result:{content:[{type:'image',data,mimeType:'image/png'}]}},
  ]}]};
  const messages=visibleTurns(state,100,{media,threadId:id(1)});assert.equal(messages.length,1);assert.equal(messages[0].role,'assistant');assert.equal(messages[0].text,'');assert.equal(messages[0].images.length,1);
  assert.equal(captured.length,1);assert.deepEqual(Object.keys(captured[0]).sort(),['content','id','type']);assert.deepEqual(Object.keys(captured[0].content[0]).sort(),['data','mimeType','type']);
  for(const secret of ['arguments','private tool output','metadata','structure',data])assert.equal(JSON.stringify(messages).includes(secret),false);
});

test('mixed history retains response-only text before and after unrelated event rows', () => {
  const rows = [
    {type:'response_item',payload:{type:'message',role:'assistant',channel:'final',id:'response-a',content:[{type:'output_text',text:'response A'}]}},
    {type:'response_item',payload:{type:'message',role:'user',id:'response-b',content:[{type:'input_text',text:'response B'}]}},
    {type:'event_msg',payload:{type:'agent_message',message:'event C'}},
    {type:'response_item',payload:{type:'message',role:'assistant',channel:'commentary',id:'response-d',content:[{type:'output_text',text:'response D'}]}},
  ];
  assert.deepEqual(parseVisibleHistory(rows.map(JSON.stringify).join('\n')).map(row=>row.text),['response A','response B','event C','response D']);
});

test('strict chronological event-response pairs keep repeated prompt occurrences without duplicate bodies', () => {
  const event = message => ({type:'event_msg',payload:{type:'user_message',message}});
  const response = (id,text) => ({type:'response_item',payload:{type:'message',role:'user',id,content:[{type:'input_text',text}]}});
  const rows=[event('repeat'),response('first','repeat'),event('middle'),response('middle','middle'),event('repeat'),response('second','repeat')];
  assert.deepEqual(parseVisibleHistory(rows.map(JSON.stringify).join('\n')).map(row=>row.text),['repeat','middle','repeat']);
});

test('unequal repeated-text source groups keep unpaired records rather than guessing identity', () => {
  const rows=[
    {type:'response_item',payload:{type:'message',role:'user',id:'early',content:[{type:'input_text',text:'repeat'}]}},
    {type:'event_msg',payload:{type:'agent_message',message:'between'}},
    {type:'event_msg',payload:{type:'user_message',message:'repeat'}},
    {type:'response_item',payload:{type:'message',role:'user',id:'late',content:[{type:'input_text',text:'repeat'}]}},
  ];
  assert.deepEqual(parseVisibleHistory(rows.map(JSON.stringify).join('\n')).map(row=>row.text),['repeat','between','repeat','repeat']);
});

test('ambiguous repeated-text media stays attached to its original response occurrence', () => {
  const rows=[
    {type:'response_item',payload:{type:'message',role:'user',id:'early-photo',content:[{type:'input_text',text:'repeat'},{type:'input_image',image_url:'data:image/png;base64,Zmlyc3Q='}]}},
    {type:'event_msg',payload:{type:'user_message',message:'repeat'}},
    {type:'response_item',payload:{type:'message',role:'user',id:'late-photo',content:[{type:'input_text',text:'repeat'},{type:'input_image',image_url:'data:image/png;base64,c2Vjb25k'}]}},
  ];
  const media={decorateItem:(_thread,item)=>({text:item.text??item.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'',images:item.content?.some(c=>c.type==='image')?[{id:item.id,contentKey:'opaque',name:'picture'}]:[]})};
  const messages=parseVisibleHistory(rows.map(JSON.stringify).join('\n'),80,{threadId:id(1),media});
  assert.deepEqual(messages.map(m=>m.text),['repeat','repeat','repeat']);assert.deepEqual(messages.filter(m=>m.images?.length).map(m=>m.images[0].id),['early-photo','late-photo']);
});
