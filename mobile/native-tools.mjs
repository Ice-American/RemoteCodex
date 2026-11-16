// Uses verified Windows app-tools for creation and isolated owner snapshots for live status.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pipe } from '../src/transport.mjs';
import { codexHome, discoverNativeDesktop } from './discovery.mjs';
import { OwnerClient } from './owner.mjs';
import { readOwnerProtocols } from './protocols.mjs';

const exec = promisify(execFile);
const officialImage = /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const toolPipe = value => /^(?:codex-browser-use-|codex-app-tools-)/.test(path.win32.basename(value ?? ''));
const localProject = project => (project.projectKind ?? project.kind) === 'local' && (!project.hostId || project.hostId === 'local');
const unsupported = '此网页暂不支持在 Mac 上新建聊天。Mac 已有聊天可以继续；新聊天请选择 Windows。';

async function probePipes(paths) {
  const names = paths ?? fs.readdirSync('\\\\.\\pipe\\').filter(toolPipe).map(name => '\\\\.\\pipe\\' + name);
  if (!names.length) return { pipes: [] };
  const { stdout } = await exec(process.env.MOBILE_CONTROL_PYTHON ?? 'D:\\python\\python.exe',
    [fileURLToPath(new URL('../src/win_probe.py', import.meta.url)), ...names],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

function localContext({ home }) {
  // An existing local metadata ID supplies caller context only. Never create a
  // hidden chat or import a different host's CODEX_THREAD_ID to obtain one.
  const file = fs.openSync(path.join(home, 'session_index.jsonl'), 'r');
  let text;
  try {
    const size = fs.fstatSync(file).size, bytes = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(file, bytes, 0, bytes.length, size - bytes.length); text = bytes.toString('utf8');
  } finally { fs.closeSync(file); }
  for (const line of text.trim().split('\n').reverse()) {
    try { const id = JSON.parse(line).id; if (uuid(id)) return id; } catch {}
  }
  throw Error('本机没有现有聊天上下文，请先在官方桌面新建聊天');
}

function unpack(frame) {
  const result = frame?.result;
  if (result?.success !== true) throw Error('官方工具未确认成功');
  const text = result.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { throw Error('官方工具返回格式未确认'); }
}

function createSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['projectId', 'prompt', 'title'].includes(key)) ||
      !Object.hasOwn(input, 'projectId') || input.projectId !== null &&
        (typeof input.projectId !== 'string' || !input.projectId.trim() || input.projectId.length > 200) ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000 ||
      input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200))
    throw Error('新聊天参数无效');
  return { projectId: input.projectId, prompt: input.prompt, ...(input.title === undefined ? {} : { title: input.title }) };
}

function projectRows(catalog) {
  if (!Array.isArray(catalog?.projects)) throw Error('官方项目列表格式未确认');
  const counts = new Map();
  for (const project of catalog.projects) counts.set(project.projectId, (counts.get(project.projectId) ?? 0) + 1);
  return catalog.projects.filter(project => typeof project.projectId === 'string' && project.projectId &&
    counts.get(project.projectId) === 1 && localProject(project)).map(project => ({
    projectId: project.projectId,
    name: project.label ?? project.name ?? project.path ?? project.projectId,
    path: typeof project.path === 'string' ? project.path : null,
  }));
}

function runtimeStatus(status) {
  if (status?.type === 'idle') return 'idle';
  if (status?.type !== 'active' || !Array.isArray(status.activeFlags)) return 'unknown';
  if (status.activeFlags.includes('waitingOnApproval')) return 'waitingForApproval';
  if (status.activeFlags.includes('waitingOnUserInput')) return 'waitingForInput';
  // Unknown active flags can represent a new actionable state, so they cannot
  // establish that the model is executing.
  if (status.activeFlags.length) return 'unknown';
  return 'running';
}

async function ownerStatuses({ ids, identity, discover, timeoutMs, registerCleanup }) {
  const protocols = readOwnerProtocols(identity.asarPath);
  let cancelled = false;
  // This short-lived follower owns no gateway subscriptions or operation journal.
  // Closing it cannot cancel the phone's selected-chat follower intent.
  const owner = new OwnerClient({ socketPath: identity.socketPath, protocolVersions: protocols, timeoutMs,
    verifyEndpoint: async () => {
      if (cancelled) throw Error('实时状态读取已取消');
      const value = await discover({ platform: identity.platform, home: identity.home, verifySignature: false });
      if (cancelled) throw Error('实时状态读取已取消');
      return value;
    } });
  const cleanup = () => { cancelled = true; owner.close(); };
  registerCleanup(cleanup);
  try {
    await owner.connect();
    if (owner.identity.fingerprint !== identity.fingerprint) throw Error('官方桌面在读取状态期间发生变化');
    const results = await Promise.allSettled(ids.map(id => owner.freshSnapshot(id, { timeoutMs })));
    return results.flatMap((result, index) => result.status === 'fulfilled' ? [{ id: ids[index],
      runtimeStatus: result.value.state?.threadRuntimeStatus, confirmed: result.value.status?.confirmed === true,
      observedAt: result.value.observedAt }] : []);
  } finally { cleanup(); }
}

export class NativeTools {
  constructor({ platform = process.platform, home = codexHome(), discover = discoverNativeDesktop,
    probe = probePipes, pipeFactory = (endpoint, kind) => new Pipe(endpoint, kind), contextResolver = localContext,
    ownerStatusReader = ownerStatuses,
    timeoutMs = 10000, statusTtlMs = 10000, statusTimeoutMs = 5500, now = Date.now } = {}) {
    Object.assign(this, { platform, home, discover, probe, pipeFactory, contextResolver, ownerStatusReader, timeoutMs, statusTtlMs, statusTimeoutMs, now });
    this.pipes = new Set(); this.ownerCleanups = new Set(); this.statusCache = null; this.statusInflight = null; this.closed = false;
  }
  #available() { return this.platform === 'win32' && !this.closed; }
  #tool(session, name) { return session.catalog.find(tool => tool.namespace === 'codex_app' && tool.name === name); }
  #params(session, name, args) {
    return { namespace: 'codex_app', tool: name, callerSource: 'codex',
      callId: 'remote-bridge-' + randomUUID(), threadId: session.context,
      turnId: 'remote-bridge-request-' + randomUUID(), arguments: args };
  }
  #call(session, name, args) {
    if (!this.#tool(session, name)) throw Error('官方桌面缺少所需接口：' + name);
    return session.pipe.request('tools/call', this.#params(session, name, args), { timeoutMs: this.timeoutMs }).then(unpack);
  }
  async #verify(session, budget) {
    const results = await Promise.allSettled([
      this.discover({ platform: this.platform, home: this.home }), this.probe([session.endpoint.path]),
    ]);
    this.#checkBudget(budget);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const owner = results[0].value, actual = results[1].value.pipes?.find(pipe => pipe.path === session.endpoint.path);
    if (owner.pid !== session.owner.pid || owner.image !== session.owner.image ||
        owner.fingerprint !== session.owner.fingerprint || actual?.pid !== owner.pid || actual.image !== owner.image ||
        !officialImage.test(actual.image) || session.pipe.socket?.destroyed || this.closed)
      throw Error('官方桌面接口身份已变化，请刷新后重试');
  }
  #checkBudget(budget) { if (budget?.expired) throw Error('实时状态读取超时'); }
  #release(session) { if (session) { this.pipes.delete(session.pipe); session.pipe.close(); } }
  async #open(budget) {
    if (!this.#available()) throw Error(this.platform === 'darwin' ? unsupported : '当前电脑不支持官方新建接口');
    const owner = await this.discover({ platform: this.platform, home: this.home });
    this.#checkBudget(budget);
    if (!owner.pid || !officialImage.test(owner.image ?? '')) throw Error('未确认官方 Windows 桌面身份');
    const discovery = await this.probe();
    this.#checkBudget(budget);
    const candidates = (discovery.pipes ?? []).filter(pipe => pipe.pid && officialImage.test(pipe.image ?? '') && toolPipe(pipe.path));
    if (!candidates.length || candidates.some(pipe => pipe.pid !== owner.pid || pipe.image !== owner.image))
      throw Error('官方 app-tools 接口身份不可用或存在歧义');
    for (const endpoint of candidates) {
      this.#checkBudget(budget);
      const pipe = this.pipeFactory(endpoint.path, 'tools'), session = { owner, endpoint, pipe };
      if (budget) budget.session = session;
      this.pipes.add(pipe);
      try {
        let timer;
        try { await Promise.race([pipe.connect(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('官方接口连接超时')), this.timeoutMs); })]); }
        finally { clearTimeout(timer); }
        const response = await pipe.request('tools/list', { threadStartKind: 'all' }, { timeoutMs: this.timeoutMs });
        this.#checkBudget(budget);
        if (!Array.isArray(response.result?.tools)) throw Error('官方接口目录格式未确认');
        session.catalog = response.result.tools;
        session.context = await this.contextResolver({ home: owner.home ?? this.home, identity: owner });
        this.#checkBudget(budget);
        if (!uuid(session.context)) throw Error('缺少有效的本机聊天上下文');
        await this.#verify(session, budget);
        return session;
      } catch (error) { this.#release(session); if (endpoint === candidates.at(-1)) throw error; }
    }
  }
  async capability() {
    if (!this.#available()) return { supported: false, reason: this.platform === 'darwin' ? unsupported : '当前电脑不支持官方新建接口', projectless: false, projects: [] };
    let session;
    try {
      session = await this.#open();
      const tool = this.#tool(session, 'create_thread');
      if (!tool?.inputSchema?.properties?.target || !tool.inputSchema.properties.prompt) throw Error('官方新建聊天接口格式未确认');
      const projects = projectRows(await this.#call(session, 'list_projects', {}));
      return { supported: true, reason: null, projectless: true, projects };
    } catch (error) { return { supported: false, reason: error.message, projectless: false, projects: [] }; }
    finally { this.#release(session); }
  }
  async create(input, { beforeDispatch } = {}) {
    const selection = createSelection(input);
    if (typeof beforeDispatch !== 'function') throw Error('创建请求缺少持久化派发保护');
    let session;
    try {
      session = await this.#open();
      const tool = this.#tool(session, 'create_thread');
      if (!tool?.inputSchema?.properties?.target || !tool.inputSchema.properties.prompt) throw Error('官方新建聊天接口格式未确认');
      const catalog = await this.#call(session, 'list_projects', {});
      projectRows(catalog);
      let target = { type: 'projectless' };
      if (selection.projectId !== null) {
        const projects = catalog.projects.filter(project => project.projectId === selection.projectId);
        if (projects.length !== 1 || !localProject(projects[0])) throw Error('所选项目已变化或不在本机，请重新选择');
        target = { type: 'project', projectId: selection.projectId, environment: { type: 'local' } };
      }
      const args = { target, prompt: selection.prompt, ...(selection.title === undefined ? {} : { title: selection.title }) };
      const params = this.#params(session, 'create_thread', args);
      await this.#verify(session);
      // The manager fsyncs its journal here. No await, retry, fallback target or
      // other operation may occur between that fence and the one native write.
      const fenced = beforeDispatch();
      if (fenced && typeof fenced.then === 'function') throw Error('派发保护必须同步完成');
      const result = unpack(await session.pipe.request('tools/call', params, { timeoutMs: this.timeoutMs }));
      const threadId = result.threadId ?? result.thread?.id;
      if (uuid(threadId)) return { threadId };
      if (typeof result.clientThreadId === 'string' && /^[\w-]{8,160}$/.test(result.clientThreadId)) return { clientThreadId: result.clientThreadId };
      throw Error('官方新建聊天结果尚未确认');
    } finally { this.#release(session); }
  }
  async #readStatuses(selected, budget) {
    let session;
    try {
      session = await this.#open(budget);
      const listing = await this.#call(session, 'list_threads', { limit: 50, mode: 'recent' });
      this.#checkBudget(budget);
      if (!Array.isArray(listing.threads) || !Array.isArray(listing.pinnedThreads)) throw Error('官方实时聊天列表格式未确认');
      const rows = [...listing.pinnedThreads, ...listing.threads].filter(row => row.kind === 'codex' && row.hostId === 'local' && uuid(row.id));
      const result = new Map(), observedAt = this.now();
      for (const row of rows) {
        // list_threads strips the runtime union's activeFlags in this app build.
        // Its plain active string is only a candidate until a fresh owner read.
        const status = typeof row.status === 'object' ? runtimeStatus(row.status) : row.status === 'idle' ? 'idle' : 'unknown';
        result.set(row.id, { id: row.id, status, statusConfirmed: status !== 'unknown', observedAt });
      }
      const active = [...new Set(rows.filter(row => selected.includes(row.id) && row.status === 'active').map(row => row.id))].slice(0, 8);
      let partial = false;
      if (active.length) {
        try {
          const polls = await this.ownerStatusReader({ ids: active, identity: session.owner, discover: this.discover,
            timeoutMs: Math.min(this.timeoutMs, this.statusTimeoutMs), registerCleanup: cleanup => {
              if (budget.expired || this.closed) { cleanup(); throw Error('实时状态读取已取消'); }
              budget.cleanup = cleanup; this.ownerCleanups.add(cleanup);
            } });
          this.#checkBudget(budget);
          for (const poll of polls ?? []) {
            if (!active.includes(poll.id) || poll.confirmed !== true || typeof poll.observedAt !== 'number' ||
                poll.observedAt > this.now() || this.now() - poll.observedAt >= this.statusTtlMs) continue;
            const status = runtimeStatus(poll.runtimeStatus);
            result.set(poll.id, { id: poll.id, status, statusConfirmed: status !== 'unknown', observedAt: poll.observedAt });
          }
          partial = active.some(id => !result.get(id)?.statusConfirmed);
        } catch (error) { this.#checkBudget(budget); partial = true; }
      }
      return { observedAt, rows: result, partial };
    } finally { this.#release(session); if (budget.cleanup) { budget.cleanup(); this.ownerCleanups.delete(budget.cleanup); } }
  }
  async statuses(ids) {
    const selected = [...new Set(Array.isArray(ids) ? ids.filter(uuid) : [])].slice(0, 200);
    if (!selected.length || !this.#available()) return selected.map(id => ({ id, status: 'unknown', statusConfirmed: false, observedAt: null }));
    let snapshot = this.statusCache;
    if (!snapshot || this.now() - snapshot.observedAt >= this.statusTtlMs) {
      if (!this.statusInflight) {
        const budget = { expired: false }; let timer;
        this.statusInflight = Promise.race([this.#readStatuses(selected, budget), new Promise((_, reject) => {
          timer = setTimeout(() => { budget.expired = true; this.#release(budget.session); if (budget.cleanup) { budget.cleanup(); this.ownerCleanups.delete(budget.cleanup); } reject(Error('实时状态读取超时')); }, this.statusTimeoutMs);
        })]).then(value => { this.statusCache = value.partial ? null : value; return value; }).finally(() => { clearTimeout(timer); this.statusInflight = null; });
      }
      // Errors do not extend an old runtime observation or cache a failure.
      snapshot = await this.statusInflight;
    }
    const rows = selected.map(id => snapshot.rows.get(id) ?? { id, status: 'unknown', statusConfirmed: false, observedAt: null });
    rows.partial = snapshot.partial === true; return rows;
  }
  close() { this.closed = true; this.statusCache = null; for (const cleanup of this.ownerCleanups) cleanup(); this.ownerCleanups.clear(); for (const pipe of this.pipes) pipe.close(); this.pipes.clear(); }
}
