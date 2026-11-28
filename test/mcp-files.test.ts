import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { head, type Projects } from '../packages/core/projects.ts';
import { Mcp } from '../packages/server/mcp.ts';
import { stageFiles, writeFilesInput } from '../packages/server/mcp-files.ts';
import { GAME_BYTES } from '../packages/server/turn-folder.ts';
import { install, legacyProject } from './helpers.ts';

const base64 = (data: string | Uint8Array) => Buffer.from(data).toString('base64');
const glb = new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0xff]);
const folder = {
  'index.html': base64('<!doctype html><script type="module" src="./assets/main.js"></script>'),
  'assets/main.js': base64('\ufeffdocument.body.append("built")'),
  'models/hero.glb': base64(glb),
};

type Result = { isError?: boolean; content: [{ text: string }] };
function connect(t: TestContext, write: boolean, setup: (projects: Projects) => { id: string }) {
  const { projects } = install(t);
  const project = setup(projects);
  const mcp = new Mcp(projects, new Map());
  const credential = 'Bearer ' + mcp.create({ projectId: project.id, hours: 1, write }).token;
  const call = (name: string, args: object) =>
    (
      mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, credential) as {
        result: Result;
      }
    ).result;
  const ok = <T>(name: string, args: object) => {
    const result = call(name, args);
    assert.ok(!result.isError, name + ': ' + result.content[0].text);
    return JSON.parse(result.content[0].text) as T;
  };
  const refused = (name: string, args: object) => {
    const result = call(name, args);
    assert.equal(result.isError, true, name + ' should be refused');
    return result.content[0].text;
  };
  const current = () => head(projects.read(project.id), 'main').id;
  return { projects, project, call, ok, refused, current };
}

type Staged = {
  proposal: { id: string };
  preview: { game: { html: string; maxPlayers: number; net?: true; files?: Record<string, string> } };
};

test("read_file gives a built game's files by path: text as text, anything else as base64", (t) => {
  const { ok, refused, current } = connect(t, false, (projects) => importGameFolder(projects, { files: folder }));
  const revision = current();
  assert.deepEqual(ok('read_file', { path: 'index.html' }), {
    revision,
    path: 'index.html',
    size: 69,
    text: '<!doctype html><script type="module" src="./assets/main.js"></script>',
  });
  // A byte order mark is part of the file's text, and its size counts its bytes.
  assert.deepEqual(ok('read_file', { path: 'assets/main.js', revision }), {
    revision,
    path: 'assets/main.js',
    size: 32,
    text: '\ufeffdocument.body.append("built")',
  });
  assert.deepEqual(ok('read_file', { path: 'models/hero.glb', branch: 'main' }), {
    revision,
    path: 'models/hero.glb',
    size: 8,
    base64: base64(glb),
  });
  assert.equal(refused('read_file', { path: 'missing.js' }), 'The game has no file at missing.js.');
  assert.equal(refused('read_file', { path: 'index.html', branch: 'other' }), 'Branch does not exist.');
  assert.equal(refused('read_file', { path: 'index.html', revision: 'nope' }), 'Revision does not exist.');
  for (const path of ['../escape.js', '.hidden.js', 'assets/MAIN.JS', 'notes.exe']) refused('read_file', { path });
  refused('read_file', { path: 'index.html', extra: true });
});

test("read_file refuses a revision without a game, and reads a one-page game's page", (t) => {
  const legacy = connect(t, false, (projects) => legacyProject(projects, 'blank'));
  assert.equal(legacy.refused('read_file', { path: 'index.html' }), 'This revision has no game.');
  const page = connect(t, false, (projects) => projects.createGame('Page', { html: '<p>héllo</p>', maxPlayers: 1 }));
  assert.deepEqual(page.ok('read_file', { path: 'index.html' }), {
    revision: page.current(),
    path: 'index.html',
    size: 13,
    text: '<p>héllo</p>',
  });
});

test('write_files stages the files it names, keeps the rest, and a write grant applies it', (t) => {
  const { ok, refused, current, projects, project } = connect(t, true, (store) =>
    importGameFolder(store, { files: folder }),
  );
  const base = current();
  const staged = ok<Staged>('write_files', {
    baseRevision: base,
    label: '  Rename the hero  ',
    files: [
      { path: 'index.html', text: '\ufeff  <!doctype html><script type="module" src="./src/main.js"></script>\n' },
      { path: 'src/main.js', text: 'document.body.append("moved")' },
      { path: 'assets/main.js', remove: true },
      { path: 'models/hero.glb', base64: base64(new Uint8Array([1, 2, 3])) },
    ],
  });
  const game = staged.preview.game;
  assert.equal(game.html, '<!doctype html><script type="module" src="./src/main.js"></script>');
  assert.deepEqual(Object.keys(game.files!), ['models/hero.glb', 'src/main.js']);
  assert.deepEqual(projects.readAsset(game.files!['models/hero.glb']!), Buffer.from([1, 2, 3]));
  assert.equal(current(), base, 'staging changes nothing yet');
  const applied = ok<{ revision: { id: string; parent: string; label: string }; branch: string }>('apply_proposal', {
    proposalId: staged.proposal.id,
  });
  assert.deepEqual(
    [applied.revision.parent, applied.revision.label, applied.branch],
    [base, 'Rename the hero', 'main'],
  );
  assert.equal(current(), applied.revision.id);
  assert.equal(ok<{ text: string }>('read_file', { path: 'src/main.js' }).text, 'document.body.append("moved")');
  assert.equal(
    ok<{ text: string }>('read_file', { path: 'assets/main.js', revision: base }).text,
    '\ufeffdocument.body.append("built")',
  );
  // The old head is stale now.
  assert.equal(
    refused('write_files', { baseRevision: base, label: 'Late', files: [{ path: 'a.txt', text: 'x' }] }),
    'The branch has changed. Request a new proposal against its current revision.',
  );
  // propose can't rewrite a folder game; write_files is its way.
  assert.match(
    refused('propose', {
      proposal: {
        baseRevision: current(),
        branch: 'main',
        label: 'Page',
        operations: [{ op: 'writeGame', game: { html: '<p>one</p>' } }],
      },
    }),
    /folder of files/,
  );
  assert.equal(projects.read(project.id).revisions.length, 2);
});

test("write_files keeps to a game folder's rules", (t) => {
  const { ok, refused, current } = connect(t, false, (projects) => importGameFolder(projects, { files: folder }));
  const write = (files: object[]) => refused('write_files', { baseRevision: current(), label: 'Edit', files });
  assert.equal(
    write([
      { path: 'a.js', text: '1' },
      { path: 'a.js', text: '2' },
    ]),
    'Name each file once: a.js.',
  );
  assert.equal(write([{ path: 'index.html', remove: true }]), 'A game keeps its index.html: write it instead.');
  assert.equal(write([{ path: 'gone.js', remove: true }]), 'The game has no file at gone.js.');
  assert.equal(
    write([{ path: 'index.html', base64: base64(new Uint8Array([0xff, 0xfe])) }]),
    'index.html must be UTF-8 text.',
  );
  assert.equal(
    write([{ path: 'index.html', text: ' \n ' }]),
    'index.html must hold the game’s page, at most 400,000 characters.',
  );
  assert.equal(
    write([{ path: 'index.html', text: 'x'.repeat(400_001) }]),
    'index.html must hold the game’s page, at most 400,000 characters.',
  );
  assert.equal(
    write([
      { path: 'assets/main.js', remove: true },
      { path: 'models/hero.glb', remove: true },
    ]),
    'A game imported as a folder keeps at least one file beside index.html.',
  );
  // Shapes the contract refuses: a path a game can't hold, both text and base64, base64 without its padding, nothing.
  for (const files of [
    [{ path: '.env', text: 'x' }],
    [{ path: 'a.js', text: 'x', base64: 'eA==' }],
    [{ path: 'a.js', base64: 'eA' }],
    [{ path: 'a.js', remove: false }],
    [],
  ])
    write(files);
  refused('write_files', { baseRevision: current(), label: ' ', files: [{ path: 'a.js', text: 'x' }] });
  // A text file written as base64 reads back as text.
  const staged = ok<Staged>('write_files', {
    baseRevision: current(),
    label: 'Data',
    files: [{ path: 'data/level.json', base64: base64('{"a":1}') }],
  });
  assert.deepEqual(Object.keys(staged.preview.game.files!), ['assets/main.js', 'data/level.json', 'models/hero.glb']);
});

test('write_files reads zirbel.json for the players, as an import does', (t) => {
  const { ok, current } = connect(t, false, (projects) => importGameFolder(projects, { files: folder }));
  const players = (manifest: string) => {
    const { game } = ok<Staged>('write_files', {
      baseRevision: current(),
      label: 'Players',
      files: [{ path: 'zirbel.json', text: manifest }],
    }).preview;
    return [game.maxPlayers, game.net ?? false];
  };
  assert.deepEqual(players('{ "players": { "min": 1, "max": 8 } }'), [8, true]);
  assert.deepEqual(players('{ "players": { "max": 40 } }'), [16, true]);
  assert.deepEqual(players('{ "players": { "max": 1 } }'), [1, false]);
  assert.deepEqual(players('not json'), [1, false]);
  // Other files leave the players as they are.
  const { game } = ok<Staged>('write_files', {
    baseRevision: current(),
    label: 'Code',
    files: [{ path: 'a.js', text: '1' }],
  }).preview;
  assert.deepEqual([game.maxPlayers, game.net], [1, undefined]);
});

test('write_files reads zirbel.json for the keys gamepads press, and keeps them while other files change', (t) => {
  const keys = { a: 'Space', start: 'Enter' };
  const { ok, current } = connect(t, true, (projects) =>
    importGameFolder(projects, { files: { ...folder, 'zirbel.json': base64(JSON.stringify({ controls: { keys } })) } }),
  );
  type Keyed = { preview: { game: { controls?: unknown } } };
  const staged = (files: object[]) =>
    ok<Keyed>('write_files', { baseRevision: current(), label: 'Keys', files }).preview.game.controls;
  assert.deepEqual(staged([{ path: 'assets/main.js', text: '1' }]), { keys });
  assert.deepEqual(staged([{ path: 'zirbel.json', text: '{ "controls": { "keys": { "up": "KeyW" } } }' }]), {
    keys: { up: 'KeyW' },
  });
  assert.equal(staged([{ path: 'zirbel.json', text: '{ "controls": { "keys": { "up": "Key W" } } }' }]), undefined);
  assert.equal(staged([{ path: 'zirbel.json', remove: true }]), undefined);
});

test('write_files gives a one-page game files, and starts a game for a project without one', (t) => {
  const page = connect(t, false, (projects) => projects.createGame('Page', { html: '<p>one</p>', maxPlayers: 3 }));
  const grown = page.ok<Staged>('write_files', {
    baseRevision: page.current(),
    label: 'Style',
    files: [{ path: 'style.css', text: 'p{}' }],
  });
  assert.deepEqual(
    [grown.preview.game.html, grown.preview.game.maxPlayers, Object.keys(grown.preview.game.files!)],
    ['<p>one</p>', 3, ['style.css']],
  );
  const only = page.ok<Staged>('write_files', {
    baseRevision: page.current(),
    label: 'Page',
    files: [{ path: 'index.html', text: '<p>two</p>' }],
  });
  assert.equal(only.preview.game.files, undefined);

  const empty = connect(t, false, (projects) => projects.createGame('Empty'));
  assert.equal(
    empty.refused('write_files', {
      baseRevision: empty.current(),
      label: 'Start',
      files: [{ path: 'a.js', text: '1' }],
    }),
    'This project has no game yet: write its index.html too.',
  );
  const started = empty.ok<Staged>('write_files', {
    baseRevision: empty.current(),
    label: 'Start',
    files: [{ path: 'index.html', text: '<p>new</p>' }],
  });
  assert.deepEqual(started.preview.game, { html: '<p>new</p>', maxPlayers: 1 });
});

test('write_files holds a game to 1000 files and 36 MB in all', (t) => {
  const { projects } = install(t);
  const project = projects.createGame('Big');
  const commit = (files: Record<string, string>) => {
    const { proposal } = projects.submit(
      project.id,
      {
        branch: 'main',
        baseRevision: head(projects.read(project.id), 'main').id,
        label: 'Files',
        operations: [{ op: 'writeGame', game: { html: '<p>big</p>', maxPlayers: 1, files } }],
      },
      true,
    );
    projects.commit(project.id, proposal.id);
  };
  const stage = (files: unknown[]) => () =>
    stageFiles(
      projects,
      project.id,
      writeFilesInput.parse({ baseRevision: head(projects.read(project.id), 'main').id, label: 'More', files }),
    );
  const one = projects.storeAsset(Buffer.from('x'));
  commit(Object.fromEntries(Array.from({ length: 1000 }, (_, index) => ['f' + index + '.txt', one])));
  assert.throws(stage([{ path: 'extra.txt', text: 'x' }]), /up to 1000 files besides index\.html/);
  assert.ok(stage([{ path: 'f0.txt', text: 'y' }])().proposal.id, 'rewriting a file adds none');
  commit({ 'big.bin': projects.storeAsset(Buffer.alloc(GAME_BYTES - 20)) });
  assert.throws(
    stage([{ path: 'more.bin', base64: base64(new Uint8Array(20)) }]),
    /larger than a game can be \(36 MB\)/,
  );
  assert.ok(stage([{ path: 'more.bin', base64: base64(new Uint8Array(5)) }])().proposal.id);
});
