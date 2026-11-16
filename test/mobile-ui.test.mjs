import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ActionGate, buildActionPayload, canAct, createMobileAPI, dedupeMessages,
  mountMobileUI, renderSafeText, viewportMetrics,
} from '../mobile/public/render.mjs';

// A deliberately small DOM fixture rejects HTML injection. Browser layout is checked separately.
class FixtureNode {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null;
    this.className = ''; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.value = ''; this.hidden = false; this.disabled = false; this._text = ''; this.scrollTop = 0;
    this.scrollHeight = 400; this.clientHeight = 500;
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.classList = {
      contains: (token) => this.className.split(/\s+/).includes(token),
      toggle: (token, enabled) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); const add = enabled ?? !names.has(token); if (add) names.add(token); else names.delete(token); this.className = [...names].join(' '); return add; },
      add: (token) => this.classList.toggle(token, true),
    };
  }
  set innerHTML(_) { throw new Error('HTML injection is forbidden in the fixture'); }
  set textContent(value) { this._text = String(value ?? ''); this.replaceChildren(); }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(''); }
  get children() { return this.childNodes.filter((node) => node.tagName !== '#TEXT'); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...nodes); }
  insertBefore(node, sibling) { node.remove(); const index = sibling ? this.childNodes.indexOf(sibling) : this.childNodes.length; node.parentNode = this; this.childNodes.splice(index, 0, node); }
  remove() { if (!this.parentNode) return; const siblings = this.parentNode.childNodes; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  fire(type, values = {}) { const event = { preventDefault() {}, ...values }; for (const listener of this.listeners.get(type) ?? []) listener(event); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
}
function fixtureDOM() {
  const data = new Map(), storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const doc = { createElement: (tag) => new FixtureNode(tag, doc), createTextNode: (text) => { const n = new FixtureNode('#text', doc); n._text = text; return n; }, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = { innerHeight: 844, visualViewport: { height: 844, offsetTop: 0, addEventListener() {}, removeEventListener() {} }, sessionStorage: storage, addEventListener() {}, removeEventListener() {} };
  const root = doc.createElement('div'); return { root, doc, storage };
}
const descendants = (node) => [node, ...node.childNodes.flatMap(descendants)];
const byClass = (root, cls) => descendants(root).filter((node) => node.classList.contains(cls));
const one = (root, cls) => { const found = byClass(root, cls); assert.equal(found.length, 1, cls); return found[0]; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const thread = (overrides = {}) => ({
  host: 'mac', id: '11111111-1111-4111-8111-111111111111', title: '手机适配', connected: true,
  ownerConfirmed: true, connectionId: 'connection-1', ownerId: 'desktop-owner', revision: 1,
  activeTurnId: null, status: 'idle', messages: [{ id: 'a1', role: 'assistant', text: '原会话回复' }],
  questions: [], approvals: [], capabilities: { send: true, steer: true, answer: true, approve: true, interrupt: true }, ...overrides,
});
function mount(t, api = {}, options = {}) {
  const dom = fixtureDOM(), view = mountMobileUI(dom.root, { ...options, api, storage: dom.storage }); t.after(() => view.destroy()); return { ...dom, view };
}
function type(root, text) { const input = one(root, 'message-input'); input.value = text; input.fire('input'); return input; }

test('all user text and the minimal Markdown subset stay inert DOM text', () => {
  const { root } = fixtureDOM();
  const unsafe = '<img src=x onerror=alert(1)>\n<script>steal()</script>\n[open](javascript:alert(1))';
  renderSafeText(root, unsafe); assert.equal(root.textContent, unsafe);
  renderSafeText(root, '# 标题\n\n**强调** and `code`\n\n```html\n' + unsafe + '\n```', { markdown: true });
  const tags = descendants(root).map((node) => node.tagName);
  assert.ok(tags.includes('H3')); assert.ok(tags.includes('STRONG')); assert.ok(tags.includes('PRE'));
  for (const forbidden of ['SCRIPT', 'IMG', 'A', 'IFRAME', 'STYLE']) assert.ok(!tags.includes(forbidden));
  assert.ok(root.textContent.includes(unsafe));
});

test('message identity replaces streaming snapshots without collapsing intentional equal text', () => {
  const items = [{ id: 'a', role: 'assistant', text: '半句' }, { id: 'u1', role: 'user', text: '继续' }, { id: 'a', role: 'assistant', text: '完整句子' }, { id: 'u2', role: 'user', text: '继续' }, { role: 'user', text: '无ID' }, { role: 'user', text: '无ID' }];
  assert.deepEqual(dedupeMessages(items).map((message) => message.text), ['完整句子', '继续', '继续', '无ID', '无ID']);
});

test('action gate blocks concurrent and unknown operations; a rejected operation may be attempted explicitly', () => {
  const gate = new ActionGate(), first = gate.begin('request');
  assert.match(first.operationId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
  assert.equal(gate.begin('request'), null);
  gate.settle('request', { status: 'unknown' }); assert.equal(gate.begin('request'), null);
  gate.begin('other'); gate.settle('other', { status: 'rejected' });
  assert.notEqual(gate.begin('other').operationId, first.operationId);
});

test('reopening the page preserves pending/unknown guards without storing request bodies', () => {
  const { storage } = fixtureDOM(), first = new ActionGate({ storage });
  const pending = first.begin('opaque-request-fingerprint');
  const reopened = new ActionGate({ storage });
  assert.equal(reopened.get('opaque-request-fingerprint').status, 'unknown');
  assert.equal(reopened.get('opaque-request-fingerprint').operationId, pending.operationId);
  assert.equal(reopened.begin('opaque-request-fingerprint'), null);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('codex-mobile-operation-guards'))[0][1]).sort(), ['operationId', 'status']);
});

test('writes require the real connection owner and snapshot; running sends use steer capability', () => {
  const state = thread({ activeTurnId: 'turn-1', status: 'running', capabilities: { send: false, steer: true } });
  assert.equal(canAct(state, 'send'), true);
  const payload = buildActionPayload(state, { operationId: 'operation', action: 'send', text: '补充', ownerId: 'forged', revision: 99, unwanted: 'drop' });
  assert.deepEqual(payload, { host: 'mac', threadId: state.id, operationId: 'operation', connectionId: 'connection-1', revision: 1, ownerId: 'desktop-owner', activeTurnId: 'turn-1', action: 'send', text: '补充' });
  for (const patch of [{ ownerConfirmed: false }, { connected: false }, { connectionId: null }, { ownerId: null }, { revision: null }, { capabilities: { send: true, steer: false } }]) assert.equal(canAct({ ...state, ...patch }, 'send'), false);
  assert.equal(canAct(thread(), 'interrupt'), false);
});

test('relative API paths carry cookies and exact action JSON, with no write retry', async () => {
  const calls = [], fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ hosts: [], status: 'submitted' }) }; };
  const api = createMobileAPI({ fetchImpl: fakeFetch });
  await api.getHosts(); await api.getThreads('windows'); await api.getThread('mac', 'a/b'); await api.action({ action: 'send', text: '<unsafe>' });
  assert.deepEqual(calls.map((call) => call.url), ['/api/hosts', '/api/threads?host=windows', '/api/thread?host=mac&id=a%2Fb', '/api/action']);
  assert.ok(calls.every((call) => call.options.credentials === 'same-origin'));
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { action: 'send', text: '<unsafe>' });
  let failedCalls = 0;
  const failing = createMobileAPI({ fetchImpl: async () => { failedCalls++; throw new Error('socket lost'); } });
  await assert.rejects(failing.action({ action: 'send' }), /socket lost/); assert.equal(failedCalls, 1);
});

test('an explicit HTTP rejection stays rejected instead of becoming an uncertain dispatch', async () => {
  const api = createMobileAPI({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ status: 'rejected', message: '原会话状态已变化，未发送' }) }) });
  assert.deepEqual(await api.action({ action: 'send' }), { status: 'rejected', message: '原会话状态已变化，未发送' });
});

test('SSE reconnect events only report transport and never replay an action', () => {
  let stream;
  class Events {
    constructor(url) { this.url = url; this.listeners = {}; stream = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
  }
  const statuses = [], snapshots = [], api = createMobileAPI({ EventSourceImpl: Events });
  const close = api.subscribe('windows', 'thread', { onStatus: (status) => statuses.push(status), onState: (state) => snapshots.push(state) });
  stream.listeners.open(); stream.listeners.error(); stream.listeners.state({ data: JSON.stringify(thread()) }); stream.listeners.state({ data: '{invalid' }); close();
  assert.equal(stream.url, '/api/events?host=windows&id=thread');
  assert.deepEqual(statuses, ['connecting', 'disconnected', 'disconnected']); assert.equal(snapshots.length, 1); assert.equal(stream.closed, true);
});

test('UI keeps stable messages, rejects stale snapshots, and preserves the live draft', (t) => {
  const { root, view } = mount(t); view.update(thread());
  const input = type(root, '尚未发送的中文草稿'), bubble = one(root, 'message-assistant');
  view.update(thread({ revision: 2, messages: [{ id: 'a1', role: 'assistant', text: '新的原会话回复' }, { id: 'a1', role: 'assistant', text: '新的原会话回复' }] }));
  assert.equal(one(root, 'message-assistant'), bubble); assert.equal(input.value, '尚未发送的中文草稿');
  assert.equal(byClass(root, 'message-assistant').length, 1);
  assert.equal(view.update(thread({ revision: 1, title: '过期标题' })), false);
  assert.equal(view.update(thread({ host: 'windows', title: '其他电脑' })), false);
  assert.equal(one(root, 'thread-title').textContent, '手机适配');
});

test('a URL-selected chat starts before hosts and thread lists resolve and never borrows their authority', async (t) => {
  const hosts = deferred(), list = deferred(), chat = deferred(), calls = [];
  const { root } = mount(t, {
    getHosts: () => { calls.push('hosts'); return hosts.promise; },
    getThreads: (host) => { calls.push('list:' + host); return list.promise; },
    getThread: (host, id) => { calls.push('chat:' + host + ':' + id); return chat.promise; },
  }, { initialHost: 'mac', initialThreadId: thread().id });
  assert.equal(calls[0], 'chat:mac:' + thread().id); assert.deepEqual(new Set(calls), new Set(['chat:mac:' + thread().id, 'list:mac', 'hosts']));
  type(root, '正文读取期间的草稿'); assert.equal(one(root, 'send-button').disabled, true);
  chat.resolve(thread()); await tick();
  assert.equal(one(root, 'thread-title').textContent, '手机适配'); assert.equal(one(root, 'send-button').disabled, false);
  assert.equal(one(root, 'thread-drawer').hidden, true); assert.equal(one(root, 'message-input').value, '正文读取期间的草稿');
  // A partial/late host list cannot silently redirect a Mac URL onto Windows.
  hosts.resolve({ hosts: [{ id: 'windows', name: 'Windows', online: true }] });
  list.resolve({ threads: [{ id: thread().id, title: '列表里的旧标题', status: 'unknown' }] }); await tick();
  assert.equal(one(root, 'thread-title').textContent, '手机适配'); assert.ok(one(root, 'thread-subtitle').textContent.startsWith('mac'));
  assert.equal(one(root, 'message-input').value, '正文读取期间的草稿'); assert.equal(one(root, 'thread-drawer').hidden, true);
  assert.equal(calls.filter((entry) => entry.startsWith('chat:')).length, 1);
});

test('a host-mismatched initial chat response stays unconnected and does not open an SSE subscription', async (t) => {
  let subscriptions = 0;
  const { root } = mount(t, {
    getHosts: async () => ({ hosts: [{ id: 'mac', name: 'Mac', online: true }] }), getThreads: async () => ({ threads: [] }),
    getThread: async () => thread({ host: 'mac' }), subscribe: () => { subscriptions++; return () => {}; },
  }, { initialHost: 'windows', initialThreadId: thread().id });
  await tick(); type(root, '保留Windows草稿');
  assert.ok(one(root, 'notice').textContent.includes('不匹配')); assert.equal(one(root, 'send-button').disabled, true);
  assert.equal(byClass(root, 'message-assistant').length, 0); assert.equal(subscriptions, 0); assert.equal(one(root, 'thread-drawer').hidden, true);
});

test('fast navigation metadata cannot finish the pending initial chat or reopen its picker', async (t) => {
  const chat = deferred(); let subscriptions = 0;
  const { root, view } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac', name: 'Mac' }] }), getThreads: async () => ({ threads: [{ id: thread().id, title: '列表标题' }] }), getThread: () => chat.promise,
    subscribe: () => { subscriptions++; return () => {}; } }, { initialThreadId: thread().id });
  await tick(); type(root, '等待正文时输入');
  assert.equal(one(root, 'connection-label').textContent, '正在读取会话…'); assert.equal(one(root, 'thread-drawer').hidden, true); assert.equal(one(root, 'send-button').disabled, true);
  await view.selectHost('mac'); assert.equal(one(root, 'message-input').value, '等待正文时输入');
  chat.resolve(thread()); await tick(); assert.equal(one(root, 'thread-title').textContent, '手机适配'); assert.equal(subscriptions, 1);
  assert.equal(one(root, 'thread-drawer').hidden, true); assert.equal(one(root, 'message-input').value, '等待正文时输入');
});

test('a pending URL chat cannot subscribe or replace content after the user switches hosts', async (t) => {
  const oldChat = deferred(), subscriptions = [];
  const { root, view } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac' }, { id: 'windows' }] }), getThreads: async () => ({ threads: [] }),
    getThread: (host, id) => host === 'mac' ? oldChat.promise : Promise.resolve(thread({ host, id, title: '当前Windows正文' })),
    subscribe: (host) => { subscriptions.push(host); return () => {}; } }, { initialThreadId: thread().id });
  await view.selectHost('windows'); await view.selectThread('windows-current'); type(root, '当前Windows草稿');
  oldChat.resolve(thread({ revision: 99, title: '迟到Mac正文' })); await tick();
  assert.equal(one(root, 'thread-title').textContent, '当前Windows正文'); assert.equal(one(root, 'message-input').value, '当前Windows草稿');
  assert.deepEqual(subscriptions, ['windows']); assert.equal(one(root, 'thread-drawer').hidden, true);
});

test('late initial navigation responses and retired SSE events cannot replace another host or reopen its drawer', async (t) => {
  const oldHosts = deferred(), oldList = deferred(), streams = []; let hostsReads = 0;
  const { root, view } = mount(t, {
    getHosts: () => ++hostsReads === 1 ? oldHosts.promise : Promise.resolve({ hosts: [{ id: 'mac', name: 'Mac' }, { id: 'windows', name: 'Windows' }] }),
    getThreads: (host) => host === 'mac' ? oldList.promise : Promise.resolve({ threads: [{ id: 'windows-thread', title: 'Windows列表' }] }),
    getThread: async (host, id) => thread({ host, id, title: host === 'mac' ? 'Mac原会话' : 'Windows原会话' }),
    subscribe: (host, id, callbacks) => { const stream = { host, id, callbacks, closed: 0 }; streams.push(stream); return () => stream.closed++; },
  }, { initialHost: 'mac', initialThreadId: thread().id });
  await tick(); type(root, 'Mac未发送草稿');
  await view.selectHost('windows'); await view.selectThread('windows-thread'); type(root, 'Windows未发送草稿');
  assert.equal(streams[0].closed, 1);
  oldHosts.resolve({ hosts: [{ id: 'mac', name: '迟到Mac' }] }); oldList.resolve({ threads: [{ id: 'old', title: '迟到Mac列表' }] });
  streams[0].callbacks.onStatus('disconnected'); streams[0].callbacks.onState(thread({ revision: 99, title: '过期Mac状态' })); await tick();
  assert.equal(one(root, 'thread-title').textContent, 'Windows原会话'); assert.equal(one(root, 'message-input').value, 'Windows未发送草稿');
  assert.equal(one(root, 'thread-drawer').hidden, true); assert.ok(one(root, 'connection-label').textContent.startsWith('已连接'));
  assert.ok(one(root, 'thread-list').textContent.includes('Windows列表')); assert.equal(one(root, 'thread-list').textContent.includes('迟到Mac'), false);
  assert.deepEqual(streams.map((stream) => stream.host), ['mac', 'windows']);
});

test('background navigation failures cannot replace an initial chat notice or unlock an unknown draft', async (t) => {
  const hosts = deferred(), list = deferred();
  const { root } = mount(t, { getHosts: () => hosts.promise, getThreads: () => list.promise, getThread: async () => thread(), action: async () => ({ status: 'unknown', message: '这条操作结果未确认' }) }, { initialThreadId: thread().id });
  await tick(); type(root, '不可重复发送的草稿'); one(root, 'composer').fire('submit'); await tick(); await tick();
  hosts.resolve(Promise.reject(Error('后台电脑列表失败'))); list.resolve(Promise.reject(Error('后台对话列表失败'))); await tick();
  assert.equal(one(root, 'thread-title').textContent, '手机适配'); assert.equal(one(root, 'notice').textContent, '这条操作结果未确认');
  assert.equal(one(root, 'message-input').value, '不可重复发送的草稿'); assert.equal(one(root, 'send-button').disabled, true);
  assert.ok(one(root, 'connection-label').textContent.startsWith('已连接')); assert.equal(one(root, 'thread-drawer').hidden, true);
  assert.ok(one(root, 'thread-list').textContent.includes('后台'));
});

test('without a URL chat, the original host-then-list picker remains in place', async (t) => {
  const hosts = deferred(), list = deferred(), calls = [];
  const { root } = mount(t, { getHosts: () => { calls.push('hosts'); return hosts.promise; }, getThreads: () => { calls.push('list'); return list.promise; }, getThread: async () => { calls.push('chat'); return thread(); } });
  assert.deepEqual(calls, ['hosts']); hosts.resolve({ hosts: [{ id: 'mac', name: 'Mac' }] }); await tick();
  assert.deepEqual(calls, ['hosts', 'list']); list.resolve({ threads: [{ id: thread().id, title: '已有对话' }] }); await tick();
  assert.equal(one(root, 'thread-drawer').hidden, false); assert.deepEqual(calls, ['hosts', 'list']);
});

test('destroying a URL-selected view ignores pending chat/list responses and never subscribes late', async (t) => {
  const hosts = deferred(), list = deferred(), chat = deferred(); let subscriptions = 0;
  const { root, view } = mount(t, { getHosts: () => hosts.promise, getThreads: () => list.promise, getThread: () => chat.promise, subscribe: () => { subscriptions++; return () => {}; } }, { initialThreadId: thread().id });
  view.destroy(); chat.resolve(thread()); hosts.resolve({ hosts: [{ id: 'mac' }] }); list.resolve({ threads: [{ id: thread().id }] }); await tick();
  assert.equal(root.childNodes.length, 0); assert.equal(subscriptions, 0);
});

test('frequent snapshots leave a hidden 200-row navigation list untouched while search and selection still update', async (t) => {
  const list = Array.from({ length: 200 }, (_, index) => ({ id: 'thread-' + index, title: '历史对话 ' + index, status: 'idle' }));
  const { root, view } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac', name: 'Mac', online: true }, { id: 'windows', name: 'Windows', online: true }] }), getThreads: async () => ({ threads: list }), getThread: async (host, id) => thread({ host, id }) });
  await tick(); await tick(); await view.selectThread('thread-0');
  const nav = one(root, 'thread-list'), hosts = one(root, 'host-switch'), rows = [...nav.childNodes], hostButtons = [...hosts.childNodes];
  let navWrites = 0, hostWrites = 0;
  const replaceRows = nav.replaceChildren.bind(nav), replaceHosts = hosts.replaceChildren.bind(hosts);
  nav.replaceChildren = (...nodes) => { navWrites++; return replaceRows(...nodes); }; hosts.replaceChildren = (...nodes) => { hostWrites++; return replaceHosts(...nodes); };
  assert.equal(rows.length, 200); assert.equal(one(root, 'thread-drawer').hidden, true);
  for (let revision = 2; revision < 12; revision++) view.update(thread({ id: 'thread-0', revision, messages: [{ id: 'a1', role: 'assistant', text: '增量 ' + revision }] }));
  assert.equal(navWrites, 0); assert.equal(hostWrites, 0); assert.deepEqual(nav.childNodes, rows); assert.deepEqual(hosts.childNodes, hostButtons);
  const search = one(root, 'thread-search'); search.value = '历史对话 199'; search.fire('input');
  assert.equal(nav.childNodes.length, 1); assert.ok(nav.textContent.includes('历史对话 199'));
  await view.selectThread('thread-199'); assert.equal(one(root, 'thread-row').getAttribute('aria-current'), 'page');
  search.value = ''; search.fire('input'); assert.equal(nav.childNodes.length, 200);
  assert.equal(byClass(root, 'thread-row').find((row) => row.getAttribute('aria-current') === 'page').textContent.startsWith('历史对话 199'), true);
});

test('unrelated snapshots preserve a question textarea node, focus, selection and answer draft', (t) => {
  const request = { id: 'focus-request', type: 'async', title: '补充说明', questions: [{ id: 'detail', question: '请输入说明', options: [] }] };
  const { root, doc, view } = mount(t); view.update(thread({ questions: [request] }));
  const answer = one(root, 'answer-input'); answer.value = '中文草稿以及正在编辑的选区'; answer.fire('input'); answer.focus(); answer.selectionStart = 2; answer.selectionEnd = 6;
  for (let revision = 2; revision < 8; revision++) view.update(thread({ revision, status: 'running', activeTurnId: 'turn-1', questions: [structuredClone(request)], messages: [{ id: 'a1', role: 'assistant', text: '其他流式内容 ' + revision }] }));
  assert.equal(one(root, 'answer-input'), answer); assert.equal(doc.activeElement, answer);
  assert.equal(answer.value, '中文草稿以及正在编辑的选区'); assert.equal(answer.selectionStart, 2); assert.equal(answer.selectionEnd, 6);
});

test('local history is visibly read-only even when inconsistent live capability flags are present', (t) => {
  const state = thread({ source: 'local-history-only', status: 'running', activeTurnId: 'stale-turn', questions: [{ id: 'history-q', questions: [{ id: 'answer', question: '历史问题', options: [] }] }] });
  for (const action of ['send', 'answer', 'approval', 'interrupt']) assert.equal(canAct(state, action), false);
  const { root, view } = mount(t); view.update(state); type(root, '保留给连接恢复后的草稿');
  assert.equal(one(root, 'connection-label').textContent, '只读历史 · 原会话未连接');
  assert.equal(one(root, 'thread-subtitle').textContent.includes('只读历史'), true);
  assert.equal(one(root, 'send-button').disabled, true); assert.equal(one(root, 'stop-button').disabled, true); assert.equal(one(root, 'primary-button').disabled, true);
  assert.equal(one(root, 'answer-input').disabled, true); assert.equal(one(root, 'message-input').value, '保留给连接恢复后的草稿');
  assert.equal(one(root, 'connection-label').textContent.includes('已连接'), false);
  view.update(thread({ revision: 2 })); assert.equal(one(root, 'send-button').disabled, false);
});

test('double submit and unknown results preserve the draft and never append optimistic messages', async (t) => {
  const pending = deferred(), calls = [], state = thread();
  const { root, view } = mount(t, { action: (body) => { calls.push(body); return pending.promise; }, getThread: async () => state });
  view.update(state); type(root, '不要重复这条消息');
  one(root, 'composer').fire('submit'); one(root, 'composer').fire('submit'); assert.equal(calls.length, 1);
  pending.resolve({ status: 'unknown', message: '结果未确认，请核对原会话' }); await tick(); await tick();
  assert.equal(one(root, 'message-input').value, '不要重复这条消息'); assert.equal(byClass(root, 'message-user').length, 0);
  assert.equal(one(root, 'send-button').disabled, true);
  view.update(thread({ revision: 3 })); one(root, 'composer').fire('submit'); await tick(); assert.equal(calls.length, 1);
  assert.ok(root.textContent.includes('结果未确认'));
});

test('reopening a UI with an uncertain send restores its draft but keeps repeat sending disabled', async (t) => {
  const { root, storage, view } = mount(t, { action: async () => ({ status: 'unknown' }), getThread: async () => thread() });
  view.update(thread()); type(root, '结果未知的草稿'); one(root, 'composer').fire('submit'); await tick(); await tick(); view.destroy();
  const reopened = mountMobileUI(root, { api: {}, storage }); t.after(() => reopened.destroy()); reopened.update(thread());
  assert.equal(one(root, 'message-input').value, '结果未知的草稿'); assert.equal(one(root, 'send-button').disabled, true);
  assert.ok(one(root, 'draft-hint').textContent.includes('禁止重复发送'));
});

test('confirmed sends clear only the unchanged draft; an edit during sending is protected', async (t) => {
  const pending = deferred(), state = thread();
  const { root, view } = mount(t, { action: () => pending.promise, getThread: async () => state });
  view.update(state); type(root, '第一条'); one(root, 'composer').fire('submit'); type(root, '下一条尚未发送');
  pending.resolve({ status: 'confirmed' }); await tick(); await tick(); assert.equal(one(root, 'message-input').value, '下一条尚未发送');
});

test('questions submit selected labels and free text arrays; ACK cannot remove their cards', async (t) => {
  const calls = [], request = { id: 'question-request', type: 'sync', title: '选择方案', questions: [{ id: 'route', question: '<script>选择路线</script>', allowOther: true, options: [{ id: 'one', label: '现有原会话', description: '保留上下文' }, { id: 'two', label: '手机输入', description: '触屏界面' }] }] };
  const state = thread({ questions: [request] });
  const { root, view } = mount(t, { action: async (body) => { calls.push(body); return { status: 'submitted' }; }, getThread: async () => state });
  view.update(state);
  for (const check of descendants(root).filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox')) { check.checked = true; check.fire('change'); }
  const other = one(root, 'answer-input'); other.value = '还要支持中文输入'; other.fire('input');
  one(root, 'primary-button').click(); await tick(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'answer'); assert.equal(calls[0].requestId, 'question-request');
  assert.deepEqual(calls[0].answers.route, ['现有原会话', '手机输入', '还要支持中文输入']);
  assert.equal(byClass(root, 'question-card').length, 1); assert.equal(one(root, 'primary-button').disabled, true);
  view.update(thread({ revision: 2, questions: [] })); assert.equal(byClass(root, 'question-card').length, 0);
});

test('approval cards show full reason, command and files; one choice locks all choices', async (t) => {
  const calls = [], command = 'printf "<img src=x>"\n' + 'long-command '.repeat(200);
  const approval = { id: 'approval-1', type: 'command', reason: '完整原因\n第二行', command, files: ['C:\\work\\file.ts', { path: '/work/app.mjs', change: '<script>patch</script>' }], details: { cwd: '/work' }, choices: [{ id: 'allow', label: '允许一次' }, { id: 'deny', label: '拒绝' }] };
  const state = thread({ approvals: [approval] });
  const { root, view } = mount(t, { action: async (body) => { calls.push(body); return { status: 'confirmed' }; }, getThread: async () => state });
  view.update(state);
  assert.ok(root.textContent.includes(command)); assert.ok(root.textContent.includes('完整原因\n第二行')); assert.ok(root.textContent.includes('C:\\work\\file.ts'));
  one(root, 'primary-button').click(); one(root, 'secondary-button').click(); await tick(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].choice, 'allow'); assert.equal(one(root, 'secondary-button').disabled, true);
  assert.equal(byClass(root, 'approval-card').length, 1);
  assert.ok(!descendants(root).some((node) => ['SCRIPT', 'IMG'].includes(node.tagName)));
});

test('SSE disconnect keeps drafts and disables writes until a new owner snapshot arrives', async (t) => {
  let events, posts = 0;
  const state = thread(), { root, view } = mount(t, { getThread: async () => state, subscribe: (_host, _id, callbacks) => { events = callbacks; return () => {}; }, action: async () => { posts++; } });
  await view.selectThread(state.id); const input = type(root, '网络断线也要保留');
  events.onStatus('disconnected'); assert.equal(one(root, 'send-button').disabled, true); assert.equal(input.value, '网络断线也要保留');
  events.onStatus('connecting'); assert.equal(one(root, 'send-button').disabled, true);
  events.onState(thread({ revision: 2 })); assert.equal(one(root, 'send-button').disabled, false); assert.equal(input.value, '网络断线也要保留'); assert.equal(posts, 0);
});

test('host and conversation changes isolate drafts; late reads cannot replace the selected host', async (t) => {
  const delayed = deferred();
  const { root, view } = mount(t, { getThreads: async () => ({ threads: [] }), getThread: async (host, id) => id === 'slow' ? delayed.promise : thread({ host, id }) });
  view.update(thread()); type(root, 'Mac草稿');
  const stale = view.selectThread('slow'); await view.selectHost('windows'); await view.selectThread('windows-thread'); type(root, 'Windows草稿');
  delayed.resolve(thread({ id: 'slow', title: '迟到的Mac结果' })); await stale;
  assert.equal(one(root, 'thread-title').textContent, '手机适配'); assert.equal(one(root, 'message-input').value, 'Windows草稿');
  await view.selectHost('mac'); await view.selectThread(thread().id); assert.equal(one(root, 'message-input').value, 'Mac草稿');
});

test('visual viewport variables and CSS keep the composer in its own bottom row', (t) => {
  assert.deepEqual(viewportMetrics({ height: 428.4, offsetTop: 18.6 }, 844), { height: 428, top: 19 });
  const { root, doc } = fixtureDOM(); doc.defaultView.visualViewport = { height: 420, offsetTop: 12, addEventListener() {}, removeEventListener() {} };
  const view = mountMobileUI(root, { api: {}, storage: null }); t.after(() => view.destroy());
  assert.equal(one(root, 'mobile-app').style['--app-height'], '420px'); assert.equal(one(root, 'mobile-app').style['--app-top'], '12px');
  const css = fs.readFileSync(new URL('../mobile/public/style.css', import.meta.url), 'utf8');
  assert.match(css, /height: var\(--app-height\)/); assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.conversation\s*\{\s*grid-row: 4/); assert.match(css, /\.composer\s*\{\s*grid-row: 5/);
  assert.match(css, /font-size: 16px/); assert.match(css, /min-height: 46px/);
});
