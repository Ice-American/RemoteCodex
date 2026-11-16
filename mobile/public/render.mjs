// Mobile view of an existing desktop owner. Only server snapshots establish messages or completed requests.
const statusLabels = {
  idle: '可继续对话', running: '正在运行', working: '正在运行', inProgress: '正在运行',
  waiting: '等待回答', waitingForInput: '等待回答', waiting_for_input: '等待回答',
  waitingForApproval: '等待审批', completed: '本轮已完成', error: '发生错误',
};
const statusType = (state) => typeof state?.status === 'string' ? state.status : state?.status?.type;
const isRunning = (state) => ['running', 'working', 'inProgress'].includes(statusType(state));
const isHistoryOnly = (state) => state?.source === 'local-history-only';
const scopeOf = (state) => JSON.stringify([state?.host ?? '', state?.id ?? '']);
const stringify = (value) => { try { return JSON.stringify(value, null, 2); } catch { return '详情无法显示'; } };
// A compact local lookup key, not an authorization token. The server validates the full owner request.
const fingerprint = (text) => { let hash = 14695981039346656037n; for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 1099511628211n); return hash.toString(16); };

export function dedupeMessages(messages = []) {
  const result = [], positions = new Map();
  for (const message of messages) {
    if (!message || typeof message.text !== 'string') continue;
    const key = message.id == null ? null : JSON.stringify([message.role, message.id]);
    if (key != null && positions.has(key)) result[positions.get(key)] = message;
    else { if (key != null) positions.set(key, result.length); result.push(message); }
  }
  return result;
}

export function viewportMetrics(viewport, fallbackHeight) {
  const height = Number(viewport?.height) || Number(fallbackHeight) || 720;
  return { height: Math.max(1, Math.round(height)), top: Math.max(0, Math.round(Number(viewport?.offsetTop) || 0)) };
}

export function canAct(state, action, transportConnected = true) {
  if (isHistoryOnly(state) || !transportConnected || state?.connected !== true || state?.ownerConfirmed !== true) return false;
  if (!state.connectionId || !state.ownerId || state.revision == null) return false;
  const capability = action === 'approval' ? 'approve' : action === 'send' && isRunning(state) ? 'steer' : action;
  return state.capabilities?.[capability] === true && (action !== 'interrupt' || !!state.activeTurnId);
}

export function buildActionPayload(state, input) {
  if (!canAct(state, input.action)) throw new Error('当前会话尚未确认操作权限，请先刷新状态。');
  const payload = {
    host: state.host, threadId: state.id, operationId: input.operationId,
    connectionId: state.connectionId, revision: state.revision, ownerId: state.ownerId,
    activeTurnId: state.activeTurnId ?? null, action: input.action,
  };
  for (const key of ['text', 'requestId', 'answers', 'choice']) if (Object.hasOwn(input, key)) payload[key] = input[key];
  return payload;
}

function operationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  return [...bytes].map((byte, index) => ([4, 6, 8, 10].includes(index) ? '-' : '') + byte.toString(16).padStart(2, '0')).join('');
}

export class ActionGate {
  constructor({ storage, storageKey = 'codex-mobile-operation-guards' } = {}) {
    this.attempts = new Map(); this.storage = storage; this.storageKey = storageKey;
    this.restore();
  }
  stored() {
    const result = new Map();
    try {
      const records = JSON.parse(this.storage?.getItem(this.storageKey) || '[]');
      if (Array.isArray(records)) for (const [key, value] of records) {
        if (typeof key !== 'string' || !value || !['pending', 'unknown', 'confirmed', 'submitted'].includes(value.status) || typeof value.operationId !== 'string') continue;
        result.set(key, value);
      }
    } catch {}
    return result;
  }
  restore() {
    for (const [key, saved] of this.stored()) {
      const local = this.attempts.get(key);
      if (local?.status === 'unknown' || local?.operationId === saved.operationId && local.status === saved.status) continue;
      const status = saved.status === 'pending' ? 'unknown' : saved.status;
      this.attempts.set(key, { operationId: saved.operationId, status, message: status === 'unknown' ? '上次操作的结果未确认。请先核对原会话，本次操作不会自动重发。' : '上次操作已提交，等待原会话状态同步。' });
    }
  }
  persist(removedKey = null) {
    // Other tabs can add unresolved receipts. An unrelated local write must
    // preserve them, and stale confirmed state must never erase an unknown.
    for (const [key, saved] of this.stored()) {
      const local = this.attempts.get(key);
      if (key === removedKey && saved.status === 'confirmed') continue;
      if (!local || saved.status === 'unknown' && local.status !== 'unknown' ||
          saved.operationId !== local.operationId && ['pending', 'submitted'].includes(saved.status) && local.status !== 'unknown') {
        this.attempts.set(key, { ...saved, status: saved.status === 'pending' ? 'unknown' : saved.status,
          message: '上次操作的结果未确认，请先核对原会话，不会自动重发。' });
      }
    }
    try { this.storage?.setItem(this.storageKey, JSON.stringify([...this.attempts].filter(([, attempt]) => attempt.status !== 'rejected').map(([key, attempt]) => [key, { operationId: attempt.operationId, status: attempt.status }]))); } catch {}
  }
  forgetConfirmed(key) { this.restore(); if (this.get(key)?.status === 'confirmed') { this.attempts.delete(key); this.persist(key); } }
  begin(key) {
    this.restore();
    const prior = this.attempts.get(key);
    if (prior && prior.status !== 'rejected') return null;
    const attempt = { operationId: operationId(), status: 'pending', message: '正在提交…' };
    this.attempts.set(key, attempt);
    this.persist();
    return this.attempts.get(key) === attempt && attempt.status === 'pending' ? attempt : null;
  }
  settle(key, response) {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.status = ['confirmed', 'submitted', 'rejected'].includes(response?.status) ? response.status : 'unknown';
    attempt.message = response?.message || ({ confirmed: '操作已确认，等待会话同步。', submitted: '已提交，等待官方状态确认。', rejected: '未提交，请刷新会话后重试。', unknown: '结果未确认。请在原会话核对，本次操作不会自动重发。' })[attempt.status];
    this.persist();
  }
  get(key) { return this.attempts.get(key); }
}

export function createMobileAPI({ apiBase = '', fetchImpl = globalThis.fetch, EventSourceImpl = globalThis.EventSource, actionTimeoutMs = 30000 } = {}) {
  const base = String(apiBase).replace(/\/$/, '');
  const path = (route, values) => base + route + (values ? '?' + new URLSearchParams(values) : '');
  async function json(url, options, acceptRejection = false) {
    const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的结果，请重新读取状态。'); }
    if (!response.ok && !(acceptRejection && data?.status === 'rejected')) throw new Error(data?.message || `读取失败（${response.status}）`);
    return data;
  }
  return {
    getHosts: () => json(path('/api/hosts')),
    getThreads: (host, options = {}) => json(path('/api/threads', { host,
      ...Object.fromEntries(Object.entries(options).filter(([key, value]) => ['projectId', 'q', 'cursor', 'limit', 'range'].includes(key) && value != null && value !== '')) })),
    getThreadStatuses: (host, ids, { signal } = {}) => json(path('/api/statuses', { host, ids: ids.join(',') }), { signal }),
    getCreation: (host) => json(path('/api/creation', { host })),
    async createThread(body) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), actionTimeoutMs);
      // Creation is a write with its own durable operation guard. Never retry it.
      try { return await json(path('/api/create'), { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true); }
      finally { clearTimeout(timer); }
    },
    getThread: (host, id, { signal } = {}) => json(path('/api/thread', { host, id }), { signal }),
    async action(body) {
      const controller = new AbortController();
      // A handover can leave an HTTP reply pending indefinitely. Stop waiting,
      // retain an unknown receipt, and never replay the already-dispatched POST.
      const timer = setTimeout(() => controller.abort(), actionTimeoutMs);
      try { return await json(path('/api/action'), { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true); }
      finally { clearTimeout(timer); }
    },
    subscribe(host, id, { onState, onStatus, onHeartbeat = () => {} }) {
      if (!EventSourceImpl) { onStatus('disconnected'); return () => {}; }
      const stream = new EventSourceImpl(path('/api/events', { host, id }), { withCredentials: true });
      let closed = false;
      stream.addEventListener('open', () => { if (!closed) onStatus('connecting'); });
      stream.addEventListener('ping', () => { if (!closed) onHeartbeat(); });
      stream.addEventListener('state', (event) => {
        if (closed) return;
        try { onState(JSON.parse(event.data)); } catch { onStatus('disconnected'); }
      });
      // EventSource may reconnect GET requests. It never resends a write or clears a draft.
      stream.addEventListener('error', () => { if (!closed) onStatus('disconnected'); });
      return () => { closed = true; stream.close(); };
    },
  };
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function inlineText(container, text) {
  const doc = container.ownerDocument;
  for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (part.startsWith('`') && part.endsWith('`')) container.append(element(doc, 'code', '', part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**')) container.append(element(doc, 'strong', '', part.slice(2, -2)));
    else container.append(doc.createTextNode(part));
  }
}

export function renderSafeText(container, text, { markdown = false } = {}) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  if (!markdown) { container.append(element(doc, 'p', '', text)); return; }
  // This small Markdown subset creates nodes. Raw HTML, links and image syntax remain inert text.
  let fenced = false, code = [], paragraph = [];
  const flushParagraph = () => { if (!paragraph.length) return; const p = element(doc, 'p'); inlineText(p, paragraph.join('\n')); container.append(p); paragraph = []; };
  const flushCode = () => { const pre = element(doc, 'pre'); pre.append(element(doc, 'code', '', code.join('\n'))); container.append(pre); code = []; };
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) { flushParagraph(); if (fenced) flushCode(); fenced = !fenced; continue; }
    if (fenced) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { flushParagraph(); const h = element(doc, 'h3'); inlineText(h, heading[1]); container.append(h); }
    else paragraph.push(line);
  }
  flushParagraph(); if (fenced) flushCode();
}

function reconcile(parent, children) {
  const keep = new Set(children);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
  children.forEach((child, index) => { if (parent.childNodes[index] !== child) parent.insertBefore(child, parent.childNodes[index] ?? null); });
}

export function mountMobileUI(root, { api, onNavigate = () => {}, initialHost = 'mac', initialThreadId = '', storage,
  timers = globalThis, readTimeoutMs = 20000, heartbeatTimeoutMs = 45000 } = {}) {
  if (!root?.ownerDocument || !api) throw new Error('需要根节点和手机控制 API。');
  const doc = root.ownerDocument, win = doc.defaultView ?? globalThis.window;
  let draftStorage = storage;
  if (draftStorage === undefined) {
    draftStorage = null;
    for (const kind of ['localStorage', 'sessionStorage']) {
      try {
        const candidate = win?.[kind]; if (!candidate) continue;
        const probe = 'codex-mobile-storage-check'; const previous = candidate.getItem(probe);
        candidate.setItem(probe, '1'); if (previous == null) candidate.removeItem(probe); else candidate.setItem(probe, previous);
        draftStorage = candidate;
        if (kind === 'localStorage') {
          let legacy; try { legacy = win?.sessionStorage; } catch {}
          if (legacy && legacy !== candidate) draftStorage = {
            getItem(key) {
              const current = candidate.getItem(key);
              if (!/^codex-mobile-(?:draft:|operation-guards$)/.test(key)) return current;
              // Upgrade existing pages lazily. Copy and read back before removing
              // the old session value; a known unknown receipt must survive it.
              try {
                const old = legacy.getItem(key); if (old == null) return current;
                let value = current ?? old;
                if (key === 'codex-mobile-operation-guards' && current != null) {
                  const merged = new Map(JSON.parse(current));
                  for (const [id, record] of JSON.parse(old)) if (!merged.has(id) || ['pending', 'unknown'].includes(record?.status)) merged.set(id, record);
                  value = JSON.stringify([...merged]);
                }
                candidate.setItem(key, value); if (candidate.getItem(key) === value) legacy.removeItem(key);
                return value;
              } catch { return current ?? legacy.getItem(key); }
            },
            setItem: (key, value) => candidate.setItem(key, value),
            removeItem: key => { candidate.removeItem(key); try { legacy.removeItem(key); } catch {} },
          };
        }
        break;
      } catch {}
    }
  }
  let state = null, hosts = [], threads = [], selectedHost = initialHost, selectedId = '', generation = 0;
  let hostGeneration = 0, listRequest = 0, hostsRequest = 0, listLoading = false, listError = '', hostError = '';
  let projects = [], selectedProject = '', selectedRange = 'week', nextCursor = null, listTotal = null, catalogPartial = false, loadedQuery = '';
  let searchTimer = null, statusTimer = null, statusGeneration = 0, statusPending = null;
  let creationOpen = false, creationReturnDrawer = false, creationGeneration = 0, creationBusy = false, creationLoading = false;
  let creation = null, creationError = '', creationResult = null, creationDesiredProject = null, creationSelectedProjectId = '';
  const createDrafts = new Map(), threadRowViews = new Map();
  let connected = false, destroyed = false, closeEvents = () => {}, loading = false, drawerOpen = false;
  const later = (fn, ms) => timers.setTimeout(fn, ms), cancel = id => { if (id != null) timers.clearTimeout(id); };
  const now = () => typeof timers.now === 'function' ? timers.now() : Date.now();
  let attemptGeneration = 0, readAttempt = null, retryTimer = null, heartbeatTimer = null, recoveryTimer = null;
  let failureSince = null, retryStep = 0, recoveryNotice = false, lastWakeAt = -Infinity, wakeTimer = null;
  let cardsSignature = '', messageScope = '', hostSignature = '', threadSignature = '', noticeText = '';
  const drafts = new Map(), answers = new Map(), gate = new ActionGate({ storage: draftStorage }), messageNodes = new Map();
  const node = (tag, cls, text) => element(doc, tag, cls, text);
  const button = (text, cls, fn) => { const b = node('button', cls, text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
  const app = node('div', 'mobile-app'); app.setAttribute('lang', 'zh-CN');
  const header = node('header', 'app-header');
  const menu = button('对话列表', 'icon-button menu-button', () => setDrawer(!drawerOpen)); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', 'thread-drawer');
  const heading = node('div', 'heading-group'), title = node('h1', 'thread-title', 'Codex 随行'), subtitle = node('p', 'thread-subtitle', '选择一个已有对话');
  const titleLine = node('div', 'title-line'), titleRunning = node('span', 'running-indicator title-running');
  titleRunning.setAttribute('role', 'img'); titleRunning.setAttribute('aria-label', '进行中'); titleRunning.hidden = true;
  titleLine.append(title, titleRunning); heading.append(titleLine, subtitle);
  const newChat = button('＋ 新建', 'new-chat-button', () => openCreation()); newChat.setAttribute('aria-label', '新建聊天');
  const hostSwitch = node('div', 'host-switch'); hostSwitch.setAttribute('role', 'group'); hostSwitch.setAttribute('aria-label', '目标电脑');
  header.append(menu, heading, newChat, hostSwitch);
  const connection = node('div', 'connection-bar'); connection.setAttribute('role', 'status');
  const connectionLabel = node('span', 'connection-label', '正在读取电脑状态…');
  const refresh = button('刷新', 'text-button', () => refreshCurrent()); connection.append(connectionLabel, refresh);
  const notice = node('div', 'notice'); notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const main = node('main', 'conversation'); main.setAttribute('aria-label', '聊天记录');
  const empty = node('div', 'empty-state', '从对话列表选择一个已有对话。');
  const messages = node('div', 'messages'), requests = node('div', 'request-cards');
  main.append(empty, messages, requests);
  const latest = button('回到最新 ↓', 'latest-button', () => { main.scrollTop = main.scrollHeight; latest.hidden = true; }); latest.hidden = true;
  const composer = node('form', 'composer');
  const composerHint = node('p', 'composer-hint', '先选择对话');
  const composeRow = node('div', 'compose-row'), input = node('textarea', 'message-input');
  input.rows = 1; input.placeholder = '给 Codex 发消息…'; input.setAttribute('aria-label', '消息草稿'); input.setAttribute('enterkeyhint', 'enter');
  const send = node('button', 'send-button', '发送'); send.type = 'submit';
  composeRow.append(input, send);
  const composeFoot = node('div', 'composer-foot'), draftHint = node('span', 'draft-hint', '草稿只保存在本设备'), interrupt = button('停止运行', 'stop-button', () => stopTurn());
  interrupt.hidden = true; composeFoot.append(draftHint, interrupt); composer.append(composerHint, composeRow, composeFoot);
  const backdrop = button('关闭对话列表', 'drawer-backdrop', () => setDrawer(false)); backdrop.hidden = true; backdrop.tabIndex = -1;
  const drawer = node('aside', 'thread-drawer'); drawer.id = 'thread-drawer'; drawer.hidden = true; drawer.setAttribute('aria-label', '已有对话列表');
  const drawerHeading = node('div', 'drawer-heading'); drawerHeading.append(node('h2', '', '聊天'), button('新建', 'drawer-new-chat', () => openCreation()), button('刷新', 'text-button drawer-refresh', () => loadThreads()), button('关闭', 'text-button', () => setDrawer(false)));
  const search = node('input', 'thread-search'); search.type = 'search'; search.placeholder = '搜索对话'; search.setAttribute('aria-label', '搜索已有对话');
  const filters = node('div', 'catalog-filters'), projectSelect = node('select', 'project-select'), rangeSelect = node('select', 'history-range');
  projectSelect.setAttribute('aria-label', '项目'); rangeSelect.setAttribute('aria-label', '历史范围');
  for (const [value, text] of [['week', '最近7天'], ['all', '全部历史']]) { const o = node('option', '', text); o.value = value; rangeSelect.append(o); }
  rangeSelect.value = selectedRange; filters.append(projectSelect, rangeSelect);
  search.placeholder = '搜索标题、项目或目录';
  const catalogHint = node('p', 'catalog-hint'), threadList = node('nav', 'thread-list'); threadList.setAttribute('aria-label', '对话');
  const more = button('加载更多', 'load-more-button', () => loadThreads({ append: true })); more.hidden = true;
  drawer.append(drawerHeading, filters, search, catalogHint, threadList, more);
  const creationBackdrop = button('关闭新建聊天', 'creation-backdrop', () => closeCreation()); creationBackdrop.hidden = true; creationBackdrop.tabIndex = -1;
  const creationDialog = node('section', 'creation-dialog'); creationDialog.hidden = true; creationDialog.setAttribute('role', 'dialog'); creationDialog.setAttribute('aria-modal', 'true'); creationDialog.setAttribute('aria-label', '新建聊天');
  const creationHeading = node('div', 'creation-heading'); creationHeading.append(node('h2', '', '新建聊天'), button('关闭', 'create-close', () => closeCreation()));
  const creationState = node('p', 'creation-state'); creationState.setAttribute('role', 'status'); creationState.setAttribute('aria-live', 'polite');
  const createForm = node('form', 'create-form'), createProject = node('select', 'create-project'), createTitle = node('input', 'create-title'), createPrompt = node('textarea', 'create-prompt');
  createProject.setAttribute('aria-label', '新聊天项目'); createTitle.setAttribute('aria-label', '新聊天标题'); createTitle.placeholder = '标题（可选）'; createTitle.maxLength = 160;
  createPrompt.setAttribute('aria-label', '第一条消息'); createPrompt.placeholder = '描述你希望 Codex 完成的工作'; createPrompt.rows = 5; createPrompt.maxLength = 24000;
  const field = (name, control) => { const label = node('label', 'create-field'); label.append(node('span', '', name), control); return label; };
  const createSubmit = node('button', 'create-submit', '创建并开始'); createSubmit.type = 'submit';
  const createRetry = button('重新读取创建能力', 'create-retry', () => loadCreation()); createRetry.hidden = true;
  const createdOpen = button('打开已创建的聊天', 'created-open', () => { const result = creationResult; if (result?.host === selectedHost && validCreatedId(result.threadId)) { closeCreation({ save: false, restore: false }); void selectThread(result.threadId); } }); createdOpen.hidden = true;
  const createBack = button('返回列表核对', 'create-back-list', () => { closeCreation({ restore: false }); setDrawer(true); void loadThreads(); }); createBack.hidden = true;
  createForm.append(field('项目', createProject), field('标题（可选）', createTitle), field('第一条消息', createPrompt), createSubmit);
  creationDialog.append(creationHeading, creationState, createForm, createRetry, createdOpen, createBack);
  app.append(header, connection, notice, main, latest, composer, backdrop, drawer, creationBackdrop, creationDialog); root.replaceChildren(app);

  function storageKey(scope) { return 'codex-mobile-draft:' + scope; }
  function draft(scope) {
    if (!drafts.has(scope)) { let text = ''; try { text = draftStorage?.getItem(storageKey(scope)) ?? ''; } catch {} drafts.set(scope, text); }
    return drafts.get(scope);
  }
  function saveDraft(scope, text) { drafts.set(scope, text); try { if (text) draftStorage?.setItem(storageKey(scope), text); else draftStorage?.removeItem(storageKey(scope)); } catch {} }
  function currentScope() { return JSON.stringify([selectedHost, selectedId]); }
  function showNotice(text, fromRecovery = false) { noticeText = text; recoveryNotice = fromRecovery; notice.textContent = text; notice.hidden = !text; }
  function autoSize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight || 44, 168) + 'px'; }
  function resize() { const metrics = viewportMetrics(win?.visualViewport, win?.innerHeight); app.style.setProperty('--app-height', metrics.height + 'px'); app.style.setProperty('--app-top', metrics.top + 'px'); autoSize(); }
  function setDrawer(open) {
    drawerOpen = open; drawer.hidden = !open; backdrop.hidden = !open; menu.setAttribute('aria-expanded', String(open)); syncOverlays();
    stopStatuses();
    if (open) { clearStatusConfirmations(); renderThreads(); search.focus(); void pollStatuses(); } else menu.focus();
  }
  function syncOverlays() {
    const blocked = drawerOpen || creationOpen;
    main.setAttribute('aria-hidden', String(blocked)); composer.setAttribute('aria-hidden', String(blocked)); main.inert = blocked; composer.inert = blocked;
    header.inert = creationOpen; connection.inert = creationOpen; drawer.inert = creationOpen;
    creationDialog.hidden = !creationOpen; creationBackdrop.hidden = !creationOpen;
  }
  const validCreatedId = id => typeof id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id);
  function createDraftKey(host) { return 'codex-mobile-create-draft:' + host; }
  function readCreateDraft(host) {
    if (!createDrafts.has(host)) {
      let saved = {}; try { saved = JSON.parse(draftStorage?.getItem(createDraftKey(host)) || '{}'); } catch {}
      createDrafts.set(host, { projectId: typeof saved.projectId === 'string' ? saved.projectId : '', title: typeof saved.title === 'string' ? saved.title : '', prompt: typeof saved.prompt === 'string' ? saved.prompt : '' });
    }
    return createDrafts.get(host);
  }
  function saveCreateDraft(host = selectedHost) {
    const saved = { projectId: creationSelectedProjectId, title: createTitle.value, prompt: createPrompt.value };
    createDrafts.set(host, saved); try { draftStorage?.setItem(createDraftKey(host), JSON.stringify(saved)); } catch {}
    return saved;
  }
  function creationKey(host = selectedHost) { return JSON.stringify([host, 'create', fingerprint(JSON.stringify([creationSelectedProjectId, createTitle.value.trim(), createPrompt.value.trim()]))]); }
  function creationTargetValid() { return creation?.supported === true && (creationSelectedProjectId === '' ? creation.projectless === true : creation.projects?.some(project => project.projectId === creationSelectedProjectId)); }
  function renderCreation() {
    const receipt = gate.get(creationKey());
    creationState.textContent = creationLoading ? '正在读取官方项目…' : creationError || receipt?.message || (creation?.supported ? '选择项目，填写第一条消息后创建。' : creation?.reason || '这台电脑暂不支持创建聊天。');
    createProject.disabled = creationLoading || creationBusy || !creation?.supported;
    createTitle.disabled = createPrompt.disabled = creationBusy;
    createSubmit.disabled = creationLoading || creationBusy || !creationTargetValid() || !createPrompt.value.trim() || !!receipt && receipt.status !== 'rejected';
    createSubmit.textContent = creationBusy ? '正在创建…' : '创建并开始';
    createRetry.hidden = creationLoading || !creationError;
    createBack.hidden = !receipt || receipt.status === 'rejected';
    createdOpen.hidden = creationResult?.host !== selectedHost || !validCreatedId(creationResult?.threadId);
  }
  function normalizedProjectPath(path) { const value = String(path || '').replace(/\\/g, '/').replace(/\/$/, ''); return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value; }
  async function loadCreation() {
    if (!creationOpen || destroyed) return;
    const host = selectedHost, stamp = ++creationGeneration; creationLoading = true; creationError = ''; renderCreation();
    try {
      if (!api.getCreation) throw new Error('当前服务暂不支持创建聊天，请刷新页面后重试。');
      const result = await api.getCreation(host); if (destroyed || !creationOpen || host !== selectedHost || stamp !== creationGeneration) return;
      creation = result; const desired = creationDesiredProject; creationDesiredProject = null;
      // A real select erases a value until its option exists. Keep intent outside
      // the DOM so a slow capability read/reload cannot change an unknown create
      // into a different project or an unguarded projectless operation.
      let selected = creationSelectedProjectId;
      // Catalog groups include worktrees/history. Only an official project ID may be sent to create.
      if (desired) selected = result.projects?.find(project => normalizedProjectPath(project.path) === normalizedProjectPath(desired.path))?.projectId ?? '__unavailable__';
      const options = [];
      if (result.projectless) options.push(Object.assign(node('option', '', '独立聊天'), { value: '' }));
      for (const project of result.projects ?? []) options.push(Object.assign(node('option', '', project.name || project.path || project.projectId), { value: project.projectId }));
      if (!options.some(option => option.value === selected)) options.unshift(Object.assign(node('option', '', selected === '__unavailable__' ? '当前分组不能新建，请选择官方项目' : selected ? '已保存项目暂不可用，请重新选择' : '请选择项目'), { value: '__unavailable__', disabled: true }));
      creationSelectedProjectId = selected;
      createProject.replaceChildren(...options); createProject.value = options.some(option => option.value === selected) ? selected : '__unavailable__';
      saveCreateDraft();
    } catch (error) { if (host === selectedHost && stamp === creationGeneration && creationOpen) { creation = null; creationError = error.message || '创建能力读取失败。'; } }
    finally { if (!destroyed && host === selectedHost && stamp === creationGeneration && creationOpen) { creationLoading = false; renderCreation(); } }
  }
  function openCreation() {
    if (destroyed || creationOpen) return;
    creationReturnDrawer = drawerOpen; if (drawerOpen) setDrawer(false);
    const saved = readCreateDraft(selectedHost); creationSelectedProjectId = saved.projectId; createProject.value = saved.projectId; createTitle.value = saved.title; createPrompt.value = saved.prompt;
    // A catalog filter only suggests a target for an empty form. Existing draft
    // intent and unresolved receipts retain their original official project.
    creationDesiredProject = !saved.prompt.trim() && !saved.title.trim() && !saved.projectId && selectedProject ? projects.find(project => project.id === selectedProject) ?? null : null;
    creation = null; creationError = ''; creationOpen = true; syncOverlays(); renderCreation(); void loadCreation(); createPrompt.focus();
  }
  function closeCreation({ save = true, restore = true } = {}) {
    if (!creationOpen) return;
    if (save) saveCreateDraft(); creationOpen = false; creationGeneration++; creationLoading = false; syncOverlays();
    if (restore && creationReturnDrawer) setDrawer(true); else newChat.focus();
  }
  async function submitCreation(event) {
    event.preventDefault(); if (creationBusy || !creationTargetValid() || !createPrompt.value.trim() || !api.createThread) return;
    const host = selectedHost, key = creationKey(), saved = saveCreateDraft(), attempt = gate.begin(key); if (!attempt) { renderCreation(); return; }
    const intent = { host, operationId: attempt.operationId, projectId: creationSelectedProjectId || null, prompt: createPrompt.value.trim(), ...(createTitle.value.trim() ? { title: createTitle.value.trim() } : {}) };
    const openedGeneration = creationGeneration; creationBusy = true; creationResult = null; renderCreation();
    let result;
    try { result = await api.createThread(intent); if (result?.status === 'confirmed' && !validCreatedId(result.threadId)) result = { status: 'unknown', message: '创建结果缺少有效聊天 ID，请返回列表核对；不会自动重发。' }; gate.settle(key, result); }
    catch { result = { status: 'unknown', message: '创建结果未确认，请返回列表核对；不会自动重发。' }; gate.settle(key, result); }
    creationBusy = false;
    if (destroyed) return;
    if (result?.status === 'confirmed') {
      creationResult = { host, threadId: result.threadId };
      if (JSON.stringify(createDrafts.get(host)) === JSON.stringify(saved)) { createDrafts.set(host, { projectId: saved.projectId, title: '', prompt: '' }); try { draftStorage?.removeItem(createDraftKey(host)); } catch {} }
      if (host === selectedHost && creationOpen && openedGeneration === creationGeneration) { closeCreation({ save: false, restore: false }); void loadThreads(); await selectThread(result.threadId); return; }
    }
    if (host === selectedHost) { renderCreation(); void loadThreads(); }
  }
  function catalogScope() { return JSON.stringify([hostGeneration, selectedHost, selectedProject, selectedRange, search.value.trim()]); }
  function filteredThreads() {
    const query = search.value.trim().toLocaleLowerCase();
    // Local filtering is just a debounce preview. The server's search result is
    // authoritative and may match multiple terms across title/project/path.
    if (!query || loadedQuery === query) return threads;
    const terms = query.split(/\s+/).filter(Boolean);
    return threads.filter(item => { const text = [item.title, item.projectName, item.cwd, item.projectPath].map(value => String(value ?? '')).join(' ').toLocaleLowerCase(); return terms.every(term => text.includes(term)); });
  }
  function rowStatus(item) {
    if (item.id === selectedId) return { status: statusType(state), confirmed: connected && state?.ownerConfirmed === true && !isHistoryOnly(state) };
    return { status: typeof item.status === 'string' ? item.status : item.status?.type, confirmed: item.statusConfirmed === true };
  }
  function updateRowStatus(item, controls) {
    const live = rowStatus(item); controls.spinner.hidden = !live.confirmed || !['running', 'working', 'inProgress'].includes(live.status);
    const label = live.confirmed ? statusLabels[live.status] || '状态待同步' : '状态待同步';
    if (controls.meta.textContent !== label) controls.meta.textContent = label;
  }
  function clearStatusConfirmations() { threads = threads.map(item => ({ ...item, statusConfirmed: false })); }
  function stopStatuses() {
    cancel(statusTimer); statusTimer = null; statusGeneration++;
    if (statusPending) { cancel(statusPending.timeout); statusPending.controller.abort(); }
    statusPending = null;
  }
  async function pollStatuses() {
    if (destroyed || !drawerOpen || doc.visibilityState === 'hidden' || !api.getThreadStatuses || listLoading || statusPending) return;
    const ids = [...new Set(filteredThreads().map(item => item.id))].slice(0, 100); if (!ids.length) return;
    const host = selectedHost, scope = catalogScope(), stamp = statusGeneration, attempt = { controller: new AbortController(), timeout: null }; statusPending = attempt;
    const current = () => !destroyed && drawerOpen && doc.visibilityState !== 'hidden' && host === selectedHost && scope === catalogScope() && stamp === statusGeneration && statusPending === attempt;
    try {
      const deadline = new Promise((_, reject) => { attempt.timeout = later(() => { attempt.controller.abort(); reject(Error('状态读取超时')); }, readTimeoutMs); });
      const result = await Promise.race([api.getThreadStatuses(host, ids, { signal: attempt.controller.signal }), deadline]); if (!current()) return;
      const found = new Map((result.statuses ?? []).filter(item => ids.includes(item.id)).map(item => [item.id, item]));
      // A missing/failed observation is unknown. Never carry an old running flag forward.
      threads = threads.map(item => { const fresh = found.get(item.id); return { ...item, status: fresh?.status ?? 'unknown', statusConfirmed: fresh?.statusConfirmed === true, observedAt: fresh?.observedAt }; });
      renderThreads();
    } catch { if (current()) { clearStatusConfirmations(); renderThreads(); } }
    finally { cancel(attempt.timeout); if (current()) { statusPending = null; statusTimer = later(() => { statusTimer = null; void pollStatuses(); }, 10000); } }
  }
  function renderHosts() {
    const signature = JSON.stringify([selectedHost, hosts]); if (signature === hostSignature) return; hostSignature = signature;
    const choices = hosts.length ? hosts : [{ id: 'mac', name: 'Mac' }, { id: 'windows', name: 'Windows' }];
    hostSwitch.replaceChildren(...choices.map((host) => {
      const b = button(host.name || (host.id === 'mac' ? 'Mac' : 'Windows'), 'host-button', () => selectHost(host.id));
      b.classList.toggle('selected', host.id === selectedHost); b.setAttribute('aria-pressed', String(host.id === selectedHost));
      if (host.online === false) { b.classList.add('host-offline'); b.setAttribute('aria-label', (host.name || host.id) + '，离线'); }
      return b;
    }));
  }
  function renderThreads() {
    const query = search.value.trim().toLocaleLowerCase(), filtered = filteredThreads();
    const signature = JSON.stringify([selectedHost, selectedId, selectedProject, selectedRange, query, filtered, projects, nextCursor, listTotal, catalogPartial, listLoading, listError, hostError]); if (signature === threadSignature) return; threadSignature = signature;
    const options = [Object.assign(node('option', '', '全部项目'), { value: '' })];
    for (const project of projects) {
      const counts = selectedRange === 'week' && project.count === 0 && project.totalCount > 0 ? '本周0 · 全部' + project.totalCount : String(project.count ?? project.totalCount ?? 0);
      const option = node('option', '', (project.name || project.path || '未分组') + '（' + counts + '）'); option.value = project.id; options.push(option);
    }
    if (selectedProject && !projects.some(project => project.id === selectedProject)) options.push(Object.assign(node('option', '', '当前项目'), { value: selectedProject }));
    projectSelect.replaceChildren(...options); projectSelect.value = selectedProject; rangeSelect.value = selectedRange;
    catalogHint.textContent = [selectedRange === 'week' ? '最近7天' : '全部历史', listTotal == null ? '' : '共' + listTotal + '条', listLoading ? (query ? '正在搜索…' : '正在读取…') : '', catalogPartial ? '部分目录暂不可读' : ''].filter(Boolean).join(' · ');
    threadRowViews.clear(); const children = [], groups = new Map();
    for (const item of filtered) {
      const row = button('', 'thread-row', () => selectThread(item.id)); row.classList.toggle('selected', item.id === selectedId);
      const rowHeading = node('span', 'thread-row-heading'), spinner = node('span', 'running-indicator row-running'); spinner.setAttribute('role', 'img'); spinner.setAttribute('aria-label', '进行中');
      rowHeading.append(node('span', 'thread-row-title', item.title || '未命名对话'), spinner); row.append(rowHeading);
      const meta = node('span', 'thread-row-meta'); row.append(meta); threadRowViews.set(item.id, { spinner, meta, item }); updateRowStatus(item, { spinner, meta });
      if (item.id === selectedId) row.setAttribute('aria-current', 'page');
      if (!selectedProject && projects.length) {
        const key = item.projectId ?? '', project = projects.find(p => p.id === key); let group = groups.get(key);
        if (!group) { group = node('section', 'project-group'); group.append(node('h3', 'project-group-title', project?.name || item.projectName || '未分组')); groups.set(key, group); children.push(group); }
        group.append(row);
      } else children.push(row);
    }
    threadList.replaceChildren(...children); more.hidden = !nextCursor; more.disabled = listLoading; more.textContent = listLoading ? '正在读取…' : '加载更多';
    if (hostError || listError) threadList.append(node('p', 'list-empty', [hostError, listError].filter(Boolean).join('；')));
    else if (!filtered.length) threadList.append(node('p', 'list-empty', listLoading ? '正在读取对话…' : query ? '当前范围没有匹配对话，可切换全部历史' : selectedRange === 'week' ? '最近7天没有对话，可切换全部历史' : '这台电脑暂未返回已有对话'));
  }
  function writeAllowed(action) { return canAct(state, action, connected); }
  function sendKey(text) { return JSON.stringify([currentScope(), 'send', fingerprint(text)]); }
  function renderStatus() {
    title.textContent = state?.title || (selectedId ? '正在读取对话…' : 'Codex 随行');
    subtitle.textContent = state ? (hosts.find((host) => host.id === selectedHost)?.name || selectedHost) + (isHistoryOnly(state) ? ' · 只读历史' : ' · 原桌面会话') : '选择一个已有对话';
    connectionLabel.textContent = !connected && failureSince != null ? (now() - failureSince >= 15000 ? '暂时无法连接' : '正在恢复连接') : isHistoryOnly(state) ? '只读历史 · 原会话未连接' : loading ? '正在读取会话…' : !selectedId ? '选择电脑和已有对话' : !connected ? '连接中断 · 状态待核实' : !state?.ownerConfirmed ? '等待确认原会话连接' : state?.questions?.length ? '已连接 · 等待回答' : state?.approvals?.length ? '已连接 · 等待审批' : '已连接 · ' + (statusLabels[statusType(state)] || '状态待同步');
    connection.classList.toggle('disconnected', !!selectedId && !connected);
    titleRunning.hidden = !connected || state?.ownerConfirmed !== true || isHistoryOnly(state) || !isRunning(state);
    const selectedRow = threadRowViews.get(selectedId); if (selectedRow) updateRowStatus(selectedRow.item, selectedRow);
    const attempt = gate.get(sendKey(input.value.trim()));
    input.disabled = !selectedId;
    send.disabled = !input.value.trim() || !writeAllowed('send') || !!attempt && attempt.status !== 'rejected';
    send.textContent = isRunning(state) ? '补充方向' : '发送';
    interrupt.hidden = !state?.activeTurnId;
    const stopAttempt = gate.get(JSON.stringify([currentScope(), 'interrupt', state?.activeTurnId]));
    interrupt.disabled = !writeAllowed('interrupt') || !!stopAttempt && stopAttempt.status !== 'rejected';
    composerHint.textContent = !selectedId ? '先选择对话' : isHistoryOnly(state) ? '只读历史，原会话未连接；草稿会保留' : !connected ? '连接恢复后才能发送，草稿会保留' : !state?.ownerConfirmed ? '等待原会话确认，草稿会保留' : !writeAllowed('send') ? (isRunning(state) ? '运行中，当前连接暂不支持补充方向' : '当前状态只读，不能发送') : isRunning(state) ? '运行中发送会补充当前方向' : '继续这个对话';
    draftHint.textContent = attempt?.status === 'unknown' ? '结果未确认，此内容已禁止重复发送' : attempt?.status === 'submitted' ? '已提交，保留草稿并等待确认' : '草稿只保存在本设备';
  }
  function renderMessages() {
    if (!state) { messages.replaceChildren(); requests.replaceChildren(); empty.hidden = false; return; }
    const scope = scopeOf(state); if (scope !== messageScope) { messageNodes.clear(); messageScope = scope; }
    const rows = dedupeMessages(state.messages), children = [];
    rows.forEach((message, index) => {
      const key = JSON.stringify([message.role, message.id ?? ['position', index]]);
      let item = messageNodes.get(key);
      if (!item) {
        const el = node('article', 'message ' + (message.role === 'user' ? 'message-user' : 'message-assistant'));
        const who = node('p', 'message-role', message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : '系统');
        const body = node('div', 'message-body'); el.append(who, body); item = { el, body, text: null }; messageNodes.set(key, item);
      }
      if (item.text !== message.text) { renderSafeText(item.body, message.text, { markdown: message.role === 'assistant' }); item.text = message.text; }
      children.push(item.el);
    });
    for (const [key, item] of messageNodes) if (!children.includes(item.el)) messageNodes.delete(key);
    reconcile(messages, children);
    empty.hidden = !!rows.length || !!state.questions?.length || !!state.approvals?.length;
    empty.textContent = connected ? '这个对话暂未返回消息。' : '暂未取得对话内容，连接恢复后可刷新。';
  }
  function requestKey(type, request) { return JSON.stringify([currentScope(), type, request.id, fingerprint(stringify(request))]); }
  function currentRequest(type, request) { const list = type === 'answer' ? state?.questions : state?.approvals; return list?.some((item) => item.id === request.id && stringify(item) === stringify(request)); }
  function requestStatus(card, key) { const attempt = gate.get(key); if (attempt) { const p = node('p', 'request-status', attempt.message); p.setAttribute('role', 'status'); card.append(p); } }
  function renderQuestion(request) {
    const key = requestKey('answer', request), card = node('section', 'request-card question-card'); card.dataset.requestId = String(request.id);
    card.append(node('p', 'card-eyebrow', 'Codex 需要你的回答'), node('h2', '', request.title || '请回答以下问题'));
    let response = answers.get(key); if (!response) { response = new Map(); answers.set(key, response); }
    const locked = !!gate.get(key) && gate.get(key).status !== 'rejected';
    const submit = button('提交回答', 'primary-button', () => {
      if (!currentRequest('answer', request)) { showNotice('问题已变化，请按最新问题回答。'); return; }
      const result = Object.create(null);
      for (const question of request.questions ?? []) {
        const draft = response.get(question.id), chosen = [...(draft?.selected ?? [])];
        if (draft?.other.trim()) chosen.push(draft.other.trim()); result[question.id] = chosen;
      }
      if (Object.values(result).some((values) => !values.length)) return;
      dispatch({ action: 'answer', requestId: request.id, answers: result }, key);
    });
    const complete = () => (request.questions?.length ?? 0) > 0 && request.questions.every((question) => { const draft = response.get(question.id); return draft?.selected.size || draft?.other.trim(); });
    const updateSubmit = () => { submit.disabled = locked || !writeAllowed('answer') || !complete(); };
    for (const question of request.questions ?? []) {
      const field = node('fieldset', 'question-field'); field.append(node('legend', '', question.question || question.id));
      let draft = response.get(question.id); if (!draft) { draft = { selected: new Set(), other: '' }; response.set(question.id, draft); }
      for (const option of question.options ?? []) {
        const label = node('label', 'question-option'), check = node('input'); check.type = 'checkbox'; check.checked = draft.selected.has(option.label); check.disabled = locked || !writeAllowed('answer');
        const copy = node('span', 'option-copy'); copy.append(node('strong', '', option.label)); if (option.description) copy.append(node('span', 'option-description', option.description));
        check.addEventListener('change', () => { if (check.checked) draft.selected.add(option.label); else draft.selected.delete(option.label); updateSubmit(); });
        label.append(check, copy); field.append(label);
      }
      if (question.allowOther || !question.options?.length) {
        const other = node('textarea', 'answer-input'); other.rows = 2; other.value = draft.other; other.placeholder = question.options?.length ? '其他补充（可选）' : '输入你的回答'; other.setAttribute('aria-label', question.question || '输入回答'); other.disabled = locked || !writeAllowed('answer');
        other.addEventListener('input', () => { draft.other = other.value; updateSubmit(); }); field.append(other);
      }
      card.append(field);
    }
    updateSubmit(); card.append(submit); requestStatus(card, key); return card;
  }
  function renderApproval(request) {
    const key = requestKey('approval', request), card = node('section', 'request-card approval-card'); card.dataset.requestId = String(request.id);
    card.append(node('p', 'card-eyebrow', '等待你的审批'), node('h2', '', request.type === 'command' ? '是否允许执行？' : request.type === 'file' ? '是否允许修改文件？' : '请核对这次操作'));
    card.append(node('p', 'approval-reason', request.reason || '此请求未提供原因，请在原会话核对。'));
    if (request.command) { card.append(node('h3', 'detail-label', '完整命令')); const pre = node('pre', 'approval-command'); pre.append(node('code', '', request.command)); card.append(pre); }
    if (request.files?.length) { card.append(node('h3', 'detail-label', '涉及文件')); for (const file of request.files) card.append(node('pre', 'approval-file', typeof file === 'string' ? file : stringify(file))); }
    if (request.details != null) { const details = node('details', 'approval-details'); details.append(node('summary', '', '查看完整详情'), node('pre', '', typeof request.details === 'string' ? request.details : stringify(request.details))); card.append(details); }
    const controls = node('div', 'approval-actions'), prior = gate.get(key), locked = prior && prior.status !== 'rejected';
    for (const choice of request.choices ?? []) {
      const b = button(choice.label, /deny|reject|decline/.test(String(choice.id)) ? 'secondary-button' : 'primary-button', () => {
        if (!currentRequest('approval', request)) { showNotice('审批内容已变化，请核对最新操作。'); return; }
        dispatch({ action: 'approval', requestId: request.id, choice: choice.id }, key);
      });
      b.disabled = !!locked || !writeAllowed('approval'); controls.append(b);
    }
    card.append(controls); if (!request.choices?.length) card.append(node('p', 'request-status', '此审批暂不支持手机处理，请在原桌面中查看。'));
    requestStatus(card, key); return card;
  }
  function renderRequests() {
    const signature = JSON.stringify([currentScope(), state?.questions, state?.approvals, writeAllowed('answer'), writeAllowed('approval'), [...gate.attempts]]);
    if (signature === cardsSignature) return; cardsSignature = signature;
    requests.replaceChildren(...(state?.questions ?? []).map(renderQuestion), ...(state?.approvals ?? []).map(renderApproval));
  }
  // Streaming messages do not change navigation. Keep large, usually hidden lists off this hot path.
  function render({ navigation = false } = {}) { if (navigation) { renderHosts(); renderThreads(); } renderStatus(); renderMessages(); renderRequests(); }

  function update(next) {
    if (destroyed || !next || !next.id || !next.host) return false;
    const navigated = !selectedId;
    if (navigated) {
      if (selectedHost !== next.host) { hostGeneration++; threads = []; listLoading = false; listError = ''; hostError = ''; }
      selectedHost = next.host; selectedId = next.id; input.value = draft(currentScope()); autoSize();
    }
    if (next.host !== selectedHost || next.id !== selectedId) return false;
    if (state?.connectionId === next.connectionId && typeof next.revision === 'number' && typeof state.revision === 'number' && next.revision < state.revision) return false;
    const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 100;
    // Disk history can display messages, but it can never establish a live owner or authorize writes.
    state = next; connected = next.connected === true && next.ownerConfirmed === true && !isHistoryOnly(next); loading = false;
    render({ navigation: navigated }); if (atBottom) main.scrollTop = main.scrollHeight; return true;
  }
  async function loadThreads({ append = false } = {}) {
    if (!api.getThreads || destroyed || append && (!nextCursor || listLoading)) return;
    const host = selectedHost, stamp = hostGeneration, request = ++listRequest, scope = catalogScope(), cursor = append ? nextCursor : null;
    const current = () => !destroyed && stamp === hostGeneration && host === selectedHost && scope === catalogScope() && request === listRequest;
    stopStatuses(); listLoading = true; listError = ''; renderThreads();
    try {
      const result = await api.getThreads(host, { projectId: selectedProject || undefined, q: search.value.trim() || undefined, cursor, limit: 50, range: selectedRange }); if (!current()) return;
      const rows = result.threads ?? [];
      loadedQuery = search.value.trim().toLocaleLowerCase();
      threads = append ? [...new Map([...threads, ...rows].map(item => [item.id, item])).values()] : rows;
      if (Array.isArray(result.projects)) projects = result.projects;
      nextCursor = result.nextCursor ?? null; listTotal = Number.isFinite(result.total) ? result.total : null; catalogPartial = result.catalog?.partial === true;
    } catch (error) { if (current()) { listError = error.message || '对话列表读取失败，原有草稿已保留。'; if (!selectedId) showNotice(listError); } }
    finally { if (current()) { listLoading = false; renderThreads(); void pollStatuses(); } }
  }
  function changeCatalog() {
    cancel(searchTimer); searchTimer = null; listRequest++; stopStatuses(); nextCursor = null; threads = []; listTotal = null; listError = ''; renderThreads(); void loadThreads();
  }
  async function selectHost(host) {
    if (destroyed || host === selectedHost && (selectedId || threads.length)) return;
    if (selectedId) saveDraft(currentScope(), input.value);
    if (creationOpen) closeCreation({ restore: false });
    cancel(searchTimer); searchTimer = null; stopStatuses();
    generation++; hostGeneration++; const stamp = hostGeneration;
    stopReadAndStream(); clearRecovery(); state = null; selectedHost = host; selectedId = ''; connected = false; loading = false;
    threads = []; projects = []; selectedProject = ''; selectedRange = 'week'; rangeSelect.value = 'week'; search.value = ''; nextCursor = null; listTotal = null; listLoading = false; listError = ''; hostError = ''; input.value = ''; showNotice(''); render({ navigation: true });
    onNavigate({ host, id: null });
    if (api.getHosts) void loadHosts({ background: true, loadList: false });
    await loadThreads(); if (!destroyed && stamp === hostGeneration && !selectedId) setDrawer(true);
  }
  async function selectThread(id) {
    if (destroyed) return;
    if (selectedId) saveDraft(currentScope(), input.value);
    generation++; const host = selectedHost; stopReadAndStream(); clearRecovery();
    state = null; selectedId = id; connected = false; loading = true; input.value = draft(currentScope()); cardsSignature = ''; showNotice(''); autoSize(); setDrawer(false); render({ navigation: true }); onNavigate({ host, id });
    return readCurrent();
  }
  function clearRecovery() {
    cancel(retryTimer); cancel(recoveryTimer); retryTimer = recoveryTimer = null; failureSince = null; retryStep = 0;
  }
  function stopReadAndStream() {
    // Navigation and each recovery retire the entire attempt, including callbacks
    // for the same host/id. A late response may belong to an obsolete owner.
    attemptGeneration++; cancel(wakeTimer); wakeTimer = null; cancel(retryTimer); retryTimer = null; cancel(heartbeatTimer); heartbeatTimer = null;
    closeEvents(); closeEvents = () => {};
    if (readAttempt) {
      cancel(readAttempt.timeout); readAttempt.controller.abort(); readAttempt.reject?.(Error('读取已取消。')); readAttempt = null;
    }
  }
  function markRecovering(error = '') {
    connected = false; loading = false;
    if (failureSince == null) {
      failureSince = now();
      recoveryTimer = later(() => { recoveryTimer = null; if (!destroyed && !connected && failureSince != null) { recoveryMessage(); renderStatus(); } }, 15000);
    }
    recoveryMessage(error); render();
  }
  function recoveryMessage(error = '') {
    // Recovery must not replace an unknown/pending operation notice or its guard.
    if (!noticeText || recoveryNotice) showNotice((error ? error + ' ' : '') +
      (now() - failureSince >= 15000 ? '暂时无法连接，将继续自动恢复。' : '正在恢复连接。') + '草稿已保留，操作不会自动重发。', true);
  }
  function scheduleRead() {
    if (destroyed || !selectedId || retryTimer != null) return;
    const delay = [1000, 2000, 4000, 8000, 15000][Math.min(retryStep++, 4)];
    retryTimer = later(() => { retryTimer = null; void readCurrent(); }, delay);
  }
  function recover({ immediate = false, error = '' } = {}) {
    if (destroyed || !selectedId) return Promise.resolve();
    // Repeated browser hints join the current GET rather than aborting it and
    // opening more connections. POSTs never enter this scheduler.
    if (readAttempt) return readAttempt.promise;
    stopReadAndStream(); markRecovering(error);
    if (immediate) return readCurrent();
    scheduleRead(); return Promise.resolve();
  }
  function watchHeartbeat(current) {
    cancel(heartbeatTimer);
    heartbeatTimer = later(() => { heartbeatTimer = null; if (current()) void recover(); }, heartbeatTimeoutMs);
  }
  function readCurrent() {
    if (destroyed || !selectedId || !api.getThread) return Promise.resolve();
    if (readAttempt) return readAttempt.promise;
    cancel(retryTimer); retryTimer = null;
    const host = selectedHost, id = selectedId, navigation = generation, attemptId = ++attemptGeneration;
    const current = () => !destroyed && navigation === generation && attemptId === attemptGeneration && selectedHost === host && selectedId === id;
    const attempt = { controller: new AbortController(), timeout: null, promise: null, reject: null }; readAttempt = attempt;
    attempt.promise = (async () => {
      try {
        const timeout = new Promise((_, reject) => { attempt.timeout = later(() => { attempt.controller.abort(); reject(Error('读取超时。')); }, readTimeoutMs); });
        const cancelled = new Promise((_, reject) => { attempt.reject = reject; });
        const result = await Promise.race([api.getThread(host, id, { signal: attempt.controller.signal }), timeout, cancelled]);
        if (!current()) return;
        if (!update(result)) throw Error('返回的会话与当前电脑不匹配，请重新读取。');
        if (!connected) throw Error('原桌面会话尚未连接。');
        // subscribe() may report an unavailable EventSource synchronously. The
        // GET is complete, so that failure must start recovery rather than join it.
        cancel(attempt.timeout); if (readAttempt === attempt) readAttempt = null;
        if (recoveryNotice) showNotice(''); renderStatus();
        if (api.subscribe) {
          const owner = result.ownerId, connectionId = result.connectionId, streamStarted = now();
          const alive = () => {
            if (!current()) return;
            // A successful GET followed by a failing SSE must keep its backoff.
            // The initial cached state/open is not proof of a stable stream.
            if (now() - streamStarted >= 15000) clearRecovery();
            watchHeartbeat(current);
          };
          watchHeartbeat(current);
          const close = api.subscribe(host, id, {
            onHeartbeat: alive,
            onState: next => {
              if (!current()) return;
              if (next?.host !== host || next?.id !== id || next?.ownerId !== owner || next?.connectionId !== connectionId) { void recover(); return; }
              alive(); update(next);
              if (!connected) void recover();
            },
            // open/ping never grant authority. This subscription was opened only
            // after this attempt's fresh GET; errors retire it before retrying.
            onStatus: status => { if (!current()) return; if (status === 'connecting') watchHeartbeat(current); else void recover(); },
          });
          if (current()) closeEvents = typeof close === 'function' ? close : () => {}; else close?.();
        } else clearRecovery();
      } catch (error) {
        if (current()) { markRecovering(error.message); scheduleRead(); }
      } finally { cancel(attempt.timeout); if (readAttempt === attempt) readAttempt = null; }
    })();
    return attempt.promise;
  }
  async function refreshCurrent() {
    if (selectedId) return recover({ immediate: true });
    return loadThreads();
  }
  async function dispatch(action, key) {
    if (!writeAllowed(action.action)) return;
    const attempt = gate.begin(key); if (!attempt) return;
    const snapshot = state, scope = currentScope();
    renderStatus(); renderRequests();
    try {
      const response = await api.action(buildActionPayload(snapshot, { ...action, operationId: attempt.operationId }));
      gate.settle(key, response);
      // A transport ACK is not a new user message or a completed question/approval.
      if (action.action === 'send' && response?.status === 'confirmed') {
        if (draft(scope).trim() === action.text) saveDraft(scope, '');
        if (scope === currentScope() && input.value.trim() === action.text) { input.value = ''; autoSize(); }
      }
    } catch { gate.settle(key, { status: 'unknown' }); }
    if (destroyed || scope !== currentScope()) return;
    showNotice(gate.get(key).message); renderStatus(); renderRequests();
    // Refresh only the read path; never retry POST after a timeout or disconnect.
    await recover({ immediate: true });
  }
  function sendMessage(event) { event.preventDefault(); const text = input.value.trim(); if (text) return dispatch({ action: 'send', text }, sendKey(text)); }
  function stopTurn() { if (state?.activeTurnId) return dispatch({ action: 'interrupt' }, JSON.stringify([currentScope(), 'interrupt', state.activeTurnId])); }
  input.addEventListener('input', () => {
    const key = sendKey(input.value.trim());
    // Retyping a confirmed message is a new user intent; unknown/submitted attempts stay blocked.
    gate.forgetConfirmed(key);
    saveDraft(currentScope(), input.value); autoSize(); renderStatus();
  });
  input.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) sendMessage(event); });
  composer.addEventListener('submit', sendMessage);
  createForm.addEventListener('submit', submitCreation);
  for (const control of [createProject, createTitle, createPrompt]) control.addEventListener(control === createProject ? 'change' : 'input', () => {
    if (control === createProject && createProject.value !== '__unavailable__') creationSelectedProjectId = createProject.value;
    saveCreateDraft(); creationResult = null; gate.forgetConfirmed(creationKey()); renderCreation();
  });
  search.addEventListener('input', () => {
    cancel(searchTimer); listRequest++; stopStatuses(); nextCursor = null; renderThreads();
    searchTimer = later(() => { searchTimer = null; void loadThreads(); }, 250);
  });
  projectSelect.addEventListener('change', () => { selectedProject = projectSelect.value; changeCatalog(); });
  rangeSelect.addEventListener('change', () => { selectedRange = rangeSelect.value === 'all' ? 'all' : 'week'; changeCatalog(); });
  main.addEventListener('scroll', () => { latest.hidden = main.scrollHeight - main.scrollTop - main.clientHeight < 160; });
  const escape = (event) => { if (event.key === 'Escape') { if (creationOpen) closeCreation(); else if (drawerOpen) setDrawer(false); } };
  const wake = () => {
    if (destroyed || !selectedId || doc.visibilityState === 'hidden' || readAttempt) return;
    const delay = 500 - (now() - lastWakeAt);
    if (delay > 0) {
      // Keep the final online hint after a rapid handover. Dropping it could
      // leave a restored network waiting behind the full retry backoff.
      if (!connected && wakeTimer == null) wakeTimer = later(() => { wakeTimer = null; wake(); }, delay);
      return;
    }
    cancel(wakeTimer); wakeTimer = null; lastWakeAt = now(); void recover({ immediate: true });
  };
  const visibility = () => { if (doc.visibilityState !== 'hidden') { wake(); if (drawerOpen) { clearStatusConfirmations(); renderThreads(); void pollStatuses(); } } else stopStatuses(); };
  const offline = () => { if (!destroyed && selectedId) { stopReadAndStream(); markRecovering(); scheduleRead(); } };
  doc.addEventListener('keydown', escape); doc.addEventListener('visibilitychange', visibility); win?.addEventListener('online', wake); win?.addEventListener('offline', offline);
  win?.addEventListener('resize', resize); win?.visualViewport?.addEventListener('resize', resize); win?.visualViewport?.addEventListener('scroll', resize);
  resize(); render({ navigation: true });
  async function loadHosts({ background = !!selectedId, loadList = true } = {}) {
    const stamp = hostGeneration, host = selectedHost, request = ++hostsRequest;
    const current = () => !destroyed && stamp === hostGeneration && host === selectedHost && request === hostsRequest;
    try {
      const result = await api.getHosts(); if (!current()) return; hosts = result.hosts ?? []; hostError = '';
      // A URL-selected chat is authoritative navigation. A late host list must
      // never move its draft, owner or write context onto another computer.
      if (!background && !selectedId && !hosts.some((item) => item.id === selectedHost) && hosts.length) { selectedHost = hosts[0].id; hostGeneration++; }
      renderHosts(); renderThreads(); renderStatus();
      if (loadList) await loadThreads();
      if (!destroyed && !background && !selectedId) setDrawer(true);
    } catch (error) { if (current()) { hostError = error.message || '电脑列表读取失败。'; renderThreads(); if (!selectedId) showNotice(hostError); renderStatus(); } }
  }
  if (initialThreadId) {
    // The selected conversation is the first-screen dependency. Navigation
    // metadata loads alongside it and cannot authorize or delay a chat action.
    void selectThread(initialThreadId);
    void loadThreads();
    if (api.getHosts) void loadHosts({ background: true, loadList: false });
  } else if (api.getHosts) void loadHosts();
  return { update, selectHost, selectThread, refresh: refreshCurrent, loadHosts, openCreation,
    destroy() { destroyed = true; generation++; cancel(searchTimer); searchTimer = null; stopStatuses(); creationGeneration++; stopReadAndStream(); clearRecovery(); doc.removeEventListener('keydown', escape); doc.removeEventListener('visibilitychange', visibility); win?.removeEventListener('online', wake); win?.removeEventListener('offline', offline); win?.removeEventListener('resize', resize); win?.visualViewport?.removeEventListener('resize', resize); win?.visualViewport?.removeEventListener('scroll', resize); root.replaceChildren(); },
  };
}

export function startUI({ root = globalThis.document?.getElementById('app'), apiBase = '', api, ...options } = {}) {
  const win = root?.ownerDocument?.defaultView;
  const params = new URLSearchParams(win?.location?.search ?? '');
  return mountMobileUI(root, {
    initialHost: params.get('host') || 'mac', initialThreadId: params.get('id') || '',
    onNavigate: ({ host, id }) => { const query = new URLSearchParams({ host }); if (id) query.set('id', id); win?.history?.replaceState(null, '', '?' + query); },
    ...options, api: api || createMobileAPI({ apiBase }),
  });
}
