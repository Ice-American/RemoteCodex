import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTools } from '../mobile/native-tools.mjs';

const context = '11111111-1111-4111-8111-111111111111';
const created = '22222222-2222-4222-8222-222222222222';
const image = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const endpoint = { path: '\\\\.\\pipe\\codex-browser-use-native-test', pid: 123, image };
const owner = { platform: 'win32', pid: 123, image, fingerprint: 'native-test', home: '/synthetic' };
const catalog = ['create_thread', 'list_projects', 'list_threads', 'wait_threads'].map(name => ({ namespace: 'codex_app', name,
  inputSchema: { properties: name === 'create_thread' ? { target: {}, prompt: {} } : {} } }));
const success = value => ({ result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] } });
const local = { projectId: 'real-native-id', projectKind: 'local', hostId: 'local', label: 'red-app', path: 'D:\\Project\\red-app' };

function rig(options = {}) {
  const events = [], calls = [], pipes = [];
  let discoveries = 0, probes = 0, projects = [local];
  const native = new NativeTools({ platform: 'win32', home: '/synthetic',
    discover: async () => { events.push('identity'); return options.owner?.(++discoveries) ?? owner; },
    probe: async paths => { events.push('probe'); probes++; return { pipes: options.endpoints?.(paths, probes) ?? [endpoint] }; },
    contextResolver: async () => context,
    ownerStatusReader: async args => { events.push('owner-status'); return options.ownerStatusReader?.(args) ?? []; },
    pipeFactory: () => {
      const pipe = { socket: { destroyed: false }, connect: async () => { events.push('connect'); },
        close: () => { pipe.socket.destroyed = true; events.push('close'); },
        request: async (method, params) => {
          const name = method === 'tools/list' ? method : params.tool;
          events.push(name); calls.push({ method, params });
          if (options.request) { const result = await options.request(name, params, events); if (result !== undefined) return result; }
          if (method === 'tools/list') return { result: { tools: options.catalog ?? catalog } };
          if (name === 'list_projects') return success({ projects });
          if (name === 'create_thread') return success({ threadId: created });
          if (name === 'list_threads') return success({ threads: [], pinnedThreads: [] });
          if (name === 'wait_threads') return success({ polls: [] });
          throw Error('Unexpected synthetic method');
        } };
      pipes.push(pipe); return pipe;
    }, ...options.native });
  return { native, events, calls, pipes, projects: value => { projects = value; }, creations: () => calls.filter(call => call.params.tool === 'create_thread') };
}

test('Mac capability is explicit and never borrows a signed identity or connects', async () => {
  const f = rig({ native: { platform: 'darwin' } });
  const cap = await f.native.capability(); assert.equal(cap.supported, false); assert.match(cap.reason, /网页.*Mac/);
  await assert.rejects(f.native.create({ projectId: null, prompt: 'synthetic' }, { beforeDispatch() { assert.fail('must not dispatch'); } }), /网页.*Mac/);
  assert.deepEqual(await f.native.statuses([context]), [{ id: context, status: 'unknown', statusConfirmed: false, observedAt: null }]);
  assert.deepEqual(f.events, []);
});

test('capability exposes only unambiguous native local project IDs', async () => {
  const f = rig();
  f.projects([local, { ...local, projectId: 'remote', projectKind: 'remote', hostId: 'other' },
    { ...local, projectId: 'duplicate' }, { ...local, projectId: 'duplicate' }]);
  assert.deepEqual(await f.native.capability(), { supported: true, reason: null, projectless: true,
    projects: [{ projectId: local.projectId, name: local.label, path: local.path }] });
  assert.equal(f.creations().length, 0); assert.ok(f.pipes.every(pipe => pipe.socket.destroyed));
});

test('creation validates fresh projects and invokes its synchronous durable fence immediately before the only write', async () => {
  const f = rig();
  assert.deepEqual(await f.native.create({ projectId: local.projectId, prompt: 'synthetic', title: 'Synthetic test' },
    { beforeDispatch() { f.events.push('durable-fence'); } }), { threadId: created });
  const call = f.creations()[0];
  assert.deepEqual(call.params.arguments, { target: { type: 'project', projectId: local.projectId, environment: { type: 'local' } }, prompt: 'synthetic', title: 'Synthetic test' });
  assert.equal(call.params.threadId, context); assert.equal(call.params.callerSource, 'codex'); assert.ok(call.params.turnId);
  assert.deepEqual(f.events.slice(f.events.indexOf('durable-fence'), -1), ['durable-fence', 'create_thread']);
  assert.equal(f.calls.filter(call => call.params.tool === 'list_projects').length, 1); assert.equal(f.creations().length, 1);
});

test('projectless is explicit; arbitrary paths, models and stale or remote selections never fall back', async () => {
  for (const extra of [{ projectId: '' }, { cwd: '/untrusted' }, { model: 'invented' }, { environment: 'remote' }]) {
    const f = rig(); await assert.rejects(f.native.create({ projectId: null, prompt: 'synthetic', ...extra }, { beforeDispatch() { assert.fail(); } }));
    assert.equal(f.creations().length, 0);
  }
  for (const projects of [[], [{ ...local, projectKind: 'remote' }], [{ ...local, hostId: 'remote' }], [local, local]]) {
    const f = rig(); f.projects(projects);
    await assert.rejects(f.native.create({ projectId: local.projectId, prompt: 'synthetic' }, { beforeDispatch() { assert.fail(); } }), /项目/);
    assert.equal(f.creations().length, 0);
  }
  const f = rig(); await f.native.create({ projectId: null, prompt: 'synthetic' }, { beforeDispatch() {} });
  assert.deepEqual(f.creations()[0].params.arguments, { target: { type: 'projectless' }, prompt: 'synthetic' });
});

test('last-moment owner or endpoint replacement blocks dispatch before the durable fence', async () => {
  for (const mutation of [
    { owner: count => count < 3 ? owner : { ...owner, pid: 456 } },
    { endpoints: (_paths, count) => count < 3 ? [endpoint] : [{ ...endpoint, pid: 456 }] },
  ]) {
    const f = rig(mutation);
    await assert.rejects(f.native.create({ projectId: null, prompt: 'synthetic' }, { beforeDispatch() { assert.fail('must not dispatch'); } }), /身份/);
    assert.equal(f.creations().length, 0);
  }
});

test('untrusted or ambiguous app-tools pipes cannot establish a connection', async () => {
  for (const endpoints of [[{ ...endpoint, image: 'C:\\User\\ChatGPT.exe' }], [endpoint, { ...endpoint, pid: 456 }]]) {
    const f = rig({ endpoints: () => endpoints }); const cap = await f.native.capability();
    assert.equal(cap.supported, false); assert.equal(f.pipes.length, 0); assert.equal(f.creations().length, 0);
  }
});

test('fence failure and missing context prevent a native create without creating a hidden context', async () => {
  const f = rig();
  await assert.rejects(f.native.create({ projectId: null, prompt: 'synthetic' }, { beforeDispatch() { throw Error('journal fsync failed'); } }), /fsync/);
  assert.equal(f.creations().length, 0);
  const missing = rig({ native: { contextResolver: async () => null } });
  assert.equal((await missing.native.capability()).supported, false); assert.equal(missing.creations().length, 0);
});

test('lost ACK, rejected native result and malformed success are thrown once after the fence, never retried', async () => {
  for (const response of [Error('lost native ACK'), { result: { success: false } }, success({}), success({ threadId: 'not-real' })]) {
    const f = rig({ request: async name => { if (name === 'create_thread') { if (response instanceof Error) throw response; return response; } } });
    let fenced = false;
    await assert.rejects(f.native.create({ projectId: null, prompt: 'synthetic' }, { beforeDispatch() { fenced = true; } }));
    assert.equal(fenced, true); assert.equal(f.creations().length, 1);
  }
});

test('queued client IDs remain distinct from native thread IDs', async () => {
  const f = rig({ request: async name => name === 'create_thread' ? success({ clientThreadId: 'queued-native-id' }) : undefined });
  assert.deepEqual(await f.native.create({ projectId: null, prompt: 'synthetic' }, { beforeDispatch() {} }), { clientThreadId: 'queued-native-id' });
});

test('temporary owner reads cover at most eight requested active chats, exclude remote and ChatGPT, and send no action', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);
  let readIds, cleanups = 0;
  const f = rig({ request: async (name, params) => {
    if (name === 'list_threads') return success({ pinnedThreads: [], threads: [
      ...ids.map(id => ({ id, kind: 'codex', hostId: 'local', status: 'active' })),
      { id: context, kind: 'codex', hostId: 'remote', status: 'idle' }, { id: created, kind: 'chatgpt', hostId: 'local', status: 'idle' },
    ] });
  }, ownerStatusReader: async ({ ids, registerCleanup }) => {
    readIds = ids; registerCleanup(() => { cleanups++; });
    return ids.map((id, i) => ({ id, runtimeStatus: { type: 'active', activeFlags: i === 1 ? ['waitingOnUserInput'] : i === 2 ? ['waitingOnApproval'] : [] },
      confirmed: true, observedAt: Date.now() }));
  } });
  const requested = ids.slice(2), result = await f.native.statuses([...requested, context, created]);
  assert.deepEqual(readIds, requested.slice(0, 8)); assert.equal(cleanups, 1);
  assert.deepEqual(result.slice(0, 3).map(row => row.status), ['running', 'waitingForInput', 'waitingForApproval']);
  assert.equal(result[8].statusConfirmed, false); assert.equal(result.at(-1).statusConfirmed, false); assert.equal(result.at(-2).statusConfirmed, false);
  assert.equal(f.creations().length, 0); assert.equal(f.calls.filter(call => call.method !== 'tools/list').length, 1);
});

test('plain active, unknown flags, stale observations and missing snapshots never become spinners', async () => {
  const f = rig({ request: async name => {
    if (name === 'list_threads') return success({ pinnedThreads: [], threads: [{ id: context, kind: 'codex', hostId: 'local', status: 'active' }] });
  }, ownerStatusReader: async () => [{ id: context, runtimeStatus: { type: 'active', activeFlags: ['unknown-new-flag'] }, confirmed: true, observedAt: Date.now() }] });
  assert.equal((await f.native.statuses([context]))[0].statusConfirmed, false);
  const noPoll = rig({ catalog: catalog.filter(tool => tool.name !== 'wait_threads'), request: async name => name === 'list_threads' ?
    success({ pinnedThreads: [], threads: [{ id: context, kind: 'codex', hostId: 'local', status: 'active' }] }) : undefined });
  assert.equal((await noPoll.native.statuses([context]))[0].statusConfirmed, false);
  const stale = rig({ request: async name => name === 'list_threads' ? success({ pinnedThreads: [], threads: [{ id: context, kind: 'codex', hostId: 'local', status: 'active' }] }) : undefined,
    ownerStatusReader: async () => [{ id: context, runtimeStatus: { type: 'active', activeFlags: [] }, confirmed: true, observedAt: Date.now() - 15000 }] });
  assert.equal((await stale.native.statuses([context]))[0].statusConfirmed, false);
});

test('temporary owner failure preserves confirmed idle rows, leaves active unknown and does not cache the failure', async () => {
  let reads = 0, closed = 0;
  const f = rig({ request: async name => name === 'list_threads' ? success({ pinnedThreads: [], threads: [
    { id: context, kind: 'codex', hostId: 'local', status: 'active' }, { id: created, kind: 'codex', hostId: 'local', status: 'idle' },
  ] }) : undefined, ownerStatusReader: async ({ registerCleanup }) => {
    reads++; registerCleanup(() => { closed++; }); throw Error('synthetic owner read failed');
  } });
  for (let i = 0; i < 2; i++) {
    const rows = await f.native.statuses([context, created]); assert.equal(rows.partial, true);
    assert.equal(rows[0].statusConfirmed, false); assert.equal(rows[1].status, 'idle'); assert.equal(rows[1].statusConfirmed, true);
  }
  assert.equal(reads, 2); assert.equal(closed, 2);
});

test('total status deadline closes its isolated owner reader', async () => {
  let closed = 0;
  const f = rig({ native: { statusTimeoutMs: 20 }, request: async name => name === 'list_threads' ?
    success({ pinnedThreads: [], threads: [{ id: context, kind: 'codex', hostId: 'local', status: 'active' }] }) : undefined,
    ownerStatusReader: async ({ registerCleanup }) => { registerCleanup(() => { closed++; }); return new Promise(() => {}); } });
  await assert.rejects(f.native.statuses([context]), /超时/); assert.equal(closed, 1);
});

test('concurrent status reads coalesce, TTL expires, and failures do not extend cached observations', async () => {
  let time = 1000, reads = 0, fail = false;
  const f = rig({ native: { now: () => time }, request: async name => {
    if (name === 'list_threads') { reads++; if (fail) throw Error('synthetic read failed'); return success({ pinnedThreads: [], threads: [{ id: context, kind: 'codex', hostId: 'local', status: 'idle' }] }); }
  } });
  const results = await Promise.all([f.native.statuses([context]), f.native.statuses([context])]);
  assert.equal(reads, 1); assert.equal(results[0][0].status, 'idle');
  await f.native.statuses([context]); assert.equal(reads, 1);
  time += 10000; fail = true; await assert.rejects(f.native.statuses([context]));
  await assert.rejects(f.native.statuses([context])); assert.equal(reads, 3);
  fail = false; assert.equal((await f.native.statuses([context]))[0].observedAt, time); assert.equal(reads, 4);
});

test('status deadline ends a stalled identity read and stops late work before any connection', async () => {
  let release;
  const identity = new Promise(resolve => { release = resolve; });
  const f = rig({ native: { discover: () => identity, statusTimeoutMs: 20 } });
  await assert.rejects(f.native.statuses([context]), /超时/);
  release(owner); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.pipes.length, 0);
});
