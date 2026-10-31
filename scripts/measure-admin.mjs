#!/usr/bin/env node
// Measures the size of folders the app could not open (system folders, other users,
// .Spotlight-V100 …). Run with:  npm run measure   (asks for your Mac password)
//
// SAFETY: reads only folder listings and file sizes (lstat) — never file contents,
// never follows symlinks, never changes or deletes anything. The web app itself keeps
// running as you, not as admin; it only reads the JSON this script writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
// --data: the user's data folder (the Mac app passes ~/Library/Application Support/MappingSpace)
const DATA = arg('--data') || path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/.data');
const IN = path.join(DATA, 'denied.json');
const OUT = path.join(DATA, 'admin-sizes.json');
const TOP = 40;

if (process.getuid?.() !== 0) {
  console.error('Run this with admin rights:  npm run measure   (it asks for your Mac password)');
  process.exit(1);
}

let list;
try { list = JSON.parse(await fs.readFile(IN, 'utf8')); } catch {
  console.error('No scan found. In the app scan "/" first, then run this again.');
  process.exit(1);
}
const paths = (list.paths || []).filter((p) => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0'));
const skip = new Set(list.skip || []);
const seen = new Set();

// Size of one folder tree, staying on the folder's own disk.
async function sizeOf(dir, dev) {
  let size = 0; let count = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return { size, count }; }
  const subdirs = [];
  await Promise.all(entries.map(async (e) => {
    const full = path.join(dir, e.name);
    if (skip.has(full)) return;
    try {
      const s = await fs.lstat(full);
      if (s.dev !== dev) return;
      if (e.isDirectory()) { subdirs.push(full); return; }
      if (s.nlink > 1) { const k = `${s.dev}:${s.ino}`; if (seen.has(k)) return; seen.add(k); }
      size += s.blocks * 512; count++;
    } catch { /* vanished */ }
  }));
  for (const d of subdirs) { const r = await sizeOf(d, dev); size += r.size; count += r.count; }
  return { size, count };
}

const result = { measuredAt: new Date().toISOString(), sizes: {} };
let grand = 0;
for (const [i, p] of paths.entries()) {
  let st;
  try { st = await fs.lstat(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  let entries = [];
  try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { continue; }
  const kids = [];
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (skip.has(full)) continue;
    try {
      const s = await fs.lstat(full);
      if (s.dev !== st.dev) continue;
      if (e.isDirectory()) { const r = await sizeOf(full, st.dev); kids.push([e.name, r.size, true, r.count]); }
      else kids.push([e.name, s.blocks * 512, false, 1]);
    } catch { /* vanished */ }
  }
  kids.sort((a, b) => b[1] - a[1]);
  const size = kids.reduce((a, k) => a + k[1], 0);
  const count = kids.reduce((a, k) => a + k[3], 0);
  const rest = kids.slice(TOP);
  result.sizes[p] = {
    size, count,
    top: kids.slice(0, TOP).map(([n, s, d]) => [n, s, d]),
    restSize: rest.reduce((a, k) => a + k[1], 0), restCount: rest.length,
  };
  grand += size;
  process.stdout.write(`\r${i + 1}/${paths.length} folders · ${(grand / 1e9).toFixed(1)} GB `);
}

await fs.writeFile(OUT, JSON.stringify(result), { mode: 0o600 });
// Hand the file back to you so the (non-admin) app can read it.
const [ou, og] = (arg('--owner') || '').split(':').map(Number);
const uid = ou || Number(process.env.SUDO_UID); const gid = og || Number(process.env.SUDO_GID);
if (uid) await fs.chown(OUT, uid, gid || 20);
console.log(`\nDone: measured ${Object.keys(result.sizes).length} folders, ${(grand / 1e9).toFixed(1)} GB. Go back to the app and press "Apply admin sizes".`);
