// Serves a small phone UI and forwards explicit actions to the existing owner.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { OwnerClient, ownerSnapshotReady } from './owner.mjs';
import { fetchPeer } from './peer.mjs';
import { readOwnerProtocols } from './protocols.mjs';
import { discoverNativeDesktop, codexHome } from './discovery.mjs';
import { ThreadCatalog, visibleTurns, validThreadId } from './history.mjs';
import { questionViews, approvalViews, buildQuestionReply, buildApprovalReply, requestFingerprint } from './requests.mjs';
import { Secrets, Journal, secretEqual, dataDirectory, writePrivate } from './store.mjs';
import { NativeTools } from './native-tools.mjs';
import { CreationManager } from './creation.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const loadError = (message, code) => Object.assign(Error(message), { code });
async function cancellable(promise, signal) {
  if (!signal) return promise;
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
const sendBytes = (res, code, bytes, headers) => {
  const gzip = bytes.length > 512 && /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:,|$))[^,]*)?(?:,|$)/i.test(res.req?.headers['accept-encoding'] ?? '');
  res.writeHead(code, { ...headers, Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gzip ? gzipSync(bytes) : bytes);
};
const sendJson = (res, code, value) => sendBytes(res, code, Buffer.from(JSON.stringify(value)), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
async function body(req) {
  let size = 0; const parts = [];
  for await (const b of req) { if ((size += b.length) > 128 * 1024) throw Error('请求太大'); parts.push(b); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

export async function createGateway({ port = 43128, hostId = process.platform === 'win32' ? 'windows' : 'mac',
  hostName = hostId === 'mac' ? 'Mac' : 'Windows', peers = [], dir = dataDirectory(),
  discover = discoverNativeDesktop, secrets = new Secrets(dir), journal = new Journal(dir),
  catalog = new ThreadCatalog(codexHome()), nativeTools = new NativeTools({ discover }),
  loadTimeoutMs = 45000,
} = {}) {
  const key = await secrets.get('self', { create: true });
  const assets = new Map(await Promise.all((await fs.readdir(publicDir)).filter(name => mime[path.extname(name)]).map(async name => [name, await fs.readFile(path.join(publicDir, name))])));
  const assetVersion = digest(Buffer.concat([...assets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bytes]) => bytes))).slice(0, 16);
  for (const name of ['index.html', 'app.mjs']) {
    let source = assets.get(name).toString('utf8');
    source = source.replace(/\.\/(style\.css|app\.mjs|render\.mjs)/g, './$1?v=' + assetVersion);
    if (name === 'index.html') source = source.replace('</head>', '<meta name="cmc-default-host" content="' + (hostId === 'windows' ? 'windows' : 'mac') + '"><link rel="modulepreload" href="./render.mjs?v=' + assetVersion + '"></head>');
    assets.set(name, Buffer.from(source));
  }
  const sessionsFile = path.join(dir, 'sessions.json');
  let savedSessions = [];
  try { savedSessions = JSON.parse(await fs.readFile(sessionsFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw Error('手机登录状态不可读，未重置现有数据'); }
  if (!Array.isArray(savedSessions)) throw Error('手机登录状态格式异常');
  const sessions = new Map(savedSessions.filter(([hash, expiry]) => /^[a-f0-9]{64}$/.test(hash) && expiry > Date.now()));
  const watches = new Set(), operationContexts = new Map();
  const creation = new CreationManager({ nativeTools, journal, hostId });
  const peerMap = new Map(peers.map(p => [p.id, p]));
  let client = null, connecting = null, identity = null, closed = false;
  const clients = new Set();
  const activeThreads = new Map(), pendingUnfollows = new Set(), loads = new Map();

  function releaseFollower(id) {
    if ([...clients].some(listener => listener.id === id)) return;
    watches.delete(id);
    if (activeThreads.get(id)) { pendingUnfollows.add(id); return; }
    pendingUnfollows.delete(id); client?.unfollow(id);
  }
  function holdThread(id) {
    activeThreads.set(id, (activeThreads.get(id) ?? 0) + 1);
    return () => {
      const remaining = activeThreads.get(id) - 1;
      if (remaining) activeThreads.set(id, remaining); else activeThreads.delete(id);
      // An old stream may close after its replacement GET or explicit action
      // has started. Release only after those users finish with the follower.
      if (!remaining && pendingUnfollows.has(id)) releaseFollower(id);
    };
  }

  async function ensureClient() {
    if (client?.connected) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      client?.close(); identity = await discover();
      const protocols = readOwnerProtocols(identity.asarPath);
      const created = new OwnerClient({ socketPath: identity.socketPath, verifyEndpoint: () => discover({ verifySignature: false }),
        protocolVersions: protocols, timeoutMs: 8000, operations: new Map(journal.records),
        onOperation: r => journal.save({ ...r, ...operationContexts.get(r.operationId) }) });
      created.subscribe(event => {
        // Refreshing already has a read in progress. Re-reading its temporary
        // unknown state would otherwise create an SSE refresh feedback loop.
        if (event.type === 'unknown' && event.refreshing) return;
        if (['snapshot', 'connection', 'unknown'].includes(event.type)) {
          for (const listener of clients) if (!event.threadId || event.threadId === listener.id) listener.schedule();
        }
      });
      await created.connect();
      if (created.identity.fingerprint !== identity.fingerprint) { created.close(); throw Error('官方桌面在连接期间发生变化'); }
      client = created; return created;
    })();
    try { return await connecting; } finally { connecting = null; }
  }
  async function state(id, { refresh = false } = {}) {
    if (!validThreadId(id)) throw Error('无效聊天标识');
    const release = holdThread(id);
    try {
      let live, error = null;
      try { const owner = await ensureClient(); live = refresh || !owner.snapshot(id) ? await owner.freshSnapshot(id) : owner.snapshot(id); }
      catch (e) { error = e.code ?? '暂时无法读取原会话'; }
      return await view(id, live, error);
    } finally { release(); }
  }
  async function view(id, live, error = null, knownMetadata) {
    const ready = ownerSnapshotReady(live) && client?.connected === true && live.generation === client.generation &&
      client.owners.get(id)?.owner === live.owner;
    const metadata = knownMetadata === undefined ? ready && live?.state?.title ? null : await catalog.get(id) : knownMetadata;
    const messages = live ? visibleTurns(live.state) : (await catalog.read(id)).messages;
    const status = live?.status?.type ?? 'unknown';
    const incompatible = error === 'UNSUPPORTED_METHOD';
    const canLoad = !ready && !incompatible && client?.connected === true && !client.pipe?.socket?.destroyed && metadata?.id === id &&
      typeof nativeTools.openExistingThread === 'function';
    return { host: hostId, id, title: live?.state?.title ?? metadata?.title ?? '原聊天', connected: ready,
      connectionState: ready ? 'ready' : incompatible ? 'incompatible' : canLoad ? 'needs-load' : 'unavailable', canLoad: !!canLoad,
      ownerConfirmed: ready, revision: ready ? live.revision : null, connectionId: ready ? String(live.generation) + ':' + live.owner : null,
      ownerId: ready ? live.owner : null, activeTurnId: ready ? live.activeTurnId : null, status, messages,
      questions: ready ? questionViews(live.state) : [], approvals: ready ? approvalViews(live.state) : [],
      capabilities: { send: ready && status === 'idle' && client.supports(id, 'start'),
        steer: ready && status === 'running' && client.supports(id, 'steer'),
        answer: ready && (client.supports(id, 'userInput') || client.supports(id, status === 'idle' ? 'start' : 'steer')),
        approve: ready && ['commandApproval', 'fileApproval', 'permissions', 'mcpElicitation'].some(k => client.supports(id, k)),
        interrupt: ready && status === 'running' && client.supports(id, 'interrupt') },
      source: live ? live.source : 'local-history-only', error };
  }
  async function loadExisting(id, signal) {
    // Cold navigation includes desktop verification and history restoration.
    // Bound the entire request, including discovery, inside the peer/UI budget.
    const deadline = Date.now() + loadTimeoutMs, controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(loadError('连接原聊天超时，消息未发送，草稿已保留。请稍后重试。', 'LOAD_TIMEOUT')), loadTimeoutMs);
    try {
      return await joinExistingLoad(id, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, deadline, () => clearTimeout(timeout));
    } finally { clearTimeout(timeout); }
  }
  async function joinExistingLoad(id, signal, deadline, preflightDone) {
    const metadata = await cancellable(catalog.get(id), signal);
    if (metadata?.id !== id) throw Error('原聊天不在当前电脑目录中，未打开其他聊天');
    const owner = await cancellable(ensureClient(), signal), connection = owner.currentConnection();
    if (typeof nativeTools.openExistingThread !== 'function') throw Error('当前电脑尚不支持加载原聊天');
    // The shared navigation now owns the remaining deadline. The independent
    // preflight timer must not race its structured failure response.
    preflightDone();
    let record = loads.get(id);
    if (!record || record.owner !== owner || record.generation !== connection.generation) {
      const controller = new AbortController();
      record = { owner, generation: connection.generation, controller, consumers: new Set(), settled: false, startedAt: Date.now(), phase: 'navigation' };
      loads.set(id, record);
      const timeout = setTimeout(() => controller.abort(loadError('电脑已打开，仍未确认原聊天加载完成。消息未发送，草稿已保留。', 'LOAD_TIMEOUT')), Math.max(1, deadline - Date.now()));
      const lost = () => controller.abort(loadError('官方桌面连接已变化，请重新读取原聊天。', 'CONNECTION_INTERRUPTED'));
      connection.signal.addEventListener('abort', lost, { once: true });
      const current = record;
      record.promise = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        // Opening is navigation only. Its ACK cannot establish a live owner,
        // and this path never sends a turn, answer, approval or interrupt.
        await cancellable(nativeTools.openExistingThread(id, { signal: controller.signal }), controller.signal);
        current.phase = 'owner';
        // Keep the resume stream and its patch base. Repeated fresh reads used
        // to clear both while Desktop was still restoring the conversation.
        const snapshot = await owner.waitForReady(id, { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!owner.connected || owner !== client || owner.generation !== connection.generation)
          throw loadError('官方桌面连接已变化，请重新读取原聊天。', 'CONNECTION_INTERRUPTED');
        return { status: 'confirmed', message: '原聊天已加载，可以继续对话。', state: await view(id, snapshot, null, metadata),
          load: { phase: 'ready', elapsedMs: Date.now() - current.startedAt } };
      }).catch(async error => ({ status: 'rejected', message: error?.message ?? '暂时无法加载原聊天，请稍后重试。',
        state: await view(id, null, error?.code ?? 'LOAD_UNAVAILABLE', metadata),
        load: { phase: current.phase, elapsedMs: Date.now() - current.startedAt, code: error?.code ?? 'LOAD_UNAVAILABLE' } }))
        .finally(() => {
          current.settled = true; clearTimeout(timeout); connection.signal.removeEventListener('abort', lost);
          if (loads.get(id) === current) loads.delete(id);
        });
    }
    // Separate HTTP clients can join one navigation. One departed phone must
    // not cancel the other, but no remaining caller permits a late navigation.
    const consumer = {}; record.consumers.add(consumer);
    try { return structuredClone(await cancellable(record.promise, signal)); }
    finally {
      record.consumers.delete(consumer);
      if (!record.settled && !record.consumers.size) record.controller.abort(loadError('加载已取消。', 'LOAD_CANCELLED'));
    }
  }
  async function statuses(ids) {
    let rows = [], partial = false;
    try { const result = await nativeTools.statuses(ids); rows = Array.isArray(result) ? result : result?.statuses ?? []; partial = result?.partial === true; }
    catch { partial = true; }
    const byId = new Map(rows.filter(row => ids.includes(row?.id)).map(row => [row.id, row]));
    return { statuses: ids.map(id => {
      // Reuse an already followed owner only. Sidebar polling must not steal
      // a fresh-snapshot intent from a reply or open dozens of subscriptions.
      const live = client?.connected ? client.snapshot(id) : null;
      if (live?.status?.confirmed) return { id, status: live.status.type, statusConfirmed: true, observedAt: live.observedAt };
      const row = byId.get(id);
      if (row?.statusConfirmed === true && typeof row.observedAt === 'number' && Date.now() - row.observedAt < 15000 && row.observedAt <= Date.now())
        return { id, status: row.status, statusConfirmed: true, observedAt: row.observedAt };
      return { id, status: 'unknown', statusConfirmed: false, observedAt: null };
    }), partial };
  }
  async function action(input, { signal } = {}) {
    const { threadId: id, operationId } = input;
    if (!validThreadId(id) || typeof operationId !== 'string' || !/^[\w-]{8,160}$/.test(operationId)) throw Error('操作标识无效');
    const release = holdThread(id);
    try { return await performAction(input, signal); }
    finally { release(); }
  }
  async function performAction(input, signal) {
    const { threadId: id, operationId } = input;
    const apiFingerprint = requestFingerprint({ host: hostId, id, action: input.action,
      text: input.text, requestId: input.requestId, answers: input.answers, choice: input.choice });
    const previous = journal.records.get(operationId);
    if (previous) {
      if (previous.apiFingerprint && previous.apiFingerprint !== apiFingerprint) throw Object.assign(Error('此发送标识已用于不同内容'), { notDispatched: true });
      return { status: previous.status === 'submitted' ? 'confirmed' : previous.status === 'dispatched' ? 'unknown' : previous.status,
        message: '此操作已有发送收据，未重复发送', deduplicated: true };
    }
    if (input.action === 'load') {
      if (Object.keys(input).some(key => !['host', 'threadId', 'operationId', 'action'].includes(key))) throw Error('加载原聊天不能包含消息或其他操作');
      return await loadExisting(id, signal);
    }
    operationContexts.set(operationId, { apiFingerprint });
    try {
    const owner = await ensureClient();
    const snapshot = await owner.freshSnapshot(id);
    if (input.connectionId !== String(snapshot.generation) + ':' + snapshot.owner || input.ownerId !== snapshot.owner ||
      input.activeTurnId !== snapshot.activeTurnId) throw Error('原会话状态已变化，请查看最新状态后再操作');
    const options = { operationId, expectedOwner: snapshot.owner, expectedTurnId: snapshot.activeTurnId };
    let result, fence = null;
    if (input.action === 'send') result = await owner.sendText(id, input.text, { ...options, mode: snapshot.status.type === 'idle' ? 'start' : 'steer' });
    else if (input.action === 'answer' || input.action === 'approval') {
      const reply = input.action === 'answer' ? buildQuestionReply(snapshot.state, input.requestId, input.answers) :
        buildApprovalReply(snapshot.state, input.requestId, input.choice);
      fence = requestFingerprint([hostId, id, reply.fence]);
      if ([...journal.records.values()].some(r => r.semanticFence === fence && ['dispatched', 'unknown', 'submitted'].includes(r.status)))
        throw Error('这个回答或审批已派发，请等待官方状态更新，未重复发送');
      // Fence the native request across different client operation IDs. The
      // choice itself is not the key: a lost ACK must not allow accept/decline twice.
      operationContexts.set(operationId, { apiFingerprint, semanticFence: fence });
      result = reply.kind === 'text' ? await owner.sendText(id, reply.text, { ...options, mode: snapshot.status.type === 'idle' ? 'start' : 'steer' }) :
        await owner.requestToOwner(id, reply.methodKey, reply.params, options);
    } else if (input.action === 'interrupt') {
      if (!snapshot.activeTurnId) throw Error('当前没有可停止的运行');
      result = await owner.requestToOwner(id, 'interrupt', { mode: 'user-stop', expectedTurnId: snapshot.activeTurnId }, options);
    } else throw Error('不支持此操作');
    return { status: result.status === 'submitted' ? 'confirmed' : result.status, message: result.status === 'unknown' ? '发送结果未知，请先查看原会话，勿重复提交' : '官方已接收，等待原会话更新' };
    } finally { operationContexts.delete(operationId); }
  }
  async function proxy(req, res, target, url, input) {
    if (req.headers['x-cmc-forwarded']) throw Error('目标电脑未正确配置');
    const peer = peerMap.get(target);
    if (!peer || !/^https:\/\/[a-z0-9.-]+\.ts\.net\/?$/i.test(peer.url)) throw Error('目标电脑未配对');
    const peerKey = await secrets.get('peer-' + target);
    if (!peerKey) throw Error('目标电脑尚未完成密钥配对');
    const controller = new AbortController();
    // A cold-load POST needs room for the remote 45s deadline and transport.
    // Message/approval writes retain their existing timeout and are never retried.
    const timer = setTimeout(() => controller.abort(), url.pathname === '/api/events' ? 86400000 :
      url.pathname === '/api/action' && input?.action === 'load' ? 55000 : 20000);
    // The phone can disappear while a streamed upstream body is still active.
    // pipeline handles both sides' errors so a network change cannot crash us.
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const upstream = await fetchPeer(new URL(url.pathname + url.search, peer.url), { method: req.method,
        headers: { Authorization: 'Bearer ' + peerKey, 'X-Cmc-Forwarded': '1',
          ...(peer.address ? { 'Accept-Encoding': req.headers['accept-encoding'] ?? 'identity' } : {}),
          ...(input ? { 'Content-Type': 'application/json' } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}), signal: controller.signal }, peer.address);
      // Address-pinned HTTPS returns raw bytes, so preserve their encoding for
      // the phone. The native-fetch fallback has already decoded its body.
      const encoding = peer.address && upstream.headers.get('content-encoding');
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(encoding ? { 'Content-Encoding': encoding } : {}) });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res); else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: '目标电脑暂时无法连接，请稍后重试' });
      else if (!res.destroyed) res.end();
    } finally { clearTimeout(timer); res.off('close', abort); controller.abort(); }
  }
  function authenticated(req) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer && secretEqual(bearer, key)) return true;
    const cookie = /(?:^|;\s*)cmc_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return !!cookie && (sessions.get(digest(cookie)) ?? 0) > Date.now();
  }
  function validOrigin(req) {
    if (!req.headers.origin) return true;
    try { const origin = new URL(req.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; }
    catch { return false; }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$|^[a-z0-9.-]+\.ts\.net(?::\d+)?$/i.test(req.headers.host ?? ''))
        return sendJson(res, 403, { error: '访问地址未授权' });
      if (!validOrigin(req)) return sendJson(res, 403, { error: '跨站请求未授权' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return sendJson(res, 200, { ok: true, host: hostId });
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.token !== 'string' || !secretEqual(input.token, key)) return sendJson(res, 401, { error: '配对链接无效' });
        const session = crypto.randomBytes(32).toString('base64url'); sessions.set(digest(session), Date.now() + 30 * 86400000);
        writePrivate(sessionsFile, [...sessions]);
        res.setHeader('Set-Cookie', `cmc_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${/\.ts\.net(?::\d+)?$/i.test(req.headers.host ?? '') ? '; Secure' : ''}`);
        return sendJson(res, 200, { paired: true });
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[a-zA-Z0-9._-]+$/.test(relative)) return sendJson(res, 404, { error: 'Not found' });
        const ext = path.extname(relative);
        if (!mime[ext]) return sendJson(res, 404, { error: 'Not found' });
        const file = assets.get(relative);
        if (!file) return sendJson(res, 404, { error: 'Not found' });
        return sendBytes(res, 200, file, { 'Content-Type': mime[ext], 'Cache-Control': relative !== 'index.html' && url.searchParams.get('v') === assetVersion ? 'private, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'" });

      }
      if (!authenticated(req)) return sendJson(res, 401, { error: '请使用电脑生成的配对链接打开' });
      const input = req.method === 'POST' ? await body(req) : null;
      const target = input?.host ?? url.searchParams.get('host') ?? hostId;
      if (url.pathname !== '/api/hosts' && target !== hostId) return await proxy(req, res, target, url, input);
      if (url.pathname === '/api/hosts' && req.method === 'GET') return sendJson(res, 200, { hosts: [
        { id: hostId, name: hostName, platform: process.platform, online: true },
        ...peers.map(p => ({ id: p.id, name: p.name, platform: p.id === 'windows' ? 'win32' : 'darwin', online: null })),
      ] });
      if (url.pathname === '/api/threads' && req.method === 'GET') return sendJson(res, 200, await catalog.query({
        projectId: url.searchParams.get('projectId') || undefined, q: url.searchParams.get('q') || '',
        range: url.searchParams.get('range') || 'week', cursor: url.searchParams.get('cursor') || undefined,
        limit: Number(url.searchParams.get('limit') || 50),
      }));
      if (url.pathname === '/api/statuses' && req.method === 'GET') {
        const ids = [...new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean))];
        if (ids.length > 100 || ids.some(id => !validThreadId(id))) throw Error('聊天状态查询范围无效');
        return sendJson(res, 200, ids.length ? await statuses(ids) : { statuses: [], partial: false });
      }
      if (url.pathname === '/api/creation' && req.method === 'GET') return sendJson(res, 200, await creation.capability());
      if (url.pathname === '/api/create' && req.method === 'POST') return sendJson(res, 200, await creation.create(input));
      if (url.pathname === '/api/thread' && req.method === 'GET') return sendJson(res, 200, await state(url.searchParams.get('id'), { refresh: true }));
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const controller = new AbortController();
        const gone = () => controller.abort(loadError('加载已取消。', 'LOAD_CANCELLED'));
        res.once('close', gone);
        try { const result = await action(input, { signal: controller.signal }); if (!res.destroyed) return sendJson(res, 200, result); }
        catch (e) {
          // Only an absent dispatch receipt proves that retrying is safe. A lost
          // native reply retains its fence even if the HTTP client disappeared.
          const receipt = journal.records.get(input.operationId);
          if (!res.destroyed) return sendJson(res, 200, { status: receipt && !e.notDispatched ? 'unknown' : 'rejected',
            message: receipt && !e.notDispatched ? '发送结果未知，请先查看原会话，勿重复提交' : e.message });
        } finally { res.off('close', gone); }
        return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const id = url.searchParams.get('id'); if (!validThreadId(id)) throw Error('无效聊天标识');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        let busy = false, timer, heartbeat, stopped = false, lastView = null;
        const push = async () => { if (busy || stopped || res.destroyed || res.writableNeedDrain) return; busy = true;
          try { const view = await state(id);
            // Reasoning-only native patches do not change the visible phone view.
            // Coalesce them instead of retransmitting the full chat over mobile.
            const visible = JSON.stringify({ ...view, revision: null });
            if (!stopped && !res.destroyed && visible !== lastView) { lastView = visible; res.write('event: state\ndata: ' + JSON.stringify(view) + '\n\n'); }
          }
          catch { if (!stopped && !res.destroyed) res.write('event: error\ndata: {}\n\n'); }
          finally { busy = false; }
        };
        const listener = { id, schedule: () => { if (!timer && !stopped) timer = setTimeout(() => { timer = null; push(); }, 100); } };
        clients.add(listener); watches.add(id); pendingUnfollows.delete(id); res.on('drain', listener.schedule);
        res.once('close', () => { stopped = true; clients.delete(listener); res.off('drain', listener.schedule); clearTimeout(timer); clearInterval(heartbeat);
          releaseFollower(id);
        });
        heartbeat = setInterval(() => { if (!stopped && !res.destroyed && !res.writableNeedDrain) res.write('event: ping\ndata: {}\n\n'); }, 15000);
        await push();
        return;
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 400, { error: e.message });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const recovery = setInterval(async () => {
    if (closed || !clients.size || client?.connected) return;
    try { await ensureClient(); for (const id of watches) await client.freshSnapshot(id); } catch {}
  }, 5000);
  recovery.unref();
  return { server, port: server.address().port, hostId, state, action, secrets,
    async close() { closed = true; clearInterval(recovery);
      for (const record of loads.values()) record.controller.abort(loadError('加载已取消。', 'LOAD_CANCELLED'));
      client?.close(); nativeTools.close?.(); for (const listener of clients) listener.schedule = () => {};
      server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
