import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCodeText, createCodeBlock } from '../mobile/public/code-copy.mjs';

class Node {
  constructor(tag, doc) {
    this.tagName = tag; this.ownerDocument = doc; this.childNodes = []; this.listeners = new Map();
    this.attributes = new Map(); this.style = {}; this.textContent = ''; this.value = ''; this.disabled = false;
  }
  set innerHTML(_) { throw Error('HTML injection'); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  remove() { if (this.parentNode) { const nodes = this.parentNode.childNodes; nodes.splice(nodes.indexOf(this), 1); this.parentNode = null; } }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { return !this.disabled && this.listeners.get('click')?.({ preventDefault() {} }); }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
}
function fixture({ clipboard, execCommand } = {}) {
  const originalRange = { cloneRange() { return originalRange; } };
  const selection = { ranges: [originalRange], get rangeCount() { return this.ranges.length; }, getRangeAt(i) { return this.ranges[i]; }, removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); } };
  const doc = { defaultView: { navigator: { clipboard } }, createElement(tag) { return new Node(tag, doc); }, getSelection: () => selection, execCommand };
  doc.body = doc.createElement('body');
  const draft = doc.createElement('textarea'); draft.value = '保留草稿'; draft.setSelectionRange(1, 3, 'backward'); draft.focus(); doc.body.append(draft);
  return { doc, draft, selection, originalRange };
}
const parts = block => ({ status: block.childNodes[0].childNodes[0], button: block.childNodes[0].childNodes[1], code: block.childNodes[1].childNodes[0] });

test('a code block copies the exact raw code during the click and keeps markup inert', async () => {
  const copied = [], text = '  const 名称 = "<script>";\n\tconsole.log(名称);\n';
  const { doc, draft } = fixture({ clipboard: { writeText(value) { copied.push(value); return Promise.resolve(); } } });
  const block = createCodeBlock(doc, text), { button, code, status } = parts(block);
  assert.equal(code.textContent, text); assert.equal(code.childNodes.length, 0); assert.equal(button.type, 'button');
  const clicked = button.click();
  assert.deepEqual(copied, [text], 'clipboard call happens before yielding away the click');
  assert.equal(button.disabled, true); await clicked;
  assert.equal(button.textContent, '已复制'); assert.equal(status.textContent, '代码已复制'); assert.equal(button.disabled, false);
  assert.equal(draft.value, '保留草稿'); assert.equal(doc.activeElement, draft);
});

test('repeated clicks share one pending copy and a later explicit click can copy again', async () => {
  let resolve, calls = 0;
  const { doc } = fixture({ clipboard: { writeText() { calls++; return new Promise(done => { resolve = done; }); } } });
  const { button } = parts(createCodeBlock(doc, 'one'));
  const first = button.click(); button.click(); button.listeners.get('click')({ preventDefault() {} });
  assert.equal(calls, 1); resolve(); await first;
  const second = button.click(); assert.equal(calls, 2); resolve(); await second;
});

test('clipboard rejection uses one fallback and restores the draft focus, input range and document selection', async () => {
  let commands = 0, copied;
  const { doc, draft, selection, originalRange } = fixture({ clipboard: { async writeText() { throw Error('denied'); } } });
  doc.execCommand = command => {
    commands++; assert.equal(command, 'copy'); copied = doc.activeElement.value;
    selection.removeAllRanges(); return true;
  };
  await copyCodeText(doc, 'fallback\n  exact');
  assert.equal(commands, 1); assert.equal(copied, 'fallback\n  exact'); assert.equal(doc.body.childNodes.length, 1);
  assert.equal(doc.activeElement, draft); assert.equal(draft.value, '保留草稿');
  assert.deepEqual([draft.selectionStart, draft.selectionEnd, draft.selectionDirection], [1, 3, 'backward']);
  assert.deepEqual(selection.ranges, [originalRange]);
});

test('fallback failure cleans up and reports failure without claiming that code was copied', async () => {
  const { doc, draft } = fixture({ execCommand() { throw Error('clipboard unavailable'); } });
  const { button, status } = parts(createCodeBlock(doc, 'code'));
  await button.click();
  assert.equal(button.textContent, '重试复制'); assert.equal(status.textContent, '复制失败，请长按代码复制');
  assert.equal(button.disabled, false); assert.equal(doc.body.childNodes.length, 1); assert.equal(doc.activeElement, draft);
  assert.equal(draft.value, '保留草稿');
});

test('an unavailable clipboard has an explicit failure and does not touch the draft', async () => {
  const { doc, draft } = fixture();
  await assert.rejects(copyCodeText(doc, 'code'), /复制失败/);
  assert.equal(doc.body.childNodes.length, 1); assert.equal(doc.activeElement, draft); assert.equal(draft.value, '保留草稿');
});

test('separate code blocks copy their own code without sharing pending state', async () => {
  const copied = [], { doc } = fixture({ clipboard: { async writeText(text) { copied.push(text); } } });
  const first = parts(createCodeBlock(doc, 'first')), second = parts(createCodeBlock(doc, 'second'));
  await Promise.all([first.button.click(), second.button.click()]);
  assert.deepEqual(copied, ['first', 'second']);
  assert.equal(first.button.textContent, '已复制'); assert.equal(second.button.textContent, '已复制');
});
