import { startUI } from './render.mjs';

// The one-time bridge key stays out of server request URLs and is immediately
// removed from browser history. Ongoing access uses an HttpOnly session cookie.
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('pair');
history.replaceState(null, '', location.pathname + location.search);
try {
  if (token) {
    const response = await fetch('/api/pair', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    if (!response.ok) throw Error('配对链接无效，请从电脑重新配对');
  }
  const params = new URLSearchParams(location.search);
  let saved = null;
  try { if (!params.size) saved = JSON.parse(localStorage.getItem('cmc-last-view')); } catch {}
  const host = params.get('host') || saved?.host || document.querySelector('meta[name="cmc-default-host"]')?.content || 'mac';
  const id = params.get('id') || saved?.id || '';
  startUI({ root: document.getElementById('app'), initialHost: ['mac', 'windows'].includes(host) ? host : 'mac',
    initialThreadId: /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id) ? id : '',
    onNavigate: ({ host, id }) => {
      const query = new URLSearchParams({ host }); if (id) query.set('id', id);
      history.replaceState(null, '', '?' + query);
      try { localStorage.setItem('cmc-last-view', JSON.stringify({ host, id })); } catch {}
    },
  });
} catch {
  document.getElementById('app').textContent = '暂时无法配对，请保持电脑在线后重试。';
}
