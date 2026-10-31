async function req(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const post = (url, body) => req(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  providers: () => req('/api/providers'),
  scan: (provider, path) => post('/api/scan', { provider, path }),
  job: (id) => req(`/api/jobs/${id}`),
  tree: (provider, id, depth = 2) => req(`/api/tree?${new URLSearchParams({ provider, id: id ?? '', depth })}`),
  remove: (provider, id, mode) => post('/api/delete', { provider, id, mode }),
  gdriveDisconnect: () => post('/api/gdrive/disconnect', {}),
  preview: (provider, id) => req(`/api/preview?${new URLSearchParams({ provider, id })}`),
  open: (provider, id, app, reveal) => post('/api/open', { provider, id, app, reveal }),
  gdriveConfig: (clientId, clientSecret) => post('/api/gdrive/config', { clientId, clientSecret }),
};

// Finder-style decimal units so numbers match macOS "Get Info".
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log10(n) / 3), u.length - 1);
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
