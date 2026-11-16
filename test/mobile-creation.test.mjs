import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../mobile/store.mjs';
import { CreationManager } from '../mobile/creation.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const input = { host: 'windows', operationId: 'isolated-create-operation', projectId: 'native-project', prompt: 'synthetic private prompt' };
function rig(t, create) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-creation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const nativeTools = { capability: async () => ({ supported: true }), create: async (...args) => { calls++; return create(...args); } };
  const journal = new Journal(dir);
  const manager = new CreationManager({ nativeTools, journal, hostId: 'windows' });
  return { manager, journal, nativeTools, dir, calls: () => calls };
}

test('creation receipt is durable before write and a duplicate returns the real ID without replay', async t => {
  let f;
  f = rig(t, async (args, { beforeDispatch }) => { assert.deepEqual(args, { projectId: 'native-project', prompt: input.prompt }); beforeDispatch(); assert.equal(new Journal(f.dir).records.get(input.operationId).status, 'dispatched'); return { threadId }; });
  assert.equal((await f.manager.create(input)).status, 'confirmed');
  const duplicate = await f.manager.create(input);
  assert.deepEqual({ status: duplicate.status, threadId: duplicate.threadId, deduplicated: duplicate.deduplicated }, { status: 'confirmed', threadId, deduplicated: true });
  assert.equal(f.calls(), 1); assert.doesNotMatch(fs.readFileSync(f.journal.file, 'utf8'), /synthetic private prompt|native-project/);
});

test('concurrent identical creation requests join one dispatch; changed content is rejected', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const f = rig(t, async (_args, { beforeDispatch }) => { entered(); await gate; beforeDispatch(); return { threadId }; });
  const first = f.manager.create(input); await ready;
  const joined = f.manager.create(input);
  assert.equal((await f.manager.create({ ...input, prompt: 'different' })).status, 'rejected');
  release(); assert.equal((await first).threadId, threadId); assert.equal((await joined).threadId, threadId); assert.equal(f.calls(), 1);
});

test('lost ACK, native RPC failure and malformed ACK all remain unknown across restart', async t => {
  for (const kind of ['lost', 'rpc', 'malformed']) {
    const f = rig(t, async (_args, { beforeDispatch }) => { beforeDispatch(); if (kind !== 'malformed') throw Error(kind); return {}; });
    assert.equal((await f.manager.create(input)).status, 'unknown');
    const restarted = new CreationManager({ nativeTools: f.nativeTools, journal: new Journal(f.dir), hostId: 'windows' });
    assert.equal((await restarted.create(input)).status, 'unknown'); assert.equal(f.calls(), 1);
  }
});

test('predispatch validation or project failure permits explicit retry without a receipt', async t => {
  const f = rig(t, async () => { throw Error('项目已不存在，未创建'); });
  for (const extra of [{ prompt: '' }, { projectId: '' }, { host: 'mac' }, { cwd: '/untrusted/path' }, { model: 'invented' }]) assert.equal((await f.manager.create({ ...input, ...extra })).status, 'rejected');
  assert.equal(f.calls(), 0);
  assert.equal((await f.manager.create(input)).status, 'rejected'); assert.equal((await f.manager.create(input)).status, 'rejected');
  assert.equal(f.calls(), 2); assert.equal(f.journal.records.size, 0);
});

test('journal failure prevents dispatch; a postdispatch journal failure still returns unknown', async t => {
  let writes = 0;
  const f = rig(t, async (_args, { beforeDispatch }) => { beforeDispatch(); writes++; return { threadId }; });
  const original = f.journal.save.bind(f.journal);
  f.journal.save = () => { throw Error('synthetic storage failure'); };
  assert.equal((await f.manager.create(input)).status, 'rejected'); assert.equal(writes, 0);
  let saves = 0;
  f.journal.save = record => { if (saves++) throw Error('synthetic later storage failure'); original(record); };
  assert.equal((await f.manager.create(input)).status, 'unknown'); assert.equal(writes, 1);
  assert.equal(new Journal(f.dir).records.get(input.operationId).status, 'dispatched');
  assert.equal((await f.manager.create(input)).status, 'unknown'); assert.equal(writes, 1);
});

test('async creation keeps its client ID separate from a real thread ID and remains deduplicated', async t => {
  const f = rig(t, async (_args, { beforeDispatch }) => { beforeDispatch(); return { clientThreadId: 'queued-creation-id' }; });
  const result = await f.manager.create(input); assert.equal(result.status, 'submitted'); assert.equal(result.threadId, undefined);
  const restarted = new CreationManager({ nativeTools: f.nativeTools, journal: new Journal(f.dir), hostId: 'windows' });
  const again = await restarted.create(input); assert.equal(again.clientThreadId, 'queued-creation-id'); assert.equal(again.status, 'submitted'); assert.equal(f.calls(), 1);
});

test('ordinary reply receipts and a full journal cannot be reused for creation', async t => {
  const f = rig(t, async () => { throw Error('must not call native tools'); });
  f.journal.save({ operationId: input.operationId, status: 'submitted', threadId, apiFingerprint: 'other' });
  assert.equal((await f.manager.create(input)).status, 'rejected'); assert.equal(f.calls(), 0);
  for (let i = 0; i < 10000; i++) f.journal.records.set('synthetic-' + i, {});
  assert.equal((await f.manager.create({ ...input, operationId: 'other-create-operation' })).status, 'rejected'); assert.equal(f.calls(), 0);
});
