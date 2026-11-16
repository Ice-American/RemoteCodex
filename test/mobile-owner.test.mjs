import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerClient } from '../mobile/owner.mjs';
import { OWNER_METHODS, OWNER_SUPPORTED_VERSIONS, readOwnerProtocols } from '../mobile/protocols.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const versions = Object.fromEntries(Object.entries(OWNER_METHODS).map(([key, method]) => [method, OWNER_SUPPORTED_VERSIONS[key].at(-1)]));
const idle = () => ({ id: threadId, cwd: '/test/workspace', resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' }, turns: [], requests: [] });
const running = (turnId = 'turn-1') => ({ ...idle(), threadRuntimeStatus: { type: 'active', activeFlags: [] },
  turns: [{ turnId, status: 'inProgress', items: [] }] });

class FakePipe extends EventEmitter {
  constructor() {
    super();
    this.socket = { destroyed: false };
    this.writes = [];
    this.following = [];
    this.owner = 'owner-1';
    this.acceptsInput = true;
    this.state = idle();
    this.revision = 1;
  }
  async connect() {}
  close() { this.socket.destroyed = true; this.emit('disconnected'); }
  async request(method, params, options) {
    if (method === OWNER_METHODS.owner) return { handledByClientId: this.owner, result: { supportsUntrustedAppInput: this.acceptsInput } };
    this.writes.push({ method, params, options });
    if (this.mutate) return this.mutate(method, params, options);
    return { type: 'response', resultType: 'success', method, handledByClientId: this.owner, result: { method, result: {
      ...(method === OWNER_METHODS.start ? { turn: { id: 'new-turn', threadId } } : { turnId: 'turn-1' }), ok: true,
    } } };
  }
  broadcast(method, params, version, targets) {
    this.following.push({ method, params, version, targets });
    if (params.following && !this.silent) this.snapshot();
  }
  snapshot(overrides = {}) {
    this.emit('frame', { type: 'broadcast', method: OWNER_METHODS.stream, version: 11,
      sourceClientId: this.owner, params: { conversationId: threadId, hostId: 'local',
        change: { type: 'snapshot', revision: this.revision, conversationState: this.state } }, ...overrides });
  }
  patch(baseRevision, revision, patches) {
    this.emit('frame', { type: 'broadcast', method: OWNER_METHODS.stream, version: 11,
      sourceClientId: this.owner, params: { conversationId: threadId, hostId: 'local',
        change: { type: 'patches', baseRevision, revision, patches } } });
  }
}
async function fixture(t, options = {}) {
  const pipes = [];
  const client = new OwnerClient({ socketPath: '/synthetic/owner.sock',
    verifyEndpoint: async () => ({ verified: true, pid: 42, inode: 123 }),
    pipeFactory: () => { const pipe = new FakePipe(); pipes.push(pipe); return pipe; },
    protocolVersions: versions, timeoutMs: 100, ...options });
  t.after(() => client.close());
  await client.connect();
  return { client, pipes, pipe: pipes[0], options: { operationId: 'operation-0001', expectedOwner: 'owner-1', expectedTurnId: null } };
}

test('fresh owner snapshots and patches are isolated from callers and foreign sources', async t => {
  const { client, pipe } = await fixture(t);
  const seen = []; const unsubscribe = client.subscribe(event => seen.push(event.type));
  const snapshot = await client.freshSnapshot(threadId);
  assert.equal(snapshot.status.type, 'idle');
  snapshot.state.cwd = '/tampered';
  assert.equal(client.snapshot(threadId).state.cwd, '/test/workspace');
  pipe.state = { ...idle(), cwd: '/foreign' };
  pipe.snapshot({ sourceClientId: 'another-owner' });
  assert.equal(client.snapshot(threadId).state.cwd, '/test/workspace');
  pipe.patch(1, 2, [{ op: 'replace', path: ['cwd'], value: '/fresh' }]);
  assert.equal(client.snapshot(threadId).state.cwd, '/fresh');
  pipe.patch(1, 3, [{ op: 'replace', path: ['cwd'], value: '/stale' }]);
  assert.equal(client.snapshot(threadId), null);
  assert.ok(seen.includes('unknown'));
  unsubscribe();
});

test('overlapping fresh reads share one owner lookup without cancelling each other or sharing mutable results', async t => {
  const { client, pipe } = await fixture(t);
  let release, lookups = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const request = pipe.request.bind(pipe);
  pipe.request = async (...args) => { lookups++; await gate; return request(...args); };
  const results = Promise.allSettled([client.freshSnapshot(threadId), client.freshSnapshot(threadId)]);
  await new Promise(resolve => setImmediate(resolve)); release();
  const values = await results;
  assert.equal(lookups, 1);
  assert.deepEqual(values.map(value => value.status), ['fulfilled', 'fulfilled']);
  values[0].value.state.cwd = '/caller-only';
  assert.equal(values[1].value.state.cwd, '/test/workspace');
  assert.equal(pipe.following.filter(value => value.params.following).length, 1);
  assert.equal(pipe.writes.length, 0);
});

test('an unfollow retires a shared refresh before a later refresh can establish a new subscription', async t => {
  const { client, pipe } = await fixture(t);
  pipe.silent = true;
  const previous = Promise.allSettled([client.freshSnapshot(threadId), client.freshSnapshot(threadId)]);
  await new Promise(resolve => setImmediate(resolve)); client.unfollow(threadId);
  pipe.silent = false;
  const current = client.freshSnapshot(threadId);
  assert.deepEqual((await previous).map(value => value.reason?.code), ['SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_CANCELLED']);
  assert.equal((await current).status.type, 'idle');
  assert.equal(client.snapshot(threadId).status.type, 'idle');
});

test('initialize is a live transport handshake even when absent from the ASAR table', async t => {
  const observed = { ...versions }; delete observed[OWNER_METHODS.initialize];
  const { client } = await fixture(t, { protocolVersions: observed });
  assert.deepEqual(client.handshake, { version: 1, source: 'live-owner-initialize' });
  assert.equal(client.protocolVersions[OWNER_METHODS.initialize], undefined);
  assert.equal((await client.freshSnapshot(threadId)).status.type, 'idle');
});

test('unfollow releases only this client subscription and refuses late frames or stale writes', async t => {
  const { client, pipe, options } = await fixture(t);
  await client.freshSnapshot(threadId);
  const result = client.unfollow(threadId);
  assert.deepEqual(result, { threadId, subscribed: false, notificationSent: true, confirmed: false });
  assert.deepEqual(pipe.following.at(-1), { method: OWNER_METHODS.following,
    params: { hostId: 'local', conversationId: threadId, following: false }, version: 1, targets: [pipe.owner] });
  assert.equal(client.snapshot(threadId), null);
  pipe.snapshot();
  assert.equal(client.snapshot(threadId), null);
  assert.equal(client.connected, true);
  await assert.rejects(client.sendText(threadId, 'Continue', options), /fresh live owner snapshot/);
  assert.equal(pipe.writes.length, 0);
  assert.equal(client.unfollow(threadId).notificationSent, false);
  assert.equal(pipe.following.filter(value => !value.params.following).length, 1);
  await client.freshSnapshot(threadId);
  assert.equal(client.snapshot(threadId).status.type, 'idle');
});

test('unfollow cancels snapshot waits and an in-flight owner lookup cannot resubscribe later', async t => {
  const f = await fixture(t);
  f.pipe.silent = true;
  const snapshotWait = f.client.freshSnapshot(threadId, { timeoutMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  f.client.unfollow(threadId);
  await assert.rejects(snapshotWait, /subscription cancelled/);
  let reply;
  f.pipe.request = () => new Promise(resolve => { reply = resolve; });
  const followWait = f.client.follow(threadId);
  const rejected = assert.rejects(followWait, /interrupted|cancelled/);
  f.client.unfollow(threadId);
  await rejected;
  const broadcasts = f.pipe.following.length;
  reply({ handledByClientId: f.pipe.owner, result: { supportsUntrustedAppInput: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pipe.following.length, broadcasts);
  assert.equal(f.client.owners.has(threadId), false);
});

test('unfollow leaves a dispatched action pending, preserving its acknowledgement and unknown fence', async t => {
  const f = await fixture(t);
  await f.client.freshSnapshot(threadId);
  let reply;
  f.pipe.mutate = () => new Promise(resolve => { reply = resolve; });
  const action = f.client.sendText(threadId, 'Continue', f.options);
  f.client.unfollow(threadId);
  reply({ type: 'response', resultType: 'success', method: OWNER_METHODS.start, handledByClientId: f.pipe.owner,
    result: { method: OWNER_METHODS.start, result: { turn: { id: 'new-turn', threadId } } } });
  assert.equal((await action).status, 'submitted');
  assert.equal((await f.client.sendText(threadId, 'Continue', f.options)).deduplicated, true);
  await f.client.freshSnapshot(threadId);
  const uncertain = f.client.sendText(threadId, 'Next action', { ...f.options, operationId: 'unknown-unfollow' });
  f.client.unfollow(threadId);
  f.pipe.emit('disconnected');
  assert.equal((await uncertain).status, 'unknown');
});

test('unfollow isolates threads, retires old owners and does not replay an uncertain cancel broadcast', async t => {
  const f = await fixture(t);
  await f.client.freshSnapshot(threadId);
  f.client.owners.set(otherId, { owner: 'other-owner', generation: f.client.generation });
  f.client.nativeSubscriptions.set(otherId, { owner: 'other-owner', generation: f.client.generation });
  f.pipe.owner = 'new-owner';
  await f.client.follow(threadId);
  assert.equal(f.pipe.following.at(-2).params.following, false);
  assert.deepEqual(f.pipe.following.at(-2).targets, ['owner-1']);
  f.client.unfollow(threadId);
  assert.equal(f.client.owners.has(otherId), true);
  const original = f.pipe.broadcast.bind(f.pipe);
  f.pipe.broadcast = (...args) => { original(...args); throw Error('write result unknown'); };
  assert.equal(f.client.unfollow(otherId).notificationSent, null);
  const broadcasts = f.pipe.following.length;
  assert.equal(f.client.unfollow(otherId).notificationSent, false);
  assert.equal(f.pipe.following.length, broadcasts);
  assert.throws(() => f.client.unfollow('bad-id'), /Invalid thread/);
});

test('supports is read-only and follows protocol, input capability and runtime availability', async t => {
  const f = await fixture(t);
  const count = f.pipe.following.length;
  assert.equal(f.client.supports(threadId, 'start'), false);
  assert.equal(f.client.supports(threadId, 'stream'), true);
  assert.equal(f.client.supports(threadId, 'arbitrary-rpc'), false);
  assert.equal(f.pipe.following.length, count);
  await f.client.freshSnapshot(threadId);
  assert.equal(f.client.supports(threadId, 'start'), true);
  assert.equal(f.client.supports(threadId, 'steer'), false);
  assert.equal(f.client.supports(threadId, 'fileApproval'), true);
  f.pipe.state = running(); f.pipe.snapshot();
  assert.equal(f.client.supports(threadId, 'start'), false);
  assert.equal(f.client.supports(threadId, 'steer'), true);
  assert.equal(f.client.supports(threadId, 'interrupt'), true);
  f.pipe.acceptsInput = false; await f.client.freshSnapshot(threadId);
  assert.equal(f.client.supports(threadId, 'userInput'), false);
  f.client.unfollow(threadId);
  assert.equal(f.client.supports(threadId, 'fileApproval'), false);
  f.client.close();
  assert.equal(f.client.supports(threadId, 'stream'), false);
});

test('visible history and an idle runtime cannot authorize a turn before the desktop has resumed the thread', async t => {
  const { client, pipe, options } = await fixture(t);
  for (const resumeState of ['needs_resume', 'resuming', undefined]) {
    pipe.state = { ...idle(), resumeState, turns: [{ turnId: 'historical-turn', status: 'completed', items: [
      { type: 'agentMessage', id: 'historical-answer', text: 'Existing visible answer' },
    ] }] };
    const snapshot = await client.freshSnapshot(threadId);
    assert.equal(snapshot.state.turns[0].items[0].text, 'Existing visible answer');
    assert.equal(client.supports(threadId, 'start'), false, String(resumeState));
    assert.equal(client.supports(threadId, 'userInput'), false, String(resumeState));
    await assert.rejects(client.sendText(threadId, 'Must not dispatch', options), /not resumed|runtime state/);
  }
  assert.equal(pipe.writes.length, 0);
});

test('invalid thread, unsafe patches and a new stream version never become current facts', async t => {
  const { client, pipe } = await fixture(t);
  await client.freshSnapshot(threadId);
  pipe.state = { ...idle(), id: otherId }; pipe.snapshot();
  assert.equal(client.snapshot(threadId), null);
  pipe.state = idle(); await client.freshSnapshot(threadId);
  pipe.patch(1, 2, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]);
  assert.equal(client.snapshot(threadId), null);
  assert.equal({}.polluted, undefined);
  await client.freshSnapshot(threadId); pipe.snapshot({ version: 12 });
  assert.equal(client.snapshot(threadId), null);
});

test('idle text is sent once to the same native owner without any queue call', async t => {
  const { client, pipe, options } = await fixture(t);
  await client.freshSnapshot(threadId);
  const result = await client.sendText(threadId, 'Continue this task', options);
  assert.equal(result.status, 'submitted');
  assert.equal(result.turnId, 'new-turn');
  assert.equal(pipe.writes[0].method, OWNER_METHODS.start);
  assert.equal(pipe.writes[0].params.turnStart.request.threadId, threadId);
  client.close();
  assert.equal((await client.sendText(threadId, 'Continue this task', options)).deduplicated, true);
  assert.equal(pipe.writes.length, 1);
  await assert.rejects(client.sendText(threadId, 'Different task', options), /another message/);
});

test('running text requires an explicit steer and binds the acknowledged turn', async t => {
  const { client, pipe } = await fixture(t);
  pipe.state = running(); await client.freshSnapshot(threadId);
  const options = { operationId: 'operation-steer', expectedOwner: pipe.owner, expectedTurnId: 'turn-1' };
  await assert.rejects(client.sendText(threadId, 'Adjust', options), /steer explicitly/);
  assert.equal(pipe.writes.length, 0);
  const result = await client.sendText(threadId, 'Adjust', { ...options, mode: 'steer' });
  assert.equal(result.status, 'submitted');
  assert.equal(pipe.writes[0].params.restoreMessage.cwd, '/test/workspace');
  assert.equal(pipe.writes[0].options.targetClientId, pipe.owner);
  pipe.mutate = async method => ({ type: 'response', resultType: 'success', method, handledByClientId: pipe.owner, result: { method, result: { turnId: 'newer-turn' } } });
  const wrong = await client.sendText(threadId, 'Adjust again', { ...options, operationId: 'operation-wrong', mode: 'steer' });
  assert.equal(wrong.status, 'unknown');
});

test('the native input capability and current owner/turn gate every mutation', async t => {
  const { client, pipe, options } = await fixture(t);
  pipe.acceptsInput = false; await client.freshSnapshot(threadId);
  await assert.rejects(client.sendText(threadId, 'Continue', options), /does not accept input/);
  pipe.acceptsInput = true; await client.freshSnapshot(threadId);
  await assert.rejects(client.sendText(threadId, 'Continue', { ...options, expectedOwner: 'old-owner' }), /changed/);
  await assert.rejects(client.sendText(threadId, 'Continue', { ...options, expectedTurnId: 'old-turn' }), /changed/);
  pipe.owner = 'owner-2'; await client.follow(threadId);
  await assert.rejects(client.sendText(threadId, 'Continue', options), /changed/);
  assert.equal(pipe.writes.length, 0);
});

test('a disconnected in-flight write immediately becomes unknown and survives reconnect without replay', async t => {
  const { client, pipe, pipes, options } = await fixture(t);
  await client.freshSnapshot(threadId);
  pipe.mutate = () => new Promise(() => {});
  const pending = client.sendText(threadId, 'Continue', options);
  pipe.emit('disconnected');
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.equal(client.snapshot(threadId), null);
  await client.connect();
  pipe.state = { ...idle(), cwd: '/old-socket' }; pipe.snapshot();
  assert.equal(client.snapshot(threadId), null);
  await client.freshSnapshot(threadId);
  assert.equal((await client.sendText(threadId, 'Continue', options)).status, 'unknown');
  assert.equal(pipes[1].writes.length, 0);
  assert.equal(pipe.writes.length, 1);
});

test('concurrent duplicate operation IDs produce only one IPC write', async t => {
  const { client, pipe, options } = await fixture(t);
  await client.freshSnapshot(threadId);
  let resolve;
  pipe.mutate = () => new Promise(r => { resolve = r; });
  const first = client.sendText(threadId, 'Continue', options);
  const second = await client.sendText(threadId, 'Continue', options);
  assert.equal(second.deduplicated, true);
  assert.equal(pipe.writes.length, 1);
  resolve({ type: 'response', resultType: 'success', method: OWNER_METHODS.start, handledByClientId: pipe.owner,
    result: { method: OWNER_METHODS.start, result: { turn: { id: 'new-turn', threadId } } } });
  assert.equal((await first).status, 'submitted');
});

test('unknown methods, unseen versions and cross-thread payloads cannot be sent', async t => {
  const { client, pipe, options } = await fixture(t);
  await client.freshSnapshot(threadId);
  await assert.rejects(client.requestToOwner(threadId, 'thread/delete', {}, options), /not writable/);
  await assert.rejects(client.requestToOwner(threadId, 'userInput', { conversationId: otherId }, options), /thread mismatch/);
  client.protocolVersions = { ...versions, [OWNER_METHODS.userInput]: 2 };
  await assert.rejects(client.requestToOwner(threadId, 'userInput', {}, options), /not been observed/);
  assert.equal(pipe.writes.length, 0);
});

test('a failing observer cannot break the dispatch fence, but a failed persistence hook prevents sending', async t => {
  const f = await fixture(t);
  await f.client.freshSnapshot(threadId);
  f.client.subscribe(() => { throw Error('SSE client disconnected'); });
  assert.equal((await f.client.sendText(threadId, 'Continue', f.options)).status, 'submitted');
  const g = await fixture(t, { onOperation: () => { throw Error('Receipt storage unavailable'); } });
  await g.client.freshSnapshot(threadId);
  await assert.rejects(g.client.sendText(threadId, 'Continue', g.options), /storage unavailable/);
  assert.equal(g.pipe.writes.length, 0);
});

test('every approval/question method requires the exact positive native acknowledgement', async t => {
  const keys = ['userInput', 'commandApproval', 'fileApproval', 'permissions', 'mcpElicitation', 'queue'];
  for (const methodKey of keys) {
    const f = await fixture(t);
    await f.client.freshSnapshot(threadId);
    const ack = () => ({ type: 'response', resultType: 'success', method: OWNER_METHODS[methodKey], handledByClientId: f.pipe.owner,
      result: { method: OWNER_METHODS[methodKey], result: { ok: true } } });
    const malformed = [
      value => { delete value.method; },
      value => { value.method = OWNER_METHODS.start; },
      value => { value.handledByClientId = 'other-owner'; },
      value => { value.type = undefined; },
      value => { value.resultType = 'error'; },
      value => { value.resultType = undefined; },
      value => { value.result.method = OWNER_METHODS.start; },
      value => { delete value.result.result.ok; },
      value => { value.result.result.ok = false; },
      value => { value.result.result.ok = 'true'; },
    ];
    for (const [index, damage] of malformed.entries()) {
      f.pipe.mutate = async () => { const value = ack(); damage(value); return value; };
      const result = await f.client.requestToOwner(threadId, methodKey, { requestId: 'native-request' },
        { ...f.options, operationId: `malformed-${methodKey}-${index}`, validateResponse: () => true });
      assert.equal(result.status, 'unknown', methodKey + ' malformed ACK ' + index);
    }
    f.pipe.mutate = async () => ack();
    assert.equal((await f.client.requestToOwner(threadId, methodKey, { requestId: 'native-request' },
      { ...f.options, operationId: `confirmed-${methodKey}` })).status, 'submitted');
    assert.equal((await f.client.requestToOwner(threadId, methodKey, { requestId: 'native-request' },
      { ...f.options, operationId: `stricter-${methodKey}`, validateResponse: () => false })).status, 'unknown');
  }
});

test('interrupt and settings have method-specific positive confirmation requirements', async t => {
  const f = await fixture(t);
  f.pipe.state = running(); await f.client.freshSnapshot(threadId);
  const options = { ...f.options, expectedTurnId: 'turn-1' };
  for (const [index, interruptedTurnId] of [undefined, 'wrong-turn', 'turn-1'].entries()) {
    f.pipe.mutate = async method => ({ type: 'response', resultType: 'success', method, handledByClientId: f.pipe.owner,
      result: { method, result: { ok: true, interruptedTurnId } } });
    const result = await f.client.requestToOwner(threadId, 'interrupt', { expectedTurnId: 'turn-1', mode: 'user-stop' },
      { ...options, operationId: `interrupt-${index}` });
    assert.equal(result.status, interruptedTurnId === 'turn-1' ? 'submitted' : 'unknown');
  }
  for (const [index, applied] of [undefined, false, true].entries()) {
    f.pipe.mutate = async method => ({ type: 'response', resultType: 'success', method, handledByClientId: f.pipe.owner,
      result: { method, result: { ok: true, applied } } });
    const result = await f.client.requestToOwner(threadId, 'settings', {},
      { ...options, operationId: `settings-${index}` });
    assert.equal(result.status, applied === true ? 'submitted' : 'unknown');
  }
});

test('persisted dispatched operations become unknown before any reconnect or write', async t => {
  const operation = { operationId: 'old-operation', status: 'dispatched', fingerprint: 'old-hash' };
  const operations = new Map([[operation.operationId, operation]]), persisted = [];
  const f = await fixture(t, { operations, onOperation: record => persisted.push(record) });
  assert.equal(operations.get(operation.operationId).status, 'unknown');
  assert.equal(persisted[0].status, 'unknown');
  assert.equal(f.pipe.writes.length, 0);
});

test('endpoint identity is reverified after connect and snapshot waiters fail on disconnect', async t => {
  let checks = 0;
  const client = new OwnerClient({ socketPath: '/fake.sock', protocolVersions: versions,
    verifyEndpoint: async () => ({ pid: ++checks }), pipeFactory: () => new FakePipe() });
  t.after(() => client.close());
  await assert.rejects(client.connect(), /identity changed/);
  const f = await fixture(t);
  f.pipe.silent = true;
  const waiting = f.client.freshSnapshot(threadId, { timeoutMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  f.pipe.emit('disconnected');
  await assert.rejects(waiting, /interrupted/);
});

function asar(codes) {
  let offset = 0;
  const files = {};
  const chunks = [];
  for (const [name, text] of Object.entries(codes)) {
    const bytes = Buffer.from(text);
    files[name] = { size: bytes.length, offset: String(offset) };
    chunks.push(bytes); offset += bytes.length;
  }
  const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files } } } } }));
  const padded = Math.ceil((header.length + 8) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(padded, 4);
  prefix.writeUInt32LE(padded - 4, 8); prefix.writeUInt32LE(header.length, 12);
  return Buffer.concat([prefix, header, Buffer.alloc(8 + padded - 16 - header.length), ...chunks]);
}
test('protocol scan reads early-bootstrap and hashes code without inventing conflicting versions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-owner-protocol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.asar');
  fs.writeFileSync(file, asar({ 'early-bootstrap.js': '{"thread-stream-state-changed":11,"thread-follower-start-turn":2}',
    'another.js': '{"thread-follower-start-turn":3,"thread-follower-file-approval-decision":1}' }));
  const report = readOwnerProtocols(file);
  assert.equal(report.versions[OWNER_METHODS.stream], 11);
  assert.equal(report.versions[OWNER_METHODS.start], undefined);
  assert.deepEqual(report.conflicts[OWNER_METHODS.start], [2, 3]);
  assert.equal(report.versions[OWNER_METHODS.fileApproval], 1);
  assert.equal(report.records[0].sha256.length, 64);
  assert.equal(report.sha256.length, 64);
  const malformed = asar({ 'early-bootstrap.js': 'ok' }); malformed.writeUInt32LE(0xffffffff, 12);
  fs.writeFileSync(file, malformed);
  assert.throws(() => readOwnerProtocols(file), /header bounds/);
});

// Captured current Desktop wire shape: outer method and owner, no redundant
// result.method, and a turn-specific result nested under result.result.
test('current Desktop acknowledgement without redundant nested method confirms only the matching turn', async t => {
  const f = await fixture(t); f.pipe.state = running(); await f.client.freshSnapshot(threadId);
  f.pipe.mutate = async method => ({ type: 'response', resultType: 'success', method,
    handledByClientId: f.pipe.owner, result: { result: { turnId: 'turn-1' } } });
  assert.equal((await f.client.sendText(threadId, 'Current wire probe', { ...f.options, expectedTurnId: 'turn-1', mode: 'steer' })).status, 'submitted');
  f.pipe.mutate = async method => ({ type: 'response', resultType: 'success', method,
    handledByClientId: f.pipe.owner, result: { result: { ok: true } } });
  assert.equal((await f.client.requestToOwner(threadId, 'userInput', { requestId: 'native-question' },
    { ...f.options, operationId: 'current-question-ack', expectedTurnId: 'turn-1' })).status, 'submitted');
});
