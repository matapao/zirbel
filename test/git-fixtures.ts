// Fixtures for the git store's tests: the git program run as a client would, a game's source as a local bare repository
// (fetched over file://, never the network), and a data folder kept the way Zirbel kept projects before git.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../packages/core/bytes.ts';

/** git as a client runs it, with none of this computer's settings, as a person named Tester. */
export function client(cwd: string, env: Record<string, string> = {}) {
  const run = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tester',
        '-c',
        'user.email=tester@example.org',
        '-c',
        'init.defaultBranch=main',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: devNull,
          GIT_TERMINAL_PROMPT: '0',
          ...env,
        },
      },
    );
  /** What a refused command said on stderr. */
  const refused = (...args: string[]) => {
    try {
      run(...args);
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? error);
    }
    throw new Error('git ' + args.join(' ') + ' should have failed');
  };
  return { run, refused };
}

/** Writes files into a folder, making the folders they need; null removes one. */
export function writeFiles(folder: string, files: Record<string, string | null>) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(folder, path);
    if (text === null) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** A game's source elsewhere: a bare repository with a working copy that commits to it, fetched by its file:// URL. */
export function sourceRepository(root: string, files: Record<string, string>) {
  const bare = join(root, 'source', 'game.git');
  const work = join(root, 'source-work');
  mkdirSync(work, { recursive: true });
  client(root).run('init', '--bare', '--quiet', bare);
  const git = client(work);
  git.run('init', '--quiet', '-b', 'main');
  git.run('remote', 'add', 'origin', bare);
  const commit = (changes: Record<string, string | null>, message: string) => {
    writeFiles(work, changes);
    git.run('add', '-A');
    git.run('commit', '--quiet', '-m', message);
    git.run('push', '--quiet', 'origin', 'main');
    return git.run('rev-parse', 'HEAD').trim();
  };
  const first = commit(files, 'The game');
  return { url: pathToFileURL(bare).href, first, commit };
}

/** A data folder as Zirbel kept it before git: version-1 project files with every revision in full, the game files
 *  and assets by their hashes, a pending proposal. The three fixture projects, and a game with history. */
export function versionOneData(data: string) {
  for (const name of ['projects', 'assets', 'proposals']) mkdirSync(join(data, name), { recursive: true, mode: 0o700 });
  const store = (bytes: Buffer) => {
    const hash = digest(bytes);
    writeFileSync(join(data, 'assets', hash), bytes);
    return hash;
  };
  const fixtures = ['firefly-fen', 'hollow-crown', 'moon-tiles'].map((name) => {
    const bundle = JSON.parse(
      readFileSync(new URL('fixtures/' + name + '.zirbel-project.json', import.meta.url), 'utf8'),
    ) as { project: { id: string; revisions: { id: string; scene: { id: string } }[] } };
    return bundle.project;
  });
  // A note on the first fixture marks a region of its scene, in the revision it was made on.
  const fen = fixtures[0]!;
  const noted = {
    ...fen,
    notes: [
      {
        id: 'note-1',
        text: 'Here',
        date: '2026-01-02T00:00:00.000Z',
        branch: 'main',
        attachments: [],
        references: [
          {
            type: 'region',
            sceneId: fen.revisions[0]!.scene.id,
            revision: fen.revisions[0]!.id,
            bounds: { x: 0, y: 0, width: 10, height: 10 },
            objects: [],
          },
        ],
      },
    ],
  };
  for (const project of [noted, ...fixtures.slice(1)])
    writeFileSync(join(data, 'projects', project.id + '.json'), JSON.stringify(project));

  const script = store(Buffer.from('document.title = "v2"'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const asset = {
    id: 'dot',
    name: 'Dot',
    author: 'Me',
    source: 'https://example.org/dot.png',
    license: 'CC0-1.0',
    credit: '',
    hash: store(png),
    media: 'image/png',
  };
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
  ];
  const game = {
    version: 1,
    id: '00000000-0000-4000-8000-0000000000aa',
    title: 'Old game',
    branches: { main: ids[2], variant: ids[3] },
    revisions: [
      { id: ids[0], parent: null, label: 'Created project', date: '2026-01-01T10:00:00.000Z', assets: [] },
      {
        id: ids[1],
        parent: ids[0],
        label: 'Write the game',
        date: '2026-01-01T11:00:00.000Z',
        assets: [asset],
        game: { html: '<script src="main.js"></script>', maxPlayers: 3, files: { 'main.js': script } },
      },
      {
        id: ids[2],
        parent: ids[1],
        restoredFrom: ids[0],
        label: 'Restore Created project',
        date: '2026-01-01T12:00:00.000Z',
        assets: [],
      },
      {
        id: ids[3],
        parent: ids[1],
        label: 'Try a variant',
        date: '2026-01-01T13:00:00.000Z',
        assets: [asset],
        game: { html: '<p>variant</p>', maxPlayers: 1, registerObjects: false },
      },
    ],
    notes: [],
    attachments: [],
  };
  writeFileSync(join(data, 'projects', game.id + '.json'), JSON.stringify(game));
  const proposal = {
    id: '00000000-0000-4000-8000-0000000000bb',
    projectId: game.id,
    date: '2026-01-01T14:00:00.000Z',
    branch: 'main',
    baseRevision: ids[2],
    label: 'Pending',
    operations: [{ op: 'writeGame', game: { html: '<p>pending</p>' } }],
  };
  writeFileSync(join(data, 'proposals', game.id + '.' + proposal.id + '.json'), JSON.stringify(proposal));
  return { fixtures: fixtures.map(({ id }) => id), game, proposal };
}
