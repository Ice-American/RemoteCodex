import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ActionGate, buildActionPayload, canAct, createMobileAPI, dedupeMessages,
  mountMobileUI, renderSafeText, viewportMetrics,
} from '../mobile/public/render.mjs';

const nativeCreation = { supported: true, projectless: true, projects: [{ projectId: 'official-red', name: 'red-app', path: 'D:\\Project\\red-app' }] };

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
  // Native selects cannot hold a value before the matching option exists.
  // Modeling this prevents a delayed project list from silently losing a draft ID.
  set value(value) { const text = String(value ?? ''); this._value = this.tagName === 'SELECT' && !this.childNodes.some(option => option.value === text) ? '' : text; }
  get value() { return this._value ?? ''; }
  set textContent(value) { this._text = String(value ?? ''); this.replaceChildren(); }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(''); }
  get children() { return this.childNodes.filter((node) => node.tagName !== '#TEXT'); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } if (this.tagName === 'SELECT' && !this.childNodes.some(option => option.value === this._value)) this._value = this.childNodes[0]?.value ?? ''; }
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
  const eventTarget = (target) => {
    const listeners = new Map();
    return Object.assign(target, { addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }, fire(type, values = {}) { for (const callback of [...listeners.get(type) ?? []]) callback({ type, ...values }); } });
  };
  const doc = eventTarget({ visibilityState: 'visible', createElement: (tag) => new FixtureNode(tag, doc), createTextNode: (text) => { const n = new FixtureNode('#text', doc); n._text = text; return n; } });
  doc.defaultView = eventTarget({ innerHeight: 844, visualViewport: { height: 844, offsetTop: 0, addEventListener() {}, removeEventListener() {} }, sessionStorage: storage });
  const root = doc.createElement('div'); return { root, doc, storage };
}
const descendants = (node) => [node, ...node.childNodes.flatMap(descendants)];
const byClass = (root, cls) => descendants(root).filter((node) => node.classList.contains(cls));
const one = (root, cls) => { const found = byClass(root, cls); assert.equal(found.length, 1, cls); return found[0]; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('today images use the existing authenticated thread GET and preserve request cancellation', async () => {
  const calls = [], controller = new AbortController();
  const api = createMobileAPI({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ host: 'mac', id: 'picture-chat', images: [] }) };
  } });
  await api.getTodayImages('mac', 'picture-chat', { signal: controller.signal });
  assert.equal(calls.length, 1); const url = new URL(calls[0].url, 'http://fixture');
  assert.equal(url.pathname, '/api/thread'); assert.equal(url.searchParams.get('view'), 'today-images');
  assert.equal(url.searchParams.get('host'), 'mac'); assert.equal(url.searchParams.get('id'), 'picture-chat');
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
});
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fakeClock() {
  let now = 0, nextId = 0; const jobs = new Map();
  return { now: () => now, setTimeout(fn, delay) { const id = ++nextId; jobs.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { jobs.delete(id); },
    get size() { return jobs.size; }, async advance(ms) { const end = now + ms; let count = 0;
      for (;;) { const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break;
        assert.ok(++count < 200, 'timer loop'); now = next[1].at; jobs.delete(next[0]); next[1].fn(); await tick(); }
      now = end; await tick();
    } };
}
const thread = (overrides = {}) => ({
  host: 'mac', id: '11111111-1111-4111-8111-111111111111', title: '手机适配', connected: true,
  ownerConfirmed: true, connectionId: 'connection-1', ownerId: 'desktop-owner', revision: 1,
  activeTurnId: null, status: 'idle', messages: [{ id: 'a1', role: 'assistant', text: '原会话回复' }],
  questions: [], approvals: [], capabilities: { send: true, steer: true, answer: true, approve: true, interrupt: true }, ...overrides,
});
const runtimeErrorThread = (overrides = {}) => thread({ connectionState: 'runtime-error', canLoad: false,
  status: 'error', runtimeError: { failedTurnId: 'failed-turn-1', message: '模型服务暂时不可用：upstream unavailable' },
  capabilities: { retry: true, send: false, steer: false, answer: false, approve: false, interrupt: false }, ...overrides });
function mount(t, api = {}, options = {}) {
  const dom = fixtureDOM(), view = mountMobileUI(dom.root, { ...options, api, storage: dom.storage }); t.after(() => view.destroy()); return { ...dom, view };
}
function type(root, text) { const input = one(root, 'message-input'); input.value = text; input.fire('input'); return input; }
function chooseCreationProject(root, projectId) {
  one(root, 'create-project').click();
  const option = byClass(root, 'create-project-option').find(item => item.value === projectId);
  assert.ok(option, 'official project option: ' + projectId); option.click();
}

const phoneImage = (values = {}) => ({ id: 'a'.repeat(64), contentKey: 'b'.repeat(64), name: '页面截图.png', ...values });

test('image-only messages use lazy same-origin opaque image references without accepting supplied URLs', t => {
  const { root, view } = mount(t);
  view.update(thread({ messages: [{ id: 'image-only', role: 'user', images: [phoneImage({ name: '<img onerror=steal()>.png', url: 'https://evil.invalid/image' })] }] }));
  const image = one(root, 'message-image-thumbnail');
  const url = new URL(image.getAttribute('src'), 'https://paired.example');
  assert.equal(url.origin, 'https://paired.example'); assert.equal(url.pathname, '/api/image');
  assert.deepEqual([...url.searchParams], [['host', 'mac'], ['threadId', thread().id], ['id', 'a'.repeat(64)], ['key', 'b'.repeat(64)]]);
  assert.equal(image.getAttribute('loading'), 'lazy'); assert.equal(image.getAttribute('decoding'), 'async');
  assert.equal(one(root, 'message-image-name').textContent, '<img onerror=steal()>.png');
  assert.equal(byClass(root, 'message-user').length, 1); assert.equal(one(root, 'empty-state').hidden, true);
});

test('streaming text preserves image nodes while same-text media patches update their references', t => {
  const { root, view } = mount(t), first = phoneImage();
  const messages = images => [{ id: 'a1', role: 'assistant', text: '结果', images }];
  view.update(thread({ messages: messages([first]) }));
  const original = one(root, 'message-image-thumbnail'), src = original.getAttribute('src');
  view.update(thread({ revision: 2, messages: [{ ...messages([first])[0], text: '结果继续更新' }] }));
  assert.equal(one(root, 'message-image-thumbnail'), original); assert.equal(original.getAttribute('src'), src);
  view.update(thread({ revision: 3, messages: [{ ...messages([first, phoneImage({ id: 'c'.repeat(64) })])[0], text: '结果继续更新' }] }));
  assert.equal(byClass(root, 'message-image-thumbnail').length, 2); assert.equal(byClass(root, 'message-image-thumbnail')[0], original);
  view.update(thread({ revision: 4, messages: messages([phoneImage({ contentKey: 'd'.repeat(64) })]) }));
  assert.notEqual(one(root, 'message-image-thumbnail'), original); assert.ok(one(root, 'message-image-thumbnail').getAttribute('src').includes('key=' + 'd'.repeat(64)));
});

test('invalid image references remain an explicit placeholder and cannot load paths or external URLs', t => {
  const { root, view } = mount(t);
  view.update(thread({ messages: [{ id: 'bad-images', role: 'assistant', text: '', images: [
    phoneImage({ id: '../../secret.png' }), phoneImage({ contentKey: 'javascript:steal()' }),
    { src: 'https://evil.invalid/image', name: '外链' }, phoneImage({ id: 'a'.repeat(64) + '\n' }),
  ] }] }));
  assert.equal(byClass(root, 'message-image-thumbnail').length, 0);
  assert.match(one(root, 'message-image-unavailable').textContent, /图片.*不可用/);
  assert.equal(descendants(root).filter(n => n.tagName === 'A').length, 1); // Only the empty, hidden preview original link exists.
});

test('a known image without a readable reference stays visible as an unavailable-image message', t => {
  const { root, view } = mount(t);
  view.update(thread({ messages: [{ id: 'unsupported-image', role: 'user', text: '', images: [], imageUnavailable: true }] }));
  assert.equal(byClass(root, 'message-user').length, 1); assert.equal(byClass(root, 'message-image-thumbnail').length, 0);
  assert.match(one(root, 'message-image-unavailable').textContent, /图片.*不可用/); assert.equal(one(root, 'empty-state').hidden, true);
});

test('image retry replaces only its GET image, keeps the draft and ignores prior attempt callbacks', t => {
  let actions = 0;
  const { root, view } = mount(t, { action: async () => { actions++; } });
  view.update(thread({ messages: [{ id: 'a1', role: 'assistant', text: '', images: [phoneImage()] }] }));
  type(root, '保留我的草稿');
  const old = one(root, 'message-image-thumbnail'); old.fire('error');
  assert.equal(one(root, 'message-image-error').hidden, false);
  assert.match(one(root, 'message-image-error').textContent, /原图.*不可用|图片.*加载失败/);
  assert.match(one(root, 'message-image-error').textContent, /电脑正在等待文件访问授权/);
  one(root, 'message-image-retry').click();
  const retried = one(root, 'message-image-thumbnail'); assert.notEqual(retried, old);
  assert.ok(retried.getAttribute('src').includes('&retry=1')); assert.equal(one(root, 'message-image-error').hidden, true);
  old.fire('error'); assert.equal(one(root, 'message-image-error').hidden, true);
  retried.fire('error'); assert.equal(one(root, 'message-image-error').hidden, false);
  assert.equal(one(root, 'message-input').value, '保留我的草稿'); assert.equal(actions, 0);
});

test('image preview opens safely, can zoom and close, and preserves conversation state', t => {
  const { root, view, doc } = mount(t);
  view.update(thread({ messages: [{ id: 'a1', role: 'assistant', text: '图', images: [phoneImage()] }] }));
  type(root, '不发送的草稿'); const opener = one(root, 'message-image-open'); opener.click();
  const preview = one(root, 'image-preview'); assert.equal(preview.hidden, false); assert.equal(preview.getAttribute('role'), 'dialog');
  one(root, 'image-preview-image').fire('error'); assert.match(one(root, 'image-preview-status').textContent, /电脑正在等待文件访问授权/);
  const full = one(root, 'image-preview-original'); assert.ok(full.getAttribute('href').startsWith('/api/image?host=mac&'));
  assert.equal(full.getAttribute('target'), '_blank'); assert.equal(full.getAttribute('rel'), 'noopener noreferrer');
  one(root, 'image-preview-zoom').click(); assert.equal(one(root, 'image-preview-viewport').classList.contains('zoomed'), true);
  one(root, 'image-preview-close').click(); assert.equal(preview.hidden, true); assert.equal(doc.activeElement, opener);
  assert.equal(one(root, 'message-input').value, '不发送的草稿');
  opener.click(); doc.fire('keydown', { key: 'Escape' }); assert.equal(preview.hidden, true);
});

test('navigation closes image preview and retired image events cannot change the next chat', async t => {
  const { root, view } = mount(t, { getThreads: async () => ({ threads: [] }) });
  view.update(thread({ messages: [{ id: 'a1', role: 'assistant', text: '', images: [phoneImage()] }] }));
  const old = one(root, 'message-image-thumbnail'); one(root, 'message-image-open').click();
  await view.selectHost('windows');
  view.update(thread({ host: 'windows', messages: [{ id: 'a1', role: 'assistant', text: '', images: [phoneImage()] }] }));
  assert.equal(one(root, 'image-preview').hidden, true);
  const current = one(root, 'message-image-thumbnail'); assert.ok(current.getAttribute('src').includes('host=windows'));
  old.fire('error'); assert.equal(one(root, 'message-image-error').hidden, true);
  assert.notEqual(current, old);
});

test('today gallery reads the selected chat, preserves repeated occurrences and returns from preview without losing drafts', async t => {
  const result = deferred(), calls = [];
  const { root, view } = mount(t, { getTodayImages: (host, id, options) => { calls.push({ host, id, signal: options.signal }); return result.promise; } });
  assert.equal(one(root, 'today-images-button').disabled, true); view.update(thread()); type(root, '今日图片查看期间的草稿');
  one(root, 'today-images-button').click(); assert.equal(one(root, 'today-images-dialog').hidden, false); assert.match(one(root, 'today-images-state').textContent, /读取/);
  assert.equal(calls.length, 1); assert.equal(calls[0].host, 'mac'); assert.equal(calls[0].id, thread().id);
  result.resolve({ host: 'mac', id: thread().id, date: '2026-11-17', complete: true, issues: [], images: [
    { ...phoneImage(), messageId: 'call-private-first', at: '2026-11-17T01:02:03Z' },
    { ...phoneImage(), messageId: 'call-private-second', at: '2026-11-17T01:04:05Z' },
  ] }); await tick();
  assert.equal(byClass(root, 'today-image-entry').length, 2); assert.equal(byClass(root, 'message-image-thumbnail').length, 2);
  assert.match(one(root, 'today-images-state').textContent, /2026-11-17.*2/); assert.ok(!one(root, 'today-images-dialog').textContent.includes('call-private'));
  assert.deepEqual(byClass(root, 'today-image-time').map(n => n.textContent), ['09:02:03', '09:04:05']);
  byClass(root, 'message-image-open')[0].click(); assert.equal(one(root, 'image-preview').hidden, false);
  one(root, 'image-preview-close').click(); assert.equal(one(root, 'today-images-dialog').hidden, false);
  assert.equal(one(root, 'message-input').value, '今日图片查看期间的草稿'); assert.equal(one(root, 'thread-title').textContent, '手机适配');
});

test('today gallery explains incomplete results and explicit read failures without business writes', async t => {
  let reads = 0, writes = 0;
  const { root, view } = mount(t, { getTodayImages: async () => { reads++; if (reads === 1) throw Error('temporary'); return { host: 'mac', id: thread().id, date: '2026-11-17', complete: false, issues: [{ privatePath: '/secret' }], images: [phoneImage()] }; }, action: async () => { writes++; } });
  view.update(thread()); one(root, 'today-images-button').click(); await tick(); assert.match(one(root, 'today-images-state').textContent, /无法读取|读取失败/);
  one(root, 'today-images-retry').click(); await tick(); assert.equal(reads, 2); assert.match(one(root, 'today-images-state').textContent, /部分.*未.*|不完整/);
  assert.ok(!one(root, 'today-images-dialog').textContent.includes('/secret')); assert.equal(writes, 0);
});

test('closing or navigating cancels today-gallery reads and ignores late data for the old chat', async t => {
  const first = deferred(), calls = [];
  const { root, view } = mount(t, { getThreads: async () => ({ threads: [] }), getTodayImages: (host, id, { signal }) => { calls.push({ host, id, signal }); return first.promise; } });
  view.update(thread()); one(root, 'today-images-button').click(); one(root, 'today-images-close').click();
  assert.equal(calls[0].signal.aborted, true); assert.equal(one(root, 'today-images-dialog').hidden, true);
  one(root, 'today-images-button').click(); await view.selectHost('windows'); assert.equal(calls[1].signal.aborted, true);
  first.resolve({ host: 'mac', id: thread().id, date: '2026-11-17', complete: true, images: [phoneImage()] }); await tick();
  assert.equal(one(root, 'today-images-dialog').hidden, true); assert.equal(byClass(root, 'today-image-entry').length, 0);
});

test('today gallery refuses host-mismatched results and safely explains missing support', async t => {
  const unsupported = mount(t); unsupported.view.update(thread()); one(unsupported.root, 'today-images-button').click();
  assert.match(one(unsupported.root, 'today-images-state').textContent, /更新电脑网关/);
  const { root, view } = mount(t, { getTodayImages: async () => ({ host: 'windows', id: thread().id, date: '2026-11-17', complete: true, images: [phoneImage()] }) });
  view.update(thread()); one(root, 'today-images-button').click(); await tick(); assert.match(one(root, 'today-images-state').textContent, /不匹配/);
  assert.equal(byClass(root, 'message-image-thumbnail').length, 0);
});

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

test('runtime retry is an independent owner capability and carries only its failed turn identity', () => {
  const state = runtimeErrorThread();
  assert.equal(canAct(state, 'retry'), true);
  const payload = buildActionPayload(state, { operationId: 'retry-operation', action: 'retry', failedTurnId: 'forged-turn',
    text: '必须保留的当前草稿', requestId: 'old-request', answers: { q: ['wrong'] }, choice: 'allow', ownerId: 'forged-owner' });
  assert.deepEqual(payload, { host: 'mac', threadId: state.id, operationId: 'retry-operation', connectionId: 'connection-1',
    revision: 1, ownerId: 'desktop-owner', activeTurnId: null, action: 'retry', failedTurnId: 'failed-turn-1' });
  for (const patch of [{ ownerConfirmed: false }, { connected: false }, { connectionId: null }, { ownerId: null },
    { revision: null }, { runtimeError: null }, { runtimeError: { failedTurnId: '', message: 'error' } },
    { capabilities: { retry: false } }, { connectionState: 'ready' }]) assert.equal(canAct({ ...state, ...patch }, 'retry'), false);
  for (const action of ['send', 'steer', 'approval', 'answer', 'interrupt']) {
    assert.equal(canAct(runtimeErrorThread({ activeTurnId: 'obsolete-turn', capabilities: { retry: true, send: true,
      steer: true, approve: true, answer: true, interrupt: true } }), action), false, action);
  }
});

test('a loaded runtime error shows the real failure and never offers to load the original chat', t => {
  const { root, view } = mount(t, { action: async () => ({ status: 'submitted' }) });
  view.update(runtimeErrorThread()); type(root, '发生错误后仍要保留的草稿');
  assert.equal(one(root, 'connection-label').textContent, '上一轮运行失败');
  assert.equal(one(root, 'runtime-error-panel').hidden, false);
  assert.equal(one(root, 'runtime-error-message').textContent, '模型服务暂时不可用：upstream unavailable');
  assert.equal(one(root, 'load-thread-panel').hidden, true);
  assert.equal(one(root, 'retry-turn-button').textContent, '重试上一轮');
  assert.equal(one(root, 'retry-turn-button').disabled, false);
  assert.equal(one(root, 'send-button').disabled, true);
  assert.equal(one(root, 'message-input').value, '发生错误后仍要保留的草稿');
});

test('explicit runtime retry sends one retry POST without sending, clearing or copying the draft', async t => {
  const pending = deferred(), calls = [], state = runtimeErrorThread();
  const { root, view } = mount(t, { action: body => { calls.push(body); return pending.promise; }, getThread: async () => state });
  view.update(state); type(root, '这条草稿不是重试内容');
  one(root, 'retry-turn-button').click(); one(root, 'retry-turn-button').click(); one(root, 'composer').fire('submit');
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'retry'); assert.equal(calls[0].failedTurnId, 'failed-turn-1');
  assert.equal(calls[0].host, 'mac'); assert.equal(calls[0].threadId, state.id);
  for (const field of ['text', 'requestId', 'answers', 'choice']) assert.equal(Object.hasOwn(calls[0], field), false, field);
  assert.equal(one(root, 'message-input').value, '这条草稿不是重试内容'); assert.equal(byClass(root, 'message-user').length, 0);
  pending.resolve({ status: 'confirmed', state: thread({ revision: 2, title: '回执不能替代真实快照' }) }); await tick(); await tick();
  assert.equal(calls.length, 1); assert.equal(one(root, 'message-input').value, '这条草稿不是重试内容');
  assert.equal(one(root, 'thread-title').textContent, state.title); assert.equal(byClass(root, 'message-user').length, 0);
});

for (const receiptStatus of ['unknown', 'submitted']) test(`runtime retry ${receiptStatus} survives refresh and page rebuild without a new POST or operation ID`, async t => {
  const calls = [], state = runtimeErrorThread(), api = { action: async body => { calls.push(body); return { status: receiptStatus }; }, getThread: async () => state };
  const { root, storage, view } = mount(t, api);
  view.update(state); type(root, '刷新后也保留的草稿'); one(root, 'retry-turn-button').click(); await tick(); await tick();
  const operationId = calls[0].operationId;
  await view.refresh(); one(root, 'retry-turn-button').click(); assert.equal(calls.length, 1); view.destroy();
  const reopened = mountMobileUI(root, { api, storage }); t.after(() => reopened.destroy()); reopened.update(state);
  assert.equal(one(root, 'message-input').value, '刷新后也保留的草稿'); assert.equal(one(root, 'retry-turn-button').disabled, true);
  one(root, 'retry-turn-button').click(); await reopened.refresh(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].operationId, operationId);
  const records = JSON.parse(storage.getItem('codex-mobile-operation-guards'));
  assert.ok(records.some(([, attempt]) => attempt.operationId === operationId && attempt.status === receiptStatus));
  assert.ok(!storage.getItem('codex-mobile-operation-guards').includes('刷新后也保留的草稿'));
});

test('a page rebuild fences a pending runtime retry before its original receipt arrives', async t => {
  const pending = deferred(), calls = [], state = runtimeErrorThread();
  const api = { action: body => { calls.push(body); return pending.promise; }, getThread: async () => state };
  const { root, storage, view } = mount(t, api);
  view.update(state); type(root, '请求未完成时的草稿'); one(root, 'retry-turn-button').click(); view.destroy();
  const reopened = mountMobileUI(root, { api, storage }); t.after(() => reopened.destroy()); reopened.update(state);
  assert.equal(one(root, 'retry-turn-button').disabled, true); one(root, 'retry-turn-button').click(); await reopened.refresh();
  pending.resolve({ status: 'submitted' }); await tick(); await tick();
  one(root, 'retry-turn-button').click(); assert.equal(calls.length, 1);
  assert.equal(one(root, 'message-input').value, '请求未完成时的草稿'); assert.equal(one(root, 'retry-turn-button').disabled, true);
});

test('a runtime retry guard cannot block an explicitly sent draft after a fresh ready snapshot', async t => {
  const calls = []; let state = runtimeErrorThread();
  const { root, view } = mount(t, { getThread: async () => state,
    action: async body => { calls.push(body); return { status: body.action === 'retry' ? 'unknown' : 'confirmed' }; } });
  view.update(state); type(root, '恢复正常后才发送'); one(root, 'retry-turn-button').click(); await tick(); await tick();
  assert.equal(one(root, 'message-input').value, '恢复正常后才发送');
  state = thread({ connectionState: 'ready', revision: 2 }); view.update(state);
  assert.equal(one(root, 'send-button').disabled, false); one(root, 'composer').fire('submit'); await tick(); await tick();
  assert.deepEqual(calls.map(call => call.action), ['retry', 'send']); assert.equal(calls[1].text, '恢复正常后才发送');
  assert.equal(one(root, 'message-input').value, '');
});

test('runtime retry waits for an explicitly confirmed owner and a fresh retry capability', t => {
  let writes = 0;
  const { root, view } = mount(t, { action: async () => { writes++; } });
  for (const patch of [{ ownerConfirmed: false }, { connected: false }, { capabilities: { retry: false } }, { runtimeError: null }]) {
    view.update(runtimeErrorThread(patch)); one(root, 'retry-turn-button').click(); assert.equal(writes, 0);
    assert.equal(one(root, 'retry-turn-button').disabled, true);
  }
});

test('runtime retry intent is scoped to host, chat and failed turn instead of the retained draft', async t => {
  const calls = []; let state = runtimeErrorThread();
  const { root, view } = mount(t, { getThreads: async () => ({ threads: [] }),
    getThread: async (host, id) => ({ ...state, host, id }), action: async body => { calls.push(body); return { status: 'unknown' }; } });
  view.update(state); type(root, '同一草稿'); one(root, 'retry-turn-button').click(); await tick(); await tick();
  type(root, '修改草稿不能创建重试意图'); one(root, 'retry-turn-button').click(); assert.equal(calls.length, 1);
  state = runtimeErrorThread({ revision: 2, runtimeError: { failedTurnId: 'failed-turn-2', message: '第二轮错误' } });
  view.update(state); one(root, 'retry-turn-button').click(); await tick(); await tick(); assert.equal(calls.length, 2);
  await view.selectThread('another-mac-chat'); one(root, 'retry-turn-button').click(); await tick(); await tick();
  await view.selectHost('windows'); await view.selectThread('another-mac-chat'); one(root, 'retry-turn-button').click(); await tick(); await tick();
  assert.equal(calls.length, 4); assert.equal(new Set(calls.map(call => call.operationId)).size, 4);
  assert.deepEqual(calls.map(call => [call.host, call.threadId, call.failedTurnId]), [
    ['mac', thread().id, 'failed-turn-1'], ['mac', thread().id, 'failed-turn-2'],
    ['mac', 'another-mac-chat', 'failed-turn-2'], ['windows', 'another-mac-chat', 'failed-turn-2'],
  ]);
});

test('runtime errors keep their read connection and SSE can restore active and idle actions', async t => {
  const timers = fakeClock(), streams = []; let reads = 0, writes = 0;
  const { root, view } = mount(t, { getThread: async () => { reads++; return runtimeErrorThread(); },
    subscribe: (_host, _id, callbacks) => { const stream = { callbacks, closed: 0 }; streams.push(stream); return () => stream.closed++; },
    action: async () => { writes++; } }, { timers });
  await view.selectThread(thread().id); type(root, '连接保留期间的草稿');
  assert.equal(streams.length, 1); assert.equal(reads, 1); assert.equal(one(root, 'connection-label').textContent, '上一轮运行失败');
  for (let index = 0; index < 4; index++) { await timers.advance(15000); streams[0].callbacks.onHeartbeat(); }
  assert.equal(reads, 1); assert.equal(streams.length, 1); assert.equal(streams[0].closed, 0);
  streams[0].callbacks.onState(runtimeErrorThread({ revision: 2, runtimeError: { failedTurnId: 'failed-turn-2', message: '新的真实错误' } }));
  await tick(); assert.equal(reads, 1); assert.equal(streams[0].closed, 0);
  assert.equal(one(root, 'runtime-error-message').textContent, '新的真实错误');
  streams[0].callbacks.onState(thread({ connectionState: 'ready', revision: 3, status: 'running', activeTurnId: 'active-turn' }));
  assert.equal(one(root, 'runtime-error-panel').hidden, true); assert.equal(one(root, 'send-button').disabled, false);
  assert.equal(one(root, 'send-button').textContent, '补充方向'); assert.equal(one(root, 'stop-button').disabled, false);
  streams[0].callbacks.onState(thread({ connectionState: 'ready', revision: 4, status: 'idle' }));
  assert.equal(one(root, 'send-button').disabled, false); assert.equal(one(root, 'send-button').textContent, '发送');
  assert.equal(one(root, 'message-input').value, '连接保留期间的草稿'); assert.equal(reads, 1); assert.equal(writes, 0);
});

test('a late failed-turn retry receipt cannot navigate or refresh a different current chat', async t => {
  const pending = deferred(), calls = [], reads = [];
  const { root, view } = mount(t, { getThread: async (host, id) => { reads.push([host, id]); return id === thread().id ? runtimeErrorThread() : thread({ host, id, title: '当前聊天' }); },
    action: body => { calls.push(body); return pending.promise; } });
  view.update(runtimeErrorThread()); type(root, '失败聊天草稿'); one(root, 'retry-turn-button').click();
  await view.selectThread('current-chat'); type(root, '当前聊天草稿');
  pending.resolve({ status: 'submitted', message: '旧失败轮已提交', state: thread({ title: '迟到的旧失败轮', revision: 99 }) }); await tick(); await tick();
  assert.equal(one(root, 'thread-title').textContent, '当前聊天'); assert.equal(one(root, 'message-input').value, '当前聊天草稿');
  assert.equal(one(root, 'runtime-error-panel').hidden, true); assert.ok(!one(root, 'notice').textContent.includes('旧失败轮'));
  assert.deepEqual(reads, [['mac', 'current-chat']]); assert.equal(calls.length, 1);
});

test('a retry receipt for an older failed turn cannot refresh or lock the newly failed turn', async t => {
  const pending = deferred(); let reads = 0;
  const { root, view } = mount(t, { getThread: async () => { reads++; return runtimeErrorThread(); }, action: () => pending.promise });
  view.update(runtimeErrorThread()); type(root, '仍未发送的下一条'); one(root, 'retry-turn-button').click();
  view.update(runtimeErrorThread({ revision: 2, runtimeError: { failedTurnId: 'failed-turn-2', message: '新失败轮必须保留' } }));
  pending.resolve({ status: 'unknown', message: '旧失败轮回执' }); await tick(); await tick();
  assert.equal(one(root, 'runtime-error-message').textContent, '新失败轮必须保留');
  assert.equal(one(root, 'retry-turn-button').disabled, false); assert.equal(one(root, 'message-input').value, '仍未发送的下一条');
  assert.ok(!one(root, 'notice').textContent.includes('旧失败轮回执')); assert.equal(reads, 0);
});

for (const receiptStatus of ['unknown', 'rejected']) test(`returning to the failed chat renders its old ${receiptStatus} retry guard without another read`, async t => {
  const pending = deferred(), reads = [], writes = [];
  const { root, view } = mount(t, { getThread: async (host, id) => { reads.push([host, id]); return runtimeErrorThread({ host, id }); }, action: body => { writes.push(body); return pending.promise; } });
  view.update(runtimeErrorThread()); type(root, '返回后保留的草稿'); one(root, 'retry-turn-button').click();
  await view.selectThread('other-chat'); await view.selectThread(thread().id);
  assert.equal(one(root, 'retry-turn-button').disabled, true); assert.equal(one(root, 'retry-turn-result').textContent, '正在提交…');
  pending.resolve({ status: receiptStatus, message: '旧导航的回执' }); await tick(); await tick();
  assert.equal(reads.length, 2); assert.equal(one(root, 'message-input').value, '返回后保留的草稿');
  assert.equal(one(root, 'retry-turn-button').disabled, receiptStatus !== 'rejected');
  assert.equal(one(root, 'retry-turn-result').textContent, '旧导航的回执');
  assert.equal(writes.length, 1);
  assert.ok(!one(root, 'notice').textContent.includes('旧导航的回执'));
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

test('loading an original chat has its own end-to-end budget without extending or retrying writes', async t => {
  const delays = [], calls = [];
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    delays.push(delay); return nativeTimeout(fn, delay, ...args);
  });
  const api = createMobileAPI({ fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'confirmed' }) };
  } });
  await api.action({ action: 'load' }); await api.action({ action: 'send' });
  assert.deepEqual(delays, [60000, 30000]);
  assert.deepEqual(calls, [{ action: 'load' }, { action: 'send' }]);
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

const unloadedThread = (overrides = {}) => thread({ connectionState: 'needs-load', canLoad: true, connected: false,
  ownerConfirmed: false, connectionId: null, ownerId: null, revision: null, ...overrides });

test('a changed desktop protocol explains the cause without repeated loading or discarding a draft', async t => {
  const timers = fakeClock(); let reads = 0, posts = 0;
  const { root } = mount(t, { getThread: async () => { reads++; return unloadedThread({ connectionState: 'incompatible', canLoad: false, error: 'UNSUPPORTED_METHOD' }); },
    action: async () => { posts++; } }, { timers, initialThreadId: thread().id });
  await tick(); type(root, '协议升级期间保留的草稿');
  assert.equal(one(root, 'connection-label').textContent, '电脑网关需要更新');
  assert.equal(one(root, 'load-thread-button').hidden, true); assert.equal(one(root, 'send-button').disabled, true);
  assert.match(one(root, 'load-thread-hint').textContent, /需要更新/);
  await timers.advance(30000);
  assert.equal(reads, 1); assert.equal(posts, 0); assert.equal(one(root, 'message-input').value, '协议升级期间保留的草稿');
});

test('an unloaded original chat offers an explicit load action without treating it as a network failure', async (t) => {
  const timers = fakeClock(); let reads = 0, posts = 0;
  const { root } = mount(t, { getThread: async () => { reads++; return unloadedThread(); }, action: async () => { posts++; } },
    { initialThreadId: thread().id, timers });
  await tick(); type(root, '保留原聊天草稿');
  assert.equal(one(root, 'connection-label').textContent, '原聊天尚未在电脑上加载');
  assert.equal(one(root, 'load-thread-panel').hidden, false); assert.equal(one(root, 'load-thread-button').disabled, false);
  assert.equal(one(root, 'load-thread-panel').parentNode, one(root, 'composer'), 'loading remains visible beside the draft even at the bottom of a long chat');
  assert.ok(one(root, 'load-thread-hint').textContent.includes('电脑前台'));
  assert.equal(one(root, 'send-button').disabled, true); assert.equal(posts, 0);
  await timers.advance(30000); assert.equal(reads, 1); assert.equal(posts, 0);
  assert.equal(one(root, 'message-input').value, '保留原聊天草稿');
});

test('loading coalesces clicks and requires a fresh owner read before enabling the retained draft', async (t) => {
  const pending = deferred(), fresh = deferred(), writes = []; let reads = 0;
  const { root } = mount(t, { getThread: async () => ++reads === 1 ? unloadedThread() : fresh.promise,
    action: body => { writes.push(body); return pending.promise; } }, { initialThreadId: thread().id });
  await tick(); type(root, '加载不是发送此草稿');
  one(root, 'load-thread-button').click(); one(root, 'load-thread-button').click();
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0]).sort(), ['action', 'host', 'operationId', 'threadId']);
  assert.equal(writes[0].action, 'load'); assert.equal(writes[0].threadId, thread().id); assert.equal(writes[0].host, 'mac');
  assert.match(writes[0].operationId, /^[\da-f-]{36}$/i);
  pending.resolve({ status: 'confirmed', state: thread({ connectionState: 'ready' }), message: '已打开原聊天' }); await tick();
  assert.equal(reads, 2); assert.equal(one(root, 'send-button').disabled, true); assert.equal(one(root, 'load-thread-button').disabled, true);
  assert.equal(one(root, 'message-input').value, '加载不是发送此草稿'); assert.equal(byClass(root, 'message-user').length, 0);
  fresh.resolve(thread({ connectionState: 'ready', canLoad: false, revision: 2 })); await tick();
  assert.equal(one(root, 'send-button').disabled, false); assert.equal(one(root, 'load-thread-panel').hidden, true);
  assert.equal(one(root, 'message-input').value, '加载不是发送此草稿'); assert.equal(writes.length, 1);
});

test('an unconfirmed load keeps the draft locked and permits only an explicit load retry', async (t) => {
  const timers = fakeClock(), writes = []; let reads = 0;
  const { root, doc, view } = mount(t, { getThread: async () => { reads++; return unloadedThread(); },
    action: async body => { writes.push(body); if (writes.length === 1) throw Error('connection lost'); return { status: 'rejected', message: '请在电脑上重试' }; } },
    { initialThreadId: thread().id, timers });
  await tick(); type(root, '尚未确认的草稿'); one(root, 'load-thread-button').click(); await tick(); await tick();
  assert.equal(writes.length, 1); assert.equal(one(root, 'send-button').disabled, true); assert.equal(one(root, 'load-thread-button').disabled, false);
  assert.ok(one(root, 'load-thread-result').textContent.includes('未确认'));
  doc.defaultView.fire('online'); await view.refresh(); await timers.advance(30000);
  assert.equal(writes.length, 1); assert.ok(reads >= 2);
  one(root, 'load-thread-button').click(); await tick(); await tick(); assert.equal(writes.length, 2);
  assert.notEqual(writes[0].operationId, writes[1].operationId); assert.equal(one(root, 'message-input').value, '尚未确认的草稿');
});

test('late load receipts cannot change a different host or replay the original load', async (t) => {
  const pending = deferred(), writes = [], reads = [];
  const { root, view } = mount(t, { getThreads: async () => ({ threads: [] }), getThread: async (host, id) => { reads.push([host, id]); return host === 'mac' ? unloadedThread({ id }) : thread({ host, id, title: '当前Windows聊天' }); },
    action: body => { writes.push(body); return pending.promise; } }, { initialThreadId: thread().id });
  await tick(); type(root, 'Mac草稿'); one(root, 'load-thread-button').click();
  await view.selectHost('windows'); await view.selectThread('windows-chat'); type(root, 'Windows草稿');
  pending.resolve({ status: 'confirmed', state: thread({ revision: 99, title: '迟到Mac聊天' }) }); await tick(); await tick();
  assert.equal(one(root, 'thread-title').textContent, '当前Windows聊天'); assert.equal(one(root, 'message-input').value, 'Windows草稿');
  assert.equal(one(root, 'load-thread-panel').hidden, true); assert.equal(writes.length, 1);
  assert.deepEqual(reads, [['mac', thread().id], ['windows', 'windows-chat']]);
});

test('a load receipt retires an earlier GET and reads a fresh owner after the action', async (t) => {
  const stale = deferred(), fresh = deferred(), pending = deferred(); let reads = 0, staleSignal;
  const { root, view } = mount(t, { getThread: (_host, _id, options) => {
    reads++; if (reads === 1) { staleSignal = options.signal; return stale.promise; } return fresh.promise;
  }, action: () => pending.promise });
  view.update(unloadedThread()); type(root, '等待加载后的owner'); const oldRead = view.refresh();
  one(root, 'load-thread-button').click(); pending.resolve({ status: 'confirmed' }); await tick();
  assert.equal(staleSignal.aborted, true); assert.equal(reads, 2);
  stale.resolve(thread({ connectionState: 'ready', revision: 99, title: '加载前的旧读取' })); await tick();
  assert.equal(one(root, 'send-button').disabled, true); assert.notEqual(one(root, 'thread-title').textContent, '加载前的旧读取');
  fresh.resolve(thread({ connectionState: 'ready', revision: 2 })); await oldRead; await tick();
  assert.equal(one(root, 'send-button').disabled, false); assert.equal(one(root, 'message-input').value, '等待加载后的owner');
});

test('leaving and returning to the same chat cannot leave a late load permanently pending', async (t) => {
  const pending = deferred(); let reads = 0, posts = 0;
  const { root, view } = mount(t, { getThread: async (_host, id) => { reads++; return unloadedThread({ id }); },
    action: () => { posts++; return pending.promise; } }, { initialThreadId: thread().id });
  await tick(); type(root, '原聊天草稿'); one(root, 'load-thread-button').click();
  await view.selectThread('other-chat'); await view.selectThread(thread().id);
  assert.equal(one(root, 'load-thread-button').disabled, true);
  pending.resolve({ status: 'confirmed', state: thread({ connectionState: 'ready', title: '旧回执' }) }); await tick();
  assert.equal(reads, 3); assert.equal(posts, 1); assert.equal(one(root, 'load-thread-button').disabled, false);
  assert.equal(one(root, 'send-button').disabled, true); assert.equal(one(root, 'message-input').value, '原聊天草稿');
  assert.notEqual(one(root, 'thread-title').textContent, '旧回执');
});

test('load controls require explicit server capability and cannot weaken unknown send guards', async (t) => {
  const { root, view } = mount(t, { action: async () => ({ status: 'unknown' }), getThread: async () => thread() });
  view.update(thread()); type(root, '结果未知的原草稿'); one(root, 'composer').fire('submit'); await tick(); await tick();
  view.update(unloadedThread()); assert.equal(one(root, 'load-thread-button').disabled, false);
  view.update(thread({ connectionState: 'ready', revision: 2 })); assert.equal(one(root, 'send-button').disabled, true);
  view.update(unloadedThread({ canLoad: false })); assert.equal(one(root, 'load-thread-button').hidden, true);
  view.update(thread({ connectionState: 'unavailable', connected: false, ownerConfirmed: false }));
  assert.equal(one(root, 'load-thread-panel').hidden, true);
  for (const connectionState of ['needs-load', 'unavailable']) assert.equal(canAct(thread({ connectionState }), 'send'), false);
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

test('SSE disconnect keeps drafts and needs a fresh GET before old stream callbacks can unlock writes', async (t) => {
  let events, posts = 0, reads = 0; const fresh = deferred(), timers = fakeClock();
  const state = thread(), { root, view } = mount(t, { getThread: async () => ++reads === 1 ? state : fresh.promise, subscribe: (_host, _id, callbacks) => { events = callbacks; return () => {}; }, action: async () => { posts++; } }, { timers });
  await view.selectThread(state.id); const input = type(root, '网络断线也要保留');
  events.onStatus('disconnected'); assert.equal(one(root, 'send-button').disabled, true); assert.equal(input.value, '网络断线也要保留');
  events.onStatus('connecting'); assert.equal(one(root, 'send-button').disabled, true);
  events.onState(thread({ revision: 99 })); assert.equal(one(root, 'send-button').disabled, true);
  await timers.advance(1000); fresh.resolve(thread({ revision: 2 })); await tick();
  assert.equal(one(root, 'send-button').disabled, false); assert.equal(input.value, '网络断线也要保留'); assert.equal(posts, 0);
});

test('a first GET failure retries automatically with one owner read and subscribes only after success', async (t) => {
  const timers = fakeClock(); let reads = 0, subscriptions = 0;
  const { root } = mount(t, { getThread: async () => { if (++reads === 1) throw Error('network switched'); return thread(); },
    subscribe: () => { subscriptions++; return () => {}; } }, { initialThreadId: thread().id, timers });
  await tick(); type(root, '恢复后继续的草稿');
  assert.equal(one(root, 'connection-label').textContent, '正在恢复连接'); assert.equal(subscriptions, 0);
  await timers.advance(999); assert.equal(reads, 1); await timers.advance(1);
  assert.equal(reads, 2); assert.equal(subscriptions, 1); assert.equal(one(root, 'send-button').disabled, false);
  assert.equal(one(root, 'message-input').value, '恢复后继续的草稿');
});

test('three online notifications coalesce and an old same-chat attempt cannot replace the recovery', async (t) => {
  const timers = fakeClock(), stale = deferred(), fresh = deferred(); let reads = 0, oldSignal; const streams = [];
  const { root, doc, view } = mount(t, { getThread: (_host, _id, options) => { reads++; if (reads === 1) return Promise.resolve(thread()); if (reads === 2) { oldSignal = options?.signal; return stale.promise; } return fresh.promise; },
    subscribe: (_host, _id, callbacks) => { const s = { callbacks, closed: 0 }; streams.push(s); return () => s.closed++; } }, { timers, readTimeoutMs: 3000 });
  await view.selectThread(thread().id); type(root, '同聊天草稿');
  doc.defaultView.fire('online'); doc.defaultView.fire('online'); doc.defaultView.fire('online');
  assert.equal(reads, 2); assert.equal(streams[0].closed, 1); assert.equal(one(root, 'send-button').disabled, true);
  await timers.advance(3000); assert.equal(oldSignal.aborted, true); await timers.advance(1000); assert.equal(reads, 3);
  fresh.resolve(thread({ revision: 2, title: '新连接' })); await tick(); stale.resolve(thread({ revision: 99, title: '旧连接' })); await tick();
  streams[0].callbacks.onState(thread({ revision: 100, title: '旧SSE' })); streams[0].callbacks.onStatus('connecting');
  assert.equal(one(root, 'thread-title').textContent, '新连接'); assert.equal(streams.length, 2); assert.equal(one(root, 'send-button').disabled, false);
});

test('recovery uses capped exponential delay and a 15 second message without enabling writes', async (t) => {
  const timers = fakeClock(), starts = [];
  const { root } = mount(t, { getThread: async () => { starts.push(timers.now()); throw Error('offline'); } }, { timers, initialThreadId: thread().id });
  await tick(); type(root, '离线草稿'); await timers.advance(14999);
  assert.deepEqual(starts, [0, 1000, 3000, 7000]); assert.equal(one(root, 'connection-label').textContent, '正在恢复连接');
  await timers.advance(1); assert.equal(one(root, 'connection-label').textContent, '暂时无法连接');
  await timers.advance(30000); assert.deepEqual(starts, [0, 1000, 3000, 7000, 15000, 30000, 45000]);
  assert.equal(one(root, 'send-button').disabled, true); assert.equal(one(root, 'message-input').value, '离线草稿');
});

test('idle heartbeat keeps one stream alive without periodic GETs and silence starts one recovery', async (t) => {
  const timers = fakeClock(), streams = []; let reads = 0;
  const { root, view } = mount(t, { getThread: async () => { reads++; return thread({ messages: [] }); }, subscribe: (_host, _id, callbacks) => {
    const s = { callbacks, closed: 0 }; streams.push(s); return () => s.closed++;
  } }, { timers });
  await view.selectThread(thread().id); type(root, '空闲也可输入');
  for (let i = 0; i < 8; i++) { await timers.advance(15000); streams[0].callbacks.onHeartbeat(); }
  assert.equal(reads, 1); assert.equal(streams.length, 1); assert.equal(one(root, 'send-button').disabled, false);
  await timers.advance(45000); assert.equal(one(root, 'send-button').disabled, true); assert.equal(streams[0].closed, 1);
  await timers.advance(1000); assert.equal(reads, 2); assert.equal(streams.length, 2); assert.equal(one(root, 'send-button').disabled, false);
});

test('foreground revalidation joins online recovery and destroy aborts and clears every pending read', async (t) => {
  const timers = fakeClock(), pending = deferred(); let reads = 0, signal, closed = 0;
  const { root, doc, view } = mount(t, { getThread: (_host, _id, options) => { reads++; signal = options.signal; return reads === 1 ? Promise.resolve(thread()) : pending.promise; },
    subscribe: () => () => closed++ }, { timers });
  await view.selectThread(thread().id); doc.visibilityState = 'hidden'; doc.fire('visibilitychange'); assert.equal(reads, 1);
  doc.visibilityState = 'visible'; doc.fire('visibilitychange'); doc.defaultView.fire('online'); const refreshing = view.refresh();
  // refresh joins this pending GET; do not await it before resolving/cancelling.
  assert.equal(reads, 2); assert.equal(closed, 1); assert.equal(one(root, 'send-button').disabled, true);
  view.destroy(); await refreshing; assert.equal(signal.aborted, true); assert.equal(timers.size, 0);
  pending.resolve(thread({ title: '销毁后迟到' })); await timers.advance(100000); assert.equal(root.childNodes.length, 0); assert.equal(reads, 2);
});

test('an uncertain POST remains single through stream failure, online recovery and fresh snapshots', async (t) => {
  const timers = fakeClock(), pending = deferred(), streams = []; let reads = 0, posts = 0;
  const { root, doc, view } = mount(t, { getThread: async () => { reads++; return thread(); }, action: () => { posts++; return pending.promise; },
    subscribe: (_host, _id, callbacks) => { streams.push(callbacks); return () => {}; } }, { timers });
  await view.selectThread(thread().id); type(root, '断开后不能重发'); one(root, 'composer').fire('submit');
  streams[0].onStatus('disconnected'); doc.defaultView.fire('online'); await tick();
  one(root, 'composer').fire('submit'); assert.equal(posts, 1);
  pending.resolve(Promise.reject(Error('response lost'))); await tick(); await tick();
  await timers.advance(1000); doc.defaultView.fire('online'); await tick(); one(root, 'composer').fire('submit');
  assert.equal(posts, 1); assert.ok(reads >= 2); assert.equal(one(root, 'message-input').value, '断开后不能重发');
  assert.equal(one(root, 'send-button').disabled, true); assert.ok(one(root, 'notice').textContent.includes('未确认'));
});

test('the API passes abort signals, reports ping heartbeats, and ignores all callbacks after close', async () => {
  const controller = new AbortController(), calls = []; let events, beats = 0, states = 0;
  class Events { constructor() { events = this; this.listeners = {}; } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} }
  const api = createMobileAPI({ EventSourceImpl: Events, fetchImpl: async (_url, options) => { calls.push(options); return { ok: true, json: async () => thread() }; } });
  await api.getThread('mac', 'thread', { signal: controller.signal }); assert.equal(calls[0].signal, controller.signal);
  const statuses = [], close = api.subscribe('mac', 'thread', { onStatus: s => statuses.push(s), onState: () => states++, onHeartbeat: () => beats++ });
  events.listeners.ping(); close(); events.listeners.ping(); events.listeners.open(); events.listeners.error(); events.listeners.state({ data: JSON.stringify(thread()) });
  assert.equal(beats, 1); assert.equal(states, 0); assert.deepEqual(statuses, []);
});

test('successful GETs cannot reset backoff when every new stream immediately fails', async (t) => {
  const timers = fakeClock(), starts = []; let closed = 0;
  const { root } = mount(t, { getThread: async () => { starts.push(timers.now()); return thread(); }, subscribe: (_host, _id, callbacks) => {
    callbacks.onState(thread()); callbacks.onStatus('disconnected'); return () => closed++;
  } }, { timers, initialThreadId: thread().id });
  await tick(); await timers.advance(45000);
  assert.deepEqual(starts, [0, 1000, 3000, 7000, 15000, 30000, 45000]); assert.equal(closed, starts.length);
  assert.equal(one(root, 'connection-label').textContent, '暂时无法连接'); assert.equal(one(root, 'send-button').disabled, true);
});

test('default local storage survives a new page instance with the draft and unknown guard', async (t) => {
  const first = fixtureDOM(), local = first.storage; first.doc.defaultView.localStorage = local;
  const old = mountMobileUI(first.root, { api: { action: async () => ({ status: 'unknown' }), getThread: async () => thread() } });
  old.update(thread()); type(first.root, 'Android重建后仍保留'); one(first.root, 'composer').fire('submit'); await tick(); await tick(); old.destroy();
  const next = fixtureDOM(); next.doc.defaultView.localStorage = local;
  let posts = 0; const reopened = mountMobileUI(next.root, { api: { action: async () => { posts++; } } }); t.after(() => reopened.destroy()); reopened.update(thread());
  assert.equal(one(next.root, 'message-input').value, 'Android重建后仍保留'); assert.equal(one(next.root, 'send-button').disabled, true);
  one(next.root, 'composer').fire('submit'); assert.equal(posts, 0);
  const records = JSON.parse(local.getItem('codex-mobile-operation-guards')); assert.equal(records[0][1].status, 'unknown');
  assert.deepEqual(Object.keys(records[0][1]).sort(), ['operationId', 'status']);
});

test('unavailable local storage falls back to session storage and then memory without losing a live draft', (t) => {
  const first = fixtureDOM(); Object.defineProperty(first.doc.defaultView, 'localStorage', { get() { throw Error('storage blocked'); } });
  const view = mountMobileUI(first.root, { api: {} }); t.after(() => view.destroy()); view.update(thread()); type(first.root, '会话存储草稿');
  assert.ok(first.storage.getItem('codex-mobile-draft:' + JSON.stringify(['mac', thread().id])).includes('会话存储'));
  const second = fixtureDOM(); const blocked = { getItem() { return null; }, setItem() { throw Error('quota'); } };
  second.doc.defaultView.localStorage = blocked; second.doc.defaultView.sessionStorage = blocked;
  const memory = mountMobileUI(second.root, { api: {} }); t.after(() => memory.destroy()); memory.update(thread()); type(second.root, '内存草稿');
  memory.update(thread({ revision: 2 })); assert.equal(one(second.root, 'message-input').value, '内存草稿');
});

test('an older tab cannot clear another tab unknown receipt or submit that operation', () => {
  const { storage } = fixtureDOM(), old = new ActionGate({ storage }), other = new ActionGate({ storage });
  other.begin('same-content'); other.settle('same-content', { status: 'unknown' });
  old.begin('unrelated'); old.settle('unrelated', { status: 'confirmed' }); old.forgetConfirmed('same-content');
  assert.equal(old.begin('same-content'), null);
  const reopened = new ActionGate({ storage }); assert.equal(reopened.get('same-content').status, 'unknown');
});

test('begin refuses the POST when persistence discovers a same-key unresolved receipt from another tab', () => {
  for (const status of ['unknown', 'pending', 'submitted']) {
    let reads = 0, written;
    const storage = { getItem: () => ++reads >= 3 ? JSON.stringify([['race', { operationId: 'other-tab', status }]]) : '[]', setItem: (_key, value) => { written = value; } };
    const gate = new ActionGate({ storage }); assert.equal(gate.begin('race'), null, status);
    assert.equal(gate.get('race').operationId, 'other-tab'); assert.equal(JSON.parse(written)[0][1].status, status === 'pending' ? 'unknown' : status);
  }
});

test('upgrading from session storage migrates the existing draft and unknown fence before use', async (t) => {
  const dom = fixtureDOM(), legacy = dom.storage;
  const old = mountMobileUI(dom.root, { api: { action: async () => ({ status: 'unknown' }), getThread: async () => thread() }, storage: legacy });
  old.update(thread()); type(dom.root, '旧版不能重复发送的草稿'); one(dom.root, 'composer').fire('submit'); await tick(); await tick(); old.destroy();
  const local = fixtureDOM().storage; dom.doc.defaultView.localStorage = local;
  let posts = 0; const upgraded = mountMobileUI(dom.root, { api: { action: async () => { posts++; } } }); t.after(() => upgraded.destroy()); upgraded.update(thread());
  assert.equal(one(dom.root, 'message-input').value, '旧版不能重复发送的草稿'); assert.equal(one(dom.root, 'send-button').disabled, true);
  one(dom.root, 'composer').fire('submit'); assert.equal(posts, 0);
  assert.equal(JSON.parse(local.getItem('codex-mobile-operation-guards'))[0][1].status, 'unknown');
  assert.equal(legacy.getItem('codex-mobile-operation-guards'), null);
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

test('an action timeout becomes unknown upstream without retrying its POST', async () => {
  let calls = 0, signal, deadline;
  const api = createMobileAPI({ actionTimeoutMs: 20, fetchImpl: async (_url, options) => {
    calls++; signal = options.signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Submission response lost', 'AbortError')), { once: true }));
  } });
  try {
    await assert.rejects(Promise.race([api.action({ action: 'send', text: 'timeout probe' }),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(Error('POST did not stop waiting')), 250); })]), { name: 'AbortError' });
    assert.equal(signal.aborted, true); assert.equal(calls, 1);
  } finally { clearTimeout(deadline); }
});

test('a rapid offline-online transition retains the trailing wake instead of waiting for backoff', async t => {
  const timers = fakeClock(); let reads = 0;
  const { root, doc, view } = mount(t, { getThread: async () => { reads++; return thread(); }, subscribe: () => () => {} }, { timers });
  await view.selectThread(thread().id); type(root, '快速切网草稿');
  doc.defaultView.fire('online'); await tick(); assert.equal(reads, 2);
  await timers.advance(100); doc.defaultView.fire('offline'); doc.defaultView.fire('online'); doc.defaultView.fire('online');
  assert.equal(one(root, 'send-button').disabled, true);
  await timers.advance(400); assert.equal(reads, 3); assert.equal(one(root, 'send-button').disabled, false);
  assert.equal(one(root, 'message-input').value, '快速切网草稿');
  view.destroy(); assert.equal(timers.size, 0);
});

test('catalog and creation API encode filters and POST once without retries', async () => {
  const calls = [], api = createMobileAPI({ fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ status: 'submitted' }) }; } });
  await api.getThreads('windows', { projectId: 'red/app', q: '新 UI', cursor: 'page/2', limit: 50, range: 'all', cwd: '/forbidden' });
  const query = new URL('http://local' + calls[0].url).searchParams;
  assert.equal(query.get('host'), 'windows'); assert.equal(query.get('projectId'), 'red/app'); assert.equal(query.get('q'), '新 UI'); assert.equal(query.get('range'), 'all'); assert.equal(query.has('cwd'), false);
  await api.getCreation('mac'); await api.getThreadStatuses('mac', ['a', 'b']);
  const body = { host: 'mac', operationId: 'durable', projectId: null, prompt: 'test' }; await api.createThread(body);
  assert.equal(calls[1].url, '/api/creation?host=mac'); assert.equal(calls[2].url, '/api/statuses?host=mac&ids=a%2Cb');
  assert.equal(calls[3].url, '/api/create'); assert.equal(calls[3].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[3].options.body), body);
  let count = 0; const failing = createMobileAPI({ fetchImpl: async () => { count++; throw Error('lost'); } });
  await assert.rejects(failing.createThread(body), /lost/); assert.equal(count, 1);
});

test('week/all project groups, server search and pagination preserve the selected chat draft', async (t) => {
  const calls = [], timers = fakeClock(), groups = [{ id: 'red', name: 'red-app', path: 'D:\\Project\\red-app', count: 0, totalCount: 331 }, { id: 'tools', name: 'Tools', count: 2, totalCount: 2 }];
  const { root, view } = mount(t, {
    getHosts: async () => ({ hosts: [{ id: 'mac' }] }),
    getThreads: async (host, options) => { calls.push({ host, ...options }); return { projects: groups, total: options.q ? 1 : 332, nextCursor: !options.q && !options.cursor ? 'next' : null,
      threads: [{ id: options.cursor ? 'older' : options.q ? 'normalized-match' : 'recent', title: options.q ? 'ＵＩ 还原' : options.cursor ? '更早的还原会话' : '最近任务', projectId: 'red', projectName: 'red-app' }] }; },
  }, { timers }); await tick(); view.update(thread()); type(root, '当前聊天草稿');
  assert.equal(calls[0].range, 'week'); assert.equal(calls[0].limit, 50); assert.equal(one(root, 'history-range').value, 'week');
  assert.ok(one(root, 'project-select').textContent.includes('本周0 · 全部331')); assert.equal(byClass(root, 'project-group').length, 1);
  const project = one(root, 'project-select'); project.value = 'red'; project.fire('change'); await tick();
  assert.equal(calls.at(-1).projectId, 'red'); assert.equal(one(root, 'thread-title').textContent, '手机适配'); assert.equal(one(root, 'message-input').value, '当前聊天草稿');
  project.value = ''; project.fire('change'); await tick(); assert.equal(one(root, 'project-select').value, '');
  const range = one(root, 'history-range'); range.value = 'all'; range.fire('change'); await tick(); assert.equal(calls.at(-1).range, 'all');
  one(root, 'load-more-button').click(); await tick(); assert.equal(calls.at(-1).cursor, 'next'); assert.equal(byClass(root, 'thread-row').length, 2);
  const search = one(root, 'thread-search'); search.value = 'red UI'; search.fire('input'); await timers.advance(250);
  assert.equal(calls.at(-1).q, 'red UI'); assert.equal(calls.at(-1).cursor, null); assert.equal(byClass(root, 'thread-row').length, 1); assert.ok(one(root, 'thread-list').textContent.includes('ＵＩ 还原'));
  assert.equal(one(root, 'message-input').value, '当前聊天草稿'); assert.equal(one(root, 'thread-title').textContent, '手机适配');
});

test('late list results cannot overwrite a newer project/range/search selection', async (t) => {
  const old = deferred(), calls = [], timers = fakeClock();
  const { root } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac' }] }), getThreads: async (host, options) => { calls.push(options); return calls.length === 1 ? old.promise : { threads: [{ id: 'new', title: '全部历史的新结果' }], projects: [] }; } }, { timers });
  await tick(); const range = one(root, 'history-range'); range.value = 'all'; range.fire('change'); await tick();
  old.resolve({ threads: [{ id: 'old', title: '过期最近一周' }] }); await tick();
  assert.ok(one(root, 'thread-list').textContent.includes('全部历史的新结果')); assert.ok(!one(root, 'thread-list').textContent.includes('过期最近一周'));
});

test('creation capability is lazy, only official project IDs are posted, and confirmed UUID navigates', async (t) => {
  let reads = 0, writes = 0; const navigations = [], created = '22222222-2222-4222-8222-222222222222';
  const { root, view } = mount(t, { getCreation: async () => { reads++; return nativeCreation; }, createThread: async body => { writes++; assert.equal(body.projectId, 'official-red'); assert.equal(body.prompt, '还原新UI'); assert.equal(body.title, '验收'); assert.ok(body.operationId); assert.equal(Object.hasOwn(body, 'cwd'), false); return { status: 'confirmed', threadId: created }; }, getThread: async (host, id) => thread({ host, id, title: '新建结果' }) }, { onNavigate: value => navigations.push(value) });
  view.update(thread()); type(root, '原聊天草稿'); assert.equal(reads, 0); one(root, 'new-chat-button').click(); await tick(); assert.equal(reads, 1); assert.equal(writes, 0);
  chooseCreationProject(root, 'official-red');
  const prompt = one(root, 'create-prompt'); prompt.value = '还原新UI'; prompt.fire('input'); const title = one(root, 'create-title'); title.value = '验收'; title.fire('input');
  assert.equal(one(root, 'create-submit').disabled, false); one(root, 'create-form').fire('submit'); one(root, 'create-form').fire('submit'); await tick();
  assert.equal(writes, 1); assert.equal(navigations.at(-1).id, created); assert.equal(one(root, 'creation-dialog').hidden, true);
  await view.selectThread(thread().id); assert.equal(one(root, 'message-input').value, '原聊天草稿');
});

test('a history/worktree group cannot silently create in projectless or a different official project', async (t) => {
  let writes = 0;
  const { root } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac' }] }), getThreads: async () => ({ threads: [], projects: [{ id: 'worktree', name: 'red-app worktree', path: 'D:\\Project\\red-app-worktree', count: 0, totalCount: 5 }] }), getCreation: async () => nativeCreation, createThread: async () => { writes++; } }); await tick();
  const project = one(root, 'project-select'); project.value = 'worktree'; project.fire('change'); await tick(); one(root, 'drawer-new-chat').click(); await tick();
  const prompt = one(root, 'create-prompt'); prompt.value = '新任务'; prompt.fire('input');
  assert.ok(one(root, 'create-project').textContent.includes('当前分组不能新建')); assert.equal(one(root, 'create-submit').disabled, true); one(root, 'create-form').fire('submit'); await tick(); assert.equal(writes, 0);
  chooseCreationProject(root, ''); assert.equal(one(root, 'create-submit').disabled, false);
});

test('unknown creation survives closing/reload with draft and GET refresh never replays POST', async (t) => {
  const dom = fixtureDOM(); let writes = 0; const api = { getCreation: async () => nativeCreation, createThread: async () => { writes++; throw Error('network lost after dispatch'); }, getThreads: async () => ({ threads: [] }) };
  let view = mountMobileUI(dom.root, { api, storage: dom.storage }); t.after(() => view.destroy());
  view.openCreation(); await tick(); const prompt = one(dom.root, 'create-prompt'); prompt.value = '可能已创建'; prompt.fire('input'); one(dom.root, 'create-form').fire('submit'); await tick();
  assert.equal(writes, 1); assert.equal(one(dom.root, 'create-submit').disabled, true); assert.equal(one(dom.root, 'create-back-list').hidden, false);
  one(dom.root, 'create-close').click(); view.openCreation(); await tick(); assert.equal(one(dom.root, 'create-prompt').value, '可能已创建'); assert.equal(one(dom.root, 'create-submit').disabled, true);
  view.destroy(); view = mountMobileUI(dom.root, { api, storage: dom.storage }); view.openCreation(); await tick();
  assert.equal(one(dom.root, 'create-prompt').value, '可能已创建'); assert.equal(one(dom.root, 'create-submit').disabled, true); one(dom.root, 'create-form').fire('submit'); one(dom.root, 'create-back-list').click(); await tick(); assert.equal(writes, 1);
});

test('submitted preparation and malformed confirmed receipts never navigate client IDs', async (t) => {
  for (const result of [{ status: 'submitted', clientThreadId: 'client-preparing', message: '已提交，项目准备中' }, { status: 'confirmed', threadId: 'not-an-official-thread' }]) {
    const dom = fixtureDOM(), navigations = [], view = mountMobileUI(dom.root, { storage: dom.storage, onNavigate: value => navigations.push(value), api: { getCreation: async () => nativeCreation, createThread: async () => result } }); t.after(() => view.destroy());
    view.openCreation(); await tick(); const prompt = one(dom.root, 'create-prompt'); prompt.value = '新任务'; prompt.fire('input'); one(dom.root, 'create-form').fire('submit'); await tick();
    assert.equal(navigations.length, 0); assert.equal(one(dom.root, 'create-submit').disabled, true); assert.equal(one(dom.root, 'created-open').hidden, true); assert.equal(one(dom.root, 'create-back-list').hidden, false);
  }
});

test('a late confirmed create cannot steal the screen after dialog closure or a host switch', async (t) => {
  const pending = deferred(), navigations = [], { root, view } = mount(t, { getCreation: async () => nativeCreation, createThread: () => pending.promise, getThreads: async () => ({ threads: [] }) }, { onNavigate: value => navigations.push(value) });
  view.openCreation(); await tick(); const prompt = one(root, 'create-prompt'); prompt.value = '新任务'; prompt.fire('input'); one(root, 'create-form').fire('submit'); one(root, 'create-close').click(); await view.selectHost('windows');
  pending.resolve({ status: 'confirmed', threadId: '22222222-2222-4222-8222-222222222222' }); await tick();
  assert.deepEqual(navigations, [{ host: 'windows', id: null }]); assert.equal(one(root, 'creation-dialog').hidden, true);
});

test('only confirmed live status spins; drawer polling is visible-only and failures clear old running', async (t) => {
  const timers = fakeClock(), current = thread().id, other = '22222222-2222-4222-8222-222222222222'; let calls = 0, fail = false;
  const { root, doc, view } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac' }] }), getThreads: async () => ({ threads: [{ id: current, title: '当前聊天', status: 'running', statusConfirmed: true }, { id: other, title: '其他聊天', status: 'running', statusConfirmed: false }] }),
    getThreadStatuses: async (host, ids) => { calls++; assert.deepEqual(ids, [current, other]); if (fail) throw Error('owner unavailable'); return { statuses: [{ id: current, status: 'running', statusConfirmed: true }, { id: other, status: 'working', statusConfirmed: true }] }; } }, { timers }); await tick();
  view.update(thread({ status: 'idle' })); assert.equal(one(root, 'title-running').hidden, true);
  const rows = () => byClass(root, 'thread-row'); assert.equal(one(rows()[0], 'row-running').hidden, true); assert.equal(one(rows()[1], 'row-running').hidden, false);
  view.update(thread({ status: 'running', revision: 2 })); assert.equal(one(root, 'title-running').hidden, false); assert.equal(one(rows()[0], 'row-running').hidden, false);
  view.update(thread({ status: 'running', revision: 3, connected: false })); assert.equal(one(root, 'title-running').hidden, true); assert.equal(one(rows()[0], 'row-running').hidden, true);
  fail = true; await timers.advance(10000); assert.equal(calls, 2); assert.equal(one(rows()[1], 'row-running').hidden, true);
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange'); await timers.advance(30000); assert.equal(calls, 2);
  doc.visibilityState = 'visible'; doc.fire('visibilitychange'); await tick(); assert.equal(calls, 3);
  one(root, 'menu-button').click(); await timers.advance(30000); assert.equal(calls, 3); view.destroy(); assert.equal(timers.size, 0);
});

test('status batches are capped and stale responses from a prior search cannot restore running', async (t) => {
  const old = deferred(), timers = fakeClock(); let calls = 0;
  const { root } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac' }] }), getThreads: async (host, options) => ({ threads: options.q ? [{ id: 'new', title: '新搜索' }] : Array.from({ length: 130 }, (_, i) => ({ id: 'row-' + i, title: '旧' + i })) }),
    getThreadStatuses: async (host, ids) => { calls++; if (calls === 1) { assert.equal(ids.length, 100); return old.promise; } return { statuses: [] }; } }, { timers }); await tick();
  const search = one(root, 'thread-search'); search.value = '新'; search.fire('input'); await timers.advance(250);
  old.resolve({ statuses: [{ id: 'new', status: 'running', statusConfirmed: true }] }); await tick();
  assert.equal(byClass(root, 'thread-row').length, 1); assert.equal(one(root, 'row-running').hidden, true); assert.ok(one(root, 'thread-list').textContent.includes('新搜索'));
});

test('a hanging read-only status poll expires, removes stale running and is aborted on drawer close', async (t) => {
  const timers = fakeClock(); let calls = 0, signal;
  const { root, view } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac' }] }), getThreads: async () => ({ threads: [{ id: 'background', title: '后台任务' }] }),
    getThreadStatuses: async (_host, _ids, options) => { calls++; signal = options.signal; return calls === 1 ? { statuses: [{ id: 'background', status: 'running', statusConfirmed: true }] } : new Promise(() => {}); } }, { timers }); await tick();
  assert.equal(one(root, 'row-running').hidden, false); await timers.advance(10000); assert.equal(calls, 2);
  await timers.advance(20000); assert.equal(signal.aborted, true); assert.equal(one(root, 'row-running').hidden, true);
  await timers.advance(10000); assert.equal(calls, 3); one(root, 'menu-button').click(); assert.equal(signal.aborted, true);
  view.destroy(); assert.equal(timers.size, 0);
});

test('project picker loading cannot erase a saved project or unlock an unknown creation', async (t) => {
  const dom = fixtureDOM(), bare = dom.doc.createElement('select'); bare.value = 'official-red'; assert.equal(bare.value, '', 'fixture must model native select without options');
  let writes = 0, capability = async () => nativeCreation;
  const api = { getCreation: () => capability(), createThread: async body => { writes++; assert.equal(body.projectId, 'official-red'); return { status: 'unknown' }; } };
  let view = mountMobileUI(dom.root, { api, storage: dom.storage }); t.after(() => view.destroy()); view.openCreation(); await tick();
  chooseCreationProject(dom.root, 'official-red'); const prompt = one(dom.root, 'create-prompt'); prompt.value = '保留原生项目的未知创建'; prompt.fire('input');
  one(dom.root, 'create-form').fire('submit'); await tick(); assert.equal(writes, 1); view.destroy();
  const pending = deferred(); capability = () => pending.promise;
  view = mountMobileUI(dom.root, { api, storage: dom.storage }); view.openCreation();
  assert.ok(one(dom.root, 'create-project').textContent.includes('正在读取'));
  one(dom.root, 'create-title').fire('input'); one(dom.root, 'create-close').click();
  assert.equal(JSON.parse(dom.storage.getItem('codex-mobile-create-draft:mac')).projectId, 'official-red');
  view.destroy(); pending.resolve(nativeCreation); await tick();
  capability = async () => ({ supported: true, projectless: true, projects: [] });
  view = mountMobileUI(dom.root, { api, storage: dom.storage }); view.openCreation(); await tick();
  assert.ok(one(dom.root, 'create-project').textContent.includes('已保存项目暂不可用')); assert.equal(one(dom.root, 'create-submit').disabled, true);
  assert.equal(JSON.parse(dom.storage.getItem('codex-mobile-create-draft:mac')).projectId, 'official-red'); view.destroy();
  capability = async () => nativeCreation; view = mountMobileUI(dom.root, { api, storage: dom.storage }); view.openCreation(); await tick();
  assert.equal(one(dom.root, 'create-project').value, 'official-red'); assert.equal(one(dom.root, 'create-prompt').value, '保留原生项目的未知创建'); assert.equal(one(dom.root, 'create-submit').disabled, true);
  one(dom.root, 'create-form').fire('submit'); await tick(); assert.equal(writes, 1);
});

test('touch project picker exposes explicit button options and preserves the official ID in the payload', async (t) => {
  const writes = [];
  const { root, view, storage } = mount(t, { getCreation: async () => ({ ...nativeCreation, projects: [...nativeCreation.projects, { projectId: 'official-btc', name: 'btc-phone' }] }), createThread: async body => { writes.push(body); return { status: 'unknown' }; } });
  view.openCreation(); await tick(); const trigger = one(root, 'create-project');
  assert.equal(trigger.tagName, 'BUTTON'); assert.equal(trigger.type, 'button'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  trigger.click(); assert.equal(one(root, 'create-project-options').hidden, false); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.ok(byClass(root, 'create-project-option').every(option => option.type === 'button' && option.getAttribute('role') === 'option'));
  byClass(root, 'create-project-option').find(option => option.value === 'official-red').click();
  assert.equal(trigger.textContent, 'red-app'); assert.equal(one(root, 'create-project-options').hidden, true); assert.equal(writes.length, 0);
  chooseCreationProject(root, 'official-btc'); assert.equal(trigger.textContent, 'btc-phone');
  assert.equal(JSON.parse(storage.getItem('codex-mobile-create-draft:mac')).projectId, 'official-btc');
  const prompt = one(root, 'create-prompt'); prompt.value = '在所选项目执行'; prompt.fire('input'); one(root, 'create-form').fire('submit'); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].projectId, 'official-btc'); assert.equal(one(root, 'create-submit').disabled, true);
  chooseCreationProject(root, 'official-red'); chooseCreationProject(root, 'official-btc'); assert.equal(one(root, 'create-submit').disabled, true);
});

test('unsupported creation explains the disabled capability and permits a GET-only refresh', async (t) => {
  let reads = 0, writes = 0;
  const { root, view } = mount(t, { getCreation: async () => { reads++; return { supported: false, projects: [], reason: 'Mac 官方新建接口拒绝当前工具的签名身份' }; }, createThread: async () => { writes++; } });
  view.openCreation(); await tick(); const trigger = one(root, 'create-project');
  assert.equal(trigger.disabled, false); trigger.click(); assert.equal(one(root, 'create-project-options').hidden, false);
  assert.ok(one(root, 'create-project-options').textContent.includes('签名身份'));
  assert.ok(one(root, 'creation-state').textContent.includes('上方选择 Windows'));
  assert.equal(byClass(root, 'create-host-button').find(choice => choice.dataset.host === 'windows').disabled, false);
  assert.equal(byClass(root, 'create-project-option').length, 0); assert.equal(one(root, 'create-retry').hidden, false);
  one(root, 'create-retry').click(); await tick(); assert.equal(reads, 2); assert.equal(writes, 0); assert.equal(one(root, 'create-submit').disabled, true);
});

test('creation can select Windows inside the dialog without moving the current Mac chat or submitting', async (t) => {
  const reads = [], navigations = []; let writes = 0;
  const { root, view } = mount(t, { getCreation: async host => {
    reads.push(host); return host === 'mac' ? { supported: false, projects: [], reason: 'Mac 暂不支持新建' } : nativeCreation;
  }, createThread: async () => { writes++; } }, { onNavigate: value => navigations.push(value) });
  view.update(thread()); type(root, 'Mac原聊天草稿'); view.openCreation(); await tick();
  assert.ok(one(root, 'creation-dialog').textContent.includes('执行电脑'));
  const windows = byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows');
  assert.ok(windows, 'Windows must be selectable inside the creation dialog'); assert.equal(windows.type, 'button'); windows.click(); await tick();
  assert.deepEqual(reads, ['mac', 'windows']); assert.equal(one(root, 'creation-dialog').hidden, false);
  assert.equal(windows.getAttribute('aria-pressed'), 'true'); assert.equal(one(root, 'thread-title').textContent, '手机适配');
  assert.equal(one(root, 'message-input').value, 'Mac原聊天草稿'); assert.deepEqual(navigations, []); assert.equal(writes, 0);
  chooseCreationProject(root, 'official-red'); assert.equal(one(root, 'create-project').textContent, 'red-app');
});

test('a confirmed create from a closed dialog settles its guard without changing the new dialog or its host draft', async (t) => {
  const pending = deferred(), navigations = [], writes = [];
  const { root, view, storage } = mount(t, { getCreation: async () => nativeCreation, createThread: body => { writes.push(body); return pending.promise; } }, { onNavigate: value => navigations.push(value) });
  view.update(thread()); view.openCreation(); await tick();
  byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  chooseCreationProject(root, 'official-red'); const prompt = one(root, 'create-prompt'); prompt.value = 'Windows待确认草稿'; prompt.fire('input');
  one(root, 'create-form').fire('submit'); one(root, 'create-close').click(); view.openCreation(); await tick();
  prompt.value = '新的Mac草稿'; prompt.fire('input');
  pending.resolve({ status: 'confirmed', threadId: '22222222-2222-4222-8222-222222222222' }); await tick();
  assert.deepEqual(navigations, []); assert.equal(one(root, 'creation-dialog').hidden, false); assert.equal(prompt.value, '新的Mac草稿');
  assert.equal(JSON.parse(storage.getItem('codex-mobile-create-draft:windows')).prompt, 'Windows待确认草稿');
  byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  assert.equal(prompt.value, 'Windows待确认草稿'); assert.equal(one(root, 'create-submit').disabled, true);
  one(root, 'create-form').fire('submit'); await tick(); assert.equal(writes.length, 1);
});

test('a late host list updates offline labels without changing the explicit creation target', async (t) => {
  const hosts = deferred(), writes = [], reads = [];
  const { root, view } = mount(t, { getHosts: () => hosts.promise, getCreation: async host => {
    reads.push(host); return { supported: true, projectless: false, projects: [{ projectId: 'mac-project', name: 'Mac项目' }] };
  }, createThread: async body => { writes.push(body); return { status: 'unknown' }; } });
  view.openCreation(); await tick(); chooseCreationProject(root, 'mac-project');
  const prompt = one(root, 'create-prompt'); prompt.value = '仍在Mac创建'; prompt.fire('input');
  hosts.resolve({ hosts: [{ id: 'windows', name: 'Windows', online: false }] }); await tick();
  const choices = byClass(root, 'create-host-button');
  assert.equal(choices.find(item => item.dataset.host === 'mac').getAttribute('aria-pressed'), 'true');
  assert.ok(choices.find(item => item.dataset.host === 'windows').textContent.includes('离线'));
  assert.ok(one(root, 'create-submit').textContent.includes('Mac')); assert.deepEqual(reads, ['mac']);
  one(root, 'create-form').fire('submit'); await tick(); assert.equal(writes.length, 1); assert.equal(writes[0].host, 'mac'); assert.equal(writes[0].projectId, 'mac-project');
});

test('creation target changes restore separate drafts and only post that computers official project ID', async (t) => {
  const writes = [], catalogs = Object.fromEntries(['mac', 'windows'].map(host => [host, { supported: true, projectless: false, projects: [{ projectId: host + '-project', name: host + '项目' }] }]));
  const { root, view } = mount(t, { getCreation: async host => catalogs[host], createThread: async body => { writes.push(body); return { status: 'unknown' }; } });
  view.update(thread()); view.openCreation(); await tick(); chooseCreationProject(root, 'mac-project');
  const prompt = one(root, 'create-prompt'), title = one(root, 'create-title'), target = host => byClass(root, 'create-host-button').find(item => item.dataset.host === host);
  prompt.value = 'Mac任务'; prompt.fire('input'); title.value = 'Mac标题'; title.fire('input');
  target('windows').click(); await tick();
  assert.equal(prompt.value, ''); assert.equal(title.value, ''); assert.equal(one(root, 'create-project').value, ''); assert.equal(one(root, 'create-submit').disabled, true);
  chooseCreationProject(root, 'windows-project'); prompt.value = 'Windows任务'; prompt.fire('input'); title.value = 'Windows标题'; title.fire('input');
  target('mac').click(); await tick();
  assert.equal(prompt.value, 'Mac任务'); assert.equal(title.value, 'Mac标题'); assert.equal(one(root, 'create-project').value, 'mac-project');
  target('windows').click(); await tick();
  assert.equal(prompt.value, 'Windows任务'); assert.equal(title.value, 'Windows标题'); assert.equal(one(root, 'create-project').value, 'windows-project');
  one(root, 'create-form').fire('submit'); await tick(); assert.equal(writes.length, 1);
  assert.deepEqual({ host: writes[0].host, projectId: writes[0].projectId, prompt: writes[0].prompt, title: writes[0].title }, { host: 'windows', projectId: 'windows-project', prompt: 'Windows任务', title: 'Windows标题' });
  target('mac').click(); await tick(); assert.equal(one(root, 'create-submit').disabled, false);
  target('windows').click(); await tick(); assert.equal(one(root, 'create-submit').disabled, true); one(root, 'create-form').fire('submit'); assert.equal(writes.length, 1);
});

test('an unknown Windows creation survives target changes and page reload without borrowing the Mac draft', async (t) => {
  const dom = fixtureDOM(); let writes = 0;
  const api = { getCreation: async () => nativeCreation, createThread: async () => { writes++; return { status: 'unknown' }; } };
  let view = mountMobileUI(dom.root, { api, storage: dom.storage }); t.after(() => view.destroy());
  view.openCreation(); await tick(); byClass(dom.root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  chooseCreationProject(dom.root, 'official-red'); let prompt = one(dom.root, 'create-prompt'); prompt.value = 'Windows结果待确认'; prompt.fire('input');
  one(dom.root, 'create-form').fire('submit'); await tick(); assert.equal(writes, 1); view.destroy();
  view = mountMobileUI(dom.root, { api, storage: dom.storage }); view.openCreation(); await tick(); prompt = one(dom.root, 'create-prompt');
  assert.equal(prompt.value, ''); assert.equal(byClass(dom.root, 'create-host-button').find(item => item.dataset.host === 'mac').getAttribute('aria-pressed'), 'true');
  byClass(dom.root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  assert.equal(prompt.value, 'Windows结果待确认'); assert.equal(one(dom.root, 'create-project').value, 'official-red'); assert.equal(one(dom.root, 'create-submit').disabled, true);
  one(dom.root, 'create-close').click(); view.openCreation(); await tick(); byClass(dom.root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  one(dom.root, 'create-form').fire('submit'); await tick(); assert.equal(writes, 1); assert.equal(one(dom.root, 'create-submit').disabled, true);
});

test('late capability reads cannot replace the chosen target after rapid creation host changes', async (t) => {
  const oldMac = deferred(), oldWindows = deferred(), reads = []; let macReads = 0, firstSignal;
  const currentMac = { supported: true, projectless: false, projects: [{ projectId: 'current-mac-project', name: '当前Mac项目' }] };
  const { root, view } = mount(t, { getCreation: (host, { signal }) => {
    reads.push(host); if (host === 'windows') return oldWindows.promise;
    if (++macReads === 1) { firstSignal = signal; return oldMac.promise; } return Promise.resolve(currentMac);
  } });
  view.openCreation(); byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows').click();
  byClass(root, 'create-host-button').find(item => item.dataset.host === 'mac').click(); await tick();
  assert.equal(firstSignal.aborted, true); chooseCreationProject(root, 'current-mac-project');
  oldWindows.resolve({ supported: false, reason: '迟到的Windows读取失败', projects: [] }); oldMac.resolve(nativeCreation); await tick();
  assert.deepEqual(reads, ['mac', 'windows', 'mac']); assert.equal(one(root, 'create-project').value, 'current-mac-project'); assert.equal(one(root, 'create-project').textContent, '当前Mac项目');
  assert.equal(one(root, 'create-submit').textContent, '在 Mac 创建并开始'); assert.equal(one(root, 'creation-state').textContent.includes('迟到'), false);
});

test('a pending creation locks its target and a confirmed Windows UUID opens before its slow directory', async (t) => {
  const pending = deferred(), slowList = deferred(), navigations = [], reads = [], writes = [];
  const created = '22222222-2222-4222-8222-222222222222';
  const { root, view } = mount(t, { getCreation: async () => nativeCreation, createThread: body => { writes.push(body); return pending.promise; },
    getThreads: host => host === 'windows' ? slowList.promise : Promise.resolve({ threads: [] }),
    getThread: async (host, id) => { reads.push({ host, id }); return thread({ host, id, title: host === 'windows' ? 'Windows已创建' : 'Mac原会话' }); },
  }, { onNavigate: value => navigations.push(value) });
  view.update(thread()); type(root, '保留Mac原聊天草稿'); view.openCreation(); await tick();
  byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  chooseCreationProject(root, 'official-red'); const prompt = one(root, 'create-prompt'); prompt.value = '明确在Windows创建'; prompt.fire('input');
  one(root, 'create-form').fire('submit'); assert.ok(byClass(root, 'create-host-button').every(item => item.disabled));
  byClass(root, 'create-host-button').find(item => item.dataset.host === 'mac').fire('click'); one(root, 'create-form').fire('submit');
  assert.equal(writes.length, 1); assert.equal(writes[0].host, 'windows'); assert.equal(byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows').getAttribute('aria-pressed'), 'true');
  pending.resolve({ status: 'confirmed', threadId: created }); await tick();
  assert.deepEqual(reads, [{ host: 'windows', id: created }]); assert.deepEqual(navigations.at(-1), { host: 'windows', id: created });
  assert.equal(one(root, 'creation-dialog').hidden, true); assert.equal(one(root, 'thread-title').textContent, 'Windows已创建');
  await view.selectHost('mac'); await view.selectThread(thread().id); slowList.resolve({ threads: [{ id: created, title: '迟到Windows目录' }] }); await tick();
  assert.deepEqual(navigations.at(-1), { host: 'mac', id: thread().id }); assert.equal(one(root, 'thread-title').textContent, 'Mac原会话');
  assert.equal(one(root, 'thread-drawer').hidden, true); assert.equal(one(root, 'message-input').value, '保留Mac原聊天草稿');
});

test('offline and unsupported Windows creation stay on Windows and only retry the read', async (t) => {
  for (const kind of ['offline', 'unsupported']) {
    const reads = []; let writes = 0;
    const { root, view } = mount(t, { getHosts: async () => ({ hosts: [{ id: 'mac', name: 'Mac', online: true }, { id: 'windows', name: 'Windows', online: false }] }),
      getCreation: async host => { reads.push(host); if (host === 'windows' && kind === 'offline') throw Error('Windows 离线，暂时无法读取'); return { supported: false, projects: [], reason: host + ' 暂不支持创建聊天' }; },
      createThread: async () => { writes++; },
    }); await tick(); view.update(thread()); view.openCreation(); await tick();
    assert.equal(one(root, 'creation-state').textContent.includes('关闭此窗口'), false);
    const windows = byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows'); windows.click(); await tick();
    const prompt = one(root, 'create-prompt'); prompt.value = '不可自动回退'; prompt.fire('input'); one(root, 'create-form').fire('submit');
    assert.equal(windows.getAttribute('aria-pressed'), 'true'); assert.ok(windows.textContent.includes('离线')); assert.equal(one(root, 'create-submit').disabled, true);
    one(root, 'create-retry').click(); await tick(); assert.deepEqual(reads, ['mac', 'windows', 'windows']); assert.equal(writes, 0);
    assert.equal(one(root, 'creation-dialog').hidden, false); assert.ok(one(root, 'creation-state').textContent.startsWith('执行电脑：Windows。'));
  }
});

test('reopening the same host while creation is pending invalidates automatic confirmed navigation', async (t) => {
  const pending = deferred(), navigations = [];
  const { root, view, storage } = mount(t, { getCreation: async () => nativeCreation, createThread: () => pending.promise }, { initialHost: 'windows', onNavigate: value => navigations.push(value) });
  view.update(thread({ host: 'windows' })); view.openCreation(); await tick();
  const prompt = one(root, 'create-prompt'); prompt.value = '同电脑新窗口仍需保留'; prompt.fire('input'); one(root, 'create-form').fire('submit');
  one(root, 'create-close').click(); view.openCreation(); await tick(); pending.resolve({ status: 'confirmed', threadId: '22222222-2222-4222-8222-222222222222' }); await tick();
  assert.deepEqual(navigations, []); assert.equal(one(root, 'creation-dialog').hidden, false); assert.equal(prompt.value, '同电脑新窗口仍需保留');
  assert.equal(JSON.parse(storage.getItem('codex-mobile-create-draft:windows')).prompt, '同电脑新窗口仍需保留');
  assert.equal(one(root, 'created-open').hidden, true); assert.equal(one(root, 'create-submit').disabled, true);
});

test('checking an unknown creation opens the chosen computers list only after the explicit button', async (t) => {
  const navigations = [], lists = [];
  const { root, view } = mount(t, { getCreation: async () => nativeCreation, createThread: async () => ({ status: 'unknown' }),
    getThreads: async host => { lists.push(host); return { threads: [] }; },
  }, { onNavigate: value => navigations.push(value) });
  view.update(thread()); view.openCreation(); await tick(); byClass(root, 'create-host-button').find(item => item.dataset.host === 'windows').click(); await tick();
  const prompt = one(root, 'create-prompt'); prompt.value = '在Windows核对结果'; prompt.fire('input'); one(root, 'create-form').fire('submit'); await tick();
  assert.deepEqual(navigations, []); assert.deepEqual(lists, []); one(root, 'create-back-list').click(); await tick();
  assert.deepEqual(navigations, [{ host: 'windows', id: null }]); assert.deepEqual(lists, ['windows']);
  assert.equal(one(root, 'creation-dialog').hidden, true); assert.equal(one(root, 'thread-drawer').hidden, false);
});

test('creation read timeout exposes a fresh GET and never accepts its late project list', async (t) => {
  const timers = fakeClock(), old = deferred(); let reads = 0, writes = 0, firstSignal;
  const { root, view } = mount(t, { getCreation: (_host, { signal }) => { reads++; if (reads === 1) { firstSignal = signal; return new Promise((resolve, reject) => { old.promise.then(resolve); signal.addEventListener('abort', () => reject(Error('synthetic AbortError'))); }); } return Promise.resolve(nativeCreation); }, createThread: async () => { writes++; } }, { timers });
  view.openCreation(); assert.equal(one(root, 'create-project').disabled, true); await timers.advance(20000);
  assert.equal(firstSignal.aborted, true); assert.ok(one(root, 'creation-state').textContent.includes('超时')); assert.equal(one(root, 'create-retry').hidden, false);
  one(root, 'create-retry').click(); await tick(); chooseCreationProject(root, 'official-red');
  old.resolve({ supported: true, projectless: true, projects: [] }); await tick();
  assert.equal(one(root, 'create-project').textContent, 'red-app'); assert.equal(reads, 2); assert.equal(writes, 0);
});
