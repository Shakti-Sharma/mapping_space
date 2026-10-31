// Exercises the real gdrive provider against a simulated Google API (no network).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gd-'));
process.env.GDRIVE_TOKEN_FILE = path.join(dir, 'token.json');
process.env.GDRIVE_CLIENT_ID = 'x.apps.googleusercontent.com';
process.env.GDRIVE_CLIENT_SECRET = 'secret-secret';
const gd = await import('../src/providers/gdrive.js');

const F = 'application/vnd.google-apps.folder';
const files = [
  { id: 'f1', name: 'Videos', mimeType: F, parents: ['ROOT'], ownedByMe: true, capabilities: { canTrash: true, canDelete: true } },
  { id: 'v1', name: 'a.mp4', mimeType: 'video/mp4', quotaBytesUsed: '5000', parents: ['f1'], ownedByMe: true, capabilities: { canTrash: true, canDelete: true } },
  { id: 'v2', name: 'b.mp4', mimeType: 'video/mp4', quotaBytesUsed: '3000', parents: ['f1'], ownedByMe: true, capabilities: { canTrash: true, canDelete: true } },
  { id: 'doc', name: 'Notes', mimeType: 'application/vnd.google-apps.document', quotaBytesUsed: '0', parents: ['ROOT'], ownedByMe: true },
  { id: 's1', name: 'shared.pdf', mimeType: 'application/pdf', quotaBytesUsed: '700', ownedByMe: false, capabilities: { canTrash: false, canDelete: false } },
  { id: 't1', name: 'team.zip', mimeType: 'application/zip', quotaBytesUsed: '900', parents: ['DRV'], driveId: 'DRV', ownedByMe: false, capabilities: { canTrash: true, canDelete: false } },
];
const calls = [];
let tokenRefreshes = 0;

before(async () => {
  await fs.writeFile(process.env.GDRIVE_TOKEN_FILE, JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: 0 }));
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (u.host === 'oauth2.googleapis.com') { tokenRefreshes++; return json(200, { access_token: 'new', expires_in: 3600 }); }
    assert.equal(opts.headers.Authorization, 'Bearer new');
    if (u.pathname.endsWith('/files/root')) return json(200, { id: 'ROOT', name: 'My Drive' });
    if (u.pathname.endsWith('/drives')) return json(200, { drives: [{ id: 'DRV', name: 'Team' }] });
    if (u.pathname.endsWith('/files') ) {
      // two pages to test pagination
      const page = u.searchParams.get('pageToken') ? 1 : 0;
      return json(200, page ? { files: files.slice(3) } : { files: files.slice(0, 3), nextPageToken: 'p2' });
    }
    if (u.searchParams.get('alt') === 'media') return { status: opts.headers.Range ? 206 : 200, ok: true, headers: new Headers({ 'content-range': 'bytes 0-9/100' }), body: null, gotRange: opts.headers.Range };
    if (u.pathname.endsWith('/export')) return { status: 200, ok: true, mime: u.searchParams.get('mimeType') };
    if (u.searchParams.get('fields') === 'thumbnailLink') return json(200, { thumbnailLink: 'https://lh3.googleusercontent.com/abc=s220' });
    if (u.host === 'lh3.googleusercontent.com') return { status: 200, ok: true, thumbUrl: u.href };
    if (opts.method === 'PATCH' || opts.method === 'DELETE') return opts.method === 'DELETE' ? { status: 204, ok: true } : json(200, {});
    return json(404, { error: { message: 'nope' } });
  };
});

test('scan builds Drive tree with sizes, sections and permissions', async () => {
  const job = { files: 0, dirs: 0, bytes: 0, errors: 0 };
  const t = await gd.scan(null, job);
  assert.equal(tokenRefreshes, 1, 'expired token refreshed once');
  assert.equal(job.files, 5);
  assert.equal(job.dirs, 1);
  assert.equal(t.root.size, 5000 + 3000 + 700 + 900);
  const names = t.root.children.map((c) => c.name);
  assert.deepEqual(names, ['My Drive', 'Shared drive: Team', 'Shared with me']);
  assert.equal(t.get('f1').size, 8000);
  assert.equal(t.get('f1').parent.id, 'ROOT');
  assert.equal(t.get('t1').parent.id, 'DRV');
  assert.equal(t.get('s1').parent.id, '__shared');
  assert.ok(calls.some((c) => c.includes('includeItemsFromAllDrives=true')));

  assert.match(gd.checkDeletable(t.get('ROOT'), 'trash'), /section/);
  assert.match(gd.checkDeletable(t.get('s1'), 'trash'), /only its owner/);
  assert.equal(gd.checkDeletable(t.get('t1'), 'trash'), null);
  assert.match(gd.checkDeletable(t.get('t1'), 'permanent'), /permission/);
  assert.equal(gd.checkDeletable(t.get('v1'), 'permanent'), null);
});

test('remove trashes or deletes via API', async () => {
  await gd.remove('v1', 'trash');
  await gd.remove('v2', 'permanent');
  assert.ok(calls.includes('PATCH /drive/v3/files/v1?supportsAllDrives=true'));
  assert.ok(calls.includes('DELETE /drive/v3/files/v2?supportsAllDrives=true'));
});

test('demo drive matches real shape', async () => {
  const { scan, checkDeletable } = await import('../src/providers/demo-drive.js');
  const t = scan();
  assert.equal(t.root.children[0].name, 'My Drive');
  const shared = t.root.children.find((c) => c.name === 'Shared with me');
  assert.ok(checkDeletable(shared.children[0], 'trash'));
});

test('preview access: range forwarded, docs export as PDF, big thumbnails', async () => {
  const r = await gd.fetchMedia('v1', 'bytes=0-9');
  assert.equal(r.status, 206);
  assert.equal(r.gotRange, 'bytes=0-9');
  assert.equal((await gd.exportPdf('doc')).mime, 'application/pdf');
  assert.match((await gd.fetchThumbnail('img')).thumbUrl, /=s2000$/);
  assert.match(await gd.authHeader(), /^Authorization: Bearer new\r\n$/);
});
