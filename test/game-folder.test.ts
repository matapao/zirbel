import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { head } from '../packages/core/projects.ts';
import { GAME_FILE_TYPES, gameFilePath } from '../packages/sdk/game.ts';
import { gamePage } from '../packages/server/game-page.ts';
import { importMap, install, rights, sandboxPolicy } from './helpers.ts';

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

test('a built game cannot be rewritten by a proposal that would drop its files, and travels with them', (t) => {
  const { projects, releases } = install(t);
  const project = importGameFolder(projects, { files: folder });
  const revision = head(project, 'main');
  assert.throws(() => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Edit',
    operations: [{ op: 'writeGame', game: { html: '<p>new</p>' } }] }), /folder of files, which this change would drop/);
  // Files only come from the editor's own harness turns: a proposal from outside can't name any.
  assert.throws(() => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Files',
    operations: [{ op: 'writeGame', game: { html: '<p>new</p>', files: {} } }] }));
  // A turn's folder game replaces it with its own files, and stays a folder game.
  const turnFiles = { 'main.js': projects.storeAsset(Buffer.from('console.log(2)')) };
  const staged = projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Turn',
    operations: [{ op: 'writeGame', game: { html: '<script src="main.js"></script>', maxPlayers: 1, files: turnFiles } }] }, true);
  assert.deepEqual(staged.preview.game?.files, turnFiles);
  assert.deepEqual(projects.preview(project.id, staged.proposal.id).preview.game?.files, turnFiles);
  projects.discard(project.id, staged.proposal.id);

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

test('every game gets the same sandbox: its own files, WebAssembly, workers and three.js addons, and no network', (t) => {
  const { projects, releases } = install(t);
  const built = releases.package(importGameFolder(projects, { files: folder }).id, 'main', rights, false);
  const single = releases.package(projects.createGame('Single', { html: '<canvas></canvas>', maxPlayers: 1 }).id, 'main', rights, false);
  for (const release of [built, single]) {
    const page = gamePage(release, 'http://h/runtime/r/', "'self'", 'http://h/game/r/key/');
    assert.equal(page.policy, sandboxPolicy('http://h/runtime/r/', 'http://h/game/r/key/', "'self'"));
    assert.ok(page.html.includes(importMap('http://h/runtime/r/')), page.html);
    // Nothing beyond this host: no wildcard or bare scheme, and every address is the game's own or the runtime's.
    assert.doesNotMatch(page.policy, /\*|https?:(?:;| )|'unsafe-eval'|allow-same-origin/);
    for (const address of page.policy.match(/https?:\/\/\S+/g) ?? []) assert.match(address, /^http:\/\/h\/(?:game|runtime)\/r\//);
  }
});

test('game files carry their content types, the same in both hosts', () => {
  const text = 'text/plain; charset=utf-8';
  for (const [extension, type] of Object.entries({ obj: 'model/obj', mtl: 'model/mtl', fbx: 'application/octet-stream',
    hdr: 'image/vnd.radiance', exr: 'image/x-exr', glsl: text, vert: text, frag: text, ts: text, tsx: text, jsx: text })) {
    assert.equal(GAME_FILE_TYPES[extension], type, extension);
    assert.equal(gameFilePath.safeParse('assets/file.' + extension).success, true, extension);
  }
  assert.equal(gameFilePath.safeParse('assets/file.tsv').success, false);
  // host/gamefiles.go keeps the same table.
  const go = readFileSync('host/gamefiles.go', 'utf8');
  const start = go.indexOf('var gameFileTypes = map[string]string{');
  const table = go.slice(start, go.indexOf('\n}\n', start));
  assert.deepEqual(Object.fromEntries([...table.matchAll(/"(\w+)": "([^"]+)"/g)].map(([, key, value]) => [key, value])), { ...GAME_FILE_TYPES });
});

test('a built folder whose zirbel.json is for several players imports as a net game, and releases as net-v2', (t) => {
  const { projects, releases } = install(t);
  const described = (manifest: unknown) => ({ ...folder, 'zirbel.json': base64(JSON.stringify(manifest)) });
  const game = (files: Record<string, string>) => head(importGameFolder(projects, { files }), 'main').game!;
  const net = game(described({ id: 'derby', players: { min: 1, max: 24 } }));
  assert.equal(net.maxPlayers, 16);
  assert.equal(net.net, true);
  assert.ok(net.files!['zirbel.json']);
  for (const manifest of [{ players: { max: 1 } }, { players: { max: 2.5 } }, { players: { max: '8' } }, { players: null }, 7, null]) {
    assert.deepEqual([game(described(manifest)).maxPlayers, game(described(manifest)).net], [1, undefined]);
  }
  assert.equal(game({ ...folder, 'zirbel.json': base64('{"players":') }).net, undefined);
  assert.equal(game({ ...folder, 'zirbel.json': base64(JSON.stringify({ players: { max: 3 }, pad: 'x'.repeat(70_000) })) }).net, undefined);

  const project = importGameFolder(projects, { title: 'Derby', files: described({ players: { max: 8 } }) });
  const release = releases.package(project.id, 'main', rights, true);
  assert.equal(release.manifest.simulation, 'net-v2');
  assert.deepEqual(release.manifest.players, { min: 1, max: 8 });
  assert.deepEqual(release.manifest.capabilities, ['multiplayer']);

  // More than four players only with net: a proposal can't drop it and keep them.
  const revision = head(project, 'main');
  assert.throws(() => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Edit',
    operations: [{ op: 'writeGame', game: { html: revision.game!.html, maxPlayers: 8 } }] }), /needs net/);
});
