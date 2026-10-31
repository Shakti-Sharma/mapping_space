// File kinds, preview/open policy, and helpers (ffmpeg, sips, Mac apps).
// SECURITY: every rule that decides what may be read, opened or streamed lives here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';

const EXT = {
  image: 'jpg jpeg png gif webp avif bmp ico svg heic heif tif tiff psd raw cr2 cr3 nef arw dng',
  video: 'mp4 m4v mov webm ogv mkv avi wmv flv mpg mpeg m2ts mts ts 3gp 3g2 vob f4v hevc',
  audio: 'mp3 m4a aac wav flac ogg oga opus aiff aif wma amr alac',
  pdf: 'pdf',
  text: 'txt md markdown log csv tsv json yaml yml xml toml ini conf cfg js mjs cjs jsx ts tsx py rb go rs java kt swift c h cpp hpp cs php sh zsh sql css scss html htm vue srt vtt',
};
const KIND_BY_EXT = new Map();
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(' ')) KIND_BY_EXT.set(e, k);

// What the browser can show by itself (anything else is converted or opened externally).
export const NATIVE = {
  image: new Set('jpg jpeg png gif webp avif bmp ico svg'.split(' ')),
  video: new Set('mp4 m4v mov webm ogv mkv'.split(' ')), // mkv/mov depend on codec → fallback on error
  audio: new Set('mp3 m4a aac wav flac ogg oga opus'.split(' ')),
};

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf',
};

export const extOf = (name) => (path.extname(name || '').slice(1) || '').toLowerCase();

export function kindOf(node) {
  if (node.isDir || node.synthetic) return null;
  const mt = node.meta?.mimeType;
  if (mt) {
    if (mt === 'application/vnd.google-apps.folder') return null;
    if (/^application\/vnd\.google-apps\.(document|spreadsheet|presentation|drawing)$/.test(mt)) return 'gdoc';
    if (mt.startsWith('image/')) return 'image';
    if (mt.startsWith('video/')) return 'video';
    if (mt.startsWith('audio/')) return 'audio';
    if (mt === 'application/pdf') return 'pdf';
    if (mt.startsWith('text/') || mt === 'application/json') return 'text';
  }
  return KIND_BY_EXT.get(extOf(node.name)) || null;
}

// Content-Type we send. HTML/XML/JS are always served as text/plain so they can never run.
export function mimeFor(name, kind) {
  if (kind === 'text') return 'text/plain; charset=utf-8';
  return MIME[extOf(name)] || 'application/octet-stream';
}

// Never previewed, streamed, downloaded or opened — even if inside the scanned folder.
const DENY = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.kube(\/|$)/, /(^|\/)\.docker\/config\.json$/,
  /\/Library\/Keychains(\/|$)/, /\/Library\/Cookies(\/|$)/, /\/Library\/Application Support\/Google\/Chrome\/.*\/(Login Data|Cookies)/,
  /(^|\/)\.env(\..+)?$/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.git-credentials$/, /(^|\/)\.pgpass$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|ovpn)$/i,
  /\/server\/\.data(\/|$)/, // our own Google token
];
export function deniedReason(p) {
  return DENY.some((re) => re.test(p)) ? 'Blocked by security policy (credentials/secrets are never opened)' : null;
}

export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;

// Local file: must be a real file in the scanned tree, inside the scan root after resolving symlinks.
const policyError = (msg) => Object.assign(new Error(msg), { kind: 'policy' });

// Turn macOS "permission denied" into something actionable.
function accessError(p, e) {
  const appData = /\/Library\/(Group Containers|Containers|Mail|Messages|Safari|Application Support\/(AddressBook|CallHistory))/.test(p);
  const who = process.env.MS_APP ? 'Mapping Space' : 'the app you run npm start from (Terminal, iTerm…)';
  return Object.assign(new Error(appData
    ? `macOS protects this folder (another app's private data). To open it, turn on Full Disk Access for ${who} in System Settings → Privacy & Security, then restart it.`
    : `macOS didn't allow reading this file (${e.code}). Full Disk Access for ${who} usually fixes it.`), { kind: 'permission' });
}

// Local file: must be a real file in the scanned tree and stay inside the scan root.
// The scan never descends into symlinked folders, so only the file itself can be a link:
// resolve it only then (realpath needs access to every parent folder, which macOS denies
// for protected app containers even when the file itself is listable).
export async function checkLocalReadable(node, scanRoot) {
  if (!node || node.isDir || node.synthetic) throw policyError('Not a file');
  const denied = deniedReason(node.id);
  if (denied) throw policyError(denied);
  const rootPrefix = scanRoot.endsWith('/') ? scanRoot : scanRoot + '/';
  if (!node.id.startsWith(rootPrefix)) throw policyError('File is outside the scanned folder');
  let st;
  try { st = await fsp.lstat(node.id); } catch (e) { throw (e.code === 'EACCES' || e.code === 'EPERM') ? accessError(node.id, e) : e; }
  let real = node.id;
  if (st.isSymbolicLink()) {
    try {
      real = await fsp.realpath(node.id);
      const root = await fsp.realpath(scanRoot);
      if (real !== root && !real.startsWith(root.endsWith('/') ? root : root + '/')) throw policyError('File points outside the scanned folder (symlink)');
      if (deniedReason(real)) throw policyError(deniedReason(real));
      st = await fsp.stat(real);
    } catch (e) {
      if (e.kind) throw e;
      throw (e.code === 'EACCES' || e.code === 'EPERM') ? accessError(node.id, e) : e;
    }
  }
  if (!st.isFile()) throw policyError('Not a regular file');
  // Fail early (with a clear message) if macOS won't let us open it.
  try { const fh = await fsp.open(real, 'r'); await fh.close(); } catch (e) {
    throw (e.code === 'EACCES' || e.code === 'EPERM') ? accessError(real, e) : e;
  }
  return { real, size: st.size };
}

// ---- external tools ------------------------------------------------------

function which(cmd, extra = []) {
  for (const p of [...extra, ...(process.env.PATH || '').split(':').map((d) => path.join(d, cmd))]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}
export const FFMPEG = process.env.FFMPEG_PATH || which('ffmpeg', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
export const SIPS = process.platform === 'darwin' ? which('sips', ['/usr/bin/sips']) : null;

// Convert an image the browser can't show (HEIC, TIFF, RAW, PSD…) to a temporary JPEG.
export function convertImage(src) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `ms-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    if (SIPS) {
      execFile(SIPS, ['-s', 'format', 'jpeg', '-Z', '2400', src, '--out', out], { timeout: 30000 }, (e) => (e ? reject(new Error('Could not convert image')) : resolve(out)));
    } else if (FFMPEG) {
      execFile(FFMPEG, ['-v', 'error', '-y', '-i', src, '-vf', 'scale=min(2400\\,iw):-2', '-frames:v', '1', out], { timeout: 30000 }, (e) => (e ? reject(new Error('Could not convert image')) : resolve(out)));
    } else reject(new Error('No image converter available'));
  });
}

// ffmpeg args that turn any video/audio into a browser-playable fragmented MP4 on stdout.
export function transcodeArgs(input, kind, startSec = 0, headers) {
  const a = ['-v', 'error', '-nostdin'];
  if (startSec > 0) a.push('-ss', String(startSec));
  if (headers) a.push('-headers', headers);
  a.push('-i', input);
  if (kind === 'audio') a.push('-vn', '-c:a', 'aac', '-b:a', '192k');
  else a.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=min(1920\\,iw):-2', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  a.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return a;
}

export function probeDuration(input, headers) {
  if (!FFMPEG) return Promise.resolve(null);
  const hdr = headers ? ['-headers', headers] : [];
  const ffprobe = which('ffprobe', [path.join(path.dirname(FFMPEG), 'ffprobe')]);
  if (ffprobe) {
    return new Promise((res) => execFile(ffprobe, ['-v', 'error', ...hdr, '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
      { timeout: 15000 }, (e, out) => res(e ? null : Number(out) || null)));
  }
  // No ffprobe: ffmpeg prints "Duration: HH:MM:SS.xx" on stderr.
  return new Promise((res) => execFile(FFMPEG, ['-hide_banner', ...hdr, '-i', input], { timeout: 15000 }, (_e, _o, err) => {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err || '');
    res(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
  }));
}

// ---- "Open with" on the Mac ---------------------------------------------

const APP_CANDIDATES = {
  image: ['Preview', 'Pixelmator Pro', 'Adobe Photoshop 2025', 'Affinity Photo 2'],
  video: ['QuickTime Player', 'IINA', 'VLC', 'Infuse 7'],
  audio: ['Music', 'QuickTime Player', 'VLC', 'IINA'],
  pdf: ['Preview', 'Adobe Acrobat Reader', 'Adobe Acrobat', 'PDF Expert'],
  text: ['TextEdit', 'Visual Studio Code', 'Sublime Text', 'BBEdit', 'Xcode'],
};
const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
let appCache = null;
function installedApps() {
  if (appCache) return appCache;
  appCache = new Set();
  for (const list of Object.values(APP_CANDIDATES)) for (const a of list) {
    if (APP_DIRS.some((d) => fs.existsSync(path.join(d, `${a}.app`)))) appCache.add(a);
  }
  return appCache;
}
export function appsFor(kind) {
  if (process.platform !== 'darwin') return [];
  return (APP_CANDIDATES[kind] || []).filter((a) => installedApps().has(a));
}

// Only these kinds may be handed to macOS `open` — never scripts, apps or installers
// (opening a .command / .app / .pkg would EXECUTE it).
export const OPENABLE_KINDS = new Set(['image', 'video', 'audio', 'pdf', 'text']);
const NEVER_OPEN_EXT = /\.(app|command|tool|sh|zsh|bash|csh|pkg|mpkg|dmg|workflow|action|scpt|scptd|applescript|terminal|jar|py|rb|pl|js|mjs|php|exe|bat|ps1|webloc|inetloc|fileloc|url|plist|mobileconfig|kext|dylib|so)$/i;

export function openPolicy(realPath, kind, app, installed = appsFor(kind)) {
  if (deniedReason(realPath)) return deniedReason(realPath);
  if (!OPENABLE_KINDS.has(kind) || NEVER_OPEN_EXT.test(realPath)) return 'Blocked by security policy: this file type is never opened (it could run code). Use "Show in Finder" instead.';
  if (app && !installed.includes(app)) return 'App not allowed for this file type';
  return null;
}

export function openLocal(realPath, kind, app, reveal) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Open with is available on macOS only'));
  let args;
  if (reveal) args = ['-R', realPath];
  else {
    const why = openPolicy(realPath, kind, app);
    if (why) return Promise.reject(new Error(why));
    // Text/code always goes to an editor explicitly, never the system default handler.
    if (kind === 'text' && !app) app = 'TextEdit';
    args = app ? ['-a', app, realPath] : [realPath];
  }
  return new Promise((resolve, reject) => execFile('/usr/bin/open', args, { timeout: 15000 }, (e) => (e ? reject(new Error('macOS could not open the file')) : resolve())));
}

// ---- audit log -----------------------------------------------------------
export function audit(dataDir, action, details) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'audit.log'), JSON.stringify({ t: new Date().toISOString(), action, ...details }) + '\n');
  } catch { /* best effort */ }
}

// ---- Thumbnails ----------------------------------------------------------
// macOS Quick Look (same as Finder icons: images, videos, PDFs) → ffmpeg fallback.
// Cached in the OS temp folder (macOS cleans it), capped, keyed by path+size+mtime.
const THUMB_DIR = path.join(os.tmpdir(), 'mapping-space-thumbs');
const THUMB_PX = 480;
const QLMANAGE = process.platform === 'darwin' && fs.existsSync('/usr/bin/qlmanage') ? '/usr/bin/qlmanage' : null;
export const THUMB_KINDS = new Set(['image', 'video', 'pdf', 'gdoc']);
const inflight = new Map();
let running = 0;
const waiters = [];
const slot = () => (running < 3 ? (running++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => { const w = waiters.shift(); if (w) w(); else running--; };

function run(cmd, args, ms = 20000) {
  return new Promise((res, rej) => execFile(cmd, args, { timeout: ms }, (e) => (e ? rej(e) : res())));
}

export async function localThumb(realPath, kind) {
  const st = await fsp.stat(realPath);
  const key = crypto.createHash('sha1').update(`${realPath}|${st.size}|${st.mtimeMs}`).digest('hex');
  const out = path.join(THUMB_DIR, `${key}.jpg`);
  try { await fsp.access(out); return out; } catch { /* make it */ }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    await slot();
    try {
      if (QLMANAGE) {
        const tmp = await fsp.mkdtemp(path.join(THUMB_DIR, 'ql-'));
        try {
          await run(QLMANAGE, ['-t', '-s', String(THUMB_PX), '-o', tmp, realPath]);
          const made = (await fsp.readdir(tmp)).find((f) => f.endsWith('.png'));
          if (made) {
            // Re-encode PNG → JPEG with sips (smaller); fall back to keeping the PNG bytes.
            if (SIPS) await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', path.join(tmp, made), '--out', out]);
            else await fsp.rename(path.join(tmp, made), out);
            return out;
          }
        } catch { /* fall through to ffmpeg */ } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
      }
      if (FFMPEG && (kind === 'video' || kind === 'image')) {
        const vf = `scale='min(${THUMB_PX},iw)':-2`;
        const pre = kind === 'video' ? ['-ss', '3'] : [];
        try { await run(FFMPEG, ['-v', 'error', '-y', ...pre, '-i', realPath, '-frames:v', '1', '-vf', vf, '-q:v', '5', out]); } catch { /* retry at 0s */ }
        try { await fsp.access(out); } catch { await run(FFMPEG, ['-v', 'error', '-y', '-i', realPath, '-frames:v', '1', '-vf', vf, '-q:v', '5', out]); }
        return out;
      }
      throw new Error('No thumbnail available');
    } finally {
      release();
      inflight.delete(key);
      pruneThumbs();
    }
  })();
  inflight.set(key, job);
  return job;
}

let lastPrune = 0;
async function pruneThumbs(maxBytes = 150e6) {
  if (Date.now() - lastPrune < 60000) return;
  lastPrune = Date.now();
  try {
    const files = await Promise.all((await fsp.readdir(THUMB_DIR)).filter((f) => f.endsWith('.jpg'))
      .map(async (f) => ({ f, s: await fsp.stat(path.join(THUMB_DIR, f)) })));
    let total = files.reduce((a, x) => a + x.s.size, 0);
    files.sort((a, b) => a.s.atimeMs - b.s.atimeMs);
    for (const x of files) { if (total <= maxBytes) break; total -= x.s.size; await fsp.rm(path.join(THUMB_DIR, x.f), { force: true }); }
  } catch { /* ignore */ }
}
