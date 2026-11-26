import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { head } from '../packages/core/projects.ts';
import { GAME_FILE_TYPES, gameDocument, gameFilePath } from '../packages/sdk/game.ts';
import { gamePage } from '../packages/server/game-page.ts';
import { fakeHarnesses } from './fake-harnesses.ts';
import { importMap, install, rights, sandboxPolicy, tempDir } from './helpers.ts';

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

test('a net game names its adapter in zirbel.json, one of its own scripts, and only its game page loads it', (t) => {
  const { projects, releases } = install(t);
  const described = (multiplayer: unknown, players = 4) => ({ ...folder, 'net/adapter.js': base64('export {}'),
    'net/adapter.mjs': base64('export {}'), 'zirbel.json': base64(JSON.stringify({ players: { max: players }, multiplayer })) });
  const game = (files: Record<string, string>) => head(importGameFolder(projects, { files }), 'main').game!;
  for (const adapter of ['net/adapter.js', 'net/adapter.mjs', 'assets/main.js']) assert.equal(game(described({ adapter })).adapter, adapter);
  // A file the folder lacks, another type, a path no game file has or no string: the game keeps its net, without an adapter.
  for (const multiplayer of [{ adapter: 'net/missing.js' }, { adapter: 'models/hero.glb' }, { adapter: './net/adapter.js' },
    { adapter: 'index.html' }, { adapter: 'net/adapter.js/' }, { adapter: 7 }, { adapter: ['net/adapter.js'] }, 'net/adapter.js', null]) {
    const imported = game(described(multiplayer));
    assert.deepEqual([imported.net, imported.adapter], [true, undefined], JSON.stringify(multiplayer));
  }
  // A game for one has none.
  const single = game(described({ adapter: 'net/adapter.js' }, 1));
  assert.deepEqual([single.net, single.adapter], [undefined, undefined]);

  // A game document holds one only with net, among its files; a proposal, which carries none, can't name one.
  const hash = 'a'.repeat(64);
  const parses = (more: object) => gameDocument.safeParse({ html: '<p>x</p>', maxPlayers: 2, ...more }).success;
  assert.equal(parses({ net: true, adapter: 'a.js', files: { 'a.js': hash } }), true);
  for (const more of [{ adapter: 'a.js', files: { 'a.js': hash } }, { net: true, adapter: 'b.js', files: { 'a.js': hash } },
    { net: true, adapter: 'a.js' }, { net: true, adapter: 'a.css', files: { 'a.css': hash } }]) assert.equal(parses(more), false, JSON.stringify(more));
  const project = importGameFolder(projects, { title: 'Net', files: described({ adapter: 'net/adapter.js' }) });
  const revision = head(project, 'main');
  const write = (more: object, withFiles = false) => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Adapter',
    operations: [{ op: 'writeGame', game: { html: '<p>x</p>', maxPlayers: 4, net: true, ...more } }] }, withFiles);
  assert.throws(() => write({ adapter: 'net/adapter.js' }), /adapter/);
  assert.throws(() => write({ adapter: 'net/gone.js', files: revision.game!.files }, true), /adapter is one of the game’s own files/);

  // Its release keeps it, in the order both hosts hash; its page loads it last, and is otherwise the page without it.
  const release = releases.package(project.id, 'main', rights, false);
  assert.deepEqual(Object.keys(release.game!), ['html', 'maxPlayers', 'net', 'adapter', 'files']);
  const runtime = 'http://h/runtime/r/', base = 'http://h/game/r/key/';
  const page = gamePage(release, runtime, "'self'", base);
  const without = structuredClone(release);
  delete without.game!.adapter;
  const plain = gamePage(without, runtime, "'self'", base);
  assert.equal(page.html, plain.html + '<script type="module" src="http://h/game/r/key/net/adapter.js"></script>');
  assert.ok(plain.html.endsWith(release.game!.html.replace(/^<!doctype html>/, '')));
  assert.deepEqual([page.policy, plain.policy], [sandboxPolicy(runtime, base, "'self'", 'http://h'), sandboxPolicy(runtime, base, "'self'", 'http://h')]);
});

test('any game names the keys gamepads press in zirbel.json, and each place’s, kept in its release and carried on its page', (t) => {
  const { projects, releases } = install(t);
  const keyed = (controls: unknown, players = 1) => ({ ...folder,
    'zirbel.json': base64(JSON.stringify({ players: { max: players }, controls })) });
  const game = (files: Record<string, string>) => head(importGameFolder(projects, { files }), 'main').game!;
  assert.deepEqual(game(keyed({ keys: { start: 'Enter', a: 'Space', up: 'ArrowUp' } })).controls,
    { keys: { a: 'Space', start: 'Enter', up: 'ArrowUp' } });
  assert.deepEqual(Object.keys(game(keyed({ keys: { start: 'Enter', a: 'Space' } })).controls!.keys!), ['a', 'start']);
  assert.deepEqual(game(keyed({ keys: { a: 'KeyJ' } }, 3)).controls, { keys: { a: 'KeyJ' } });
  // An input it doesn't know, a code that isn't one, none at all, or anything but an object: no controls.
  for (const controls of [{ keys: { a: 'Space', jump: 'KeyW' } }, { keys: { a: 'Space bar' } }, { keys: { a: 32 } }, { keys: {} },
    { keys: ['Space'] }, { keys: 'Space' }, 'keys', null, { keys: { a: 'A'.repeat(25) } }, { keys: { A: 'Space' } }, {}])
    assert.equal(game(keyed(controls)).controls, undefined, JSON.stringify(controls));
  assert.equal(game({ ...folder, 'zirbel.json': base64('{"controls":{"keys":{"__proto__":"Space"}}}') }).controls, undefined);

  // Each place's own keys, name and colour, in that order, other fields aside; the list only where all of it is right.
  const players = [{ color: '#d03030', keys: { up: 'KeyW', a: 'Space' }, name: 'Red car', wheels: 4 }, {}, { name: 'Blue car' }];
  assert.deepEqual(JSON.stringify(game(keyed({ keys: { a: 'KeyJ' }, players })).controls),
    '{"keys":{"a":"KeyJ"},"players":[{"keys":{"a":"Space","up":"KeyW"},"name":"Red car","color":"#d03030"},{},{"name":"Blue car"}]}');
  for (const wrong of [[], Array(9).fill({}), [{ name: '' }], [{ name: 'n'.repeat(25) }], [{ color: 'red' }], [{ color: '#12345' }],
    [{ keys: {} }], [{ keys: { a: 'Space bar' } }], [null], ['Red car'], { name: 'Red car' }])
    assert.deepEqual(game(keyed({ keys: { a: 'KeyJ' }, players: wrong })).controls, { keys: { a: 'KeyJ' } }, JSON.stringify(wrong));
  // A name's length as JavaScript counts it, in UTF-16 code units.
  assert.deepEqual(game(keyed({ players: [{ name: '🚗'.repeat(12) }] })).controls, { players: [{ name: '🚗'.repeat(12) }] });
  assert.equal(game(keyed({ players: [{ name: '🚗'.repeat(13) }] })).controls, undefined);

  // A proposal can't set them.
  const project = importGameFolder(projects, { files: keyed({ keys: { b: 'ShiftLeft', a: 'Space' }, players: [{ name: 'Ada' }] }) });
  const revision = head(project, 'main');
  assert.throws(() => projects.submit(project.id, { baseRevision: revision.id, branch: 'main', label: 'Keys',
    operations: [{ op: 'writeGame', game: { html: '<p>x</p>', controls: { keys: { a: 'KeyX' } } } }] }));

  // Its release keeps them, in the order both hosts hash; its page carries them ahead of game-sdk, and is otherwise as it was.
  const release = releases.package(project.id, 'main', rights, false);
  assert.deepEqual(Object.keys(release.game!), ['html', 'maxPlayers', 'controls', 'files']);
  const runtime = 'http://h/runtime/r/', base = 'http://h/game/r/key/';
  const without = structuredClone(release);
  delete without.game!.controls;
  const controls = '<script type="application/json" id="zirbel-controls">' +
    '{"keys":{"a":"Space","b":"ShiftLeft"},"players":[{"name":"Ada"}]}</script>';
  assert.equal(gamePage(release, runtime, "'self'", base).html,
    gamePage(without, runtime, "'self'", base).html.replace('<script crossorigin', controls + '<script crossorigin'));
});

test('a harness edit of a net game keeps the adapter its game/zirbel.json names, while that file is there', async (t) => {
  const { runHarnessChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const manifest = JSON.stringify({ players: { max: 4 }, multiplayer: { adapter: 'net/adapter.js' } });
  const project = importGameFolder(projects, { files: { 'index.html': base64('<p>net</p>'), 'zirbel.json': base64(manifest),
    'net/adapter.js': base64('export {}') } });
  const folder = tempDir(t, 'zirbel-turn-');
  mkdirSync(join(folder, 'game', 'net'), { recursive: true });
  writeFileSync(join(folder, 'game', 'index.html'), '<p>edited</p>');
  writeFileSync(join(folder, 'game', 'zirbel.json'), manifest);
  writeFileSync(join(folder, 'game', 'net', 'adapter.js'), 'export {}');
  const harnesses = fakeHarnesses([{ id: 'codex', name: 'Codex' }], async () =>
    ({ task: 'one', stopReason: 'end_turn', text: JSON.stringify({ action: 'edit', message: 'Edited.' }) }));
  const edit = async () => {
    const current = projects.read(project.id);
    await runHarnessChat(harnesses, 'codex', projects, current, head(current, 'main'), { text: 'Edit it.', branch: 'main', folder }, []);
    return head(projects.read(project.id), 'main').game!;
  };
  const edited = await edit();
  assert.deepEqual([edited.html, edited.net, edited.adapter], ['<p>edited</p>', true, 'net/adapter.js']);
  rmSync(join(folder, 'game', 'net'), { recursive: true });
  const unwired = await edit();
  assert.deepEqual([unwired.net, unwired.adapter], [true, undefined]);
});
