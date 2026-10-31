import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, deniedReason, openPolicy, mimeFor } from '../src/media.js';

test('kinds by extension and Drive mimeType', () => {
  assert.equal(kindOf({ name: 'a.HEIC' }), 'image');
  assert.equal(kindOf({ name: 'm.mkv' }), 'video');
  assert.equal(kindOf({ name: 'x.pdf' }), 'pdf');
  assert.equal(kindOf({ name: 'x.bin' }), null);
  assert.equal(kindOf({ name: 'Notes', meta: { mimeType: 'application/vnd.google-apps.document' } }), 'gdoc');
  assert.equal(kindOf({ name: 'noext', meta: { mimeType: 'video/x-msvideo' } }), 'video');
  assert.equal(kindOf({ name: 'dir', isDir: true }), null);
});

test('secrets are never served', () => {
  for (const p of ['/Users/me/.ssh/id_ed25519', '/Users/me/proj/.env', '/Users/me/.env.local', '/Users/me/Library/Keychains/login.keychain-db',
    '/Users/me/cert.pem', '/Users/me/.aws/credentials', '/x/server/.data/gdrive-token.json']) assert.ok(deniedReason(p), p);
  assert.equal(deniedReason('/Users/me/Movies/trip.mp4'), null);
});

test('open-with policy never runs code', () => {
  assert.ok(openPolicy('/u/run.command', 'text', null, []));
  assert.ok(openPolicy('/u/Tool.app', null, null, []));
  assert.ok(openPolicy('/u/script.sh', 'text', 'TextEdit', ['TextEdit']));
  assert.ok(openPolicy('/u/v.mp4', 'video', 'Terminal', ['QuickTime Player']), 'unknown app refused');
  assert.equal(openPolicy('/u/v.mp4', 'video', 'QuickTime Player', ['QuickTime Player']), null);
  assert.equal(openPolicy('/u/v.mp4', 'video', null, []), null);
});

test('html/svg-like text is served as plain text', () => {
  assert.match(mimeFor('page.html', 'text'), /^text\/plain/);
});
