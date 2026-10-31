import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
// Per-user data: the Mac app sets MS_DATA_DIR to ~/Library/Application Support/MappingSpace,
// so every macOS user has their own settings, Google login and scan data.
const DATA_DIR = process.env.MS_DATA_DIR || path.join(here, '../.data');
process.env.MS_DATA_DIR = DATA_DIR;
const ENV_FILE = process.env.MS_DATA_DIR_ENV || (process.env.MS_APP ? path.join(DATA_DIR, '.env') : path.join(here, '../.env'));
loadEnv(ENV_FILE);

const local = await import('./providers/local.js');
const demo = await import('./providers/demo.js');
const demoDrive = await import('./providers/demo-drive.js');
const gdrive = await import('./providers/gdrive.js');
const media = await import('./media.js');
const { Readable } = await import('node:stream');
const { spawn, execFile } = await import('node:child_process');

const PROVIDERS = { local, demo, gdrive, 'demo-drive': demoDrive };
const state = {}; // provider -> { tree, scanRoot }
const jobs = new Map();

const app = express();
app.use(express.json());

// ---- Security policy (see SECURITY.md) ----
// 1. Only answer requests addressed to localhost (blocks DNS-rebinding attacks).
// 2. Refuse API calls made by other websites (Sec-Fetch-Site), except Google's sign-in redirect.
// 3. Page cannot be framed (clickjacking on Delete) and only loads its own scripts.
app.disable('x-powered-by');

// 4. Session key: on a Mac with several users, any user can reach any other user's
//    localhost port. Only someone holding this random key (given to the browser by the
//    launcher, then kept in an HttpOnly cookie) can use the app. Off only in dev mode.
const TOKEN = process.env.MS_DEV ? null : (process.env.MS_TOKEN || randomBytes(24).toString('hex'));
const tokenOk = (t) => {
  if (!TOKEN) return true;
  const a = Buffer.from(String(t || '')); const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};
const cookieToken = (req) => (/(?:^|;\s*)ms_session=([a-f0-9]+)/.exec(req.get('cookie') || '') || [])[1];
app.use((req, res, next) => {
  const host = (req.hostname || '').replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return res.status(403).send('Forbidden host');
  if (TOKEN) {
    if (req.method === 'GET' && req.path === '/' && req.query.t) {
      if (!tokenOk(req.query.t)) return res.status(403).send('This link is out of date. Open Mapping Space again from Applications.');
      res.set('Set-Cookie', `ms_session=${TOKEN}; HttpOnly; SameSite=Lax; Path=/`);
      return res.redirect(req.query.provider ? `/?provider=${encodeURIComponent(req.query.provider)}` : '/');
    }
    // Google's sign-in redirect returns here as a top-level navigation; the Lax cookie is sent.
    if (!tokenOk(cookieToken(req))) {
      return res.status(401).type('html').send('<!doctype html><meta charset=utf-8><title>Mapping Space</title><body style="font:15px -apple-system,sans-serif;background:#0f1115;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Open Mapping Space from Applications</h2><p style="color:#8a92a6">This page only works when started from the app (or the link <code>npm start</code> prints).</p></div>');
    }
  }
  if (req.path.startsWith('/api/') && req.get('sec-fetch-site') === 'cross-site' && req.path !== '/api/gdrive/callback') {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' });
  if (!req.path.startsWith('/api/')) {
    res.set({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' https://drive.google.com https://accounts.google.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
  }
  next();
});

// Mutating calls: only from localhost pages.
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  next();
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (res.headersSent) return res.destroy();
  res.removeHeader('Content-Disposition');
  res.status(400).json({ error: e.message });
});

app.get('/api/providers', wrap(async (_req, res) => {
  res.json({
    home: os.homedir(),
    platform: process.platform,
    demoOnly: Boolean(process.env.DEMO_ONLY),
    isApp: Boolean(process.env.MS_APP),
    user: os.userInfo().username,
    providers: [
      { id: 'local', label: 'This Mac', ready: !process.env.DEMO_ONLY, scanned: Boolean(state.local), denied: state.local?.denied.slice(0, 30), deniedCount: state.local?.denied.length || 0, fdaApp: fdaApp(), admin: state.local?.admin || null, adminFile: readAdminSizes()?.measuredAt || null, scanRoot: state.local?.scanRoot },
      { id: 'gdrive', label: 'Google Drive', configured: gdrive.isConfigured(), connected: await gdrive.isConnected(), ready: gdrive.isConfigured() && await gdrive.isConnected() && !process.env.DEMO_ONLY, scanned: Boolean(state.gdrive) },
      { id: 'demo', label: 'Demo: Mac', ready: true, scanned: Boolean(state.demo) },
      { id: 'demo-drive', label: 'Demo: Drive', ready: true, scanned: Boolean(state['demo-drive']) },
    ],
  });
}));

app.post('/api/scan', wrap(async (req, res) => {
  const { provider, path: p } = req.body;
  const prov = PROVIDERS[provider];
  if (!prov) throw new Error('Unknown provider');
  if (process.env.DEMO_ONLY && !provider.startsWith('demo')) throw new Error('Server is in demo-only mode');
  for (const j of jobs.values()) if (j.provider === provider && j.status === 'running') j.cancelled = true;
  const job = { id: randomUUID(), provider, status: 'running', files: 0, dirs: 0, bytes: 0, errors: 0, started: Date.now() };
  jobs.set(job.id, job);
  const scanRoot = provider === 'local' ? path.resolve((p || os.homedir()).replace(/^~(?=$|\/)/, os.homedir())) : null;
  Promise.resolve(prov.scan(scanRoot, job))
    .then((tree) => {
      if (job.cancelled) return;
      state[provider] = { tree, scanRoot, denied: job.denied || [], diskUsed: job.diskUsed };
      if (provider === 'local') {
        // Hand the list of unreadable folders to `npm run measure` (admin helper), and
        // re-apply a recent admin measurement so you don't have to run it after every scan.
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(path.join(DATA_DIR, 'denied.json'), JSON.stringify({ scanRoot, paths: job.allDenied || [], skip: [...(job.skipList || [])] }), { mode: 0o600 });
          const m = readAdminSizes();
          if (m && Date.now() - Date.parse(m.measuredAt) < 7 * 864e5) state.local.admin = { ...local.applyAdminSizes(tree, m.sizes), measuredAt: m.measuredAt };
        } catch { /* best effort */ }
      }
      Object.assign(job, { status: 'done', rootId: tree.root.id, ms: Date.now() - job.started });
    })
    .catch((e) => Object.assign(job, { status: 'error', error: e.message }));
  res.json({ jobId: job.id });
}));

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  res.json(job);
});

app.get('/api/tree', wrap(async (req, res) => {
  const s = state[req.query.provider];
  if (!s) throw new Error('Not scanned yet');
  const node = s.tree.get(req.query.id);
  if (!node) throw new Error('Item not found (maybe deleted)');
  const depth = Math.min(Number(req.query.depth ?? 2), 4);
  res.json({ node: s.tree.view(node, depth), crumbs: s.tree.ancestors(node), total: s.tree.root.size });
}));

app.post('/api/delete', wrap(async (req, res) => {
  const { provider, id, mode = 'trash' } = req.body;
  const s = state[provider];
  if (!s) throw new Error('Not scanned yet');
  const node = s.tree.get(id);
  if (!node || node === s.tree.root) throw new Error('Cannot delete this item');
  if (!['trash', 'permanent'].includes(mode)) throw new Error('Bad mode');
  if (node.meta?.virtual) throw new Error(`"${node.name}" is not a real file or folder`);
  if (node.meta?.admin) throw new Error(`"${node.name}" needs administrator rights — this app never deletes as admin. Use Finder if you really need to.`);
  const why = provider === 'local' ? local.checkDeletable(node.id, s.scanRoot)
    : PROVIDERS[provider].checkDeletable ? PROVIDERS[provider].checkDeletable(node, mode) : null;
  if (why) throw new Error(why);
  await PROVIDERS[provider].remove(node.id, mode);
  if (!provider.startsWith('demo')) media.audit(DATA_DIR, 'delete', { provider, id: node.id, name: node.name, mode, size: node.size });
  const freed = node.size;
  s.tree.remove(node);
  res.json({ ok: true, freed, parentId: node.parent.id });
}));

function readAdminSizes() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'admin-sizes.json'), 'utf8')); } catch { return null; }
}

// Merge the sizes `npm run measure` wrote (it runs as admin; this server never does).
app.post('/api/admin-sizes/apply', wrap(async (_req, res) => {
  const s = state.local;
  if (!s) throw new Error('Scan first');
  const m = readAdminSizes();
  if (!m) throw new Error('No measurement yet — run "npm run measure" in Terminal first');
  if (s.admin && s.admin.measuredAt === m.measuredAt) return res.json(s.admin);
  s.admin = { ...local.applyAdminSizes(s.tree, m.sizes), measuredAt: m.measuredAt };
  media.audit(DATA_DIR, 'admin-sizes', { applied: s.admin.applied, bytes: s.admin.bytes });
  res.json(s.admin);
}));

// One-click admin measurement: macOS shows its own password dialog. The command and every
// argument are fixed by the server (passed as argv, quoted by AppleScript), nothing from the request.
app.post('/api/admin-measure', wrap(async (_req, res) => {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  if (!state.local) throw new Error('Scan first');
  const script = path.join(here, '../../scripts/measure-admin.mjs');
  const owner = `${process.getuid()}:${process.getgid()}`;
  const as = [
    'on run argv',
    'do shell script (quoted form of item 1 of argv) & " " & (quoted form of item 2 of argv) & " --data " & (quoted form of item 3 of argv) & " --owner " & (quoted form of item 4 of argv) with administrator privileges with prompt "Mapping Space wants to measure folders only an administrator can read. It reads sizes only and changes nothing."',
    'end run',
  ];
  await new Promise((ok, fail) => execFile('/usr/bin/osascript', [...as.flatMap((l) => ['-e', l]), process.execPath, script, DATA_DIR, owner],
    { timeout: 30 * 60 * 1000 }, (e, _o, err) => (e ? fail(new Error(/User canceled|-128/.test(err || '') ? 'Cancelled' : 'Measuring failed')) : ok())));
  const m = readAdminSizes();
  if (!m) throw new Error('Measuring produced no result');
  state.local.admin = { ...local.applyAdminSizes(state.local.tree, m.sizes), measuredAt: m.measuredAt };
  media.audit(DATA_DIR, 'admin-measure', { applied: state.local.admin.applied, bytes: state.local.admin.bytes });
  res.json(state.local.admin);
}));

// "Quit" in the app: stop this user's server.
app.post('/api/quit', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 200);
});

// Which app needs Full Disk Access = whatever launched `npm start`.
function fdaApp() {
  if (process.env.MS_APP) return 'Mapping Space';
  const t = process.env.TERM_PROGRAM || '';
  if (t === 'Apple_Terminal') return 'Terminal';
  if (t === 'iTerm.app') return 'iTerm';
  if (t === 'vscode') return process.env.CURSOR_TRACE_ID ? 'Cursor' : 'Visual Studio Code';
  if (/warp/i.test(t)) return 'Warp';
  if (/ghostty/i.test(t)) return 'Ghostty';
  return t || 'the app you ran npm start from';
}

// Opens System Settings → Privacy & Security → Full Disk Access (fixed URL, nothing user-supplied).
app.post('/api/open-fda-settings', wrap(async (_req, res) => {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  await new Promise((ok, fail) => execFile('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], (e) => (e ? fail(e) : ok())));
  res.json({ ok: true });
}));

// ---- Preview / Open with ----

const DRIVE_NATIVE = {
  image: /^image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml|x-icon)$/,
  video: /^video\/(mp4|quicktime|webm|ogg|x-matroska|x-m4v)$/,
  audio: /^audio\/(mpeg|mp3|mp4|x-m4a|aac|wav|x-wav|flac|x-flac|ogg|opus|webm)$/,
};

function lookup(req) {
  const provider = req.query.provider ?? req.body?.provider;
  const id = req.query.id ?? req.body?.id;
  const s = state[provider];
  if (!s) throw new Error('Not scanned yet');
  const node = s.tree.get(id);
  if (!node || node === s.tree.root) throw new Error('Item not found');
  return { provider, s, node, kind: media.kindOf(node) };
}

// File responses: never executable, never embeddable by other sites, never cached.
function fileHeaders(res, kind, name, download) {
  res.set({
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': kind === 'pdf' || kind === 'gdoc'
      ? "frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'",
  });
  if (download) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
}

app.get('/api/preview', wrap(async (req, res) => {
  const { provider, s, node, kind } = lookup(req);
  const q = new URLSearchParams({ provider, id: node.id });
  const out = { id: node.id, name: node.name, size: node.size, kind, apps: [], canReveal: false, link: node.meta?.link, mode: 'none', ffmpeg: Boolean(media.FFMPEG) };
  if (provider.startsWith('demo')) return res.json({ ...out, demo: true });
  if (provider === 'local') {
    out.canReveal = process.platform === 'darwin';
    try { await media.checkLocalReadable(node, s.scanRoot); } catch (e) { return res.json({ ...out, blocked: e.message, blockedKind: e.kind || 'permission' }); }
    if (kind && media.OPENABLE_KINDS.has(kind)) out.apps = media.appsFor(kind);
    out.canOpenDefault = process.platform === 'darwin' && Boolean(kind);
  }
  if (!kind) return res.json(out);
  const ext = media.extOf(node.name);
  const mt = node.meta?.mimeType;
  const native = provider === 'gdrive' ? DRIVE_NATIVE[kind]?.test(mt) : media.NATIVE[kind]?.has(ext);
  out.file = `/api/file?${q}`;
  out.download = `/api/file?${q}&download=1`;
  if (kind === 'image') {
    if (native) out.mode = 'native';
    else if (provider === 'gdrive' || media.SIPS || media.FFMPEG) { out.mode = 'convert'; out.image = `/api/image?${q}`; }
  } else if (kind === 'video' || kind === 'audio') {
    if (media.FFMPEG) out.stream = `/api/stream?${q}`;
    out.mode = native ? 'native' : media.FFMPEG ? 'transcode' : 'none';
  } else if (kind === 'text') {
    out.mode = node.size <= media.TEXT_PREVIEW_MAX ? 'native' : 'none';
    if (out.mode === 'none') out.reason = 'Text file too large to preview';
  } else out.mode = 'native'; // pdf, gdoc
  if (kind === 'gdoc') delete out.download;
  res.json(out);
}));

app.get('/api/file', wrap(async (req, res) => {
  const { provider, s, node, kind } = lookup(req);
  const download = req.query.download === '1';
  if (provider.startsWith('demo')) throw new Error('Demo files have no content');
  if (!download && !kind) throw new Error('This file type cannot be previewed');
  if (kind === 'text' && !download && node.size > media.TEXT_PREVIEW_MAX) throw new Error('Text file too large to preview');
  fileHeaders(res, kind, node.name, download);
  if (provider === 'local') {
    const { real } = await media.checkLocalReadable(node, s.scanRoot);
    res.type(download ? 'application/octet-stream' : media.mimeFor(node.name, kind));
    media.audit(DATA_DIR, download ? 'download' : 'preview', { provider, id: node.id });
    return res.sendFile(real, { dotfiles: 'allow', acceptRanges: true, cacheControl: false, lastModified: false, etag: false });
  }
  // Google Drive: proxy bytes (token stays on server), forward Range for seeking.
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const r = kind === 'gdoc' ? await gdrive.exportPdf(node.id, ac.signal) : await gdrive.fetchMedia(node.id, req.get('range'), ac.signal);
  res.status(r.status);
  const type = kind === 'gdoc' ? 'application/pdf' : kind === 'text' ? 'text/plain; charset=utf-8'
    : (DRIVE_NATIVE[kind]?.test(node.meta?.mimeType) || kind === 'pdf') ? node.meta.mimeType : 'application/octet-stream';
  res.set('Content-Type', download ? 'application/octet-stream' : type);
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) res.set(h, r.headers.get(h));
  if (!r.headers.get('accept-ranges') && kind !== 'gdoc') res.set('Accept-Ranges', 'bytes');
  media.audit(DATA_DIR, download ? 'download' : 'preview', { provider, id: node.id, name: node.name });
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}));

app.get('/api/image', wrap(async (req, res) => {
  const { provider, s, node, kind } = lookup(req);
  if (kind !== 'image') throw new Error('Not an image');
  fileHeaders(res, kind, node.name, false);
  if (provider === 'gdrive') {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const r = await gdrive.fetchThumbnail(node.id, ac.signal);
    res.type(r.headers.get('content-type') || 'image/jpeg');
    return Readable.fromWeb(r.body).pipe(res);
  }
  const { real } = await media.checkLocalReadable(node, s.scanRoot);
  const out = await media.convertImage(real);
  res.type('image/jpeg');
  res.sendFile(out, () => fs.rm(out, { force: true }, () => {}));
}));

// Small cached thumbnails for treemap tiles and list rows.
app.get('/api/thumb', wrap(async (req, res) => {
  const { provider, s, node, kind } = lookup(req);
  if (!media.THUMB_KINDS.has(kind)) throw new Error('No thumbnail for this type');
  res.set({ 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  if (provider === 'gdrive') {
    if (!node.meta?.hasThumb) return res.status(404).json({ error: 'No thumbnail' });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const r = await gdrive.fetchThumbnail(node.id, ac.signal, 480, node.thumbLink);
    res.type(r.headers.get('content-type') || 'image/jpeg');
    return Readable.fromWeb(r.body).pipe(res);
  }
  if (provider !== 'local') throw new Error('No thumbnail');
  const { real } = await media.checkLocalReadable(node, s.scanRoot);
  const out = await media.localThumb(real, kind);
  res.type('image/jpeg');
  res.sendFile(out);
}));

// On-the-fly conversion for formats the browser can't play (AVI, WMV, MKV/HEVC, FLV…).
// One stream at a time so a forgotten tab can't keep the CPU busy.
let currentFfmpeg = null;
app.get('/api/stream', wrap(async (req, res) => {
  const { provider, s, node, kind } = lookup(req);
  if (kind !== 'video' && kind !== 'audio') throw new Error('Not video or audio');
  if (!media.FFMPEG) throw new Error('Install ffmpeg (brew install ffmpeg) to play this format in the app');
  let input; let headers;
  if (provider === 'local') input = (await media.checkLocalReadable(node, s.scanRoot)).real;
  else if (provider === 'gdrive') { input = gdrive.mediaUrl(node.id); headers = await gdrive.authHeader(); }
  else throw new Error('Demo files have no content');
  if (req.query.probe === '1') return res.json({ duration: await media.probeDuration(input, headers) });
  const start = Math.max(0, Number(req.query.t) || 0);
  if (currentFfmpeg) currentFfmpeg.kill('SIGKILL');
  const ff = spawn(media.FFMPEG, media.transcodeArgs(input, kind, start, headers), { stdio: ['ignore', 'pipe', 'pipe'] });
  currentFfmpeg = ff;
  let errText = '';
  ff.stderr.on('data', (d) => { errText = (errText + d).slice(-500); });
  fileHeaders(res, kind, node.name, false);
  res.type(kind === 'audio' ? 'audio/mp4' : 'video/mp4');
  ff.stdout.pipe(res);
  ff.on('close', (code) => { if (currentFfmpeg === ff) currentFfmpeg = null; if (code && !res.headersSent) res.status(500).end(errText); });
  res.on('close', () => ff.kill('SIGKILL'));
  media.audit(DATA_DIR, 'stream', { provider, id: node.id, start });
}));

app.post('/api/open', wrap(async (req, res) => {
  const { provider, s, node, kind } = lookup(req);
  if (provider !== 'local') throw new Error('Open with is for files on this Mac');
  const reveal = Boolean(req.body.reveal);
  let real;
  if (node.isDir || node.synthetic) {
    if (!reveal) throw new Error('Folders can only be shown in Finder');
    if (media.deniedReason(node.id)) throw new Error(media.deniedReason(node.id));
    real = node.id;
  } else real = (await media.checkLocalReadable(node, s.scanRoot)).real;
  await media.openLocal(real, kind, req.body.app || null, reveal);
  media.audit(DATA_DIR, reveal ? 'reveal' : 'open', { provider, id: node.id, app: req.body.app || 'default' });
  res.json({ ok: true });
}));

// Google Drive OAuth
app.get('/api/gdrive/auth', (_req, res) => {
  if (!gdrive.isConfigured()) return res.status(400).send('Set GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET in server/.env');
  res.redirect(gdrive.authUrl());
});
app.get('/api/gdrive/callback', wrap(async (req, res) => {
  if (req.query.error) throw new Error(`Google sign-in cancelled: ${req.query.error}`);
  await gdrive.handleCallback(req.query.code);
  res.redirect(`${process.env.CLIENT_URL || ''}/?provider=gdrive`);
}));
// Save OAuth keys from the UI into server/.env (no manual file editing).
app.post('/api/gdrive/config', wrap(async (req, res) => {
  const clientId = String(req.body.clientId || '').trim();
  const clientSecret = String(req.body.clientSecret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Client ID should end with .apps.googleusercontent.com');
  if (clientSecret.length < 10) throw new Error('Client secret looks too short');
  const envFile = ENV_FILE;
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : [];
  const set = (k, v) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
    process.env[k] = v;
  };
  set('GDRIVE_CLIENT_ID', clientId);
  set('GDRIVE_CLIENT_SECRET', clientSecret);
  fs.writeFileSync(envFile, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  res.json({ ok: true });
}));
app.get('/api/gdrive/info', (_req, res) => res.json({ redirectUri: gdrive.redirectUri() }));
app.post('/api/gdrive/disconnect', wrap(async (_req, res) => {
  await gdrive.disconnect();
  delete state.gdrive;
  res.json({ ok: true });
}));

// Built client (npm run build) is served from here in production mode.
const dist = path.join(here, '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Each Mac account gets its own port (first account 4000, next 4001 …) so two
// accounts can run Mapping Space at the same time.
const uidPort = () => { const u = process.getuid?.() ?? 501; return 4000 + (u >= 501 ? u - 501 : 0) % 100; };
const PORT = Number(process.env.PORT || uidPort());
// If the port is taken (e.g. another Mac account is running Mapping Space), use the next free one.
function listen(port, triesLeft = 20) {
  const server = app.listen(port, '127.0.0.1', () => {
    process.env.PORT = String(port); // Google sign-in redirect uses the real port
    const url = `http://localhost:${port}/${TOKEN ? `?t=${TOKEN}` : ''}`;
    if (port !== PORT) console.log(`Port ${PORT} was busy, using ${port} instead.`);
    console.log(`Mapping Space on ${url}${process.env.DEMO_ONLY ? ' (demo only)' : ''}`);
    if (process.env.MS_URL_FILE) fs.writeFileSync(process.env.MS_URL_FILE, url, { mode: 0o600 });
    // `npm start` on a Mac opens the browser with the session key for you.
    if (!process.env.MS_APP && !process.env.MS_DEV && !process.env.MS_NO_OPEN && process.platform === 'darwin') execFile('/usr/bin/open', [url], () => {});
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error(e.code === 'EADDRINUSE' ? `Ports ${PORT}–${port} are all in use.` : e.message);
    process.exit(1);
  });
}
listen(PORT);

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
