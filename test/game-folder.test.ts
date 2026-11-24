import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { head } from '../packages/core/projects.ts';
import { gamePage } from '../packages/server/game-page.ts';
import { install, rights } from './helpers.ts';

const base64 = (text: string | Uint8Array) => Buffer.from(text).toString('base64');
const folder = {
  'index.html': base64('\ufeff<!doctype html><script type="module" src="./assets/main.js"></script>'),
  'assets/main.js': base64('fetch("./models/hero.glb")'),
  'models/hero.glb': base64(new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0])),
};

test('a built folder imports as a game whose files are stored by hash', (t) => {
  const { projects } = install(t);
  const project = importGameFolder(projects, { title: 'Crawler', files: folder });
  const game = head(project, 'main').game!;
  assert.equal(project.title, 'Crawler');
  assert.equal(game.html, '<!doctype html><script type="module" src="./assets/main.js"></script>');
  assert.deepEqual(Object.keys(game.files!), ['assets/main.js', 'models/hero.glb']);
  assert.equal(projects.readAsset(game.files!['models/hero.glb']!).toString('base64'), folder['models/hero.glb']);

  const refuses = (files: Record<string, string>, status: number | RegExp) => assert.throws(() => importGameFolder(projects, { files }),
    (error: Error & { status?: number }) => typeof status === 'number' ? error.status === status : status.test(error.message));
  refuses({ 'assets/main.js': folder['assets/main.js'] }, 422); // no index.html
  refuses({ ...folder, '.hidden/x.js': base64('x') }, /files/);
  refuses({ ...folder, 'assets/MAIN.JS': base64('x') }, /files/);
  refuses({ ...folder, '../escape.js': base64('x') }, /files/);
  refuses({ ...folder, 'assets/odd.js': 'abc' }, 400); // base64 without its padding
  refuses({ 'index.html': base64(new Uint8Array([0xff, 0xfe])) }, 422); // not UTF-8
});

test('a built game cannot be rewritten by a proposal, and travels with its files', (t) => {
  const { projects, releases } = install(t);
  const project = importGameFolder(projects, { files: folder });
  const revision = head(project, 'main');
  assert.throws(() => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Edit',
    operations: [{ op: 'writeGame', game: { html: '<p>new</p>' } }] }), /built folder/);
  assert.throws(() => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Files',
    operations: [{ op: 'writeGame', game: { html: '<p>new</p>', files: {} } }] }));

  const release = releases.package(project.id, 'main', rights, true);
  const files = Object.values(revision.game!.files!);
  assert.deepEqual(Object.keys(release.assets).sort(), [...files].sort());
  assert.equal(releases.import(JSON.parse(JSON.stringify(release))).manifest.releaseId, release.manifest.releaseId);
  const tampered = JSON.parse(JSON.stringify(release));
  tampered.assets[files[0]!] = base64('changed');
  assert.throws(() => install(t).releases.import(tampered), /does not match its hash/);
  const remixed = releases.remix(release.manifest.releaseId);
  assert.deepEqual(head(remixed, 'main').game!.files, revision.game!.files);

  const other = install(t).projects;
  const copy = other.import(projects.export(project.id));
  assert.deepEqual(head(copy, 'main').game!.files, revision.game!.files);
  assert.equal(other.readAsset(files[0]!).length > 0, true);
});

test('only a built game may load files, and only from beside its document', (t) => {
  const { projects, releases } = install(t);
  const built = releases.package(importGameFolder(projects, { files: folder }).id, 'main', rights, false);
  const policy = gamePage(built, 'http://h/runtime/r/', "'self'", 'http://h/game/r/key/').policy;
  assert.match(policy, /^sandbox allow-scripts;/);
  assert.match(policy, /connect-src http:\/\/h\/game\/r\/key\/ data: blob:; worker-src http:\/\/h\/game\/r\/key\/ blob:;/);
  assert.match(policy, /script-src 'unsafe-inline' 'wasm-unsafe-eval' http:\/\/h\/game\/r\/key\/ /);
  const single = projects.createGame('Single', { html: '<canvas></canvas>', maxPlayers: 1 });
  const plain = gamePage(releases.package(single.id, 'main', rights, false), 'http://h/runtime/r/', "'self'", 'http://h/game/r/key/').policy;
  assert.match(plain, /connect-src 'none';/);
  assert.doesNotMatch(plain, /game\/r\/key/);
});
