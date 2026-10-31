import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtBytes } from './api.js';
import Treemap from './Treemap.jsx';
import Viewer from './Viewer.jsx';

const THUMBABLE = new Set(['image', 'video', 'pdf', 'gdoc']);
export const thumbUrl = (provider, item) => (
  THUMBABLE.has(item.kind) && !provider.startsWith('demo') && (provider === 'local' || item.meta?.hasThumb)
    ? `/api/thumb?${new URLSearchParams({ provider, id: item.id })}` : null);
const loadPref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };

const KIND_ICON = { image: '▣', video: '▶', audio: '♪', pdf: '▤', gdoc: '▤', text: '≡' };

export default function App() {
  const [info, setInfo] = useState(null);
  const [provider, setProvider] = useState(() => new URLSearchParams(location.search).get('provider') || 'demo');
  const [scanPath, setScanPath] = useState('');
  const [job, setJob] = useState(null);
  const [view, setView] = useState(null);
  const [selected, setSelected] = useState(new Map());
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [thumbs, setThumbs] = useState(() => loadPref('ms-thumbs', true));
  const autoOpened = useRef(false);
  const poll = useRef(null);

  const refreshInfo = useCallback(() => api.providers().then((i) => {
    setInfo(i);
    setScanPath((p) => p || i.home);
    return i;
  }), []);

  useEffect(() => { refreshInfo().catch((e) => setError(e.message)); }, [refreshInfo]);

  // After a page reload, show the scan the server already has instead of the welcome screen.
  useEffect(() => {
    if (!info || autoOpened.current) return;
    autoOpened.current = true;
    if (info.providers.find((x) => x.id === provider)?.scanned) open(null, provider);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(async (id, prov = provider) => {
    try {
      setView(await api.tree(prov, id));
      setSelected(new Map());
      setError(null);
    } catch (e) { setError(e.message); }
  }, [provider]);

  // When switching provider, show its existing scan if any.
  useEffect(() => {
    setView(null); setSelected(new Map()); setJob(null); setError(null); setViewing(null);
    clearInterval(poll.current);
    const p = info?.providers.find((x) => x.id === provider);
    if (p?.scanned) open(null, provider);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startScan() {
    setError(null); setView(null);
    try {
      const { jobId } = await api.scan(provider, scanPath);
      clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const j = await api.job(jobId);
        setJob(j);
        if (j.status !== 'running') {
          clearInterval(poll.current);
          if (j.status === 'done') { await open(null); refreshInfo(); } else setError(j.error);
        }
      }, 400);
    } catch (e) { setError(e.message); }
  }

  function toggleSelect(item, multi) {
    const why = lockReason(item);
    if (why) { setError(why); return; }
    setSelected((prev) => {
      const next = new Map(multi ? prev : []);
      if (prev.has(item.id) && multi) next.delete(item.id); else next.set(item.id, item);
      return next;
    });
  }

  async function doDelete(mode) {
    const items = [...selected.values()];
    setConfirm(null);
    let freed = 0; const failed = [];
    for (const it of items) {
      try { freed += (await api.remove(provider, it.id, mode)).freed; } catch (e) { failed.push(`${it.name}: ${e.message}`); }
    }
    setToast(`${mode === 'trash' ? 'Moved to Trash' : 'Deleted'} ${items.length - failed.length} item(s), freed ${fmtBytes(freed)}${failed.length ? ` — ${failed.length} failed` : ''}`);
    if (failed.length) setError(failed.join('\n'));
    setTimeout(() => setToast(null), 5000);
    await open(view.node.id);
  }

  const prov = info?.providers.find((p) => p.id === provider);
  const selTotal = [...selected.values()].reduce((s, i) => s + i.size, 0);
  const running = job?.status === 'running';

  return (
    <div className="app">
      <header>
        <div className="brand">Mapping<span>Space</span>{info?.user && <small title="Mac user this app is running as">{info.user}</small>}</div>
        <nav className="tabs">
          {info?.providers.map((p) => (
            <button key={p.id} className={p.id === provider ? 'on' : ''} onClick={() => setProvider(p.id)}>{p.label}</button>
          ))}
        </nav>
        <div className="scanbar">
          {provider === 'local' && (
            <input value={scanPath} onChange={(e) => setScanPath(e.target.value)} placeholder="/Users/you" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && startScan()} />
          )}
          {provider === 'gdrive' && prov?.configured && !prov?.connected && <a className="btn" href="/api/gdrive/auth">Connect Google Drive</a>}
          {provider === 'gdrive' && prov?.connected && <button className="ghost" onClick={() => api.gdriveDisconnect().then(refreshInfo)}>Disconnect</button>}
          <button className="btn" disabled={running || !prov?.ready} onClick={startScan}>{running ? 'Scanning…' : view ? 'Rescan' : 'Scan'}</button>
          {info?.isApp && <button className="ghost" title="Stop Mapping Space" onClick={async () => { await fetch('/api/quit', { method: 'POST' }).catch(() => {}); document.body.innerHTML = '<div class="quit">Mapping Space has quit. You can close this tab.</div>'; }}>Quit</button>}
        </div>
      </header>

      {running && (
        <div className="progress">
          <div className="bar"><i /></div>
          {job.files.toLocaleString()} files · {job.dirs.toLocaleString()} folders · {fmtBytes(job.bytes)} · {((Date.now() - job.started) / 1000).toFixed(0)}s
        </div>
      )}
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      {provider === 'local' && prov?.deniedCount > 0 && !running && <FdaBanner prov={prov} home={info.home} platform={info.platform} isApp={info.isApp}
        onApplied={async () => { await refreshInfo(); if (view) open(view.node.id); }} onError={setError} />}

      {provider === 'gdrive' && prov && !prov.configured && !running && <DriveSetup onSaved={refreshInfo} />}

      {!view && !running && !(provider === 'gdrive' && !prov?.configured) && (
        <div className="welcome">
          <h1>See what's eating your disk.</h1>
          <p>{provider === 'demo' ? 'A fake Mac disk — safe to click around and "delete".' : provider === 'demo-drive' ? 'A fake Google Drive — safe to click around and "delete".' : provider === 'local' ? 'Pick a folder (your home folder is a good start, / scans everything) and press Scan.' : prov?.connected ? 'Scans My Drive, Shared drives and files shared with you.' : 'Connect your Google account, then press Scan.'}</p>
          {prov?.ready && <button className="btn big" onClick={startScan}>Scan {prov.label}</button>}
        </div>
      )}

      {view && (
        <main>
          <div className="crumbs">
            {view.crumbs.map((c, i) => (
              <span key={c.id}>
                {i > 0 && <b>›</b>}
                <button onClick={() => open(c.id)} disabled={i === view.crumbs.length - 1}>{c.name}</button>
              </span>
            ))}
            <label className="thumb-toggle"><input type="checkbox" checked={thumbs} onChange={(e) => { setThumbs(e.target.checked); savePref('ms-thumbs', e.target.checked); }} /> Thumbnails</label>
            <span className="crumb-size">{fmtBytes(view.node.size)} · {view.node.count.toLocaleString()} files · {((view.node.size / view.total) * 100).toFixed(1)}% of scan</span>
          </div>
          {view.node.id === '__hidden' && <HiddenInfo node={view.node} />}
          <div className="panes">
            <Treemap node={view.node} onOpen={open} onSelect={toggleSelect} onPreview={setViewing} selected={selected}
              thumbFor={thumbs ? (item) => thumbUrl(provider, item) : () => null} />
            <aside>
              <ul className="list">
                {(view.node.children || []).map((c) => (
                  <li key={c.id} className={`${selected.has(c.id) ? 'sel' : ''} ${c.synthetic ? 'synthetic' : ''}`}>
                    {!c.synthetic && <input type="checkbox" checked={selected.has(c.id)} disabled={Boolean(lockReason(c))} title={lockReason(c) || ''} onChange={() => toggleSelect(c, true)} />}
                    <span className="ico">{thumbs && thumbUrl(provider, c)
                      ? <img className="row-thumb" src={thumbUrl(provider, c)} alt="" loading="lazy" onError={(e) => { e.currentTarget.replaceWith(document.createTextNode(KIND_ICON[c.kind] || '·')); }} />
                      : c.meta?.hidden ? '◌' : c.meta?.admin && !c.isDir ? '🛡' : c.isDir ? (c.meta?.denied ? (c.meta.admin ? '🛡' : '🔒') : '▸') : KIND_ICON[c.kind] || '·'}</span>
                    <button className="name" disabled={c.synthetic} onClick={() => (c.isDir ? open(c.id) : setViewing(c))} title={c.isDir ? c.id : `Preview ${c.name}`}>{c.name}</button>
                    <span className="sz">
                      {c.meta?.link && <a className="ext" href={c.meta.link} target="_blank" rel="noreferrer" title="Open in Google Drive">↗</a>}
                      {c.meta && c.meta.ownedByMe === false && <span className="badge" title="Owned by someone else">shared</span>}
                      {fmtBytes(c.size)}
                    </span>
                    <span className="pct"><i style={{ width: `${view.node.size ? (c.size / view.node.size) * 100 : 0}%` }} /></span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </main>
      )}

      {selected.size > 0 && (
        <div className="actionbar">
          <span>{selected.size} selected · {fmtBytes(selTotal)}</span>
          <button className="ghost" onClick={() => setSelected(new Map())}>Clear</button>
          <button className="danger" onClick={() => setConfirm({ typed: '' })}>Delete…</button>
        </div>
      )}

      {confirm && (
        <div className="modal" onClick={() => setConfirm(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {selected.size} item(s), {fmtBytes(selTotal)}?</h2>
            <ul className="dl">{[...selected.values()].slice(0, 8).map((i) => <li key={i.id}>{i.id}</li>)}{selected.size > 8 && <li>…and {selected.size - 8} more</li>}</ul>
            <p>Move to Trash is reversible{provider.includes('drive') ? ' (Google Drive Trash keeps it 30 days)' : ''}. Permanent delete is not.</p>
            <div className="row">
              <button className="btn" onClick={() => doDelete('trash')}>Move to Trash</button>
              <input placeholder='type DELETE for permanent' value={confirm.typed} onChange={(e) => setConfirm({ typed: e.target.value })} />
              <button className="danger" disabled={confirm.typed !== 'DELETE'} onClick={() => doDelete('permanent')}>Delete permanently</button>
            </div>
            <button className="ghost close" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {viewing && view && (
        <Viewer provider={provider} item={viewing} onClose={() => setViewing(null)} onNavigate={setViewing} onError={setError}
          siblings={(view.node.children || []).filter((c) => !c.isDir && !c.synthetic)} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function lockReason(item) {
  if (item.synthetic) return 'Group of small items';
  if (item.meta?.hidden) return `"${item.name}" is space macOS manages itself, not a file you can delete here`;
  if (item.meta?.virtual) return `"${item.name}" is a section, not a folder you can delete`;
  if (item.meta?.admin) return `"${item.name}" needs administrator rights — this app never deletes as admin`;
  if (item.meta?.canTrash === false) return `"${item.name}" is owned by someone else — only the owner can delete it`;
  return null;
}

function DriveSetup({ onSaved }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState(null);
  const redirect = `${location.protocol}//localhost:4000/api/gdrive/callback`;
  async function save() {
    try { await api.gdriveConfig(id, secret); setErr(null); await onSaved(); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="setup">
      <h1>Connect Google Drive</h1>
      <p>One-time, about 5 minutes. Google needs you to create your own sign-in keys so this app can read and trash files in <i>your</i> Drive; nothing leaves your Mac.</p>
      <ol>
        <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud Console</a> and create a project (any name).</li>
        <li>Enable the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a>.</li>
        <li><a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">OAuth consent screen</a>: External, then under <b>Audience → Test users</b> add your own Gmail.</li>
        <li><a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noreferrer">Create OAuth client</a> → type <b>Web application</b> → Authorized redirect URI:<br /><code className="copy" onClick={() => navigator.clipboard?.writeText(redirect)} title="click to copy">{redirect}</code></li>
        <li>Paste the Client ID and Client secret here:</li>
      </ol>
      <div className="setup-form">
        <input placeholder="Client ID (…apps.googleusercontent.com)" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} />
        <input placeholder="Client secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="btn" onClick={save} disabled={!id || !secret}>Save keys</button>
      </div>
      {err && <div className="error inline">{err}</div>}
      <p className="hint">Google shows "app isn't verified" on first sign-in — that's expected for your own test app: click <b>Continue</b>.</p>
    </div>
  );
}

function FdaBanner({ prov, home, platform, isApp, onApplied, onError }) {
  const [busy, setBusy] = useState(false);
  const names = (prov.denied || []).map((p) => (p.startsWith(home + '/') ? '~/' + p.slice(home.length + 1) : p));
  // Blocked folders inside your home = macOS privacy (fixed by Full Disk Access).
  // Anything else (system folders, other users) needs administrator rights.
  const privacy = names.filter((n) => n.startsWith('~/'));
  const mac = platform === 'darwin';
  async function apply(measure) {
    setBusy(true);
    try {
      const r = await fetch(measure ? '/api/admin-measure' : '/api/admin-sizes/apply', { method: 'POST' }).then(async (x) => (x.ok ? x.json() : Promise.reject(new Error((await x.json()).error))));
      await onApplied(r);
    } catch (e) { onError(e.message); }
    setBusy(false);
  }
  return (
    <div className="fda">
      <div>
        {privacy.length > 0 && (
          <div>
            <b>🔒 macOS privacy blocked {privacy.length} of your folders</b>: {privacy.slice(0, 5).join(', ')}{privacy.length > 5 ? ' …' : ''}
            {mac && <> — turn on <b>{prov.fdaApp}</b> in Full Disk Access, quit it (⌘Q), reopen, <code>npm start</code>, Rescan.</>}
          </div>
        )}
        <div className="fda-admin">
          {prov.admin?.applied > 0
            ? <>🛡 <b>Admin-only folders measured</b> ({prov.admin.applied} folders, {fmtBytes(prov.admin.bytes)}) — shown with 🛡. </>
            : <><b>🛡 {prov.deniedCount} folder{prov.deniedCount > 1 ? 's' : ''} need administrator rights</b> (system folders, other users, Spotlight index). </>}
          {mac && <button className="btn sm" disabled={busy} onClick={() => apply(true)}>{busy ? 'Measuring… (enter password in the dialog)' : prov.admin?.applied ? 'Measure again' : 'Measure now'}</button>}
          {mac && !isApp && <span className="muted"> or run <code>npm run measure</code> in Terminal, then <button className="linkish" disabled={busy} onClick={() => apply(false)}>apply</button></span>}
          {mac && <span className="muted"> — asks for an administrator password; reads sizes only.</span>}
        </div>
      </div>
      {mac && privacy.length > 0 && (
        <button className="ghost sm" disabled={busy} onClick={async () => { setBusy(true); try { await fetch('/api/open-fda-settings', { method: 'POST' }); } finally { setBusy(false); } }}>Open Privacy Settings</button>
      )}
    </div>
  );
}

function HiddenInfo({ node }) {
  return (
    <div className="hidden-info">
      <b>What is this space?</b> It's used on your disk but isn't visible as normal files to an app running as you:
      <ul>
        {(node.children || []).filter((c) => !c.synthetic).map((c) => (
          <li key={c.id}><b>{c.name}</b> — {fmtBytes(c.size)}{c.meta?.note ? `: ${c.meta.note}` : ''}</li>
        ))}
      </ul>
      <span className="muted">
        Read admin-only folders with <code>npm run measure</code> + <b>Apply admin sizes</b> (banner above).
        Time Machine local snapshots and purgeable space are not files: macOS deletes them automatically when you need space.
        To see snapshots run <code>tmutil listlocalsnapshots /</code> in Terminal.
      </span>
    </div>
  );
}
