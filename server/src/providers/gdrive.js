// Google Drive provider (phase 2). Plain REST + OAuth2 via fetch — no googleapis
// SDK (it is ~100 MB installed). Folder size = sum of quotaBytesUsed of contents.
// Covers My Drive, Shared drives, and items shared with you.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tree, makeNode } from '../tree.js';

const DATA_DIR = process.env.MS_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.data');
const tokenFile = () => process.env.GDRIVE_TOKEN_FILE || path.join(DATA_DIR, 'gdrive-token.json');
const SCOPE = 'https://www.googleapis.com/auth/drive'; // needed to trash/delete
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'nextPageToken, files(id,name,mimeType,size,quotaBytesUsed,parents,ownedByMe,driveId,webViewLink,thumbnailLink,hasThumbnail,capabilities(canTrash,canDelete))';

const cfg = () => ({
  id: process.env.GDRIVE_CLIENT_ID,
  secret: process.env.GDRIVE_CLIENT_SECRET,
  redirect: `http://localhost:${process.env.PORT || 4000}/api/gdrive/callback`,
});

export const isConfigured = () => Boolean(cfg().id && cfg().secret);
export const redirectUri = () => cfg().redirect;

async function loadToken() {
  try { return JSON.parse(await fs.readFile(tokenFile(), 'utf8')); } catch { return null; }
}
async function saveToken(t) {
  await fs.mkdir(path.dirname(tokenFile()), { recursive: true });
  await fs.writeFile(tokenFile(), JSON.stringify(t), { mode: 0o600 });
}
export async function isConnected() { return Boolean(await loadToken()); }
export async function disconnect() { await fs.rm(tokenFile(), { force: true }); }

export function authUrl() {
  const c = cfg();
  const q = new URLSearchParams({
    client_id: c.id, redirect_uri: c.redirect, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  const c = cfg();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google sign-in error: ${j.error_description || j.error}`);
  return j;
}

export async function handleCallback(code) {
  const j = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: cfg().redirect });
  await saveToken({ ...j, expires_at: Date.now() + j.expires_in * 1000 });
}

async function accessToken() {
  const t = await loadToken();
  if (!t) throw new Error('Google Drive not connected');
  if (Date.now() < t.expires_at - 60_000) return t.access_token;
  if (!t.refresh_token) throw new Error('Google session expired — disconnect and connect again');
  const j = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const nt = { ...t, ...j, expires_at: Date.now() + j.expires_in * 1000 };
  await saveToken(nt);
  return nt.access_token;
}

async function api(url, opts = {}, attempt = 0) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    ...opts,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  // Back off on rate limits / transient errors (big Drives page through thousands of calls).
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    return api(url, opts, attempt + 1);
  }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Drive API: ${j.error?.message || r.status}`);
  return j;
}

async function listAll(job, params) {
  const out = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
    const j = await api(`/files?${q}`);
    for (const f of j.files) {
      out.push(f);
      if (f.mimeType === FOLDER) job.dirs++; else job.files++;
      job.bytes += Number(f.quotaBytesUsed || f.size || 0);
    }
    pageToken = j.nextPageToken;
  } while (pageToken && !job.cancelled);
  return out;
}

export async function scan(_path, job) {
  const rootMeta = await api('/files/root?fields=id,name');
  const root = makeNode('__all', 'Google Drive', true);
  const tree = new Tree(root);
  const virtual = (id, name) => {
    const n = tree.add(makeNode(id, name, true, 0, root));
    n.meta = { virtual: true };
    return n;
  };
  const myDrive = virtual(rootMeta.id, 'My Drive');
  root.children.push(myDrive);
  const shared = virtual('__shared', 'Shared with me');

  // Shared drives become top-level folders keyed by their driveId.
  const drives = [];
  let pageToken;
  do {
    const j = await api(`/drives?${new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) })}`).catch(() => ({ drives: [] }));
    drives.push(...(j.drives || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  for (const d of drives) root.children.push(virtual(d.id, `Shared drive: ${d.name}`));

  const items = await listAll(job, {
    q: 'trashed = false',
    pageSize: '1000',
    fields: FIELDS,
    corpora: drives.length ? 'allDrives' : 'user',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });

  for (const f of items) {
    if (tree.index.has(f.id)) continue;
    const isDir = f.mimeType === FOLDER;
    const n = makeNode(f.id, f.name, isDir, isDir ? 0 : Number(f.quotaBytesUsed || f.size || 0));
    n.meta = {
      mimeType: f.mimeType,
      ownedByMe: Boolean(f.ownedByMe),
      link: f.webViewLink,
      canTrash: f.capabilities?.canTrash ?? Boolean(f.ownedByMe),
      canDelete: f.capabilities?.canDelete ?? Boolean(f.ownedByMe),
    };
    if (f.thumbnailLink) { n.thumbLink = f.thumbnailLink; n.meta.hasThumb = true; }
    n._p = f.parents?.[0] || f.driveId;
    tree.add(n);
  }
  for (const n of tree.index.values()) {
    if (!('_p' in n)) continue;
    let p = (n._p && tree.index.get(n._p)) || shared;
    // Guard against parent cycles (corrupt metadata): fall back to "Shared with me".
    for (let a = p; a; a = a.parent) if (a === n) { p = shared; break; }
    delete n._p;
    n.parent = p;
    p.children.push(n);
  }
  if (shared.children.length) root.children.push(shared); else tree.index.delete(shared.id);
  tree.finalize();
  return tree;
}

// ---- content access (preview / stream). The token never leaves the server. ----

export const mediaUrl = (id) => `${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true&acknowledgeAbuse=false`;
export async function authHeader() { return `Authorization: Bearer ${await accessToken()}\r\n`; }

// Raw file bytes; forwards a Range header so videos can seek.
export async function fetchMedia(id, range, signal) {
  const r = await fetch(mediaUrl(id), {
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(range ? { Range: range } : {}) },
    signal,
  });
  if (!r.ok && r.status !== 206) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`Drive API: ${j.error?.message || r.status}`);
  }
  return r;
}

// Google Docs/Sheets/Slides have no bytes: export them as PDF for viewing (Drive limit 10 MB).
export async function exportPdf(id, signal) {
  const r = await fetch(`${API}/files/${encodeURIComponent(id)}/export?mimeType=application%2Fpdf`, {
    headers: { Authorization: `Bearer ${await accessToken()}` }, signal,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`Drive export: ${j.error?.message || r.status}`);
  }
  return r;
}

// Drive renders thumbnails for HEIC/TIFF/RAW etc. — used when the browser can't decode the original.
export async function fetchThumbnail(id, signal, px = 2000, cachedLink) {
  const get = async (link) => fetch(link.replace(/=s\d+$/, `=s${px}`), { headers: { Authorization: `Bearer ${await accessToken()}` }, signal });
  if (cachedLink) { const r = await get(cachedLink); if (r.ok) return r; } // links expire after a few hours
  const meta = await api(`/files/${encodeURIComponent(id)}?fields=thumbnailLink&supportsAllDrives=true`);
  if (!meta.thumbnailLink) throw new Error('Google Drive has no preview for this file');
  const r = await get(meta.thumbnailLink);
  if (!r.ok) throw new Error('Could not load Drive preview');
  return r;
}

export function checkDeletable(node, mode) {
  if (node.meta?.virtual) return 'This is a Drive section, not a real folder';
  if (mode === 'permanent' && node.meta?.canDelete === false) return `You don't have permission to delete "${node.name}" (not the owner)`;
  if (mode !== 'permanent' && node.meta?.canTrash === false) return `You can't trash "${node.name}" — only its owner can`;
  return null;
}

export async function remove(id, mode) {
  const u = `/files/${encodeURIComponent(id)}?supportsAllDrives=true`;
  if (mode === 'permanent') await api(u, { method: 'DELETE' });
  else await api(u, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
}
