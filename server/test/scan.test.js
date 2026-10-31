import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scan, checkDeletable } from '../src/providers/local.js';
import { scan as demoScan } from '../src/providers/demo.js';

test('local scan sums sizes and supports remove', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-'));
  await fs.mkdir(path.join(dir, 'a/b'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a/b/big.bin'), Buffer.alloc(200_000, 1));
  await fs.writeFile(path.join(dir, 'small.txt'), 'hi');
  const job = { files: 0, dirs: 0, bytes: 0, errors: 0 };
  const tree = await scan(dir, job);
  assert.equal(job.files, 2);
  assert.ok(tree.root.size >= 200_000);
  const a = tree.get(path.join(dir, 'a'));
  assert.equal(tree.root.children[0], a, 'largest first');
  const before = tree.root.size;
  tree.remove(a);
  assert.equal(tree.root.size, before - a.size);
  assert.equal(tree.get(path.join(dir, 'a/b')), undefined);
  await fs.rm(dir, { recursive: true });
});

test('delete guards', () => {
  assert.ok(checkDeletable('/', '/'));
  assert.ok(checkDeletable(os.homedir(), '/'));
  assert.ok(checkDeletable('/System/Library', '/'));
  assert.ok(checkDeletable('/tmp/x', '/Users/me'));
  assert.equal(checkDeletable('/Users/me/Downloads/x.iso', '/Users/me'), null);
});

test('demo tree builds and views', () => {
  const t = demoScan();
  const v = t.view(t.root, 1);
  assert.ok(v.size > 100 * 1024 ** 3);
  assert.ok(v.children.length > 3);
});

test('admin sizes merge into blocked folders and shrink the hidden bucket', async () => {
  const { Tree, makeNode } = await import('../src/tree.js');
  const { applyAdminSizes } = await import('../src/providers/local.js');
  const root = makeNode('/', '/', true); const t = new Tree(root);
  const sys = t.add(makeNode('/private', 'private', true, 0, root)); root.children.push(sys);
  const locked = t.add(makeNode('/private/db', 'db', true, 0, sys)); locked.meta = { denied: true }; sys.children.push(locked);
  const h = t.add(makeNode('__hidden', 'hidden', true, 0, root)); root.children.push(h);
  const rest = t.add(makeNode('__hidden_rest', 'rest', false, 5000, h)); h.children.push(rest);
  t.finalize();
  const before = root.size;
  const r = applyAdminSizes(t, { '/private/db': { size: 3000, count: 3, top: [['x', 2000, true], ['y', 1000, false]] } });
  assert.equal(r.applied, 1);
  assert.equal(locked.size, 3000);
  assert.equal(rest.size, 2000);
  assert.equal(root.size, before, 'total disk usage unchanged');
  assert.equal(applyAdminSizes(t, { '/private/db': { size: 1, count: 1 } }).applied, 0, 'applied once');
});
