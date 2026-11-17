import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { Readable, Writable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createGateway } from '../mobile/gateway.mjs';
import { Journal, writePrivate } from '../mobile/store.mjs';
import { requestFingerprint } from '../mobile/requests.mjs';
import { ThreadCatalog, visibleItem } from '../mobile/history.mjs';
import { OwnerClient, ownerSnapshotReady } from '../mobile/owner.mjs';
import { OWNER_METHODS, OWNER_SUPPORTED_VERSIONS } from '../mobile/protocols.mjs';
import { runtimeStatus } from '../src/state.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const selfKey = 'synthetic-self-pairing-key-for-isolated-tests';
const peerKey = 'synthetic-peer-key-for-isolated-tests';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const auth = { Authorization: 'Bearer ' + selfKey };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function within(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}

async function rig(t, { peers = [], peerPaired = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-gateway-test-'));
  const open = new Set(), calls = { discover: 0, credentials: [] };
  // Tests must not read a real Keychain/DPAPI entry, desktop socket or Codex history.
  const keys = new Map([['self', selfKey], ...(peerPaired ? [['peer-windows', peerKey]] : [])]);
  const secrets = { async get(name) { calls.credentials.push(name); return keys.get(name) ?? null; } };
  async function start(extra = {}) {
    const gateway = await createGateway({ port: 0, hostId: 'mac', hostName: 'Mac fixture', dir, peers, secrets,
      catalog: new ThreadCatalog(path.join(dir, 'isolated-codex-home')),
      nativeTools: { capability: async () => ({ supported: false, reason: 'fixture' }), statuses: async () => [], create: async () => { throw Error('Native creation forbidden in isolated gateway tests'); } },
      discover: async () => { calls.discover++; throw Error('Test isolation: native desktop discovery is forbidden'); }, ...extra });
    open.add(gateway); return gateway;
  }
  async function close(gateway) { if (open.delete(gateway)) await gateway.close(); }
  t.after(async () => { for (const gateway of [...open]) await close(gateway); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, calls, keys, secrets, start, close };
}

function request(gateway, { route = '/api/hosts', method = 'GET', headers = {}, body } = {}) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gateway.port, path: route, method,
      headers: { ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, (res) => {
      const parts = []; res.on('data', (part) => parts.push(part)); res.on('error', reject);
      res.on('end', () => {
        const received = Buffer.concat(parts), text = received.toString('utf8'); let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, bytes: received, text, data });
      });
    });
    req.on('error', reject); req.end(bytes);
  });
}
async function pair(gateway, headers = {}) {
  const result = await request(gateway, { route: '/api/pair', method: 'POST', headers, body: { token: selfKey } });
  assert.equal(result.status, 200); const full = result.headers['set-cookie']?.[0]; assert.ok(full);
  return { result, full, cookie: full.split(';')[0], value: full.split(';')[0].slice('cmc_session='.length) };
}

test('phone image GET uses pairing and exact thread-scoped opaque references without desktop discovery', async t => {
  const f = await rig(t), imageId = 'a'.repeat(64), contentKey = 'b'.repeat(64);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ4sAAAAASUVORK5CYII=', 'base64');
  const reads = [];
  const media = { read(id, image, key) {
    reads.push({ id, image, key });
    if (id !== threadId || image !== imageId || key !== contentKey) throw Error('/private/not-for-response.png');
    return { bytes, type: 'image/png', name: '截图.png' };
  } };
  const gateway = await f.start({ media });
  const route = '/api/image?threadId=' + threadId + '&id=' + imageId + '&key=' + contentKey;
  assert.equal((await request(gateway, { route })).status, 401);
  assert.equal(reads.length, 0);
  const paired = await pair(gateway);
  const image = await request(gateway, { route, headers: { Cookie: paired.cookie } });
  assert.equal(image.status, 200);
  assert.deepEqual(image.bytes, bytes);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.match(image.headers['cache-control'], /private/);
  assert.match(image.headers['content-security-policy'], /default-src 'none'/);
  const other = await request(gateway, { route: route.replace(threadId, '22222222-2222-4222-8222-222222222222'), headers: auth });
  assert.equal(other.status, 404); assert.ok(!other.text.includes('/private/'));
  assert.equal((await request(gateway, { route: route.replace(contentKey, 'c'.repeat(64)), headers: auth })).status, 404);
  assert.equal(f.calls.discover, 0);
});

test('phone image route rejects paths, arbitrary URLs, ambiguous keys and non-GET requests', async t => {
  const f = await rig(t), reads = [];
  const gateway = await f.start({ media: { read(...args) { reads.push(args); throw Error('Must not read'); } } });
  const route = '/api/image?threadId=' + threadId + '&id=' + 'a'.repeat(64) + '&key=' + 'b'.repeat(64);
  for (const invalid of [route + '&path=/etc/passwd', route + '&url=https://example.com/a.png', route + '&id=' + 'a'.repeat(64),
    route.replace('id=' + 'a'.repeat(64), 'id=../../a.png'), route.replace('key=' + 'b'.repeat(64), 'key=')]) {
    assert.equal((await request(gateway, { route: invalid, headers: auth })).status, 400);
  }
  assert.equal((await request(gateway, { route, method: 'POST', headers: auth, body: {} })).status, 405);
  assert.deepEqual(reads, []);
});

test('phone history projects an inline original to an authenticated image reference instead of a large JSON payload', async t => {
  const f = await rig(t);
  const source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ4sAAAAASUVORK5CYII=';
  const catalog = { get: async () => ({ id: threadId, title: '图片-only历史' }),
    read: async (id, _limit, { media }) => ({ messages: [visibleItem({ type: 'userMessage', id: 'photo-only',
      content: [{ type: 'image', url: source }] }, { media, threadId: id })] }) };
  const gateway = await f.start({ catalog });
  const thread = await request(gateway, { route: '/api/thread?id=' + threadId, headers: auth });
  assert.equal(thread.status, 200); assert.equal(thread.data.messages.length, 1);
  const image = thread.data.messages[0].images[0];
  assert.match(image.id, /^[a-f0-9]{64}$/); assert.match(image.contentKey, /^[a-f0-9]{64}$/);
  assert.ok(!thread.text.includes('base64')); assert.ok(thread.bytes.length < 2048);
  const route = '/api/image?threadId=' + threadId + '&id=' + image.id + '&key=' + image.contentKey;
  const original = await request(gateway, { route, headers: auth });
  assert.equal(original.status, 200); assert.equal(original.headers['content-type'], 'image/png');
  assert.deepEqual(original.bytes, Buffer.from(source.split(',')[1], 'base64'));
  assert.equal((await request(gateway, { route: route + '&retry=1', headers: auth })).status, 200);
});

const todayGalleryRoute = '/api/thread?view=today-images&id=' + threadId;
const galleryFixture = () => ({ date: '2026-11-17', complete: true, issues: [], images: [{
  id: 'a'.repeat(64), contentKey: 'b'.repeat(64), name: 'fixture.png', messageId: 'gallery-message', at: 1794870000000,
}] });

test('today gallery authenticates before catalog access and validates the chat ID', async t => {
  const f = await rig(t); let reads = 0;
  const catalog = { async readTodayImages() { reads++; return galleryFixture(); } };
  const gateway = await f.start({ catalog });
  assert.equal((await request(gateway, { route: todayGalleryRoute })).status, 401);
  assert.equal(reads, 0); assert.equal(f.calls.discover, 0);
  const invalid = await request(gateway, { route: todayGalleryRoute.replace(threadId, 'not-a-chat-id'), headers: auth });
  assert.equal(invalid.status, 400); assert.equal(reads, 0); assert.equal(f.calls.discover, 0);
});

test('today gallery reads saved pictures with no owner discovery and exposes only opaque metadata', async t => {
  const f = await rig(t); let reads = 0;
  const catalog = { async readTodayImages(id) {
    reads++; assert.equal(id, threadId);
    const data = galleryFixture(); data.images[0].path = '/private/source.png'; data.images[0].data = 'private-base64';
    return data;
  } };
  const gateway = await f.start({ catalog });
  const result = await request(gateway, { route: todayGalleryRoute, headers: auth });
  assert.equal(result.status, 200); assert.equal(result.data.host, 'mac'); assert.equal(result.data.id, threadId);
  assert.equal(result.data.complete, true); assert.equal(reads, 1); assert.equal(f.calls.discover, 0);
  assert.ok(!result.text.includes('/private/') && !result.text.includes('private-base64'));
});

test('today gallery source failures keep private paths out of the HTTP response', async t => {
  const f = await rig(t), gateway = await f.start({ catalog: {
    async readTodayImages() { throw Error('cannot read /private/secret/history.jsonl with private-payload'); },
  } });
  const result = await request(gateway, { route: todayGalleryRoute, headers: auth });
  assert.equal(result.status, 503); assert.match(result.data.error, /今日图片暂时无法读取/);
  assert.ok(!result.text.includes('/private/') && !result.text.includes('private-payload'));
  assert.equal(f.calls.discover, 0);
});

test('cancelling one gallery HTTP client aborts its read without cancelling another client', async t => {
  const f = await rig(t), signals = [], bothEntered = deferred(), firstCancelled = deferred(), resultGate = deferred();
  const gateway = await f.start({ catalog: { async readTodayImages(_id, { signal }) {
    const index = signals.push(signal) - 1; if (signals.length === 2) bothEntered.resolve();
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { if (index === 0) firstCancelled.resolve(); reject(signal.reason); }, { once: true });
      resultGate.promise.then(resolve, reject);
    });
  } } });
  const first = http.request({ host: '127.0.0.1', port: gateway.port, path: todayGalleryRoute, headers: auth });
  first.on('error', () => {}); first.end();
  const second = request(gateway, { route: todayGalleryRoute, headers: auth });
  await within(bothEntered.promise, 'Gallery HTTP reads did not start'); first.destroy();
  await within(firstCancelled.promise, 'Cancelled HTTP read did not receive abort');
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  assert.equal((await request(gateway, { route: '/health' })).status, 200);
  resultGate.resolve(galleryFixture()); assert.equal((await second).status, 200);
  assert.equal(f.calls.discover, 0);
});

test('Windows phone front door preserves the gallery query and uses only the paired Mac peer', async t => {
  const calls = [], data = { ...galleryFixture(), host: 'mac', id: threadId };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json(data);
  });
  const f = await rig(t, { peers: [{ id: 'mac', url: 'https://mac-fixture.tailfixture.ts.net' }] });
  f.keys.set('peer-mac', peerKey);
  const gateway = await f.start({ hostId: 'windows', hostName: 'Windows fixture' });
  const route = todayGalleryRoute + '&host=mac';
  assert.equal((await request(gateway, { route })).status, 401); assert.equal(calls.length, 0);
  const result = await request(gateway, { route, headers: auth });
  assert.equal(result.status, 200); assert.deepEqual(result.data, data); assert.equal(calls.length, 1);
  const forwarded = new URL(calls[0].url);
  assert.equal(forwarded.hostname, 'mac-fixture.tailfixture.ts.net');
  assert.equal(forwarded.searchParams.get('view'), 'today-images'); assert.equal(forwarded.searchParams.get('id'), threadId);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + peerKey); assert.equal(f.calls.discover, 0);
});

test('a new gallery inline reference is readable only in its authenticated chat and content identity', async t => {
  const f = await rig(t), source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ4sAAAAASUVORK5CYII=';
  const gateway = await f.start({ catalog: { async readTodayImages(id, { media }) {
    const message = visibleItem({ type: 'userMessage', id: 'saved-gallery-picture', content: [{ type: 'image', url: source }] }, { media, threadId: id });
    return { date: '2026-11-17', complete: true, issues: [], images: message.images.map(image => ({ ...image, messageId: message.id, at: 1794870000000 })) };
  } } });
  const gallery = await request(gateway, { route: todayGalleryRoute, headers: auth });
  assert.equal(gallery.status, 200); assert.equal(gallery.data.images.length, 1);
  const image = gallery.data.images[0], route = '/api/image?threadId=' + threadId + '&id=' + image.id + '&key=' + image.contentKey;
  assert.equal((await request(gateway, { route })).status, 401);
  const original = await request(gateway, { route, headers: auth });
  assert.equal(original.status, 200); assert.deepEqual(original.bytes, Buffer.from(source.split(',')[1], 'base64'));
  assert.equal((await request(gateway, { route: route.replace(threadId, '22222222-2222-4222-8222-222222222222'), headers: auth })).status, 404);
  assert.equal((await request(gateway, { route: route.replace(image.contentKey, 'c'.repeat(64)), headers: auth })).status, 404);
  assert.equal(f.calls.discover, 0);
});

test('phone image peer forwarding preserves image headers and uses only the paired peer credential', async t => {
  const calls = [], bytes = Buffer.from('fixture original image bytes');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': String(bytes.length),
      'cache-control': 'private, max-age=300', 'content-disposition': 'inline; filename="image.png"',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", etag: '"fixture"' } });
  });
  const f = await rig(t, { peers: [{ id: 'windows', url: 'https://windows-fixture.tailfixture.ts.net' }] });
  const gateway = await f.start(), paired = await pair(gateway);
  const route = '/api/image?host=windows&threadId=' + threadId + '&id=' + 'a'.repeat(64) + '&key=' + 'b'.repeat(64);
  const image = await request(gateway, { route, headers: { Cookie: paired.cookie } });
  assert.equal(image.status, 200); assert.deepEqual(image.bytes, bytes);
  assert.equal(image.headers['content-type'], 'image/png'); assert.equal(image.headers['content-length'], String(bytes.length));
  assert.equal(image.headers['cache-control'], 'private, max-age=300'); assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + peerKey); assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(f.calls.discover, 0);
});

test('waiting for image permission leaves health responsive and bounded image failures do not disclose paths', async t => {
  const f = await rig(t), pending = deferred(), entered = deferred();
  const bytes = Buffer.from('isolated image bytes'), route = '/api/image?threadId=' + threadId + '&id=' + 'a'.repeat(64) + '&key=' + 'b'.repeat(64);
  const gateway = await f.start({ media: { async read() { entered.resolve(); return pending.promise; } } });
  const image = request(gateway, { route, headers: auth }); await entered.promise;
  assert.equal((await within(request(gateway, { route: '/health' }), 'Image read blocked health')).status, 200);
  pending.resolve({ bytes, type: 'image/png' });
  assert.equal((await image).status, 200);
  const timeout = await f.start({ media: { async read() { throw Object.assign(Error('/private/permissions.png'), { code: 'MEDIA_TIMEOUT' }); } } });
  const failed = await request(timeout, { route, headers: auth });
  assert.equal(failed.status, 504); assert.match(failed.data.error, /访问授权/); assert.ok(!failed.text.includes('/private/'));
});
function openPeerStream(gateway) {
  const ready = deferred(), closed = deferred(); let response;
  const req = http.get({ host: '127.0.0.1', port: gateway.port,
    path: '/api/events?host=windows&id=' + threadId, headers: auth }, (res) => {
    response = res;
    res.once('data', () => ready.resolve({ status: res.statusCode, res }));
    res.on('error', () => {}); res.once('close', closed.resolve);
  });
  req.on('error', () => { if (!response) ready.resolve({ status: 0 }); });
  return { ready: ready.promise, closed: closed.promise, cancel() { response?.destroy(); req.destroy(); } };
}

// Keep live-state tests on a synthetic verified desktop, with no native socket,
// real credentials, history, navigation or task-write method available.
function syntheticIdentity(dir) {
  const code = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(OWNER_METHODS)
    .map(([key, method]) => [method, key === 'stream' ? 11 : OWNER_SUPPORTED_VERSIONS[key].at(-1)]))));
  const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files: {
    'synthetic.js': { size: code.length, offset: '0' },
  } } } } } }));
  const padded = Math.ceil((header.length + 8) / 4) * 4, prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(padded, 4); prefix.writeUInt32LE(padded - 4, 8); prefix.writeUInt32LE(header.length, 12);
  const asarPath = path.join(dir, 'synthetic.asar');
  fs.writeFileSync(asarPath, Buffer.concat([prefix, header, Buffer.alloc(8 + padded - 16 - header.length), code]));
  return { verified: true, fingerprint: 'synthetic-desktop', asarPath, socketPath: '/never-connect-synthetic.sock' };
}
async function ownerRig(t, options = {}) {
  const f = await rig(t), identity = syntheticIdentity(f.dir);
  const control = { ready: false, exists: true, reads: 0, opens: [], openAttempts: 0, unfollows: 0, mutations: 0, owner: null };
  const catalog = { get: async id => control.exists && id === threadId ? { id, title: 'Existing fixture' } : null,
    read: async () => ({ messages: [{ id: 'existing-user', role: 'user', text: 'Previous user message' }] }), query: async () => ({ threads: [] }) };
  t.mock.method(OwnerClient.prototype, 'connect', async function () {
    this.connected = true; this.generation++; this.identity = identity; this.abort = new AbortController();
    this.pipe = { socket: { destroyed: false }, off() {}, close() {} }; control.owner = this;
    return identity;
  });
  t.mock.method(OwnerClient.prototype, 'freshSnapshot', async function (id) {
    if (control.readError) throw control.readError;
    control.reads++; this.unknown(id, 'Waiting for a fresh owner snapshot', { refreshing: true });
    control.readStarted?.resolve(); if (control.readGate) await control.readGate.promise;
    if (!control.ready || !this.connected) throw Object.assign(Error('No live Desktop owner was found'), { code: 'OWNER_UNAVAILABLE' });
    const state = { id, title: 'Existing fixture', resumeState: control.resumeState ?? 'resumed',
      threadRuntimeStatus: { type: control.runtimeType ?? 'idle' }, turns: control.turns ?? [], requests: [],
      unconfirmedTurnSubmissions: control.unconfirmedTurnSubmissions ?? [] };
    if (control.omitResumeState) delete state.resumeState;
    const snapshot = { threadId: id, owner: 'fixture-owner', generation: this.generation, revision: 1, sequence: control.reads,
      activeTurnId: null, status: runtimeStatus(state), source: 'official-desktop-owner-IPC-live', state };
    this.snapshots.set(id, snapshot); this.owners.set(id, { owner: snapshot.owner, generation: this.generation, supportsUntrustedAppInput: true });
    this.nativeSubscriptions.set(id, { generation: this.generation });
    return structuredClone(snapshot);
  });
  // This rig isolates HTTP lifetime and cancellation. The wire integration
  // tests below keep the real readiness method and stream decoder instead.
  t.mock.method(OwnerClient.prototype, 'waitForReady', async function (id, { signal } = {}) {
    while (!signal?.aborted) {
      try { const snapshot = await this.freshSnapshot(id); if (ownerSnapshotReady(snapshot)) return snapshot; }
      catch (error) { if (signal?.aborted) throw signal.reason; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw signal.reason;
  });
  const unfollow = OwnerClient.prototype.unfollow;
  t.mock.method(OwnerClient.prototype, 'unfollow', function (id) { if (this === control.owner) control.unfollows++; return unfollow.call(this, id); });
  for (const name of ['sendText', 'requestToOwner']) t.mock.method(OwnerClient.prototype, name, async () => { control.mutations++; throw Error('Task writes forbidden'); });
  t.mock.method(OwnerClient.prototype, 'retryFailedTurn', async function (id, options) {
    control.mutations++;
    if (!control.retryOutcome) throw Error('Task retries forbidden');
    (control.retries ??= []).push({ id, options });
    const record = { operationId: options.operationId, fingerprint: hash(options.operationId), threadId: id,
      methodKey: 'start', owner: options.expectedOwner, expectedTurnId: null, generation: this.generation, status: 'dispatched' };
    this.operation(record); control.retryStarted?.resolve();
    if (control.retryGate) await control.retryGate.promise;
    const result = { ...record, status: control.retryOutcome, turnId: 'native-new-turn' };
    this.operation(result); return result;
  });
  const nativeTools = { capability: async () => ({ supported: false }), statuses: async () => [],
    openExistingThread: async (id, { signal } = {}) => {
      control.openAttempts++; control.openSignal = signal; control.openStarted?.resolve();
      if (control.openGate) await control.openGate.promise;
      if (signal?.aborted) throw signal.reason;
      control.opens.push(id);
    } };
  const gateway = await f.start({ discover: async () => identity, catalog, nativeTools, ...options });
  return { ...f, gateway, control };
}

test('a running desktop chat exposes only completed tool image blocks to the paired phone', async t => {
  const f = await ownerRig(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ4sAAAAASUVORK5CYII=', 'base64');
  f.control.ready = true; f.control.runtimeType = 'active';
  f.control.turns = [{ items: [{ type: 'mcpToolCall', id: 'public-tool-screenshot', status: 'completed', tool: 'js',
    arguments: { hidden: 'private-tool-arguments' }, result: { content: [
      { type: 'text', text: 'private-tool-text' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png', _meta: { hidden: 'private-image-meta' } },
    ], structuredContent: { private: 'private-structured-content' } } }] }];
  const thread = await request(f.gateway, { route: '/api/thread?id=' + threadId, headers: auth });
  assert.equal(thread.status, 200); assert.equal(thread.data.status, 'running');
  assert.equal(thread.data.messages.length, 1); const message = thread.data.messages[0];
  assert.equal(message.role, 'assistant'); assert.equal(message.text, ''); assert.equal(message.images.length, 1);
  for (const hidden of ['private-tool-', 'private-image-meta', 'private-structured-content', png.toString('base64')]) assert.ok(!thread.text.includes(hidden));
  const image = message.images[0], result = await request(f.gateway, { headers: auth,
    route: '/api/image?threadId=' + threadId + '&id=' + image.id + '&key=' + image.contentKey });
  assert.equal(result.status, 200); assert.deepEqual(result.bytes, png); assert.equal(f.control.mutations, 0);
});

function localStream(gateway) {
  const ready = deferred(), closed = deferred(); let response;
  const observe = (req, res) => { if (req.url.startsWith('/api/events')) { gateway.server.off('request', observe); res.once('close', closed.resolve); } };
  gateway.server.on('request', observe);
  const req = http.get({ host: '127.0.0.1', port: gateway.port, path: '/api/events?host=mac&id=' + threadId, headers: auth }, res => {
    response = res; res.on('error', () => {}); res.once('data', ready.resolve);
  });
  req.on('error', () => {});
  return { ready: ready.promise, closed: closed.promise, cancel() { response?.destroy(); req.destroy(); } };
}

// Exercise the actual raw-peer adapter and gateway stream, while keeping TLS
// transport synthetic. Assertions below inspect the phone-facing wire bytes.
function rawPeerResponse(t, createResponse) {
  const calls = [];
  t.mock.method(https, 'request', (url, options, onResponse) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return new Writable({ write(_bytes, _encoding, done) { done(); }, final(done) {
      const { bytes, headers } = createResponse(calls.at(-1));
      const upstream = Readable.from([bytes]); upstream.statusCode = 200; upstream.headers = headers;
      queueMicrotask(() => onResponse(upstream)); done();
    } });
  });
  return calls;
}

test('thread query defaults to seven days and forwards project/search/paging filters without a fixed 200 limit', async t => {
  const calls = [], f = await rig(t);
  const catalog = { query: async input => { calls.push(input); return { threads: [{ id: threadId }], projects: [], total: 345, nextCursor: 'next', complete: true }; } };
  const gateway = await f.start({ catalog });
  const first = await request(gateway, { route: '/api/threads', headers: auth });
  assert.equal(first.data.total, 345); assert.deepEqual(calls[0], { projectId: undefined, q: '', range: 'week', cursor: undefined, limit: 50 });
  await request(gateway, { route: '/api/threads?range=all&projectId=red-app&q=UI&cursor=next&limit=25', headers: auth });
  assert.deepEqual(calls[1], { projectId: 'red-app', q: 'UI', range: 'all', cursor: 'next', limit: 25 });
});

test('new-chat capability/create are authenticated and same-origin, and creation receipts deduplicate', async t => {
  let writes = 0;
  const f = await rig(t), nativeTools = {
    capability: async () => ({ supported: true, projectless: true, projects: [{ projectId: 'native-red', name: 'red-app' }] }),
    create: async (_args, { beforeDispatch }) => { beforeDispatch(); writes++; return { threadId }; },
  };
  const gateway = await f.start({ nativeTools });
  const input = { host: 'mac', operationId: 'fixture-create-operation', prompt: 'synthetic create', projectId: 'native-red' };
  assert.equal((await request(gateway, { route: '/api/creation' })).status, 401);
  assert.equal((await request(gateway, { route: '/api/create', method: 'POST', body: input })).status, 401);
  assert.equal((await request(gateway, { route: '/api/create', method: 'POST', headers: { ...auth, Origin: 'https://untrusted.invalid' }, body: input })).status, 403);
  assert.equal(writes, 0);
  assert.equal((await request(gateway, { route: '/api/creation', headers: auth })).data.projects[0].name, 'red-app');
  for (let i = 0; i < 2; i++) assert.equal((await request(gateway, { route: '/api/create', method: 'POST', headers: auth, body: input })).data.threadId, threadId);
  assert.equal(writes, 1); assert.equal(f.calls.discover, 0);
});

test('sidebar status ignores old, unconfirmed and unrelated rows; invalid query never contacts native tools', async t => {
  const other = '22222222-2222-4222-8222-222222222222', third = '33333333-3333-4333-8333-333333333333';
  let calls = 0;
  const f = await rig(t), gateway = await f.start({ nativeTools: { statuses: async () => { calls++; return { statuses: [
    { id: threadId, status: 'running', statusConfirmed: true, observedAt: Date.now() },
    { id: other, status: 'running', statusConfirmed: true, observedAt: Date.now() - 60000 },
    { id: third, status: 'running', statusConfirmed: false, observedAt: Date.now() },
  ] }; } } });
  assert.equal((await request(gateway, { route: '/api/statuses?ids=bad', headers: auth })).status, 400); assert.equal(calls, 0);
  const result = await request(gateway, { route: '/api/statuses?ids=' + [threadId, other, third].join(','), headers: auth });
  assert.equal(result.data.statuses[0].status, 'running');
  assert.deepEqual(result.data.statuses.slice(1).map(r => [r.status, r.statusConfirmed]), [['unknown', false], ['unknown', false]]);
  assert.equal(f.calls.discover, 0);
});

test('raw peer receives the browser Accept-Encoding and negotiates gzip JSON the phone can decode', async (t) => {
  const payload = { title: '手机收到完整中文与符号 ✅', messages: Array(30).fill('原会话文字，不应变成乱码。') };
  const plain = Buffer.from(JSON.stringify(payload));
  const calls = rawPeerResponse(t, call => {
    const gzip = /(?:^|,)\s*gzip(?:\s*[,;]|$)/.test(call.headers.get('accept-encoding') ?? '');
    return { bytes: gzip ? gzipSync(plain) : plain, headers: { 'content-type': 'application/json; charset=utf-8', ...(gzip ? { 'content-encoding': 'gzip' } : {}) } };
  });
  const f = await rig(t, { peers: [{ id: 'windows', url: 'https://windows-fixture.tailfixture.ts.net', address: '100.64.23.45' }] }), gateway = await f.start();
  const result = await request(gateway, { route: '/api/thread?host=windows&id=' + threadId, headers: { ...auth, 'Accept-Encoding': 'gzip, br;q=0.5' } });
  assert.equal(result.status, 200); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('accept-encoding'), 'gzip, br;q=0.5', 'the upstream must see the phone representation preference');
  assert.equal(result.headers['content-encoding'], 'gzip', 'compressed bytes need their matching phone-facing encoding');
  assert.deepEqual(JSON.parse(gunzipSync(result.bytes).toString('utf8')), payload);
  assert.ok(result.bytes.length < plain.length, 'the phone receives the smaller representation on the wire');
  assert.equal(f.calls.discover, 0);
});

test('an already-gzipped raw peer body retains its encoding instead of reaching the phone as unreadable JSON', async (t) => {
  const payload = { title: '原始压缩响应：完整中文', answer: '确认' }, plain = Buffer.from(JSON.stringify(payload)), zipped = gzipSync(plain);
  rawPeerResponse(t, () => ({ bytes: zipped, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }));
  const f = await rig(t, { peers: [{ id: 'windows', url: 'https://windows-fixture.tailfixture.ts.net', address: '100.64.23.45' }] }), gateway = await f.start();
  const result = await request(gateway, { route: '/api/thread?host=windows&id=' + threadId, headers: { ...auth, 'Accept-Encoding': 'gzip' } });
  assert.equal(result.status, 200);
  // A phone decodes based on this header; gzip bytes without it are corrupt JSON.
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.deepEqual(result.bytes, zipped); assert.deepEqual(JSON.parse(gunzipSync(result.bytes).toString('utf8')), payload);
});

test('raw peer SSE without encoding stays byte-for-byte readable and is not labelled gzip', async (t) => {
  const bytes = Buffer.from('event: state\ndata: {"title":"空闲中文会话"}\n\nevent: ping\ndata: {}\n\n');
  rawPeerResponse(t, () => ({ bytes, headers: { 'content-type': 'text/event-stream' } }));
  const f = await rig(t, { peers: [{ id: 'windows', url: 'https://windows-fixture.tailfixture.ts.net', address: '100.64.23.45' }] }), gateway = await f.start();
  const result = await request(gateway, { route: '/api/events?host=windows&id=' + threadId, headers: { ...auth, 'Accept-Encoding': 'gzip' } });
  assert.equal(result.status, 200); assert.equal(result.headers['content-encoding'], undefined);
  assert.match(result.headers['content-type'], /^text\/event-stream/); assert.deepEqual(result.bytes, bytes);
});

test('native-fetch fallback forwards its decompressed JSON without the old upstream gzip label', async (t) => {
  const payload = { title: '真实 fetch 自动解压兼容', messages: Array(20).fill('中文正文必须可直接解析') }, plain = Buffer.from(JSON.stringify(payload));
  const upstream = http.createServer((_req, res) => { const zipped = gzipSync(plain); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': zipped.length }); res.end(zipped); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const nativeFetch = globalThis.fetch; let upstreamEncoding;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const response = await nativeFetch('http://127.0.0.1:' + upstream.address().port + '/gzip-fixture', options);
    upstreamEncoding = response.headers.get('content-encoding'); return response;
  });
  const f = await rig(t, { peers: [{ id: 'windows', url: 'https://windows-fixture.tailfixture.ts.net' }] }), gateway = await f.start();
  const result = await request(gateway, { route: '/api/thread?host=windows&id=' + threadId, headers: { ...auth, 'Accept-Encoding': 'gzip' } });
  assert.equal(upstreamEncoding, 'gzip', 'native fetch retains the origin header after decoding its response body');
  assert.equal(result.status, 200); assert.equal(result.headers['content-encoding'], undefined, 'the phone must not try to decompress decoded bytes again');
  assert.deepEqual(result.bytes, plain); assert.deepEqual(result.data, payload);
});

test('public shell and health are readable; every protected API requires a valid session or bearer', async (t) => {
  const f = await rig(t), gateway = await f.start();
  const health = await request(gateway, { route: '/health' }); assert.equal(health.status, 200); assert.deepEqual(health.data, { ok: true, host: 'mac' });
  const shell = await request(gateway, { route: '/' }); assert.equal(shell.status, 200);
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(shell.headers['x-content-type-options'], 'nosniff');
  for (const headers of [{}, { Authorization: 'Bearer wrong-test-key' }, { Cookie: 'cmc_session=unknown-test-session' }]) {
    assert.equal((await request(gateway, { headers })).status, 401);
    assert.equal((await request(gateway, { route: '/api/action', method: 'POST', headers, body: { host: 'mac' } })).status, 401);
  }
  const allowed = await request(gateway, { headers: auth }); assert.equal(allowed.status, 200); assert.equal(allowed.data.hosts[0].id, 'mac');
  assert.equal(f.calls.discover, 0);
});

test('pairing validates the token, sets restricted cookies and persists only a hash of the session', async (t) => {
  const f = await rig(t), gateway = await f.start(), sessionsFile = path.join(f.dir, 'sessions.json');
  assert.equal((await request(gateway, { route: '/api/pair', method: 'POST', body: { token: 'invalid-test-token' } })).status, 401);
  assert.equal(fs.existsSync(sessionsFile), false);
  const paired = await pair(gateway);
  assert.match(paired.full, /HttpOnly/); assert.match(paired.full, /SameSite=Strict/); assert.match(paired.full, /Path=\//); assert.match(paired.full, /Max-Age=2592000/);
  assert.equal(paired.full.includes('; Secure'), false, 'loopback HTTP fixture is allowed for local setup');
  assert.deepEqual(paired.result.data, { paired: true });
  const records = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  assert.equal(records.length, 1); assert.equal(records[0][0], hash(paired.value));
  assert.ok(records[0][1] > Date.now() + 29 * 86400000);
  assert.ok(!fs.readFileSync(sessionsFile, 'utf8').includes(paired.value)); assert.ok(!fs.readFileSync(sessionsFile, 'utf8').includes(selfKey));
  if (process.platform !== 'win32') assert.equal(fs.statSync(sessionsFile).mode & 0o777, 0o600);
  assert.equal((await request(gateway, { headers: { Cookie: paired.cookie } })).status, 200);
  assert.equal(f.calls.discover, 0);
});

test('Tailscale HTTPS entry cookies are Secure and the same browser pairing survives gateway restart', async (t) => {
  const f = await rig(t), first = await f.start();
  const paired = await pair(first, { Host: 'mac-fixture.tailfixture.ts.net', Origin: 'https://mac-fixture.tailfixture.ts.net' });
  assert.match(paired.full, /; Secure(?:;|$)/);
  await f.close(first); const restarted = await f.start();
  assert.equal((await request(restarted, { headers: { Cookie: paired.cookie } })).status, 200);
  assert.equal((await request(restarted, { headers: auth })).status, 200);
  assert.equal(f.calls.discover, 0);
});

test('expired persisted sessions fail authentication without resetting the saved pairing file', async (t) => {
  const f = await rig(t), file = path.join(f.dir, 'sessions.json');
  writePrivate(file, [[hash('expired-test-session'), Date.now() - 1000]]); const before = fs.readFileSync(file);
  const gateway = await f.start();
  assert.equal((await request(gateway, { headers: { Cookie: 'cmc_session=expired-test-session' } })).status, 401);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('unreadable pairing data fails closed and never overwrites the existing file', async (t) => {
  const f = await rig(t), file = path.join(f.dir, 'sessions.json'); fs.writeFileSync(file, '{broken fixture');
  await assert.rejects(f.start(), /手机登录状态不可读/); assert.equal(fs.readFileSync(file, 'utf8'), '{broken fixture');
  fs.writeFileSync(file, '{}'); await assert.rejects(f.start(), /手机登录状态格式异常/); assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('cross-site Origin headers cannot pair, read or submit even with the correct bearer', async (t) => {
  const f = await rig(t), gateway = await f.start();
  for (const origin of ['https://attacker.example', 'null', 'file:///tmp/page', 'not-an-origin']) {
    const headers = { ...auth, Origin: origin };
    assert.equal((await request(gateway, { headers })).status, 403);
    assert.equal((await request(gateway, { route: '/api/pair', method: 'POST', headers, body: { token: selfKey } })).status, 403);
    assert.equal((await request(gateway, { route: '/api/action', method: 'POST', headers, body: { host: 'mac' } })).status, 403);
  }
  assert.equal((await request(gateway, { headers: { ...auth, Origin: 'http://127.0.0.1:' + gateway.port } })).status, 200);
  assert.equal(fs.existsSync(path.join(f.dir, 'sessions.json')), false); assert.equal(f.calls.discover, 0);
});

test('untrusted Host headers are rejected before routing or native discovery', async (t) => {
  const f = await rig(t), gateway = await f.start();
  for (const host of ['attacker.example', '127.0.0.1.attacker.example', 'mac.ts.net.attacker.example', '192.0.2.10']) {
    assert.equal((await request(gateway, { route: '/health', headers: { Host: host } })).status, 403);
    assert.equal((await request(gateway, { headers: { ...auth, Host: host } })).status, 403);
  }
  assert.equal((await request(gateway, { headers: { ...auth, Host: 'localhost:' + gateway.port, Origin: 'http://localhost:' + gateway.port } })).status, 200);
  assert.equal(f.calls.discover, 0);
});

test('peer forwarding accepts only a configured HTTPS ts.net origin and blocks forwarding loops', async (t) => {
  let fetches = 0; t.mock.method(globalThis, 'fetch', async () => { fetches++; throw Error('Unexpected external request'); });
  const f = await rig(t, { peers: [{ id: 'windows', name: 'Windows fixture', url: 'https://windows-fixture.tailfixture.ts.net' }] }), gateway = await f.start();
  assert.equal((await request(gateway, { route: '/api/threads?host=unconfigured', headers: auth })).status, 400);
  assert.equal((await request(gateway, { route: '/api/threads?host=windows', headers: { ...auth, 'X-Cmc-Forwarded': '1' } })).status, 400);
  const invalid = ['http://windows-fixture.ts.net', 'https://windows-fixture.ts.net.attacker.example', 'https://user@windows-fixture.ts.net', 'https://windows-fixture.ts.net/private', 'https://windows-fixture.ts.net?secret=fixture', 'https://windows-fixture.ts.net:444'];
  for (const url of invalid) {
    const bad = await f.start({ peers: [{ id: 'windows', name: 'Windows fixture', url }] });
    assert.equal((await request(bad, { route: '/api/threads?host=windows', headers: auth })).status, 400);
  }
  assert.equal(fetches, 0); assert.equal(f.calls.discover, 0);
});

test('a peer must have its own paired key; authenticated proxies strip browser credentials', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options }); return new Response(JSON.stringify({ fixture: 'peer-result' }), { headers: { 'content-type': 'application/json' } });
  });
  const peers = [{ id: 'windows', name: 'Windows fixture', url: 'https://windows-fixture.tailfixture.ts.net' }];
  const missing = await rig(t, { peers, peerPaired: false }), missingGateway = await missing.start();
  assert.equal((await request(missingGateway, { route: '/api/threads?host=windows', headers: auth })).status, 400); assert.equal(calls.length, 0);
  const f = await rig(t, { peers }), gateway = await f.start(), paired = await pair(gateway);
  const result = await request(gateway, { route: '/api/action', method: 'POST', headers: { Cookie: paired.cookie }, body: { host: 'windows', action: 'interrupt', threadId } });
  assert.equal(result.status, 200); assert.deepEqual(result.data, { fixture: 'peer-result' }); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://windows-fixture.tailfixture.ts.net/api/action');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + peerKey); assert.equal(calls[0].options.headers['X-Cmc-Forwarded'], '1');
  assert.equal(calls[0].options.headers.Cookie, undefined); assert.equal(JSON.stringify(calls[0].options.headers).includes(paired.value), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), { host: 'windows', action: 'interrupt', threadId }); assert.equal(f.calls.discover, 0);
});

test('persisted duplicate operation IDs return their receipt after restart without contacting an owner', async (t) => {
  const f = await rig(t), input = { host: 'mac', threadId, operationId: 'test-operation-restart', action: 'send', text: 'synthetic message body', connectionId: 'fixture:owner', ownerId: 'owner', activeTurnId: null };
  const apiFingerprint = requestFingerprint({ host: 'mac', id: threadId, action: 'send', text: input.text, requestId: undefined, answers: undefined, choice: undefined });
  const journal = new Journal(f.dir); journal.save({ operationId: input.operationId, status: 'dispatched', apiFingerprint, threadId, owner: 'fixture-owner' });
  const first = await f.start(), before = fs.readFileSync(journal.file);
  const duplicate = await request(first, { route: '/api/action', method: 'POST', headers: auth, body: input });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.data.status, 'unknown'); assert.equal(duplicate.data.deduplicated, true);
  await f.close(first); const restarted = await f.start();
  const again = await request(restarted, { route: '/api/action', method: 'POST', headers: auth, body: input }); assert.equal(again.data.deduplicated, true);
  const changed = await request(restarted, { route: '/api/action', method: 'POST', headers: auth, body: { ...input, text: 'different synthetic body' } });
  assert.equal(changed.status, 200); assert.equal(changed.data.status, 'rejected'); assert.match(changed.data.message, /不同内容/);
  assert.equal(f.calls.discover, 0); assert.deepEqual(fs.readFileSync(journal.file), before);
});

test('discovery failure before dispatch is safely rejected and an explicit retry never becomes unknown', async (t) => {
  const f = await rig(t), gateway = await f.start();
  const input = { host: 'mac', threadId, operationId: 'test-operation-not-dispatched', action: 'send', text: 'synthetic retryable message',
    connectionId: 'fixture:owner', ownerId: 'fixture-owner', activeTurnId: null };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await request(gateway, { route: '/api/action', method: 'POST', headers: auth, body: input });
    assert.equal(result.status, 200); assert.equal(result.data.status, 'rejected');
    assert.match(result.data.message, /native desktop discovery is forbidden/);
    assert.notEqual(result.data.status, 'unknown'); assert.equal(result.data.deduplicated, undefined);
    assert.equal(f.calls.discover, attempt, 'the failed connection is not cached as an in-flight dispatch');
    assert.equal(new Journal(f.dir).records.size, 0, 'a failed discovery cannot produce a dispatch receipt');
  }
});

test('only submitted receipts map to confirmed; dispatched and unknown receipts stay unknown after restart', async (t) => {
  const f = await rig(t), journal = new Journal(f.dir), operations = [];
  for (const status of ['submitted', 'dispatched', 'unknown']) {
    const input = { host: 'mac', threadId, operationId: 'test-receipt-' + status, action: 'send', text: 'synthetic ' + status };
    const apiFingerprint = requestFingerprint({ host: 'mac', id: threadId, action: 'send', text: input.text, requestId: undefined, answers: undefined, choice: undefined });
    journal.save({ operationId: input.operationId, status, apiFingerprint, threadId });
    operations.push({ input, expected: status === 'submitted' ? 'confirmed' : 'unknown' });
  }
  let gateway = await f.start();
  for (let generation = 0; generation < 2; generation++) {
    for (const { input, expected } of operations) {
      const result = await request(gateway, { route: '/api/action', method: 'POST', headers: auth, body: input });
      assert.equal(result.status, 200); assert.equal(result.data.status, expected); assert.equal(result.data.deduplicated, true);
    }
    if (!generation) { await f.close(gateway); gateway = await f.start(); }
  }
  assert.equal(f.calls.discover, 0);
  assert.deepEqual([...new Journal(f.dir).records.values()].map((record) => record.status), ['submitted', 'dispatched', 'unknown'], 'API labels must not rewrite durable native receipts');
});

test('journal persistence strips private payloads and keeps deduplication fences across status updates', async (t) => {
  const f = await rig(t), journal = new Journal(f.dir), operationId = 'test-operation-metadata';
  journal.save({ operationId, status: 'dispatched', semanticFence: 'semantic-fingerprint', apiFingerprint: 'api-fingerprint', threadId,
    text: 'private synthetic text', token: 'private synthetic key', answers: { q: ['private answer'] }, command: 'private command' });
  journal.save({ operationId, status: 'unknown' });
  const restarted = new Journal(f.dir), record = restarted.records.get(operationId);
  assert.deepEqual(record, { operationId, status: 'unknown', semanticFence: 'semantic-fingerprint', apiFingerprint: 'api-fingerprint' });
  assert.doesNotMatch(fs.readFileSync(journal.file, 'utf8'), /private|answers|command|token/);
});

test('a failed durable journal write never publishes an in-memory receipt', async (t) => {
  const f = await rig(t), journal = new Journal(f.dir); fs.mkdirSync(journal.file);
  assert.throws(() => journal.save({ operationId: 'test-operation-unwritable', status: 'dispatched' }));
  assert.equal(journal.records.has('test-operation-unwritable'), false);
});

test('remote SSE client disconnect cancels upstream and leaves gateway health available', async (t) => {
  const aborted = deferred();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    signal.addEventListener('abort', aborted.resolve, { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': fixture ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const f = await rig(t, { peers: [{ id: 'windows', name: 'Windows fixture', url: 'https://windows-fixture.tailfixture.ts.net' }] }), gateway = await f.start();
  const stream = openPeerStream(gateway); t.after(() => stream.cancel()); assert.equal((await within(stream.ready, 'SSE fixture did not start')).status, 200);
  stream.cancel(); await within(aborted.promise, 'SSE upstream was not cancelled after client disconnect');
  assert.equal((await request(gateway, { route: '/health' })).status, 200); assert.equal(f.calls.discover, 0);
});

test('local SSE disconnect during first discovery releases heartbeat and recovery subscriptions', async (t) => {
  const discoveryStarted = deferred(), discoveryGate = deferred(), catalogRead = deferred(), responseClosed = deferred();
  const intervals = new Map(), nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    if (![5000, 15000].includes(delay)) return nativeSetInterval(callback, delay, ...args);
    const timer = { delay, run: () => callback(...args), unref() { return this; } };
    intervals.set(timer, timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => { if (!intervals.delete(timer)) nativeClearInterval(timer); });
  // A delayed failed discovery falls back to history. Keep that read isolated
  // instead of scanning the developer's real Codex home during this race test.
  t.mock.method(ThreadCatalog.prototype, 'list', async () => []);
  t.mock.method(ThreadCatalog.prototype, 'read', async () => { catalogRead.resolve(); return { messages: [], source: 'local-history' }; });
  const f = await rig(t); let discoveries = 0;
  const gateway = await f.start({ discover: async () => {
    discoveries++; discoveryStarted.resolve(); await discoveryGate.promise;
    throw Error('Synthetic first-discovery failure after the phone disconnected');
  } });
  gateway.server.on('request', (req, res) => { if (req.url.startsWith('/api/events')) res.once('close', responseClosed.resolve); });
  const req = http.get({ host: '127.0.0.1', port: gateway.port, path: '/api/events?host=mac&id=' + threadId, headers: auth });
  req.on('error', () => {}); t.after(() => { discoveryGate.resolve(); req.destroy(); });
  await within(discoveryStarted.promise, 'Local SSE did not enter its first discovery'); assert.equal(discoveries, 1);
  req.destroy(); await within(responseClosed.promise, 'Server did not observe the early phone disconnect');
  assert.equal([...intervals.values()].filter((timer) => timer.delay === 15000).length, 0, 'the disconnected stream must release its heartbeat before discovery finishes');
  assert.equal((await request(gateway, { route: '/health' })).status, 200, 'a pending discovery cannot block health');
  discoveryGate.resolve(); await within(catalogRead.promise, 'Delayed first push did not finish its isolated fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const recovery = [...intervals.values()].find((timer) => timer.delay === 5000); assert.ok(recovery);
  for (let tick = 0; tick < 3; tick++) await recovery.run();
  assert.equal(discoveries, 1, 'a disconnected subscriber must not keep retrying desktop discovery');
  assert.equal([...intervals.values()].filter((timer) => timer.delay === 15000).length, 0, 'a late first push must not recreate the heartbeat');
  assert.equal((await request(gateway, { route: '/health' })).status, 200);
  await f.close(gateway); assert.equal(intervals.size, 0, 'closing the isolated gateway releases its remaining recovery timer');
});

test('an upstream Readable error ends only that SSE response, not the gateway process', async (t) => {
  let upstream;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { upstream = controller; controller.enqueue(new TextEncoder().encode(': fixture ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }));
  const f = await rig(t, { peers: [{ id: 'windows', name: 'Windows fixture', url: 'https://windows-fixture.tailfixture.ts.net' }] }), gateway = await f.start();
  const stream = openPeerStream(gateway); t.after(() => stream.cancel()); assert.equal((await within(stream.ready, 'SSE fixture did not start')).status, 200);
  upstream.error(Error('synthetic upstream Readable failure'));
  await within(stream.closed, 'Failed upstream SSE response did not close');
  assert.equal((await request(gateway, { route: '/health' })).status, 200); assert.equal(f.calls.discover, 0);
});

test('idle SSE sends a JavaScript-visible ping so the phone can detect a stalled stream', async (t) => {
  const timers = new Map(); let next = 1;
  t.mock.method(globalThis, 'setInterval', (run, delay) => { const id = next++; timers.set(id, { run, delay }); return { id, unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', (handle) => timers.delete(handle?.id));
  t.mock.method(ThreadCatalog.prototype, 'list', async () => []);
  t.mock.method(ThreadCatalog.prototype, 'read', async () => ({ messages: [] }));
  const f = await rig(t), gateway = await f.start(), ready = deferred(), ping = deferred(), serverClosed = deferred();
  gateway.server.on('request', (_req, res) => res.once('close', serverClosed.resolve));
  let response, text = '';
  const req = http.get({ host: '127.0.0.1', port: gateway.port, path: '/api/events?host=mac&id=' + threadId, headers: auth }, res => {
    response = res; res.on('error', () => {});
    res.on('data', bytes => { text += bytes; if (text.includes('event: state\n')) ready.resolve(); if (text.includes('event: ping\ndata: {}\n\n')) ping.resolve(); });
  });
  req.on('error', () => {}); t.after(() => { response?.destroy(); req.destroy(); });
  await within(ready.promise, 'initial isolated state did not arrive');
  const heartbeat = [...timers.values()].find(timer => timer.delay === 15000); assert.ok(heartbeat);
  heartbeat.run(); await within(ping.promise, 'JavaScript-visible heartbeat did not arrive');
  assert.equal(f.calls.discover, 1, 'heartbeat must not trigger another owner read');
  response.destroy(); req.destroy(); await within(serverClosed.promise, 'SSE close did not settle'); await f.close(gateway); assert.equal(timers.size, 0);
});

test('cold load deadline also bounds desktop discovery before navigation', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const { gateway, control } = await ownerRig(t, { discover: async () => { await gate.promise; throw Error('fixture discovery stopped'); } });
  const timers = [], nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (run, delay, ...args) => {
    const timer = nativeTimeout(run, delay, ...args); timers.push({ run, delay }); return timer;
  });
  const pending = gateway.action({ host: 'mac', threadId, operationId: 'load-discovery-deadline', action: 'load' });
  const outcome = assert.rejects(pending, /连接原聊天超时/);
  await new Promise(resolve => setImmediate(resolve));
  const deadline = timers.find(timer => timer.delay === 45000);
  assert.ok(deadline, 'one 45s deadline covers preflight as well as navigation and restore');
  deadline.run(); await outcome;
  assert.deepEqual(control.opens, []); assert.equal(control.mutations, 0);
});

test('cold load uses the real owner stream through resume patches and concurrent HTTP reads', async t => {
  const f = await rig(t), identity = syntheticIdentity(f.dir), pipe = new EventEmitter();
  const opened = deferred(), navigate = deferred(), firstSnapshot = deferred();
  const control = { navigations: 0, follows: 0, mutations: 0, navigated: false, revision: 1 };
  let state = { id: threadId, title: 'Wire fixture', resumeState: 'resuming', threadRuntimeStatus: { type: 'idle' }, turns: [], requests: [] };
  const frame = change => pipe.emit('frame', { type: 'broadcast', method: OWNER_METHODS.stream, version: 11,
    sourceClientId: 'wire-owner', params: { hostId: 'local', conversationId: threadId, change } });
  pipe.socket = { destroyed: false };
  pipe.close = () => { pipe.socket.destroyed = true; pipe.emit('disconnected'); };
  pipe.request = async method => {
    if (method !== OWNER_METHODS.owner) { control.mutations++; throw Error('Task write forbidden'); }
    if (!control.navigated) throw Error('no-client-found');
    return { type: 'response', resultType: 'success', method, handledByClientId: 'wire-owner', result: { supportsUntrustedAppInput: true } };
  };
  pipe.broadcast = (method, params) => {
    if (params.following) {
      control.follows++;
      frame({ type: 'snapshot', revision: control.revision, conversationState: state }); firstSnapshot.resolve();
    }
  };
  t.mock.method(OwnerClient.prototype, 'connect', async function () {
    this.connected = true; this.generation++; this.identity = identity; this.abort = new AbortController(); this.pipe = pipe;
    const generation = this.generation;
    pipe.on('frame', value => this.receive(value, pipe, generation));
    pipe.on('disconnected', () => this.invalidate(pipe, generation, 'fixture disconnect'));
    return identity;
  });
  const gateway = await f.start({ discover: async () => identity,
    catalog: { get: async () => ({ id: threadId, title: 'Wire fixture' }), read: async () => ({ messages: [] }) },
    nativeTools: { openExistingThread: async () => { control.navigations++; opened.resolve(); await navigate.promise; control.navigated = true; } } });
  const pending = request(gateway, { route: '/api/action', method: 'POST', headers: auth,
    body: { host: 'mac', threadId, action: 'load', operationId: 'wire-cold-load' } });
  await within(opened.promise, 'navigation did not start'); navigate.resolve();
  await within(firstSnapshot.promise, 'initial resume snapshot did not arrive');
  const before = await gateway.state(threadId);
  assert.equal(before.connected, false); assert.equal(before.ownerConfirmed, false); assert.equal(before.capabilities.send, false);
  const concurrent = gateway.state(threadId, { refresh: true });
  await new Promise(resolve => setImmediate(resolve));
  state = { ...state, resumeState: 'resumed' }; control.revision = 2;
  frame({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['resumeState'], value: 'resumed' }] });
  const [loaded, read] = await Promise.all([pending, concurrent]);
  assert.equal(loaded.data.status, 'confirmed'); assert.equal(loaded.data.state.connected, true);
  assert.equal(read.connected, true); assert.equal(read.ownerConfirmed, true); assert.equal(read.capabilities.send, true);
  assert.equal(control.navigations, 1); assert.equal(control.follows, 1); assert.equal(control.mutations, 0);
  assert.equal(new Journal(f.dir).records.size, 0);
});

test('paired cold loads have transport headroom while message timeouts stay unchanged', async t => {
  const calls = rawPeerResponse(t, () => ({ bytes: Buffer.from('{"status":"confirmed"}'), headers: { 'content-type': 'application/json' } }));
  const f = await rig(t, { peers: [{ id: 'windows', url: 'https://windows-fixture.tailfixture.ts.net', address: '100.64.23.45' }] }), gateway = await f.start();
  const delays = [], nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (run, delay, ...args) => { delays.push(delay); return nativeTimeout(run, delay, ...args); });
  for (const action of ['load', 'send']) {
    const result = await request(gateway, { route: '/api/action', method: 'POST', headers: auth,
      body: { host: 'windows', threadId, operationId: 'peer-budget-' + action, action } });
    assert.equal(result.data.status, 'confirmed');
  }
  assert.deepEqual(delays, [55000, 20000]); assert.equal(calls.length, 2);
});

test('history GET identifies a known unloaded chat without navigating or enabling any task action', async t => {
  const { gateway, control } = await ownerRig(t);
  const first = await request(gateway, { route: '/api/thread?id=' + threadId, headers: auth });
  assert.equal(first.data.connectionState, 'needs-load'); assert.equal(first.data.canLoad, true);
  assert.equal(first.data.connected, false); assert.equal(first.data.source, 'local-history-only');
  assert.ok(Object.values(first.data.capabilities).every(value => value === false));
  assert.deepEqual(control.opens, []); assert.equal(control.mutations, 0);
  control.exists = false;
  const missing = await gateway.state(threadId, { refresh: true });
  assert.equal(missing.connectionState, 'unavailable'); assert.equal(missing.canLoad, false);
  control.exists = true; control.ready = true;
  const live = await gateway.state(threadId, { refresh: true });
  assert.equal(live.connectionState, 'ready'); assert.equal(live.canLoad, false); assert.equal(live.capabilities.send, true);
});

const failedTurnId = '22222222-2222-4222-8222-222222222222';
function failedRuntime(control) {
  control.ready = true; control.runtimeType = 'systemError';
  control.turns = [{ turnId: failedTurnId, status: 'failed', turnStartedAtMs: 1000,
    error: { message: 'You have hit your usage limit. Try again later.' }, items: [] }];
}

test('a resumed system error stays connected and exposes retry instead of asking to load again', async t => {
  const { gateway, control } = await ownerRig(t); failedRuntime(control);
  const view = await gateway.state(threadId, { refresh: true });
  assert.equal(view.connectionState, 'runtime-error');
  assert.equal(view.connected, true); assert.equal(view.ownerConfirmed, true);
  assert.equal(view.canLoad, false); assert.equal(view.status, 'error');
  assert.equal(view.runtimeError.failedTurnId, failedTurnId);
  assert.match(view.runtimeError.message, /usage limit/);
  assert.equal(view.capabilities.retry, true);
  for (const capability of ['send', 'steer', 'answer', 'approve', 'interrupt']) assert.equal(view.capabilities[capability], false);
  assert.equal(control.opens.length, 0); assert.equal(control.mutations, 0);
});

test('a resumed system error with an unconfirmed submission keeps reads but cannot retry', async t => {
  const { gateway, control } = await ownerRig(t); failedRuntime(control);
  control.unconfirmedTurnSubmissions = [{ id: 'unconfirmed-existing-submission' }];
  const view = await gateway.state(threadId, { refresh: true });
  assert.equal(view.connectionState, 'runtime-error'); assert.equal(view.canLoad, false);
  assert.equal(view.capabilities.retry, false); assert.equal(view.connected, true);
});

test('a stale load button cannot navigate a resumed system-error chat again', async t => {
  const { gateway, control } = await ownerRig(t, { loadTimeoutMs: 30 }); failedRuntime(control);
  await gateway.state(threadId, { refresh: true });
  const result = await gateway.action({ threadId, operationId: 'stale-system-error-load', action: 'load' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.state.connectionState, 'runtime-error');
  assert.equal(result.state.canLoad, false); assert.equal(control.opens.length, 0);
});

async function retryPayload(gateway, operationId) {
  const view = await gateway.state(threadId, { refresh: true });
  return { threadId, host: 'mac', operationId, action: 'retry', connectionId: view.connectionId,
    ownerId: view.ownerId, revision: view.revision, activeTurnId: null, failedTurnId };
}

test('failed-turn retry is explicit, carries its exact identity and does not consume a draft', async t => {
  const { gateway, control } = await ownerRig(t); failedRuntime(control); control.retryOutcome = 'submitted';
  const payload = await retryPayload(gateway, 'explicit-failed-turn-retry');
  const result = await gateway.action(payload);
  assert.equal(result.status, 'confirmed'); assert.equal(control.retries.length, 1);
  assert.deepEqual(control.retries[0].options, { operationId: payload.operationId, expectedOwner: payload.ownerId,
    expectedGeneration: control.owner.generation, expectedFailedTurnId: failedTurnId });
  const repeated = await gateway.action(payload); assert.equal(repeated.deduplicated, true);
  assert.equal(control.retries.length, 1);
  await assert.rejects(gateway.action({ ...payload, failedTurnId: '33333333-3333-4333-8333-333333333333' }), /不同内容/);
  assert.equal(control.retries.length, 1);
});

test('failed-turn retry rejects stale failure, ordinary draft fields and unresolved native submissions before dispatch', async t => {
  const { gateway, control } = await ownerRig(t); failedRuntime(control); control.retryOutcome = 'submitted';
  const payload = await retryPayload(gateway, 'rejected-failed-turn-retry');
  await assert.rejects(gateway.action({ ...payload, text: 'unsent local draft' }), /草稿/);
  await assert.rejects(gateway.action({ ...payload, failedTurnId: 'stale-failed-turn' }), /轮次/);
  control.unconfirmedTurnSubmissions = [{}];
  await assert.rejects(gateway.action(payload), /轮次/);
  assert.equal(control.mutations, 0);
});

test('failed-turn retry fences concurrent new operation IDs and retains unknown after gateway restart', async t => {
  const f = await ownerRig(t); const { gateway, control } = f; failedRuntime(control); control.retryOutcome = 'unknown';
  control.retryGate = deferred(); control.retryStarted = deferred();
  const payload = await retryPayload(gateway, 'unknown-failed-turn-retry');
  const first = gateway.action(payload); await control.retryStarted.promise;
  await assert.rejects(gateway.action({ ...payload, operationId: 'concurrent-failed-turn-retry' }), /已请求重试/);
  assert.equal(control.retries.length, 1);
  control.retryGate.resolve(); assert.equal((await first).status, 'unknown');
  const restarted = await f.start({ discover: async () => syntheticIdentity(f.dir) });
  // The persisted failure fence blocks even a new client operation ID. No
  // re-dispatch is permitted just because the HTTP server was restarted.
  await assert.rejects(restarted.action({ ...payload, operationId: 'after-restart-failed-turn-retry' }), /已请求重试/);
  assert.equal(control.retries.length, 1);
  control.turns = [{ turnId: '44444444-4444-4444-8444-444444444444', status: 'failed', turnStartedAtMs: 2000, items: [] }];
  const next = await gateway.state(threadId, { refresh: true });
  const nextResult = await gateway.action({ ...payload, operationId: 'new-failure-explicit-retry', failedTurnId: next.runtimeError.failedTurnId });
  assert.equal(nextResult.status, 'unknown'); assert.equal(control.retries.length, 2);
});

test('offline or unverified desktop cannot offer loading even when its local catalog contains the chat', async t => {
  const f = await rig(t), catalog = { get: async () => ({ id: threadId, title: 'Existing' }), read: async () => ({ messages: [] }) };
  const gateway = await f.start({ catalog });
  const view = await gateway.state(threadId);
  assert.equal(view.connectionState, 'unavailable'); assert.equal(view.canLoad, false);
});

test('a protocol change cannot be mislabelled as an unloaded chat', async t => {
  const { gateway, control } = await ownerRig(t);
  control.readError = Object.assign(Error('Unverified stream version'), { code: 'UNSUPPORTED_METHOD' });
  const state = await gateway.state(threadId, { refresh: true });
  assert.equal(state.connectionState, 'incompatible'); assert.equal(state.canLoad, false);
  assert.equal(state.connected, false); assert.equal(state.error, 'UNSUPPORTED_METHOD');
  assert.ok(Object.values(state.capabilities).every(value => value === false));
  assert.equal(control.opens.length, 0); assert.equal(control.mutations, 0);
});

test('an owner snapshot can preserve visible messages while unloaded or unconfirmed state still requires explicit loading', async t => {
  const { gateway, control } = await ownerRig(t); control.ready = true;
  control.turns = [{ turnId: 'existing-completed-turn', status: 'completed', items: [
    { id: 'existing-assistant', type: 'agentMessage', text: 'Owner history stays visible before resume' },
  ] }];
  for (const [runtimeType, resumeState, omitResumeState] of [
    ['notLoaded', 'resumed', false], ['unknown', 'resumed', false],
    ['idle', 'needs_resume', false], ['idle', 'resuming', false], ['idle', 'resumed', true],
  ]) {
    Object.assign(control, { runtimeType, resumeState, omitResumeState });
    const result = await request(gateway, { route: '/api/thread?id=' + threadId, headers: auth });
    assert.equal(result.data.connectionState, 'needs-load', runtimeType + ':' + resumeState);
    assert.equal(result.data.canLoad, true); assert.equal(result.data.connected, false); assert.equal(result.data.ownerConfirmed, false);
    assert.equal(result.data.connectionId, null); assert.equal(result.data.ownerId, null);
    assert.equal(result.data.messages[0].text, 'Owner history stays visible before resume');
    assert.ok(Object.values(result.data.capabilities).every(value => value === false));
  }
  control.exists = false;
  const unavailable = await gateway.state(threadId, { refresh: true });
  assert.equal(unavailable.connectionState, 'unavailable'); assert.equal(unavailable.canLoad, false);
  assert.equal(unavailable.messages[0].text, 'Owner history stays visible before resume');
  assert.deepEqual(control.opens, []); assert.equal(control.mutations, 0);
});

test('navigation plus a residual idle snapshot cannot confirm loading while resume is still pending', async t => {
  const { gateway, control } = await ownerRig(t, { loadTimeoutMs: 25 });
  control.ready = true; control.resumeState = 'resuming';
  const result = await gateway.action({ host: 'mac', threadId, operationId: 'load-resume-not-finished', action: 'load' });
  assert.equal(result.status, 'rejected'); assert.equal(result.state.connectionState, 'needs-load');
  assert.equal(result.state.connected, false); assert.equal(result.state.capabilities.send, false);
  assert.deepEqual(control.opens, [threadId]); assert.equal(control.mutations, 0);
});

test('explicit loads merge navigation and require a fresh owner snapshot before becoming confirmed', async t => {
  const { gateway, control } = await ownerRig(t);
  control.openStarted = deferred(); control.openGate = deferred(); control.readStarted = deferred(); control.readGate = deferred();
  const input = { host: 'mac', threadId, action: 'load' };
  let settled = false;
  const first = request(gateway, { route: '/api/action', method: 'POST', headers: auth,
    body: { ...input, operationId: 'explicit-load-first' } }).then(value => { settled = true; return value; });
  await within(control.openStarted.promise, 'Explicit load did not invoke the navigation adapter');
  const secondStarted = deferred(); gateway.server.once('request', secondStarted.resolve);
  const second = request(gateway, { route: '/api/action', method: 'POST', headers: auth,
    body: { ...input, operationId: 'explicit-load-second' } });
  await within(secondStarted.promise, 'Second load did not reach the gateway');
  await new Promise(resolve => setImmediate(resolve)); control.openGate.resolve();
  await within(control.readStarted.promise, 'Navigation ACK did not start a fresh owner read');
  assert.equal(settled, false, 'navigation ACK alone cannot confirm readiness');
  control.ready = true; control.readGate.resolve();
  const responses = await Promise.all([first, second]);
  for (const response of responses) {
    assert.equal(response.data.status, 'confirmed'); assert.equal(response.data.state.connectionState, 'ready');
    assert.equal(response.data.state.ownerConfirmed, true); assert.equal(response.data.state.capabilities.send, true);
  }
  assert.deepEqual(control.opens, [threadId]); assert.equal(control.mutations, 0);
});

test('load rejects a non-catalog ID and a navigation ACK without a confirmed runtime never enables sending', async t => {
  const { gateway, control } = await ownerRig(t, { loadTimeoutMs: 25 });
  const missingId = '22222222-2222-4222-8222-222222222222';
  const missing = await request(gateway, { route: '/api/action', method: 'POST', headers: auth,
    body: { host: 'mac', threadId: missingId, operationId: 'load-missing-chat', action: 'load' } });
  assert.equal(missing.data.status, 'rejected'); assert.deepEqual(control.opens, []);
  const pending = await request(gateway, { route: '/api/action', method: 'POST', headers: auth,
    body: { host: 'mac', threadId, operationId: 'load-without-owner', action: 'load' } });
  assert.equal(pending.data.status, 'rejected'); assert.equal(pending.data.state.connected, false);
  assert.equal(pending.data.state.connectionState, 'needs-load');
  assert.deepEqual(control.opens, [threadId]); assert.equal(control.mutations, 0);
});

test('refresh-generated unknown events cannot make an unloaded SSE repeatedly refresh itself', async t => {
  const { gateway, control } = await ownerRig(t), stream = localStream(gateway); t.after(() => stream.cancel());
  await within(stream.ready, 'Initial history-only SSE state did not arrive');
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(control.reads, 1, 'an internal refresh is not a new external invalidation');
  assert.deepEqual(control.opens, []); assert.equal(control.mutations, 0);
  stream.cancel(); await within(stream.closed, 'SSE cleanup did not finish');
});

test('closing the last SSE cannot cancel an in-flight fresh GET for the same chat', async t => {
  const { gateway, control } = await ownerRig(t); control.ready = true;
  const stream = localStream(gateway); t.after(() => stream.cancel()); await within(stream.ready, 'Initial live SSE did not arrive');
  control.readStarted = deferred(); control.readGate = deferred();
  t.after(() => control.readGate.resolve());
  const pending = request(gateway, { route: '/api/thread?id=' + threadId, headers: auth });
  await within(control.readStarted.promise, 'Fresh GET did not start'); stream.cancel();
  await within(stream.closed, 'Server did not observe the SSE close');
  assert.equal(control.unfollows, 0, 'the fresh GET still owns a follower reference');
  control.readGate.resolve(); const result = await pending;
  assert.equal(result.data.connected, true); assert.equal(result.data.connectionState, 'ready');
});

test('closing the last SSE cannot cancel an explicitly requested load while navigation is pending', async t => {
  const { gateway, control } = await ownerRig(t), stream = localStream(gateway); t.after(() => stream.cancel());
  await within(stream.ready, 'Initial history SSE did not arrive');
  control.openStarted = deferred(); control.openGate = deferred();
  const pending = request(gateway, { route: '/api/action', method: 'POST', headers: auth,
    body: { host: 'mac', threadId, operationId: 'load-during-stream-close', action: 'load' } });
  await within(control.openStarted.promise, 'Explicit load did not reach navigation'); stream.cancel();
  await within(stream.closed, 'Server did not observe the SSE close'); assert.equal(control.unfollows, 0);
  control.ready = true; control.openGate.resolve();
  const result = await pending; assert.equal(result.data.status, 'confirmed'); assert.equal(control.mutations, 0);
});

test('a timed-out load cancels delayed navigation and never turns a late ACK into readiness', async t => {
  const { gateway, control } = await ownerRig(t, { loadTimeoutMs: 25 });
  control.openGate = deferred(); t.after(() => control.openGate.resolve());
  const result = await gateway.action({ host: 'mac', threadId, operationId: 'load-navigation-timeout', action: 'load' });
  assert.equal(result.status, 'rejected'); assert.equal(result.state.connected, false);
  assert.equal(control.openSignal.aborted, true); assert.deepEqual(control.opens, []);
  control.ready = true; control.openGate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(control.opens, []); assert.equal(control.reads, 0); assert.equal(control.mutations, 0);
});

test('one cancelled load caller leaves the shared navigation available to the remaining caller', async t => {
  const { gateway, control } = await ownerRig(t), abort = new AbortController();
  control.openGate = deferred(); control.openStarted = deferred(); t.after(() => control.openGate.resolve());
  const first = gateway.action({ host: 'mac', threadId, operationId: 'load-cancelled-caller', action: 'load' }, { signal: abort.signal });
  const rejected = assert.rejects(first, /fixture caller departed/);
  await within(control.openStarted.promise, 'First load did not start');
  const second = gateway.action({ host: 'mac', threadId, operationId: 'load-remaining-caller', action: 'load' });
  await new Promise(resolve => setImmediate(resolve)); abort.abort(Error('fixture caller departed')); await rejected;
  assert.equal(control.openSignal.aborted, false);
  control.ready = true; control.openGate.resolve();
  assert.equal((await second).status, 'confirmed'); assert.equal(control.openAttempts, 1);
  assert.deepEqual(control.opens, [threadId]); assert.equal(control.mutations, 0);
});

test('a disconnected load HTTP client cancels pending navigation before the adapter can launch', async t => {
  const { gateway, control } = await ownerRig(t);
  control.openGate = deferred(); control.openStarted = deferred(); t.after(() => control.openGate.resolve());
  const bytes = Buffer.from(JSON.stringify({ host: 'mac', threadId, operationId: 'load-phone-disappeared', action: 'load' }));
  const req = http.request({ host: '127.0.0.1', port: gateway.port, path: '/api/action', method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': bytes.length } });
  req.on('error', () => {}); req.end(bytes); t.after(() => req.destroy());
  await within(control.openStarted.promise, 'HTTP load did not reach its adapter');
  const aborted = deferred(); control.openSignal.addEventListener('abort', aborted.resolve, { once: true });
  req.destroy(); await within(aborted.promise, 'Closed HTTP load did not cancel its delayed navigation');
  control.openGate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(control.opens, []); assert.equal(control.reads, 0); assert.equal(control.mutations, 0);
});

test('a desktop disconnect cancels a pending load without navigating on a replacement connection', async t => {
  const { gateway, control } = await ownerRig(t);
  control.openGate = deferred(); control.openStarted = deferred(); t.after(() => control.openGate.resolve());
  const pending = gateway.action({ host: 'mac', threadId, operationId: 'load-owner-disappeared', action: 'load' });
  await within(control.openStarted.promise, 'Load did not reach its adapter');
  control.owner.invalidate(control.owner.pipe, control.owner.generation, 'fixture owner disconnected');
  const result = await pending;
  assert.equal(result.status, 'rejected'); assert.equal(result.state.connectionState, 'unavailable');
  assert.equal(control.openSignal.aborted, true); control.openGate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(control.opens, []); assert.equal(control.reads, 0); assert.equal(control.mutations, 0);
});

test('closing the last SSE cannot cancel an action while its fresh owner check is pending', async t => {
  const { gateway, control } = await ownerRig(t); control.ready = true;
  const stream = localStream(gateway); t.after(() => stream.cancel()); await within(stream.ready, 'Initial live SSE did not arrive');
  control.readGate = deferred(); control.readStarted = deferred(); t.after(() => control.readGate.resolve());
  const pending = request(gateway, { route: '/api/action', method: 'POST', headers: auth, body: {
    host: 'mac', threadId, operationId: 'action-during-stream-close', action: 'send', text: 'Never dispatched',
    ownerId: 'obsolete-owner', connectionId: 'obsolete-connection', activeTurnId: null,
  } });
  await within(control.readStarted.promise, 'Action did not start its owner check'); stream.cancel();
  await within(stream.closed, 'SSE close did not finish'); assert.equal(control.unfollows, 0);
  control.readGate.resolve(); const result = await pending;
  assert.equal(result.data.status, 'rejected'); assert.match(result.data.message, /状态已变化/); assert.equal(control.mutations, 0);
});
