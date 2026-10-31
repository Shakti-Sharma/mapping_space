// Fake Google Drive for demos: same shape as the real gdrive provider
// (virtual sections, owner permissions), deletes only touch memory.
import { Tree, makeNode } from '../tree.js';
import { checkDeletable as driveCheck } from './gdrive.js';

const GB = 1e9;
const MB = 1e6;
const DOC = 'application/vnd.google-apps.document';

// [name, size | children[], opts?]  opts.notMine → shared by someone else
const SECTIONS = [
  ['My Drive', [
    ['Google Photos backup', [['2023', 18.4 * GB], ['2024', 22.1 * GB], ['2025', 9.7 * GB]]],
    ['Videos', [['wedding-full.mp4', 11.2 * GB], ['drone-raw.mov', 6.4 * GB], ['zoom-recordings', [['standup-0412.mp4', 900 * MB], ['all-hands.mp4', 2.1 * GB]]]]],
    ['Work', [['Client decks', 1.8 * GB], ['Datasets', [['training.parquet', 4.2 * GB], ['raw.csv.gz', 1.3 * GB]]], ['Notes (Google Doc)', 0, { mime: DOC }]]],
    ['Backups', [['laptop-2022.zip', 14.9 * GB], ['phone-backup.tar', 7.6 * GB]]],
    ['Scans', 640 * MB],
  ]],
  ['Shared drive: Team', [
    ['Design assets', 8.3 * GB], ['Release builds', [['v1.2.dmg', 1.1 * GB], ['v1.3.dmg', 1.2 * GB]]],
  ]],
  ['Shared with me', [
    ['Conference talks.mp4', 3.4 * GB, { notMine: true }],
    ['Family album', [['IMG_0001.heic', 4 * MB]], { notMine: true }],
  ]],
];

export function scan() {
  const root = makeNode('__all', 'Google Drive', true);
  const tree = new Tree(root);
  let seq = 0;
  const build = ([name, val, opts = {}], parent, virtual = false) => {
    const isDir = Array.isArray(val);
    const n = tree.add(makeNode(virtual ? `__s${seq++}` : `d${seq++}`, name, isDir, isDir ? 0 : Math.round(val), parent));
    n.meta = virtual ? { virtual: true }
      : { mimeType: opts.mime || (isDir ? 'application/vnd.google-apps.folder' : 'application/octet-stream'),
          ownedByMe: !opts.notMine, canTrash: !opts.notMine, canDelete: !opts.notMine,
          link: 'https://drive.google.com/' };
    if (isDir) n.children = val.map((c) => build(opts.notMine ? [c[0], c[1], { ...c[2], notMine: true }] : c, n));
    return n;
  };
  root.children = SECTIONS.map((s) => build(s, root, true));
  tree.finalize();
  return tree;
}

export const checkDeletable = driveCheck;
export async function remove() { /* in-memory only */ }
