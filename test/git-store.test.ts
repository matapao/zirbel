// The git store (AGENTS.md): every save a commit, the game's folder at the top of its tree, the host's own
// files under .zirbel/, proposals on refs of their own, history from git, and the version-1 projects migrated.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { FastImport, git, listTree, readObjects, resolve } from '../packages/core/git.ts';
import { readTree, TREE_ENTRIES } from '../packages/core/git-tree.ts';
import { head, Projects } from '../packages/core/projects.ts';
import { versionOneData } from './git-fixtures.ts';
import { install, legacyProject } from './helpers.ts';

const base64 = (text: string) => Buffer.from(text).toString('base64');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const tree = (repo: string, commit: string) => listTree(repo, commit).map(({ path }) => path);
const blob = (repo: string, commit: string, path: string) =>
  git(repo, ['cat-file', 'blob', commit + ':' + path]).stdout.toString('utf8');
const log = (repo: string, ref = 'main') =>
  git(repo, ['log', '--format=%H|%an|%ae|%cn|%ce|%s', ref]).stdout.toString('utf8').trim().split('\n');

test('every save is a commit: the game’s folder at its top, the author who asked, Zirbel committing', (t) => {
  const { projects } = install(t);
  const ada = { name: 'Ada <x>', email: 'editor.1@zirbel.invalid' };
  const project = importGameFolder(
    projects,
    {
      title: 'Net',
      files: {
        'index.html': base64('<script src="net/adapter.mjs"></script>'),
        'net/adapter.mjs': base64('export {}'),
        'zirbel.json': base64(JSON.stringify({ players: { max: 8 }, multiplayer: { adapter: 'net/adapter.mjs' } })),
      },
    },
    ada,
  );
  const repo = projects.repository(project.id);
  const first = head(project, 'main');
  assert.match(first.id, /^[0-9a-f]{40}$/);
  assert.equal(resolve(repo, 'refs/heads/main'), first.id);
  assert.deepEqual(tree(repo, first.id), ['index.html', 'net/adapter.mjs', 'zirbel.json']);
  assert.deepEqual(first.game, {
    html: '<script src="net/adapter.mjs"></script>',
    maxPlayers: 8,
    net: true,
    adapter: 'net/adapter.mjs',
    files: {
      'net/adapter.mjs': first.game!.files!['net/adapter.mjs']!,
      'zirbel.json': first.game!.files!['zirbel.json']!,
    },
  });
  assert.deepEqual(log(repo), [
    first.id + '|Ada x|editor.1@zirbel.invalid|Zirbel|zirbel@zirbel.invalid|Imported game folder',
  ]);
  assert.equal(first.author, 'Ada x');
  // Each game file's blob, by its SHA-256, kept beside the repository.
  const kept = readFileSync(join(repo, 'zirbel-sha256'), 'utf8');
  for (const entry of listTree(repo, first.id).filter(({ path }) => path !== 'index.html'))
    assert.ok(kept.includes(entry.oid + ' ' + (first.game?.files?.[entry.path] ?? '')), entry.path);

  // A game for three that shares state: its own fields under .zirbel/, as JSON a host writes the same.
  const shared = projects.createGame('Shared', { html: '<p>three</p>', maxPlayers: 3, registerObjects: false });
  const sharedRepo = projects.repository(shared.id);
  assert.deepEqual(tree(sharedRepo, 'main'), ['.zirbel/game.json', 'index.html']);
  assert.equal(blob(sharedRepo, 'main', '.zirbel/game.json'), '{\n  "maxPlayers": 3,\n  "registerObjects": false\n}\n');
  assert.deepEqual(head(shared, 'main').game, { html: '<p>three</p>', maxPlayers: 3, registerObjects: false });
  assert.equal(log(sharedRepo)[0]!.split('|')[1], 'Owner');
});

test('an older scene project keeps its scene and assets under .zirbel/', (t) => {
  const { projects } = install(t);
  const project = legacyProject(projects, 'mosslight');
  const hash = projects.storeAsset(Buffer.from(png, 'base64'));
  const asset = {
    id: 'dot',
    name: 'Dot',
    author: 'Me',
    source: 'https://example.org/dot.png',
    license: 'CC0-1.0' as const,
    credit: '',
    hash,
    media: 'image/png' as const,
  };
  const { proposal } = projects.submit(project.id, {
    branch: 'main',
    baseRevision: project.branches.main,
    label: 'Add a dot',
    operations: [
      { op: 'addAsset', asset },
      { op: 'background', color: '#112233' },
    ],
  });
  const { revision } = projects.commit(project.id, proposal.id);
  const repo = projects.repository(project.id);
  assert.deepEqual(tree(repo, revision.id), [
    '.zirbel/assets.json',
    '.zirbel/assets/' + hash + '.png',
    '.zirbel/scene.json',
  ]);
  assert.deepEqual(JSON.parse(blob(repo, revision.id, '.zirbel/scene.json')), revision.scene);
  assert.equal(revision.scene?.background, '#112233');
  assert.deepEqual(revision.assets, [asset]);
  // Removing the asset takes its bytes out of the tree too.
  const removed = projects.submit(project.id, {
    branch: 'main',
    baseRevision: revision.id,
    label: 'No dot',
    operations: [{ op: 'removeAsset', id: 'dot' }],
  });
  assert.deepEqual(tree(repo, projects.commit(project.id, removed.proposal.id).revision.id), ['.zirbel/scene.json']);
});

test('what the host doesn’t manage stays in the tree, and a proposal is a commit on a ref of its own', (t) => {
  const { projects } = install(t);
  const project = projects.createGame('Kept', { html: '<p>one</p>', maxPlayers: 1 });
  const repo = projects.repository(project.id);
  // A README and a .gitignore, as a client's push brings them.
  const stream = new FastImport();
  const mark = stream.commit(
    'refs/heads/main',
    {
      author: { name: 'Tester', email: 't@example.org' },
      time: 1_800_000_000,
      message: 'Docs\n',
      from: project.branches.main,
    },
    [
      ['M', '100644', stream.blob(Buffer.from('# Kept\n')), 'README.md'],
      ['M', '100644', stream.blob(Buffer.from('node_modules\n')), '.gitignore'],
    ],
  );
  const pushed = stream.run(repo).get(mark)!;
  const docs = projects.read(project.id);
  assert.equal(docs.branches.main, pushed);
  assert.deepEqual(head(docs, 'main').game, { html: '<p>one</p>', maxPlayers: 1 });

  const staged = projects.submit(project.id, {
    branch: 'main',
    baseRevision: pushed,
    label: 'Two',
    operations: [{ op: 'writeGame', game: { html: '<p>two</p>', maxPlayers: 2 } }],
  });
  const ref = 'refs/zirbel/proposals/' + staged.proposal.id;
  const commit = resolve(repo, ref)!;
  assert.equal(
    git(repo, ['rev-parse', commit + '^'])
      .stdout.toString('utf8')
      .trim(),
    pushed,
  );
  assert.deepEqual(tree(repo, commit), ['.gitignore', '.zirbel/game.json', 'README.md', 'index.html']);
  assert.deepEqual(staged.preview, { game: { html: '<p>two</p>', maxPlayers: 2 }, assets: [] });
  const sibling = projects.submit(project.id, {
    branch: 'main',
    baseRevision: pushed,
    label: 'Three',
    operations: [{ op: 'writeGame', game: { html: '<p>three</p>' } }],
  });
  const forked = projects.submit(project.id, {
    branch: 'main',
    baseRevision: pushed,
    label: 'Four',
    operations: [{ op: 'writeGame', game: { html: '<p>four</p>' } }],
  });
  assert.throws(() => projects.commit(project.id, forked.proposal.id, 'main'), /already exists/);

  const applied = projects.commit(project.id, staged.proposal.id);
  assert.equal(applied.revision.id, commit, 'applying moves the branch to the proposal’s commit');
  assert.equal(resolve(repo, ref), undefined);
  assert.throws(() => projects.commit(project.id, sibling.proposal.id), /branch has changed/);
  // Its base gone, a proposal can neither go to a new branch; one discarded leaves no ref.
  assert.throws(() => projects.commit(project.id, forked.proposal.id, 'experiment'), /branch has changed/);
  projects.discard(project.id, sibling.proposal.id);
  assert.equal(resolve(repo, 'refs/zirbel/proposals/' + sibling.proposal.id), undefined);
  const next = projects.submit(project.id, {
    branch: 'main',
    baseRevision: commit,
    label: 'Five',
    operations: [{ op: 'writeGame', game: { html: '<p>five</p>' } }],
  });
  assert.equal(projects.commit(project.id, next.proposal.id, 'experiment').branch, 'experiment');
  assert.deepEqual(Object.keys(projects.read(project.id).branches), ['experiment', 'main']);
});

test('history lists every revision, the heads in full, and gives one in full by its id; restore commits the earlier tree', (t) => {
  const { projects, root } = install(t);
  const project = projects.createGame('History', { html: '<p>1</p>', maxPlayers: 1 });
  const first = project.branches.main!;
  const write = (html: string, base: string) =>
    projects.commit(
      project.id,
      projects.submit(project.id, {
        branch: 'main',
        baseRevision: base,
        label: html,
        operations: [{ op: 'writeGame', game: { html } }],
      }).proposal.id,
    ).revision.id;
  const second = write('<p>2</p>', first);
  const restored = head(
    projects.restore(project.id, 'main', second, first, { name: 'Bo', email: 'device.2@zirbel.invalid' }),
    'main',
  );
  assert.equal(restored.restoredFrom, first);
  assert.equal(restored.label, 'Restore Created with harness');
  assert.equal(restored.author, 'Bo');
  const repo = projects.repository(project.id);
  assert.equal(
    git(repo, ['rev-parse', restored.id + '^{tree}']).stdout.toString(),
    git(repo, ['rev-parse', first + '^{tree}']).stdout.toString(),
  );
  assert.match(
    git(repo, ['log', '-1', '--format=%B', restored.id]).stdout.toString(),
    /\n\nZirbel-Restored-From: [0-9a-f]{40}\n/,
  );

  const listed = new Projects(root).read(project.id);
  assert.deepEqual(
    listed.revisions.map(({ label }) => label),
    ['Created with harness', '<p>2</p>', 'Restore Created with harness'],
  );
  assert.deepEqual(
    listed.revisions.map((revision) => Object.hasOwn(revision, 'assets')),
    [false, false, true],
  );
  assert.deepEqual(projects.revision(project.id, second).game, { html: '<p>2</p>', maxPlayers: 1 });
  // A proposal's commit, or anything else, isn't a revision of the project.
  const staged = projects.submit(project.id, {
    branch: 'main',
    baseRevision: restored.id,
    label: 'x',
    operations: [{ op: 'writeGame', game: { html: '<p>x</p>' } }],
  });
  for (const id of [resolve(repo, 'refs/zirbel/proposals/' + staged.proposal.id)!, 'f'.repeat(40), 'nope'])
    assert.throws(() => projects.revision(project.id, id), /Revision does not exist/);
});

test('a tree a game can’t be is read as what it is, its problems said', () => {
  const entry = (path: string, mode = '100644', size = 1) => ({
    mode,
    type: mode === '160000' ? 'commit' : 'blob',
    oid: path.padEnd(40, '0'),
    size,
    path,
  });
  const read = (entries: ReturnType<typeof entry>[], bytes: Record<string, string | Buffer> = {}) =>
    readTree(entries, {
      bytes: (oids) =>
        new Map(
          entries
            .filter(
              ({ oid }) => oids.includes(oid) && bytes[entries.find((item) => item.oid === oid)!.path] !== undefined,
            )
            .map(({ oid, path }) => [oid, Buffer.from(bytes[path]!)]),
        ),
      sha256: (found) => new Map(found.map(({ oid }) => [oid, 'a'.repeat(64)])),
      assets: () => [],
    });
  assert.match(
    read([entry('index.html'), entry('link.js', '120000')]).problems[0]!,
    /links or submodules, which a game can’t: link\.js/,
  );
  assert.match(read([entry('index.html'), entry('lib', '160000')]).problems[0]!, /links or submodules/);
  assert.match(
    read(Array.from({ length: TREE_ENTRIES + 1 }, (_, index) => entry('f' + index + '.txt'))).problems[0]!,
    /more than 4000/,
  );
  assert.match(read([entry('index.html')], { 'index.html': Buffer.from([0xff, 0xfe]) }).problems[0]!, /UTF-8/);
  assert.match(read([entry('index.html')], { 'index.html': '  ' }).problems[0]!, /the game’s page/);
  assert.match(
    read([entry('index.html'), entry('.zirbel/game.json')], {
      'index.html': '<p>',
      '.zirbel/game.json': '{"maxPlayers":8}',
    }).problems[0]!,
    /more than 4 players to a game without net/,
  );
  assert.match(read([entry('.zirbel/scene.json')], { '.zirbel/scene.json': '{}' }).problems[0]!, /not a scene/);
  assert.match(
    read([entry('.zirbel/assets.json')], {
      '.zirbel/assets.json': JSON.stringify([
        {
          id: 'a',
          name: 'A',
          author: 'A',
          source: 'https://example.org/a',
          license: 'CC0-1.0',
          credit: '',
          hash: 'b'.repeat(64),
          media: 'image/png',
        },
      ]),
    }).problems[0]!,
    /bytes of these assets are missing: A/,
  );
  // What isn't the game's stays out of it; the game is index.html and its files.
  const game = read([entry('index.html'), entry('README.md'), entry('.github/ci.yml'), entry('src/main.js')], {
    'index.html': ' <p>x</p> ',
  });
  assert.deepEqual(game, {
    content: { game: { html: '<p>x</p>', maxPlayers: 1, files: { 'src/main.js': 'a'.repeat(64) } }, assets: [] },
    problems: [],
  });
});

test('version-1 projects become repositories once, to the same commits, with the old files kept aside', (t) => {
  const { root } = install(t);
  const { fixtures, game, proposal } = versionOneData(root);
  const projects = new Projects(root);
  assert.equal(projects.migrate(), 4);
  assert.equal(projects.migrate(), 0, 'a version-2 project stays as it is');
  for (const id of [...fixtures, game.id]) {
    assert.ok(existsSync(join(root, 'migrated-projects', id + '.json')));
    assert.equal(JSON.parse(readFileSync(join(root, 'projects', id + '.json'), 'utf8')).version, 2);
  }
  const migrated = projects.read(game.id);
  assert.deepEqual(
    migrated.revisions.map(({ label, date, author }) => [label, date, author]),
    game.revisions.map(({ label, date }) => [label, date, 'Zirbel']),
  );
  const [created, written, restored, variant] = migrated.revisions;
  assert.deepEqual(migrated.branches, { main: restored!.id, variant: variant!.id });
  assert.equal(restored!.restoredFrom, created!.id);
  assert.equal(written!.parent, created!.id);
  assert.equal(variant!.parent, written!.id);
  assert.deepEqual(projects.revision(game.id, written!.id).game, game.revisions[1]!.game);
  assert.deepEqual(head(migrated, 'variant').game, game.revisions[3]!.game);
  const repo = projects.repository(game.id);
  assert.match(
    git(repo, ['log', '-1', '--format=%B', written!.id]).stdout.toString(),
    /Zirbel-Revision: 00000000-0000-4000-8000-000000000002/,
  );
  // The pending proposal waits on its base's commit.
  const [pending] = projects.proposals(game.id, 'main');
  assert.equal(pending?.id, proposal.id);
  assert.equal(pending?.baseRevision, restored!.id);
  assert.deepEqual(projects.preview(game.id, proposal.id).preview.game, { html: '<p>pending</p>', maxPlayers: 1 });
  // A note's reference names its revision's commit.
  const fen = projects.read(fixtures[0]!);
  assert.equal(fen.notes[0]!.references[0]!.revision, fen.branches.main);
  assert.equal(head(fen, 'main').scene?.id, fen.notes[0]!.references[0]!.sceneId);

  // A migration that ended before its last step runs again to the very same commits.
  copyFileSync(join(root, 'migrated-projects', game.id + '.json'), join(root, 'projects', game.id + '.json'));
  const again = new Projects(root);
  assert.equal(again.migrate(), 1);
  assert.deepEqual(again.read(game.id).branches, migrated.branches);
  assert.equal(again.proposals(game.id, 'main')[0]?.baseRevision, restored!.id);
});

test('a bundle imports as commits and exports back, every revision in full', (t) => {
  const { projects } = install(t);
  const bundle = JSON.parse(
    readFileSync(new URL('fixtures/hollow-crown.zirbel-project.json', import.meta.url), 'utf8'),
  );
  const imported = projects.import(bundle, { name: 'Importer', email: 'owner@zirbel.invalid' });
  const revision = head(imported, 'main');
  assert.match(revision.id, /^[0-9a-f]{40}$/);
  assert.equal(revision.author, 'Importer');
  assert.deepEqual(revision.scene, bundle.project.revisions[0].scene);
  const exported = projects.export(imported.id);
  assert.deepEqual(
    exported.project.revisions.map(({ id }) => id),
    [revision.id],
  );
  assert.equal(exported.project.revisions[0]!.author, 'Importer');
  const copy = projects.import(exported);
  assert.deepEqual(head(copy, 'main').scene, revision.scene);
  assert.equal(head(copy, 'main').author, 'Importer', 'a bundle keeps who made each revision');
  // The proposal ref namespace and the source stay the host's: a bundle carries neither.
  assert.equal(Object.hasOwn(exported.project, 'source'), false);
  const blobs = readObjects(projects.repository(copy.id), [head(copy, 'main').id + ':.zirbel/scene.json']);
  assert.deepEqual(JSON.parse([...blobs.values()][0]!.toString('utf8')), revision.scene);
});

// Two histories a version-1 file can hold: a branch forked from an early revision after a restore (the import ref then
// moves to a commit that isn't a descendant), and a restore of a revision the file doesn't have (a damaged file).
test('a migration writes a fork after a restore, and a restore of a missing revision without its trailer', (t) => {
  const { root } = install(t);
  const id = '00000000-0000-4000-8000-0000000000aa';
  const r = (n: number) => '00000000-0000-4000-8000-00000000000' + n;
  const revision = (n: number, parent: number | null, label: string, extra: object = {}) => ({
    id: r(n),
    parent: parent === null ? null : r(parent),
    label,
    date: '2026-01-01T1' + n + ':00:00.000Z',
    assets: [],
    ...extra,
  });
  writeFileSync(
    join(root, 'projects', id + '.json'),
    JSON.stringify({
      version: 1,
      id,
      title: 'Old game',
      branches: { main: r(3), variant: r(4), damaged: r(5) },
      notes: [],
      attachments: [],
      revisions: [
        revision(1, null, 'Created project'),
        revision(2, 1, 'Write the game', { game: { html: '<p>1</p>', maxPlayers: 3 } }),
        revision(3, 2, 'Restore Created project', { restoredFrom: r(1) }),
        revision(4, 1, 'Try a variant', { game: { html: '<p>variant</p>' } }),
        revision(5, 4, 'Restore a lost one', {
          restoredFrom: '00000000-0000-4000-8000-0000000000ff',
          game: { html: '<p>5</p>' },
        }),
      ],
    }),
  );
  const projects = new Projects(root);
  assert.equal(projects.migrate(), 1);
  const migrated = projects.read(id);
  assert.deepEqual(Object.keys(migrated.branches).sort(), ['damaged', 'main', 'variant']);
  const repo = projects.repository(id);
  assert.match(
    git(repo, ['log', '-1', '--format=%B', 'main']).stdout.toString('utf8'),
    /Zirbel-Restored-From: [0-9a-f]{40}/,
  );
  assert.doesNotMatch(
    git(repo, ['log', '-1', '--format=%B', 'damaged']).stdout.toString('utf8'),
    /Zirbel-Restored-From/,
  );
  assert.equal(head(migrated, 'variant').game?.html, '<p>variant</p>');
});
