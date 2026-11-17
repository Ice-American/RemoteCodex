// Renders inert code with a gesture-triggered copy action. Clipboard access
// never reads or changes the chat draft, and legacy selection is restored.

function legacyCopy(doc, text) {
  if (typeof doc.execCommand !== 'function' || !doc.body) return false;
  const active = doc.activeElement;
  const inputSelection = active && typeof active.selectionStart === 'number'
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const selection = doc.getSelection?.();
  const ranges = [];
  for (let i = 0; i < (selection?.rangeCount ?? 0); i++) ranges.push(selection.getRangeAt(i).cloneRange());
  const temporary = doc.createElement('textarea');
  temporary.value = text;
  temporary.readOnly = true;
  temporary.tabIndex = -1;
  temporary.setAttribute('aria-hidden', 'true');
  Object.assign(temporary.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  try {
    doc.body.append(temporary);
    temporary.focus({ preventScroll: true });
    temporary.select();
    temporary.setSelectionRange(0, text.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    temporary.remove();
    // The fallback runs synchronously. Returning focus and selections here
    // avoids replacing the user's draft selection or moving the page.
    try { active?.focus?.({ preventScroll: true }); } catch {}
    try {
      if (inputSelection) active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
      if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
    } catch {}
  }
}

export async function copyCodeText(doc, text) {
  const clipboard = doc.defaultView?.navigator?.clipboard;
  if (typeof clipboard?.writeText === 'function') {
    try {
      // Call before the first await so Android receives the original click's
      // transient user activation. Never request read access to the clipboard.
      await clipboard.writeText(text);
      return;
    } catch {}
  }
  if (!legacyCopy(doc, text)) throw Error('复制失败，请长按代码复制');
}

export function createCodeBlock(doc, rawCode) {
  const text = String(rawCode);
  const block = doc.createElement('div'); block.className = 'code-block';
  const toolbar = doc.createElement('div'); toolbar.className = 'code-block-toolbar';
  const status = doc.createElement('span'); status.className = 'code-copy-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const copy = doc.createElement('button'); copy.className = 'code-copy-button';
  copy.type = 'button'; copy.textContent = '复制代码'; copy.setAttribute('aria-label', '复制代码');
  const pre = doc.createElement('pre'), code = doc.createElement('code'); code.textContent = text;
  pre.append(code); toolbar.append(status, copy); block.append(toolbar, pre);
  let pending = false;
  copy.addEventListener('click', async event => {
    event.preventDefault();
    if (pending) return;
    pending = true; copy.disabled = true; copy.textContent = '复制中…'; status.textContent = '';
    try {
      await copyCodeText(doc, text);
      copy.textContent = '已复制'; status.textContent = '代码已复制';
    } catch {
      copy.textContent = '重试复制'; status.textContent = '复制失败，请长按代码复制';
    } finally {
      pending = false; copy.disabled = false;
    }
  });
  return block;
}
