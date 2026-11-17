// Loads only registered visualization references. Each sandbox belongs to one
// message and chat; retired frames cannot resize or update another conversation.
export function visualizationSource(host, threadId, reference) {
  const token = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/i.test(value);
  if (!['mac', 'windows'].includes(host) || typeof threadId !== 'string' || threadId.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threadId) ||
      !token(reference?.id) || !token(reference?.contentKey)) return null;
  return '/api/visualization?' + new URLSearchParams({ host, threadId, id: reference.id, key: reference.contentKey });
}

const failureMessage = '内嵌内容读取失败。请检查连接或配对状态后重试。';

export function createVisualizationUI({ doc, win, isCurrent, later, cancel, timeoutMs = 15000 }) {
  const records = new Set();
  const node = (tag, className, text) => {
    const result = doc.createElement(tag); result.className = className;
    if (text != null) result.textContent = text;
    return result;
  };
  const current = record => records.has(record) && isCurrent(record);
  function retire(record) {
    records.delete(record); cancel(record.timer); record.timer = null;
    // Removing the element releases its browsing context, including its scripts.
    record.frame?.remove(); record.frame = null; record.panel.replaceChildren();
  }
  function fail(record, message = failureMessage) {
    cancel(record.timer); record.timer = null;
    if (record.frame) record.frame.hidden = true;
    record.status.textContent = message; record.status.hidden = false; record.retry.hidden = false;
  }
  function load(record, retry = false) {
    if (!current(record) || record.frame && !retry) return;
    cancel(record.timer); record.frame?.remove();
    record.retry.hidden = true; record.status.hidden = false; record.status.textContent = '正在读取内嵌内容…';
    const frame = node('iframe', 'message-visualization-frame'); record.frame = frame;
    frame.setAttribute('title', record.name); frame.setAttribute('referrerpolicy', 'no-referrer');
    // Direct navigation preserves the endpoint's nonce CSP. srcdoc/blob would
    // inherit the parent's policy and can block the trusted tabs/resize runtime.
    // Omitting same-origin keeps the frame opaque even for this same-origin GET.
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('scrolling', 'no'); frame.setAttribute('height', '240'); frame.style.height = '240px';
    frame.addEventListener('error', () => { if (current(record) && record.frame === frame) fail(record); });
    // A 401/403 document may emit load. Only the registered runtime can confirm
    // success; missing runtimes become a visible, explicitly retryable failure.
    record.timer = later(() => { if (current(record) && record.frame === frame) fail(record); }, Math.min(timeoutMs, 15000));
    record.panel.append(frame); frame.setAttribute('src', record.url);
  }
  function receiveMessage(event) {
    const data = event.data;
    if (event.origin !== 'null' || !data || !['cmc-visualization-height', 'cmc-visualization-state'].includes(data.type)) return;
    for (const record of records) {
      const frame = record.frame;
      if (!current(record) || !frame?.contentWindow || event.source !== frame.contentWindow ||
          data.id !== record.reference.id || data.key !== record.reference.contentKey) continue;
      if (data.type === 'cmc-visualization-height') {
        if (typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height < 120 || data.height > 40000) return;
        const height = Math.ceil(data.height); frame.style.height = height + 'px'; frame.setAttribute('height', String(height));
      } else if (data.status === 'ready') {
        cancel(record.timer); record.timer = null; frame.hidden = false; record.status.hidden = true; record.retry.hidden = true;
      } else if (data.status === 'error') {
        const message = typeof data.message === 'string' ? data.message.replace(/[\0-\x1f\x7f]/g, '').slice(0, 512).trim() : '';
        fail(record, message || failureMessage);
      }
      return;
    }
  }
  win?.addEventListener('message', receiveMessage);
  return {
    render(item, refs, { host, threadId, messageKey, scope }) {
      item.visualizations ??= new Map(); const keep = new Set(), children = []; let unavailable = false;
      for (const reference of Array.isArray(refs) ? refs : []) {
        const url = visualizationSource(host, threadId, reference);
        if (!url) { unavailable = true; continue; }
        const key = JSON.stringify([reference.id, reference.contentKey]); if (keep.has(key)) continue; keep.add(key);
        const name = typeof reference.name === 'string' ? reference.name.replace(/[\0-\x1f\x7f]/g, '').slice(0, 512) || '内嵌内容' : '内嵌内容';
        let record = item.visualizations.get(key);
        if (!record) {
          const section = node('section', 'message-visualization'), open = node('button', 'message-visualization-open');
          const panel = node('div', 'message-visualization-panel'), status = node('p', 'message-visualization-status');
          const retry = node('button', 'message-visualization-retry', '重试内容');
          open.type = retry.type = 'button'; open.setAttribute('aria-expanded', 'false');
          status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.hidden = status.hidden = retry.hidden = true;
          panel.append(status, retry); section.append(open, panel);
          record = { reference: { id: reference.id, contentKey: reference.contentKey }, key, messageKey, scope, host, threadId, url, name, section, open, panel, status, retry, frame: null, timer: null };
          item.visualizations.set(key, record); records.add(record);
          open.addEventListener('click', () => {
            if (!current(record)) return;
            panel.hidden = !panel.hidden; open.setAttribute('aria-expanded', String(!panel.hidden));
            if (!panel.hidden) load(record);
          });
          retry.addEventListener('click', () => { if (current(record)) load(record, true); });
        }
        record.name = name; record.open.textContent = '查看：' + name; record.frame?.setAttribute('title', name); children.push(record.section);
      }
      for (const [key, record] of item.visualizations) if (!keep.has(key)) { retire(record); item.visualizations.delete(key); }
      if (unavailable) {
        item.visualizationUnavailable ??= node('p', 'message-visualization-unavailable', '此内嵌内容暂不可用，请刷新会话后重试。');
        children.push(item.visualizationUnavailable);
      }
      // Keep existing frames connected during streaming patches. Replacing all
      // children would restart their document and reset its interactive state.
      const desired = new Set(children);
      for (const child of [...item.visualMedia.childNodes]) if (!desired.has(child)) child.remove();
      children.forEach((child, index) => { if (item.visualMedia.childNodes[index] !== child) item.visualMedia.insertBefore(child, item.visualMedia.childNodes[index] ?? null); });
      item.visualMedia.hidden = !children.length;
    },
    disposeItem(item) { for (const record of item.visualizations?.values() ?? []) retire(record); item.visualizations?.clear(); },
    clear() { for (const record of [...records]) retire(record); },
    destroy() { this.clear(); win?.removeEventListener('message', receiveMessage); },
  };
}
