// Demo provider: deterministic fake Mac disk so the app can be shown without
// scanning (and without any risk). Deletes only change the in-memory tree.
import { Tree, makeNode } from '../tree.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// [name, sizeBytes] for files, [name, [...children]] for folders
const SPEC = ['Macintosh HD', [
  ['Applications', [
    ['Xcode.app', 12.4 * GB], ['Docker.app', 2.1 * GB], ['Google Chrome.app', 1.3 * GB],
    ['Slack.app', 520 * MB], ['Visual Studio Code.app', 610 * MB], ['Spotify.app', 380 * MB],
  ]],
  ['Library', [
    ['Developer', [['CoreSimulator', 18.2 * GB], ['Xcode DerivedData', 6.7 * GB]]],
    ['Caches', [['com.apple.Safari', 1.9 * GB], ['Homebrew', 3.2 * GB], ['pip', 900 * MB]]],
    ['Application Support', [['Docker', [['Docker.raw', 32 * GB]]], ['Google', 2.4 * GB], ['Slack', 1.1 * GB]]],
  ]],
  ['Users', [
    ['demo', [
      ['Downloads', [
        ['ubuntu-24.04.iso', 5.8 * GB], ['old-backup.zip', 7.3 * GB], ['installer.dmg', 1.2 * GB],
        ['receipts', [['jan.pdf', 2 * MB], ['feb.pdf', 3 * MB]]],
      ]],
      ['Movies', [['vacation-4k.mov', 14.6 * GB], ['screen-recording.mov', 3.4 * GB]]],
      ['Pictures', [['Photos Library.photoslibrary', 41 * GB]]],
      ['Documents', [['thesis', [['data.csv', 860 * MB], ['draft.docx', 4 * MB]]], ['taxes', 120 * MB]]],
      ['projects', [
        ['web-app', [['node_modules', 1.4 * GB], ['src', 12 * MB], ['.git', 210 * MB]]],
        ['ml-experiments', [['checkpoints', 9.6 * GB], ['datasets', 6.2 * GB], ['.venv', 2.3 * GB]]],
        ['api-server', [['node_modules', 820 * MB], ['dist', 40 * MB]]],
      ]],
      ['.Trash', 2.8 * GB],
    ]],
  ]],
  ['System', 15.2 * GB],
  ['private', [['var', [['vm', [['sleepimage', 8 * GB], ['swapfile0', 2 * GB]]]]]]],
]];

export function scan() {
  const build = ([name, val], parent) => {
    const id = parent ? `${parent.id}/${name}` : `/demo`;
    if (Array.isArray(val)) {
      const n = makeNode(id, name, true, 0, parent);
      n.children = val.map((c) => build(c, n));
      tree.add(n);
      return n;
    }
    return tree.add(makeNode(id, name, false, Math.round(val), parent));
  };
  const tree = new Tree(null);
  tree.root = build(SPEC, null);
  tree.finalize();
  return tree;
}

export async function remove() { /* in-memory only */ }
