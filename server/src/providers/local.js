// Local disk provider: fast concurrent walk, real on-disk size (blocks*512),
// no symlink following, hard-link dedupe, top-N files kept per folder.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Tree, makeNode } from '../tree.js';

const KEEP_FILES = 200; // individual files kept per folder; rest aggregated
const WORKERS = 32;
const STAT_BATCH = 64;

// Never descended into: virtual filesystems and other disks.
const SKIP_DIRS = new Set(['/dev', '/proc', '/sys', '/Volumes']);

// macOS keeps user data on a separate "Data" volume that appears at / through firmlinks
// (/Users, /Applications, /Library, /private, /opt, /usr/local …). Walking
// /System/Volumes/Data would count those twice, so inside it we skip exactly the
// firmlinked folders and walk only what is NOT visible elsewhere (.Spotlight-V100,
// .DocumentRevisions-V100, .fseventsd …). Other hidden volumes (VM swap, Preboot,
// Update) are walked normally under /System/Volumes.
const DATA_VOL = '/System/Volumes/Data';
async function firmlinkTargets() {
  const out = new Set();
  try {
    for (const line of (await fs.readFile('/usr/share/firmlinks', 'utf8')).split('\n')) {
      const target = line.split('\t')[1]?.trim();
      if (target) out.add(path.join(DATA_VOL, target));
    }
  } catch { /* not macOS */ }
  out.add(path.join(DATA_VOL, 'Volumes'));
  return out;
}

function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { timeout: 15000, maxBuffer: 8e6 }, (e, out) => res(e ? null : out)));
}

// Sizes of every APFS volume (no admin needed) + Time Machine local snapshot count.
export async function apfsBreakdown(diskTotal) {
  if (process.platform !== 'darwin') return null;
  const xml = await run('/usr/sbin/diskutil', ['apfs', 'list', '-plist']);
  if (!xml) return null;
  const json = await new Promise((res) => {
    const p = execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { maxBuffer: 8e6 }, (e, out) => res(e ? null : out));
    p.stdin.end(xml);
  });
  let containers;
  try { containers = JSON.parse(json).Containers || []; } catch { return null; }
  // The boot container is the one whose size matches the / filesystem.
  const c = containers.sort((a, b) => Math.abs(a.CapacityCeiling - diskTotal) - Math.abs(b.CapacityCeiling - diskTotal))[0];
  if (!c) return null;
  const snaps = (await run('/usr/bin/tmutil', ['listlocalsnapshots', '/'])) || '';
  // "Available for important usage" (what Finder shows as free) includes purgeable space;
  // statfs free does not. The difference is purgeable (iCloud cache, old snapshots…).
  const important = Number((await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('Foundation'); var v = $.NSURL.fileURLWithPath('/').resourceValuesForKeysError(['NSURLVolumeAvailableCapacityForImportantUsageKey'], null); String(ObjC.unwrap(v.objectForKey('NSURLVolumeAvailableCapacityForImportantUsageKey')))"]) || '').trim()) || 0;
  return {
    importantFree: important,
    volumes: (c.Volumes || []).map((v) => ({ name: v.Name, roles: v.Roles || [], used: v.CapacityInUse || 0 })),
    snapshots: snaps.split('\n').filter((l) => /com\.apple/.test(l)).length,
  };
}

const ROLE_MOUNT = { VM: '/System/Volumes/VM', Preboot: '/System/Volumes/Preboot', Update: '/System/Volumes/Update', xART: '/System/Volumes/xarts', Hardware: '/System/Volumes/Hardware' };

export async function scan(rootPath, job) {
  const rootAbs = path.resolve(rootPath.replace(/^~(?=$|\/)/, os.homedir()));
  const st = await fs.stat(rootAbs);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${rootAbs}`);

  const root = makeNode(rootAbs, rootAbs, true);
  const tree = new Tree(root);
  const seenInodes = new Set();
  const queue = [root];
  let active = 0;
  const firm = process.platform === 'darwin' ? await firmlinkTargets() : new Set();
  const volDev = new Map(); // '/System/Volumes/X' → st_dev, to avoid walking into nested mounts
  const allDenied = [];

  async function walk(dirNode) {
    let dir;
    try {
      dir = await fs.opendir(dirNode.id, { bufferSize: 256 });
    } catch (e) {
      job.errors++;
      // macOS privacy (TCC) blocks Desktop/Documents/Downloads/Photos… without Full Disk Access.
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        dirNode.meta = { denied: true };
        job.denied = job.denied || [];
        if (job.denied.length < 200) job.denied.push(dirNode.id);
        if (allDenied.length < 20000) allDenied.push(dirNode.id);
      }
      return;
    }
    const files = [];
    const pending = [];
    const flush = async () => {
      const batch = pending.splice(0);
      await Promise.all(batch.map(async (full) => {
        try {
          const s = await fs.lstat(full);
          if (s.nlink > 1) {
            const key = `${s.dev}:${s.ino}`;
            if (seenInodes.has(key)) return;
            seenInodes.add(key);
          }
          const size = s.blocks != null ? s.blocks * 512 : s.size;
          files.push([full, size]);
          job.files++;
          job.bytes += size;
        } catch {
          job.errors++;
        }
      }));
    };
    try {
      for await (const d of dir) {
        if (job.cancelled) return;
        const full = path.join(dirNode.id, d.name);
        if (d.isDirectory()) {
          if (SKIP_DIRS.has(full) || firm.has(full)) continue;
          if (full.startsWith('/System/Volumes/')) {
            // Stay on the same volume (Update/Preboot contain mounted snapshots/cryptexes).
            const volRoot = full.split('/').slice(0, 4).join('/');
            try {
              const s = await fs.lstat(full);
              if (full === volRoot) volDev.set(volRoot, s.dev);
              else if (volDev.has(volRoot) && volDev.get(volRoot) !== s.dev) continue;
            } catch { continue; }
          }
          const child = tree.add(makeNode(full, d.name, true, 0, dirNode));
          dirNode.children.push(child);
          queue.push(child);
        } else {
          pending.push(full); // files, symlinks (own size), sockets…
          if (pending.length >= STAT_BATCH) await flush();
        }
      }
      await flush();
    } catch {
      job.errors++;
    }
    files.sort((a, b) => b[1] - a[1]);
    for (const [full, size] of files.slice(0, KEEP_FILES)) {
      dirNode.children.push(tree.add(makeNode(full, path.basename(full), false, size, dirNode)));
    }
    if (files.length > KEEP_FILES) {
      const rest = files.slice(KEEP_FILES);
      dirNode.other = { size: rest.reduce((s, f) => s + f[1], 0), count: rest.length };
    }
    job.dirs++;
  }

  await new Promise((resolve) => {
    const pump = () => {
      if (job.cancelled || (queue.length === 0 && active === 0)) return resolve();
      while (active < WORKERS && queue.length) {
        const next = queue.pop(); // DFS keeps the queue small
        active++;
        walk(next).finally(() => { active--; pump(); });
      }
    };
    pump();
  });

  tree.finalize();
  job.allDenied = allDenied;
  job.skipList = [...SKIP_DIRS, ...firm];

  // Whole-disk scan: what the scan could not read gets its own folder, broken down by
  // APFS volume, so the map adds up to the disk usage macOS reports.
  if (rootAbs === '/' && fs.statfs) {
    try {
      const sf = await fs.statfs('/');
      const used = (sf.blocks - sf.bavail) * sf.bsize;
      job.diskUsed = used;
      const hidden = used - root.size;
      if (hidden > 5e8) {
        const h = tree.add(makeNode('__hidden', 'Not readable without admin', true, 0, root));
        h.meta = { virtual: true, hidden: true };
        const add = (id, name, size, note) => {
          if (size < 5e7) return 0;
          const n = tree.add(makeNode(id, name, false, size, h));
          n.meta = { virtual: true, hidden: true, note };
          h.children.push(n);
          return size;
        };
        let explained = 0;
        const apfs = await apfsBreakdown(sf.blocks * sf.bsize);
        for (const v of apfs?.volumes || []) {
          const role = v.roles[0];
          if (!role || role === 'System' || role === 'Data') continue;
          const mount = ROLE_MOUNT[role];
          const walked = mount && tree.get(mount) ? tree.get(mount).size : 0;
          explained += add(`__vol_${role}`, `${v.name} volume (${role})${walked ? ' — admin-only part' : ''}`, Math.max(0, v.used - walked),
            role === 'VM' ? 'Swap memory and sleep image; managed by macOS.' : role === 'Recovery' ? 'macOS Recovery system.' : 'macOS system volume; managed by macOS.');
        }
        const purgeable = apfs?.importantFree ? Math.max(0, apfs.importantFree - sf.bavail * sf.bsize) : 0;
        explained += add('__purgeable', 'Purgeable space', Math.min(purgeable, Math.max(0, hidden - explained)),
          'Caches and iCloud copies macOS deletes automatically when you need space (counts as free in Finder).');
        const rest = Math.max(0, hidden - explained);
        const snap = apfs?.snapshots ? `${apfs.snapshots} Time Machine snapshot${apfs.snapshots > 1 ? 's' : ''}, ` : '';
        add('__hidden_rest', `${snap ? 'Snapshots & ' : ''}admin-only folders`, rest,
          `${snap}folders only an administrator can read (${allDenied.length} found). Run "npm run measure" to read them.`);
        h.size = h.children.reduce((a, c) => a + c.size, 0);
        h.count = 0;
        h.children.sort((a, b) => b.size - a.size);
        root.children.push(h);
        root.size += h.size;
        root.children.sort((a, b) => b.size - a.size);
        job.snapshots = apfs?.snapshots || 0;
      }
    } catch { /* statfs unsupported */ }
  }
  return tree;
}

// Merge sizes measured by `npm run measure` (run with sudo) into folders the scan
// couldn't open. Measured bytes are taken out of the "admin-only" bucket so totals stay equal.
export function applyAdminSizes(tree, measured) {
  let total = 0; let applied = 0;
  for (const [p, m] of Object.entries(measured)) {
    const node = tree.get(p);
    if (!node || !node.isDir || !node.meta?.denied || node.meta.admin) continue;
    const dSize = m.size - node.size; const dCount = m.count - node.count;
    node.size = m.size; node.count = m.count;
    node.meta = { denied: true, admin: true };
    for (const [name, size, isDir] of m.top || []) {
      const c = tree.add(makeNode(path.join(p, name), name, false, size, node));
      c.meta = { admin: true, folder: Boolean(isDir) };
      node.children.push(c);
    }
    if (m.restSize > 0) node.other = { size: m.restSize, count: m.restCount || 0 };
    node.children.sort((a, b) => b.size - a.size);
    for (let a = node.parent; a; a = a.parent) { a.size += dSize; a.count += dCount; a.children.sort((x, y) => y.size - x.size); }
    total += dSize; applied++;
  }
  const rest = tree.get('__hidden_rest');
  if (rest && total > 0) {
    const take = Math.min(rest.size, total);
    for (let a = rest; a; a = a.parent) a.size -= take;
    rest.parent.children.sort((x, y) => y.size - x.size);
    tree.root.children.sort((x, y) => y.size - x.size);
  }
  return { applied, bytes: total };
}

// ---- deletion -------------------------------------------------------------

const HOME = os.homedir();
const PROTECT_EXACT = new Set(['/', HOME, '/Users', '/Applications', '/Library', path.join(HOME, 'Library'), '/home']);
const PROTECT_TREE = ['/System', '/usr', '/bin', '/sbin', '/dev', '/private', '/etc', '/var', '/opt/homebrew/bin'];

export function checkDeletable(target, scanRoot) {
  const extra = (process.env.PROTECTED_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const t = path.resolve(target);
  if (PROTECT_EXACT.has(t) || extra.includes(t)) return `Protected path: ${t}`;
  if (PROTECT_TREE.some((p) => t === p || t.startsWith(p + '/'))) return `Inside protected system folder: ${t}`;
  if (t === scanRoot) return 'Cannot delete the scan root itself';
  if (!t.startsWith(scanRoot.endsWith('/') ? scanRoot : scanRoot + '/')) return 'Path is outside the scanned folder';
  return null;
}

function trashDir() {
  return process.platform === 'darwin'
    ? path.join(HOME, '.Trash')
    : path.join(HOME, '.local/share/Trash/files');
}

async function moveToTrash(target) {
  const dir = trashDir();
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(target);
  let dest = path.join(dir, base);
  try { await fs.access(dest); dest = path.join(dir, `${base} ${Date.now()}`); } catch { /* free name */ }
  try {
    await fs.rename(target, dest);
  } catch (e) {
    if (e.code === 'EXDEV' && process.platform === 'darwin') {
      // Different volume: let Finder handle it (supports "Put Back").
      await new Promise((res, rej) => execFile('osascript', ['-e',
        `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`], (err) => (err ? rej(err) : res())));
    } else throw e;
  }
}

export async function remove(target, mode) {
  if (mode === 'permanent') await fs.rm(target, { recursive: true, force: true });
  else await moveToTrash(target);
}
