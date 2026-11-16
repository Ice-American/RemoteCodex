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
import { createGateway } from '../mobile/gateway.mjs';
import { Journal, writePrivate } from '../mobile/store.mjs';
import { requestFingerprint } from '../mobile/requests.mjs';
import { ThreadCatalog } from '../mobile/history.mjs';

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
