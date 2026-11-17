import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerClient, ownerSnapshotReady, ownerSnapshotRuntimeError, ownerSnapshotRetryable,
  retryableFailedTurnId } from '../mobile/owner.mjs';
import { OWNER_METHODS, OWNER_SUPPORTED_VERSIONS, readOwnerProtocols } from '../mobile/protocols.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const versions = Object.fromEntries(Object.entries(OWNER_METHODS).map(([key, method]) => [method, OWNER_SUPPORTED_VERSIONS[key].at(-1)]));
// Default fixtures model the installed Mac stream. Windows 13 is explicit below.
versions[OWNER_METHODS.stream] = 11;
const idle = () => ({ id: threadId, cwd: '/test/workspace', resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' }, turns: [], requests: [] });
const running = (turnId = 'turn-1') => ({ ...idle(), threadRuntimeStatus: { type: 'active', activeFlags: [] },
  turns: [{ turnId, status: 'inProgress', items: [] }] });
const failed = (turnId = 'failed-turn') => ({ ...idle(), threadRuntimeStatus: { type: 'systemError' },
  turns: [{ turnId, status: 'failed', items: [{ type: 'userMessage', text: 'Original user text must not be replayed' }] }],
  unconfirmedTurnSubmissions: [] });
const retryOptions = (client, options = {}) => ({ operationId: 'retry-operation', expectedOwner: 'owner-1',
  expectedGeneration: client.generation, expectedFailedTurnId: 'failed-turn', ...options });

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
    if (method === OWNER_METHODS.owner) return { type: 'response', resultType: 'success', method,
      handledByClientId: this.owner, result: { supportsUntrustedAppInput: this.acceptsInput } };
    this.writes.push({ method, params, options });
    if (this.mutate) return this.mutate(method, params, options);
    return { type: 'response', resultType: 'success', method, handledByClientId: this.owner, result: { method, result: {
      ...(method === OWNER_METHODS.start ? { turn: { id: 'new-turn', threadId } } : { turnId: 'turn-1' }), ok: true,
    } } };
  }
  broadcast(method, params, version, targets) {
    this.following.push({ method, params, version, targets });
    this.followers ??= new Set();
    const prior = this.followers.has(targets?.[0]);
    if (params.following) this.followers.add(targets?.[0]);
    else this.followers.delete(targets?.[0]);
    if (params.following && !this.silent && (this.repeatSnapshots !== false || !prior)) this.snapshot();
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

test('unverified stream versions fail before following a loaded owner', async t => {
  for (const version of [12, 14]) {
    const { client, pipe } = await fixture(t, { protocolVersions: { ...versions, [OWNER_METHODS.stream]: version } });
    await assert.rejects(client.freshSnapshot(threadId), { code: 'UNSUPPORTED_METHOD' });
    assert.equal(pipe.following.length, 0); assert.equal(client.supports(threadId, 'start'), false);
  }
});

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

test('readiness retains the first needs_resume snapshot until a delayed resumed patch confirms the runtime', async t => {
  const { client, pipe } = await fixture(t);
  // The stream permits incremental updates after the initial full snapshot.
  // A repeated follower notification need not be used to make this pass.
  pipe.repeatSnapshots = false;
  pipe.state = { ...idle(), resumeState: 'needs_resume' };
  let settled = false;
  const waiting = client.waitForReady(threadId, { timeoutMs: 1000 }).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.snapshot(threadId).revision, 1);
  assert.equal(settled, false);
  pipe.patch(1, 2, [{ op: 'replace', path: ['resumeState'], value: 'resuming' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  pipe.patch(2, 3, [{ op: 'replace', path: ['resumeState'], value: 'resumed' },
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'unknown' } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  pipe.patch(3, 4, [{ op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'active', activeFlags: [] } }]);
  const ready = await waiting;
  assert.equal(ready.state.resumeState, 'resumed');
  assert.equal(ready.state.threadRuntimeStatus.type, 'active');
  assert.equal(ready.status.confirmed, true);
  assert.equal(pipe.following.filter(value => value.params.following).length, 1);
  ready.state.cwd = '/caller-only';
  assert.equal(client.snapshot(threadId).state.cwd, '/test/workspace');
  assert.equal(pipe.writes.length, 0);
});

test('a resumed system error is a loaded owner failure and retains the live snapshot', async t => {
  const { client, pipe, options } = await fixture(t);
  pipe.state = { ...idle(), threadRuntimeStatus: { type: 'systemError' },
    turns: [{ turnId: 'failed-turn', status: 'failed', items: [] }] };
  await assert.rejects(client.waitForReady(threadId), error => {
    assert.equal(error.code, 'OWNER_RUNTIME_ERROR');
    assert.equal(error.snapshot.owner, pipe.owner);
    assert.equal(error.snapshot.state.resumeState, 'resumed');
    error.snapshot.state.cwd = '/caller-only';
    return true;
  });
  assert.equal(client.snapshot(threadId).state.cwd, '/test/workspace');
  assert.equal(client.supports(threadId, 'start'), false);
  assert.equal(client.supports(threadId, 'steer'), false);
  await assert.rejects(client.sendText(threadId, 'Must not dispatch', options), /not resumed|runtime state/);
  await assert.rejects(client.requestToOwner(threadId, 'start', { turnStart: { request: { threadId, input: [] } } }, options), /not resumed|runtime state/);
  assert.equal(pipe.writes.length, 0);
});

test('retry projection uses the current failed turn from native turn history without treating errors as ready', () => {
  const snapshot = { activeTurnId: null, status: { type: 'unknown', confirmed: false }, state: failed() };
  delete snapshot.state.turns;
  snapshot.state.turnHistory = { history: { entitiesByKey: {
    newest: { turnId: 'latest-failure', turnStartedAtMs: 200, status: 'failed' },
    oldest: { turnId: 'old-failure', turnStartedAtMs: 100, status: 'failed' },
  } } };
  assert.equal(ownerSnapshotReady(snapshot), false);
  assert.equal(ownerSnapshotRuntimeError(snapshot), true);
  assert.equal(ownerSnapshotRetryable(snapshot), true);
  assert.equal(retryableFailedTurnId(snapshot), 'latest-failure');
  delete snapshot.state.unconfirmedTurnSubmissions;
  assert.equal(retryableFailedTurnId(snapshot), 'latest-failure', 'Desktop deletes the empty submissions field');
  snapshot.state.turnHistory.history.entitiesByKey.newest.status = 'completed';
  assert.equal(retryableFailedTurnId(snapshot), null, 'an old failed turn must not become the current retry target');
});

test('a competing fresh read retains a readiness patch base and still requires a later stream observation', async t => {
  const { client, pipe } = await fixture(t);
  pipe.repeatSnapshots = false;
  pipe.state = { ...idle(), resumeState: 'needs_resume' };
  const ready = client.waitForReady(threadId, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  let freshSettled = false;
  const fresh = client.freshSnapshot(threadId, { timeoutMs: 500 }).then(value => { freshSettled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(freshSettled, false, 'the earlier full snapshot is not a fresh response');
  assert.equal(client.snapshot(threadId).revision, 1);
  assert.equal(pipe.following.filter(value => value.params.following).length, 1);
  pipe.patch(1, 2, [{ op: 'replace', path: ['resumeState'], value: 'resumed' }]);
  const [loaded, observed] = await Promise.all([ready, fresh]);
  assert.equal(loaded.revision, 2);
  assert.equal(observed.revision, 2);
  assert.equal(pipe.writes.length, 0);
});

test('concurrent readiness consumers share a follower and one cancellation does not cancel the other', async t => {
  const { client, pipe } = await fixture(t);
  pipe.repeatSnapshots = false;
  pipe.state = { ...idle(), resumeState: 'needs_resume' };
  const controller = new AbortController();
  const first = client.waitForReady(threadId, { signal: controller.signal, timeoutMs: 1000 });
  const rejected = assert.rejects(first, error => error.code === 'SUBSCRIPTION_CANCELLED');
  const second = client.waitForReady(threadId, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected;
  pipe.patch(1, 2, [{ op: 'replace', path: ['resumeState'], value: 'resumed' }]);
  assert.equal((await second).revision, 2);
  assert.equal(pipe.following.filter(value => value.params.following).length, 1);
  assert.equal(client.readinessWaits.size, 0);
});

test('a fresh read after readiness still clears the ready snapshot until a new observation arrives', async t => {
  const { client, pipe } = await fixture(t);
  await client.waitForReady(threadId);
  pipe.silent = true;
  const reading = client.freshSnapshot(threadId);
  assert.equal(client.snapshot(threadId), null);
  assert.equal(client.supports(threadId, 'start'), false);
  await new Promise(resolve => setImmediate(resolve));
  pipe.snapshot();
  assert.equal((await reading).status.type, 'idle');
  assert.equal(pipe.following.filter(value => value.params.following).length, 2);
});

test('a joined readiness consumer keeps its own shorter deadline', async t => {
  const { client, pipe } = await fixture(t);
  pipe.state = { ...idle(), resumeState: 'needs_resume' };
  const first = client.waitForReady(threadId, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.waitForReady(threadId, { timeoutMs: 10 }), error => error.code === 'OWNER_READY_TIMEOUT');
  pipe.patch(1, 2, [{ op: 'replace', path: ['resumeState'], value: 'resumed' }]);
  assert.equal((await first).revision, 2);
  assert.equal(pipe.following.filter(value => value.params.following).length, 1);
});

test('readiness retries an initial no-client-found only until owner discovery succeeds', async t => {
  const { client, pipe } = await fixture(t);
  const original = pipe.request.bind(pipe);
  let lookups = 0;
  pipe.request = async (...args) => {
    if (args[0] === OWNER_METHODS.owner && ++lookups === 1) throw Error('no-client-found');
    return original(...args);
  };
  const ready = await client.waitForReady(threadId, { timeoutMs: 1000 });
  assert.equal(ready.status.type, 'idle');
  assert.equal(lookups, 2);
  assert.equal(pipe.following.filter(value => value.params.following).length, 1);
});

test('readiness discovery has a total deadline and cancellation stops future retries', async t => {
  const { client, pipe } = await fixture(t);
  let lookups = 0;
  pipe.request = async () => { lookups++; throw Error('no-client-found'); };
  await assert.rejects(client.waitForReady(threadId, { timeoutMs: 20 }), error => error.code === 'OWNER_READY_TIMEOUT');
  assert.equal(lookups, 1);
  const controller = new AbortController();
  const waiting = client.waitForReady(threadId, { signal: controller.signal, timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(waiting, error => error.code === 'SUBSCRIPTION_CANCELLED');
  const stopped = lookups;
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(lookups, stopped);
});

test('a changed owner or disconnected connection cannot complete an earlier readiness wait', async t => {
  for (const change of ['owner', 'disconnect', 'unfollow']) {
    const { client, pipe } = await fixture(t);
    pipe.state = { ...idle(), resumeState: 'needs_resume' };
    const waiting = client.waitForReady(threadId, { timeoutMs: 1000 });
    const rejected = assert.rejects(waiting, error => ['SUBSCRIPTION_CANCELLED', 'CONNECTION_INTERRUPTED'].includes(error.code));
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'owner') { pipe.owner = 'owner-2'; pipe.state = idle(); await client.follow(threadId); }
    if (change === 'disconnect') pipe.emit('disconnected');
    if (change === 'unfollow') client.unfollow(threadId);
    await rejected;
    pipe.patch(1, 2, [{ op: 'replace', path: ['resumeState'], value: 'resumed' }]);
  }
});

test('a cancelled readiness lookup does not return a late successful owner response', async t => {
  const { client, pipe } = await fixture(t);
  let reply;
  pipe.request = () => new Promise(resolve => { reply = resolve; });
  const controller = new AbortController();
  const waiting = client.waitForReady(threadId, { signal: controller.signal, timeoutMs: 1000 });
  const rejected = assert.rejects(waiting, error => error.code === 'SUBSCRIPTION_CANCELLED');
  controller.abort();
  await rejected;
  reply({ type: 'response', resultType: 'success', method: OWNER_METHODS.owner,
    handledByClientId: pipe.owner, result: { supportsUntrustedAppInput: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.readinessWaits.size, 0);
  assert.equal(pipe.writes.length, 0);
});

test('readiness repairs a revision gap with one bounded full refresh before accepting new patches', async t => {
  const { client, pipe } = await fixture(t);
  pipe.state = { ...idle(), resumeState: 'needs_resume' };
  const waiting = client.waitForReady(threadId, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  pipe.revision = 3;
  const repaired = new Promise(resolve => {
    const unsubscribe = client.subscribe(event => {
      if (event.type === 'snapshot' && event.snapshot.revision === 3) { unsubscribe(); resolve(); }
    });
  });
  pipe.patch(0, 2, [{ op: 'replace', path: ['resumeState'], value: 'resumed' }]);
  await repaired;
  assert.equal(client.snapshot(threadId).revision, 3);
  assert.equal(client.snapshot(threadId).state.resumeState, 'needs_resume');
  assert.equal(pipe.following.filter(value => value.params.following).length, 2);
  pipe.patch(3, 4, [{ op: 'replace', path: ['resumeState'], value: 'resumed' }]);
  assert.equal((await waiting).revision, 4);
});

test('readiness repairs a missing initial snapshot but stops after a bounded number of full refreshes', async t => {
  const { client, pipe } = await fixture(t, { timeoutMs: 10 });
  pipe.silent = true;
  await assert.rejects(client.waitForReady(threadId, { timeoutMs: 80 }), error => error.code === 'OWNER_READY_TIMEOUT');
  assert.equal(pipe.following.filter(value => value.params.following).length, 3);
  assert.equal(client.readinessWaits.size, 0);
});

test('a cold first snapshot can finish within the total budget after bounded repair reads expire', async t => {
  const { client, pipe } = await fixture(t, { timeoutMs: 10 });
  pipe.silent = true;
  const waiting = client.waitForReady(threadId, { timeoutMs: 500 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(pipe.following.filter(value => value.params.following).length, 3);
  pipe.snapshot();
  assert.equal((await waiting).status.type, 'idle');
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

test('retry uses the native empty-turn trigger once and never repeats historical user text', async t => {
  const { client, pipe } = await fixture(t);
  pipe.state = failed(); await client.freshSnapshot(threadId);
  const options = retryOptions(client);
  assert.equal(client.supports(threadId, 'retry'), true);
  const result = await client.retryFailedTurn(threadId, options);
  assert.equal(result.status, 'submitted');
  assert.equal(result.turnId, 'new-turn');
  assert.equal(result.failedTurnId, 'failed-turn');
  assert.equal(pipe.writes[0].method, OWNER_METHODS.start);
  const request = pipe.writes[0].params.turnStart.request;
  assert.equal(request.threadId, threadId);
  assert.equal(request.turnTrigger, 'capacity_retry_manual');
  assert.equal(request.clientUserMessageId, options.operationId);
  assert.deepEqual(request.input, []);
  assert.doesNotMatch(JSON.stringify(pipe.writes), /Original user text/);
  client.close();
  assert.equal((await client.retryFailedTurn(threadId, options)).deduplicated, true);
  assert.equal(pipe.writes.length, 1);
  await assert.rejects(client.retryFailedTurn(threadId, { ...options, expectedFailedTurnId: 'different-turn' }), /another/);
});

test('retry rejects changed owner, generation, failed turn, and every nonfailed or unconfirmed state', async t => {
  const cases = [
    state => { state.resumeState = 'needs_resume'; },
    state => { state.resumeState = 'resuming'; },
    state => { state.threadRuntimeStatus = { type: 'unknown' }; },
    state => { state.threadRuntimeStatus = { type: 'idle' }; },
    state => { state.threadRuntimeStatus = { type: 'active', activeFlags: [] }; },
    state => { state.turns.at(-1).status = 'completed'; },
    state => { state.turns.at(-1).status = 'interrupted'; },
    state => { state.turns.push({ turnId: 'newer-turn', status: 'completed', items: [] }); },
    state => { state.turns.unshift({ turnId: 'active-turn', status: 'inProgress', items: [] }); },
    state => { state.unconfirmedTurnSubmissions = [{ id: 'unknown-submission' }]; },
    state => { state.unconfirmedTurnSubmissions = {}; },
  ];
  for (const mutate of cases) {
    const { client, pipe } = await fixture(t);
    pipe.state = failed(); mutate(pipe.state); await client.freshSnapshot(threadId);
    assert.equal(client.supports(threadId, 'retry'), false);
    await assert.rejects(client.retryFailedTurn(threadId, retryOptions(client)));
    assert.equal(pipe.writes.length, 0);
  }
  for (const options of [ { expectedOwner: 'old-owner' }, { expectedGeneration: 0 },
    { expectedFailedTurnId: 'older-turn' }, { expectedGeneration: undefined } ]) {
    const { client, pipe } = await fixture(t);
    pipe.state = failed(); await client.freshSnapshot(threadId);
    await assert.rejects(client.retryFailedTurn(threadId, retryOptions(client, options)), /changed|required/);
    assert.equal(pipe.writes.length, 0);
  }
});

test('retry requires live input permission and the observed start protocol', async t => {
  for (const unavailable of ['input', 'version', 'subscription']) {
    const { client, pipe } = await fixture(t);
    pipe.state = failed();
    if (unavailable === 'input') pipe.acceptsInput = false;
    await client.freshSnapshot(threadId);
    if (unavailable === 'version') client.protocolVersions = { ...versions, [OWNER_METHODS.start]: 3 };
    if (unavailable === 'subscription') client.unfollow(threadId);
    assert.equal(client.supports(threadId, 'retry'), false);
    await assert.rejects(client.retryFailedTurn(threadId, retryOptions(client)));
    assert.equal(pipe.writes.length, 0);
  }
});

test('concurrent retry and unknown acknowledgement retain one persistent dispatch fence', async t => {
  const persisted = [], { client, pipe } = await fixture(t, { onOperation: value => persisted.push(value) });
  pipe.state = failed(); await client.freshSnapshot(threadId);
  let reject;
  pipe.mutate = () => new Promise((_, fail) => { reject = fail; });
  const options = retryOptions(client), first = client.retryFailedTurn(threadId, options);
  assert.equal((await client.retryFailedTurn(threadId, options)).deduplicated, true);
  assert.equal(pipe.writes.length, 1);
  assert.equal(persisted[0].status, 'dispatched');
  assert.equal(persisted[0].failedTurnId, 'failed-turn');
  reject(Error('Native owner response timed out'));
  assert.equal((await first).status, 'unknown');
  client.close();
  assert.equal((await client.retryFailedTurn(threadId, options)).status, 'unknown');
  assert.equal(pipe.writes.length, 1);
});

test('retry validates the native start acknowledgement owner, method, thread and new turn', async t => {
  const cases = [
    value => { value.handledByClientId = 'another-owner'; },
    value => { value.method = OWNER_METHODS.steer; },
    value => { value.result.result.turn.threadId = otherId; },
    value => { delete value.result.result.turn.id; },
    value => { value.result.result.turn.id = 'failed-turn'; },
  ];
  for (const damage of cases) {
    const { client, pipe } = await fixture(t);
    pipe.state = failed(); await client.freshSnapshot(threadId);
    pipe.mutate = async () => {
      const value = { type: 'response', resultType: 'success', method: OWNER_METHODS.start, handledByClientId: pipe.owner,
        result: { result: { turn: { id: 'new-turn', threadId } } } };
      damage(value); return value;
    };
    assert.equal((await client.retryFailedTurn(threadId, retryOptions(client))).status, 'unknown');
    assert.equal(pipe.writes.length, 1);
  }
});

test('retry checks the exact failed state again after persisting its dispatch fence', async t => {
  let pipe;
  const f = await fixture(t, { onOperation: value => {
    if (value.status === 'dispatched') {
      pipe.state = failed('newer-failed-turn'); pipe.snapshot();
    }
  } });
  pipe = f.pipe; pipe.state = failed(); await f.client.freshSnapshot(threadId);
  const result = await f.client.retryFailedTurn(threadId, retryOptions(f.client));
  assert.equal(result.status, 'unknown');
  assert.equal(pipe.writes.length, 0);
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
