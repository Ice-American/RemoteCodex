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
    try {
      const records = JSON.parse(storage?.getItem(storageKey) || '[]');
      if (Array.isArray(records)) for (const [key, value] of records) {
        if (typeof key !== 'string' || !value || !['pending', 'unknown', 'confirmed', 'submitted'].includes(value.status) || typeof value.operationId !== 'string') continue;
        const status = value.status === 'pending' ? 'unknown' : value.status;
        this.attempts.set(key, { operationId: value.operationId, status, message: status === 'unknown' ? '上次操作的结果未确认。请先核对原会话，本次操作不会自动重发。' : '上次操作已提交，等待原会话状态同步。' });
      }
    } catch {}
  }
  persist() {
    try { this.storage?.setItem(this.storageKey, JSON.stringify([...this.attempts].filter(([, attempt]) => attempt.status !== 'rejected').map(([key, attempt]) => [key, { operationId: attempt.operationId, status: attempt.status }]))); } catch {}
  }
  forgetConfirmed(key) { if (this.get(key)?.status === 'confirmed') { this.attempts.delete(key); this.persist(); } }
  begin(key) {
    const prior = this.attempts.get(key);
    if (prior && prior.status !== 'rejected') return null;
    const attempt = { operationId: operationId(), status: 'pending', message: '正在提交…' };
    this.attempts.set(key, attempt);
    this.persist();
    return attempt;
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

export function createMobileAPI({ apiBase = '', fetchImpl = globalThis.fetch, EventSourceImpl = globalThis.EventSource } = {}) {
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
    getThreads: (host) => json(path('/api/threads', { host })),
    getThread: (host, id) => json(path('/api/thread', { host, id })),
    action: (body) => json(path('/api/action'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true),
    subscribe(host, id, { onState, onStatus }) {
      if (!EventSourceImpl) { onStatus('disconnected'); return () => {}; }
      const stream = new EventSourceImpl(path('/api/events', { host, id }), { withCredentials: true });
      stream.addEventListener('open', () => onStatus('connecting'));
      stream.addEventListener('state', (event) => {
        try { onState(JSON.parse(event.data)); } catch { onStatus('disconnected'); }
      });
      // EventSource may reconnect GET requests. It never resends a write or clears a draft.
      stream.addEventListener('error', () => onStatus('disconnected'));
      return () => stream.close();
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

export function mountMobileUI(root, { api, onNavigate = () => {}, initialHost = 'mac', initialThreadId = '', storage } = {}) {
  if (!root?.ownerDocument || !api) throw new Error('需要根节点和手机控制 API。');
  const doc = root.ownerDocument, win = doc.defaultView ?? globalThis.window;
  let draftStorage = storage;
  if (draftStorage === undefined) { try { draftStorage = win?.sessionStorage; } catch { draftStorage = null; } }
  let state = null, hosts = [], threads = [], selectedHost = initialHost, selectedId = '', generation = 0;
  let hostGeneration = 0, listRequest = 0, hostsRequest = 0, listLoading = false, listError = '', hostError = '';
  let connected = false, destroyed = false, closeEvents = () => {}, loading = false, drawerOpen = false;
  let cardsSignature = '', messageScope = '', hostSignature = '', threadSignature = '', noticeText = '';
  const drafts = new Map(), answers = new Map(), gate = new ActionGate({ storage: draftStorage }), messageNodes = new Map();
  const node = (tag, cls, text) => element(doc, tag, cls, text);
  const button = (text, cls, fn) => { const b = node('button', cls, text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
  const app = node('div', 'mobile-app'); app.setAttribute('lang', 'zh-CN');
  const header = node('header', 'app-header');
  const menu = button('对话列表', 'icon-button menu-button', () => setDrawer(!drawerOpen)); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-controls', 'thread-drawer');
  const heading = node('div', 'heading-group'), title = node('h1', 'thread-title', 'Codex 随行'), subtitle = node('p', 'thread-subtitle', '选择一个已有对话');
  heading.append(title, subtitle);
  const hostSwitch = node('div', 'host-switch'); hostSwitch.setAttribute('role', 'group'); hostSwitch.setAttribute('aria-label', '目标电脑');
  header.append(menu, heading, hostSwitch);
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
  const drawerHeading = node('div', 'drawer-heading'); drawerHeading.append(node('h2', '', '已有对话'), button('关闭', 'text-button', () => setDrawer(false)));
  const search = node('input', 'thread-search'); search.type = 'search'; search.placeholder = '搜索对话'; search.setAttribute('aria-label', '搜索已有对话');
  const threadList = node('nav', 'thread-list'); threadList.setAttribute('aria-label', '对话');
  drawer.append(drawerHeading, search, threadList);
  app.append(header, connection, notice, main, latest, composer, backdrop, drawer); root.replaceChildren(app);

  function storageKey(scope) { return 'codex-mobile-draft:' + scope; }
  function draft(scope) {
    if (!drafts.has(scope)) { let text = ''; try { text = draftStorage?.getItem(storageKey(scope)) ?? ''; } catch {} drafts.set(scope, text); }
    return drafts.get(scope);
  }
  function saveDraft(scope, text) { drafts.set(scope, text); try { if (text) draftStorage?.setItem(storageKey(scope), text); else draftStorage?.removeItem(storageKey(scope)); } catch {} }
  function currentScope() { return JSON.stringify([selectedHost, selectedId]); }
  function showNotice(text) { noticeText = text; notice.textContent = text; notice.hidden = !text; }
  function autoSize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight || 44, 168) + 'px'; }
  function resize() { const metrics = viewportMetrics(win?.visualViewport, win?.innerHeight); app.style.setProperty('--app-height', metrics.height + 'px'); app.style.setProperty('--app-top', metrics.top + 'px'); autoSize(); }
  function setDrawer(open) { drawerOpen = open; drawer.hidden = !open; backdrop.hidden = !open; menu.setAttribute('aria-expanded', String(open)); main.setAttribute('aria-hidden', String(open)); composer.setAttribute('aria-hidden', String(open)); main.inert = open; composer.inert = open; if (open) search.focus(); else menu.focus(); }
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
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = threads.filter((thread) => String(thread.title || '未命名对话').toLocaleLowerCase().includes(query));
    const signature = JSON.stringify([selectedHost, selectedId, query, filtered, listLoading, listError, hostError]); if (signature === threadSignature) return; threadSignature = signature;
    threadList.replaceChildren(...filtered.map((thread) => {
      const b = button('', 'thread-row', () => selectThread(thread.id)); b.classList.toggle('selected', thread.id === selectedId);
      b.append(node('span', 'thread-row-title', thread.title || '未命名对话'));
      const kind = typeof thread.status === 'string' ? thread.status : thread.status?.type;
      b.append(node('span', 'thread-row-meta', statusLabels[kind] || '状态待同步'));
      if (thread.id === selectedId) b.setAttribute('aria-current', 'page'); return b;
    }));
    if (hostError || listError) threadList.append(node('p', 'list-empty', [hostError, listError].filter(Boolean).join('；')));
    else if (!filtered.length) threadList.append(node('p', 'list-empty', listLoading ? '正在读取对话…' : query ? '没有找到匹配对话' : '这台电脑暂未返回已有对话'));
  }
  function writeAllowed(action) { return canAct(state, action, connected); }
  function sendKey(text) { return JSON.stringify([currentScope(), 'send', fingerprint(text)]); }
  function renderStatus() {
    title.textContent = state?.title || (selectedId ? '正在读取对话…' : 'Codex 随行');
    subtitle.textContent = state ? (hosts.find((host) => host.id === selectedHost)?.name || selectedHost) + (isHistoryOnly(state) ? ' · 只读历史' : ' · 原桌面会话') : '选择一个已有对话';
    connectionLabel.textContent = isHistoryOnly(state) ? '只读历史 · 原会话未连接' : loading ? '正在读取会话…' : !selectedId ? '选择电脑和已有对话' : !connected ? '连接中断 · 状态待核实' : !state?.ownerConfirmed ? '等待确认原会话连接' : state?.questions?.length ? '已连接 · 等待回答' : state?.approvals?.length ? '已连接 · 等待审批' : '已连接 · ' + (statusLabels[statusType(state)] || '状态待同步');
    connection.classList.toggle('disconnected', !!selectedId && !connected);
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
    state = next; connected = next.connected === true && !isHistoryOnly(next); loading = false;
    if (connected && /^连接已中断|^正在重新连接/.test(noticeText)) showNotice('');
    render({ navigation: navigated }); if (atBottom) main.scrollTop = main.scrollHeight; return true;
  }
  async function loadThreads() {
    if (!api.getThreads || destroyed) return;
    const host = selectedHost, stamp = hostGeneration, request = ++listRequest;
    const current = () => !destroyed && stamp === hostGeneration && host === selectedHost && request === listRequest;
    listLoading = true; listError = ''; renderThreads();
    try { const result = await api.getThreads(host); if (!current()) return; threads = result.threads ?? []; }
    catch (error) { if (current()) { listError = error.message || '对话列表读取失败，原有草稿已保留。'; if (!selectedId) showNotice(listError); } }
    finally { if (current()) { listLoading = false; renderThreads(); } }
  }
  async function selectHost(host) {
    if (destroyed || host === selectedHost && (selectedId || threads.length)) return;
    if (selectedId) saveDraft(currentScope(), input.value);
    generation++; hostGeneration++; const stamp = hostGeneration;
    closeEvents(); closeEvents = () => {}; state = null; selectedHost = host; selectedId = ''; connected = false; loading = false;
    threads = []; listLoading = false; listError = ''; hostError = ''; input.value = ''; showNotice(''); render({ navigation: true });
    onNavigate({ host, id: null });
    if (api.getHosts) void loadHosts({ background: true, loadList: false });
    await loadThreads(); if (!destroyed && stamp === hostGeneration && !selectedId) setDrawer(true);
  }
  async function selectThread(id) {
    if (destroyed) return;
    if (selectedId) saveDraft(currentScope(), input.value);
    generation++; const stamp = generation, host = selectedHost; closeEvents(); closeEvents = () => {};
    state = null; selectedId = id; connected = false; loading = true; input.value = draft(currentScope()); cardsSignature = ''; showNotice(''); autoSize(); setDrawer(false); render({ navigation: true }); onNavigate({ host, id });
    try {
      const result = await api.getThread(host, id); if (destroyed || stamp !== generation) return;
      if (!update(result)) throw new Error('返回的会话与当前电脑不匹配，请刷新后重试。');
      if (api.subscribe) closeEvents = api.subscribe(host, id, {
        onState: (next) => { if (stamp === generation && !destroyed) update(next); },
        onStatus: (status) => { if (stamp !== generation || destroyed) return; connected = false; showNotice(status === 'connecting' ? '正在重新连接，等待原会话状态。草稿已保留。' : '连接已中断，草稿已保留。恢复连接后会自动读取状态，不会重发操作。'); render(); },
      });
    } catch (error) { if (stamp === generation && !destroyed) { loading = false; connected = false; showNotice(error.message || '对话读取失败，草稿已保留。'); render(); } }
  }
  async function refreshCurrent() {
    if (selectedId) return selectThread(selectedId);
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
    try { const next = await api.getThread(selectedHost, selectedId); if (scope === currentScope() && !destroyed) update(next); } catch {}
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
  search.addEventListener('input', renderThreads);
  main.addEventListener('scroll', () => { latest.hidden = main.scrollHeight - main.scrollTop - main.clientHeight < 160; });
  const escape = (event) => { if (event.key === 'Escape' && drawerOpen) setDrawer(false); };
  doc.addEventListener('keydown', escape); win?.addEventListener('resize', resize); win?.visualViewport?.addEventListener('resize', resize); win?.visualViewport?.addEventListener('scroll', resize);
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
  return { update, selectHost, selectThread, refresh: refreshCurrent, loadHosts,
    destroy() { destroyed = true; generation++; closeEvents(); doc.removeEventListener('keydown', escape); win?.removeEventListener('resize', resize); win?.visualViewport?.removeEventListener('resize', resize); win?.visualViewport?.removeEventListener('scroll', resize); root.replaceChildren(); },
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
