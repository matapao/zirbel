// Git as the revision engine, on both hosts (AGENTS.md: The git store): the editor's saves are commits a clone sees, a push of
// a game becomes its head and anything else is refused before the branch moves, a game imports from a git URL and
// updates from its source (a fast-forward, a merge, a conflict reported), and the version-1 projects of a data folder
// become repositories at start-up. Each host is held to the same answers; where both run, they must write the same
// trees and migrate to the same commits. A box's roles and tokens over git are in git-box.contract.test.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { client, sourceRepository, versionOneData, writeFiles } from './git-fixtures.ts';
import { hostsUnderTest, launch, stopHost, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();
const base64 = (text: string) => Buffer.from(text).toString('base64');
type Revision = {
  id: string;
  parent: string | null;
  restoredFrom?: string;
  label: string;
  date: string;
  author: string;
  game?: { html: string; maxPlayers: number; net?: true; files?: Record<string, string> };
  assets?: unknown[];
};
type Project = {
  id: string;
  title: string;
  branches: Record<string, string>;
  revisions: Revision[];
  source?: { url: string; ref?: string };
};

async function startEditor(t: TestContext, command: string[], data: string, env?: Record<string, string>) {
  const { child, ready } = launch(
    t,
    command,
    ['--data', data, '--port', '0'],
    (line) => (typeof line.editor === 'string' ? line.editor : undefined),
    env,
  );
  const editor = await ready;
  const call = async (method: string, path: string, payload?: unknown) => {
    const response = await fetch(editor + path, {
      method,
      headers: { origin: editor, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      body: payload === undefined ? null : JSON.stringify(payload),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, body };
  };
  const ok = async <T>(method: string, path: string, payload?: unknown, status = method === 'GET' ? 200 : 201) => {
    const answer = await call(method, path, payload);
    assert.equal(answer.status, status, method + ' ' + path + ': ' + JSON.stringify(answer.body));
    return answer.body as T;
  };
  return { editor, call, ok, stop: () => stopHost(child) };
}
type Editor = Awaited<ReturnType<typeof startEditor>>;
const headOf = (project: Project, branch = 'main') =>
  project.revisions.find(({ id }) => id === project.branches[branch])!;

/** The editor's saves, as commits a clone sees: ids, authors, Zirbel committing, the restore's trailer, the files. */
async function savesAreCommits({ ok, call }: Editor, work: string) {
  const created = await ok<Project>('POST', '/api/projects', { title: 'Commits' });
  const write = async (base: string, game: object, label: string) => {
    const { proposal } = await ok<{ proposal: { id: string } }>('POST', '/api/projects/' + created.id + '/proposals', {
      baseRevision: base,
      branch: 'main',
      label,
      operations: [{ op: 'writeGame', game }],
    });
    return (await ok<{ revision: Revision }>('POST', '/api/projects/' + created.id + '/apply/' + proposal.id, {}, 200))
      .revision;
  };
  const first = await write(created.branches.main!, { html: '<p>one</p>', maxPlayers: 2 }, 'One');
  assert.match(first.id, /^[0-9a-f]{40}$/);
  assert.deepEqual(first, {
    id: first.id,
    parent: created.branches.main,
    label: 'One',
    date: first.date,
    author: 'Owner',
    game: { html: '<p>one</p>', maxPlayers: 2 },
    assets: [],
  });
  const second = await write(first.id, { html: '<p>two</p>' }, 'Two');
  const restored = await ok<Project>(
    'POST',
    '/api/projects/' + created.id + '/restore',
    { branch: 'main', baseRevision: second.id, target: first.id },
    200,
  );
  const now = headOf(restored);
  assert.deepEqual(
    [now.label, now.restoredFrom, now.parent, now.game],
    ['Restore One', first.id, second.id, first.game],
  );
  // History: every revision listed, the head alone with its content; one revision in full by its id.
  assert.deepEqual(
    restored.revisions.map(({ label }) => label),
    ['Created project', 'One', 'Two', 'Restore One'],
  );
  assert.deepEqual(
    restored.revisions.map((revision) => 'assets' in revision),
    [false, false, false, true],
  );
  assert.deepEqual((await ok<Revision>('GET', '/api/projects/' + created.id + '/revisions/' + second.id)).game, {
    html: '<p>two</p>',
    maxPlayers: 1,
  });
  assert.equal((await call('GET', '/api/projects/' + created.id + '/revisions/' + 'f'.repeat(40))).status, 404);
  // A proposal waiting stays the host's: a clone sees the branches alone.
  await ok('POST', '/api/projects/' + created.id + '/proposals', {
    baseRevision: now.id,
    branch: 'main',
    label: 'Waiting',
    operations: [{ op: 'writeGame', game: { html: '<p>wait</p>' } }],
  });

  const clone = await ok<{ url: string; command: string; token?: string }>(
    'GET',
    '/api/projects/' + created.id + '/clone',
  );
  assert.match(clone.url, new RegExp('^http://127\\.0\\.0\\.1:\\d+/git/' + created.id + '\\.git$'));
  assert.deepEqual(clone, { url: clone.url, command: 'git clone ' + clone.url });
  const git = client(work);
  assert.deepEqual(
    git
      .run('ls-remote', clone.url)
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[1]),
    ['HEAD', 'refs/heads/main'],
  );
  git.run('clone', '--quiet', clone.url, 'commits');
  const copy = client(join(work, 'commits'));
  assert.deepEqual(
    copy.run('log', '--format=%H|%P|%an|%ae|%cn|%ce|%s', 'main').trim().split('\n'),
    [...restored.revisions]
      .reverse()
      .map(({ id, parent, label }) =>
        [id, parent ?? '', 'Owner', 'owner@zirbel.invalid', 'Zirbel', 'zirbel@zirbel.invalid', label].join('|'),
      ),
  );
  assert.match(
    copy.run('log', '-1', '--format=%B'),
    new RegExp('^Restore One\\n\\nZirbel-Restored-From: ' + first.id + '\\n'),
  );
  assert.deepEqual(copy.run('ls-files').trim().split('\n'), ['.zirbel/game.json', 'index.html']);
  assert.equal(readFileSync(join(work, 'commits', 'index.html'), 'utf8'), '<p>one</p>');
  assert.equal(readFileSync(join(work, 'commits', '.zirbel', 'game.json'), 'utf8'), '{\n  "maxPlayers": 2\n}\n');

  // A built folder: its files at the top, as they were imported.
  const folder = {
    'index.html': '<script type="module" src="./net/adapter.mjs"></script>',
    'net/adapter.mjs': 'export {}',
    'zirbel.json': JSON.stringify({ players: { max: 6 }, multiplayer: { adapter: 'net/adapter.mjs' } }),
    'models/hero.glb': 'glTF',
  };
  const built = await ok<Project>('POST', '/api/projects/import-game', {
    title: 'Built',
    files: Object.fromEntries(Object.entries(folder).map(([path, text]) => [path, base64(text)])),
  });
  assert.deepEqual(
    { ...headOf(built).game, files: undefined },
    { html: folder['index.html'], maxPlayers: 6, net: true, adapter: 'net/adapter.mjs', files: undefined },
  );
  git.run('clone', '--quiet', clone.url.replace(created.id, built.id), 'built');
  const files = client(join(work, 'built')).run('ls-files').trim().split('\n');
  assert.deepEqual(files, Object.keys(folder).sort());
  for (const [path, text] of Object.entries(folder))
    assert.equal(readFileSync(join(work, 'built', path), 'utf8'), text, path);
  return [
    client(join(work, 'commits')).run('rev-parse', 'HEAD^{tree}').trim(),
    client(join(work, 'built')).run('rev-parse', 'HEAD^{tree}').trim(),
  ];
}

/** A push of a game becomes the head; anything else is refused before the branch moves. */
async function pushes({ ok, call }: Editor, work: string) {
  const created = await ok<Project>('POST', '/api/projects', { title: 'Pushes' });
  const { url } = await ok<{ url: string }>('GET', '/api/projects/' + created.id + '/clone');
  client(work).run('clone', '--quiet', url, 'pushes');
  const folder = join(work, 'pushes');
  const git = client(folder);
  const commit = (files: Record<string, string | null>, message: string) => {
    writeFiles(folder, files);
    git.run('add', '-A');
    git.run('commit', '--quiet', '-m', message);
    return git.run('rev-parse', 'HEAD').trim();
  };
  const pushed = commit({ 'index.html': '<p>pushed</p>', 'README.md': '# Mine', 'js/game.js': 'x' }, 'From a clone');
  git.run('push', '--quiet', 'origin', 'main');
  const project = await ok<Project>('GET', '/api/projects/' + created.id);
  const now = headOf(project);
  assert.equal(project.branches.main, pushed);
  assert.deepEqual(
    [now.label, now.author, now.parent, now.game?.html, Object.keys(now.game?.files ?? {})],
    ['From a clone', 'Tester', created.branches.main, '<p>pushed</p>', ['js/game.js']],
  );
  // A new branch, pushed, is the game's too.
  git.run('push', '--quiet', 'origin', 'HEAD:experiment');
  assert.equal((await ok<Project>('GET', '/api/projects/' + created.id)).branches.experiment, pushed);

  const refuse = async (args: string[], reason: RegExp) => {
    const said = git.refused('push', ...args);
    assert.match(said, reason, args.join(' '));
    const after = await ok<Project>('GET', '/api/projects/' + created.id);
    assert.deepEqual(after.branches, { experiment: pushed, main: pushed }, 'nothing moved: ' + args.join(' '));
  };
  commit({ 'index.html': null, 'other.html': '<p>no</p>' }, 'No page');
  await refuse(['origin', 'main'], /there is no index\.html at its top/);
  git.run('reset', '--quiet', '--hard', pushed);
  symlinkSync('index.html', join(folder, 'linked.html'));
  commit({}, 'A link');
  await refuse(['origin', 'main'], /links or submodules, which a game can’t: linked\.html/);
  git.run('reset', '--quiet', '--hard', pushed);
  commit({ '.zirbel/game.json': '{"maxPlayers":9}' }, 'Too many');
  await refuse(['origin', 'main'], /more than 4 players to a game without net/);
  git.run('reset', '--quiet', '--hard', created.branches.main!);
  commit({ 'index.html': '<p>rewritten</p>' }, 'Rewrite');
  await refuse(['--force', 'origin', 'main'], /moved on|non-fast-forward/);
  git.run('reset', '--quiet', '--hard', pushed);
  await refuse(['origin', ':experiment'], /delet/);
  await refuse(['origin', 'HEAD:Bad_Name'], /branches alone/);
  git.run('tag', 'v1');
  await refuse(['origin', 'v1'], /branches alone/);
  await refuse(['origin', 'HEAD:refs/zirbel/proposals/x'], /hidden|branches alone|deny updating a hidden ref/);
  // Smart HTTP alone: the dumb protocol's files aren't served.
  assert.equal((await call('GET', '/git/' + created.id + '.git/HEAD')).status, 404);
  assert.equal((await call('GET', '/git/' + created.id + '.git/info/refs')).status, 404);
  assert.equal((await call('GET', '/git/no-such-game.git/info/refs?service=git-upload-pack')).status, 404);
}

/** A game from a git URL, its source's history its own; updates fetch it again and bring it under the game's commits. */
async function sources({ ok, call }: Editor, work: string) {
  const source = sourceRepository(work, {
    'index.html': '<script src="a.js"></script>',
    'a.js': 'a1',
    'b.js': 'b1',
    'README.md': '# Source',
  });
  const imported = await ok<Project>('POST', '/api/projects/import-git', { url: source.url });
  assert.deepEqual(
    [imported.title, imported.source, imported.branches],
    ['game', { url: source.url }, { main: source.first }],
  );
  assert.deepEqual(
    imported.revisions.map(({ label, author }) => [label, author]),
    [['The game', 'Tester']],
  );
  assert.deepEqual(Object.keys(headOf(imported).game!.files!), ['a.js', 'b.js']);
  for (const [input, status] of [
    [{ url: 'http://example.org/x.git' }, 400],
    [{ url: 'https://user:secret@example.org/x.git' }, 400],
    [{ url: 'ftp://example.org/x.git' }, 400],
    [{ url: source.url, ref: '../main' }, 400],
    [{ url: source.url, ref: 'no-such-branch' }, 502],
    [{ url: source.url.replace('game.git', 'missing.git') }, 502],
  ] as const)
    assert.equal((await call('POST', '/api/projects/import-git', input)).status, status, JSON.stringify(input));
  const empty = sourceRepository(join(work, 'empty'), { 'README.md': 'Nothing to play' });
  const refused = await call('POST', '/api/projects/import-git', { url: empty.url });
  assert.deepEqual(
    [refused.status, (refused.body as { error: string }).error],
    [422, 'This repository isn’t a game Zirbel can keep. There is no index.html at its top: a game needs one.'],
  );

  const path = '/api/projects/' + imported.id;
  const update = (baseRevision: string) => call('POST', path + '/update-from-source', { baseRevision });
  const current = async () => (await ok<Project>('GET', path)).branches.main!;
  assert.deepEqual((await update(source.first)).body, { updated: false, project: await ok<Project>('GET', path) });
  assert.equal((await update('f'.repeat(40))).status, 409);
  // The source moved on and the game didn't: a fast-forward.
  const second = source.commit({ 'a.js': 'a2' }, 'Faster');
  const forward = (await update(source.first)).body as { updated: boolean; project: Project };
  assert.deepEqual([forward.updated, forward.project.branches.main], [true, second]);
  // The host's own commit (its multiplayer, which the source never has), then the source's: a merge, the host's first.
  const clone = await ok<{ url: string }>('GET', path + '/clone');
  client(work).run('clone', '--quiet', clone.url, 'hosted');
  const hosted = client(join(work, 'hosted'));
  writeFiles(join(work, 'hosted'), { 'zirbel.json': JSON.stringify({ players: { max: 4 } }) });
  hosted.run('add', '-A');
  hosted.run('commit', '--quiet', '-m', 'Multiplayer');
  hosted.run('push', '--quiet', 'origin', 'main');
  const own = hosted.run('rev-parse', 'HEAD').trim();
  const third = source.commit({ 'b.js': 'b2' }, 'Better');
  const merged = (await update(own)).body as { updated: boolean; project: Project };
  const top = headOf(merged.project);
  assert.deepEqual(
    [
      merged.updated,
      top.label,
      top.author,
      top.parent,
      top.game?.net,
      top.game?.maxPlayers,
      Object.keys(top.game!.files!),
    ],
    [true, 'Update from source', 'Owner', own, true, 4, ['a.js', 'b.js', 'zirbel.json']],
  );
  hosted.run('pull', '--quiet', '--ff-only');
  assert.equal(hosted.run('log', '-1', '--format=%P').trim(), own + ' ' + third);
  assert.equal(readFileSync(join(work, 'hosted', 'b.js'), 'utf8'), 'b2');
  // Both changed the page: the conflict is said, and nothing moves.
  writeFiles(join(work, 'hosted'), { 'index.html': '<p>host</p><script src="a.js"></script>' });
  hosted.run('commit', '--quiet', '-am', 'Host page');
  hosted.run('push', '--quiet', 'origin', 'main');
  const page = hosted.run('rev-parse', 'HEAD').trim();
  source.commit({ 'index.html': '<p>source</p><script src="a.js"></script>' }, 'Source page');
  const conflict = await update(page);
  assert.equal(conflict.status, 409);
  assert.match((conflict.body as { error: string }).error, /conflict with this game’s in: index\.html\./);
  assert.equal(await current(), page);
  // A game with no source has nothing to update from.
  const plain = await ok<Project>('POST', '/api/projects', { title: 'Plain' });
  assert.equal(
    (await call('POST', '/api/projects/' + plain.id + '/update-from-source', { baseRevision: plain.branches.main }))
      .status,
    404,
  );
}

/** The version-1 projects of a data folder, repositories from the start, once. */
async function migration(t: TestContext, command: string[], root: string) {
  const data = join(root, 'data');
  const { fixtures, game, proposal } = versionOneData(data);
  const first = await startEditor(t, command, data);
  const summaries = await first.ok<{ id: string }[]>('GET', '/api/projects');
  assert.deepEqual(summaries.map(({ id }) => id).sort(), [...fixtures, game.id].sort());
  const migrated = await first.ok<Project>('GET', '/api/projects/' + game.id);
  assert.deepEqual(
    migrated.revisions.map(({ label, date, author }) => [label, date, author]),
    game.revisions.map(({ label, date }) => [label, date, 'Zirbel']),
  );
  const [created, written, restored, variant] = migrated.revisions;
  assert.deepEqual(migrated.branches, { main: restored!.id, variant: variant!.id });
  assert.deepEqual([restored!.restoredFrom, written!.parent, variant!.parent], [created!.id, created!.id, written!.id]);
  assert.deepEqual(headOf(migrated, 'variant').game, game.revisions[3]!.game);
  assert.deepEqual(
    (await first.ok<Revision>('GET', '/api/projects/' + game.id + '/revisions/' + written!.id)).game,
    game.revisions[1]!.game,
  );
  const pending = await first.ok<{ id: string; baseRevision: string }[]>(
    'GET',
    '/api/projects/' + game.id + '/proposals?branch=main',
  );
  assert.deepEqual(
    pending.map(({ id, baseRevision }) => [id, baseRevision]),
    [[proposal.id, restored!.id]],
  );
  for (const id of [...fixtures, game.id]) {
    assert.ok(existsSync(join(data, 'migrated-projects', id + '.json')), id);
    assert.ok(existsSync(join(data, 'git', id + '.git', 'HEAD')), id);
  }
  const heads: Record<string, Record<string, string>> = {};
  for (const id of [...fixtures, game.id]) heads[id] = (await first.ok<Project>('GET', '/api/projects/' + id)).branches;
  await first.stop();
  const again = await startEditor(t, command, data);
  for (const id of [...fixtures, game.id])
    assert.deepEqual((await again.ok<Project>('GET', '/api/projects/' + id)).branches, heads[id]);
  await again.stop();
  return heads;
}

// Each host's run is a step of one test, and the comparison its last: steps keep their order, whatever order
// --test-randomize gives the file's tests.
test('every editor keeps its saves as commits, which a clone sees, and both write the same trees', async (t) => {
  const trees = new Map<string, string[]>();
  for (const host of hosts) {
    await t.test(host.name + ' editor saves become commits, which a clone sees', async (t) => {
      const root = tempDir(t, 'zirbel-git-');
      const editor = await startEditor(t, host.command, join(root, 'data'));
      trees.set(host.name, await savesAreCommits(editor, root));
    });
  }
  if (hosts.length > 1)
    await t.test('both hosts write the same trees for the same games', () =>
      assert.deepEqual(trees.get('go'), trees.get('node')),
    );
});

test('every host migrates the version-1 projects of its data folder at start-up, both to the same commits', async (t) => {
  const migrations = new Map<string, Record<string, Record<string, string>>>();
  for (const host of hosts) {
    await t.test(host.name + ' migrates the version-1 projects of its data folder at start-up', async (t) => {
      migrations.set(host.name, await migration(t, host.command, tempDir(t, 'zirbel-git-')));
    });
  }
  if (hosts.length > 1) {
    await t.test('both hosts migrate a data folder to the same commits', () =>
      assert.deepEqual(migrations.get('go'), migrations.get('node')),
    );
  }
});

for (const host of hosts) {
  test(host.name + ' takes a push of a game as its head and refuses anything else', async (t) => {
    const root = tempDir(t, 'zirbel-git-');
    await pushes(await startEditor(t, host.command, join(root, 'data')), root);
  });
  test(host.name + ' imports a game from a git URL and updates it from its source', async (t) => {
    const root = tempDir(t, 'zirbel-git-');
    await sources(await startEditor(t, host.command, join(root, 'data'), { ZIRBEL_GIT_ALLOW_LOCAL: '1' }), root);
    // Without the tests' switch, only https.
    const strict = await startEditor(t, host.command, join(root, 'strict'));
    mkdirSync(join(root, 'other'));
    const local = sourceRepository(join(root, 'other'), { 'index.html': '<p>local</p>' });
    assert.equal((await strict.call('POST', '/api/projects/import-git', { url: local.url })).status, 400);
  });
  test(host.name + ' editor refuses to start without git, and says so', async (t) => {
    const root = tempDir(t, 'zirbel-git-');
    mkdirSync(join(root, 'bin'));
    const { ready } = launch(t, host.command, ['--data', join(root, 'data'), '--port', '0'], (line) => line.editor, {
      PATH: join(root, 'bin'),
    });
    await assert.rejects(
      ready,
      /exited with 1: .*Zirbel needs git 2\.38 or later to keep its games' history \(found no git\)\. Install git and start Zirbel again\./s,
    );
  });
}
