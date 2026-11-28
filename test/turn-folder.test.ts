// A thread's folder at a turn's start and its game/ read back: game/ written afresh from the revision, node_modules
// linking three.js, TypeScript and esbuild where the editor has them, the harness's own files left alone, and game/
// read back as an imported folder is, refusing links out, bad paths and more than a game holds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { GAME_BYTES, prepareFolder, readGameFolder } from '../packages/server/turn-folder.ts';
import { turnTools } from '../packages/server/turn-tools.ts';
import { install, tempDir } from './helpers.ts';

const WEB = resolve('dist/web');

test('each turn starts with game/ from the revision and node_modules linking the editor’s packages', (t) => {
  const { projects } = install(t);
  const folder = tempDir(t, 'zirbel-turn-');
  const tools = turnTools(WEB);
  const read = (hash: string) => projects.readAsset(hash);
  // A new project: game/ is empty.
  prepareFolder(folder, undefined, read, tools.links);
  assert.equal(lstatSync(join(folder, 'game')).isDirectory(), true);
  assert.equal(existsSync(join(folder, 'game', 'index.html')), false);
  // The harness's own files stay; what it left in game/ goes when the next turn starts.
  writeFileSync(join(folder, 'notes.md'), 'mine');
  writeFileSync(join(folder, 'game', 'stray.js'), 'old');
  const files = { 'src/main.js': projects.storeAsset(Buffer.from('export const x = 1;')) };
  prepareFolder(
    folder,
    { html: '<script type="module" src="./src/main.js"></script>', maxPlayers: 1, files },
    read,
    tools.links,
  );
  assert.equal(
    readFileSync(join(folder, 'game', 'index.html'), 'utf8'),
    '<script type="module" src="./src/main.js"></script>',
  );
  assert.equal(readFileSync(join(folder, 'game', 'src', 'main.js'), 'utf8'), 'export const x = 1;');
  assert.equal(existsSync(join(folder, 'game', 'stray.js')), false);
  assert.equal(readFileSync(join(folder, 'notes.md'), 'utf8'), 'mine');
  // A game/ the harness made a link is replaced, and what it led to is left as it was.
  const outside = tempDir(t, 'zirbel-outside-');
  writeFileSync(join(outside, 'keep.txt'), 'kept');
  const game = join(folder, 'game');
  execFileSync('rm', ['-rf', game]);
  symlinkSync(outside, game);
  prepareFolder(folder, { html: '<p>one</p>', maxPlayers: 1 }, read, tools.links);
  assert.equal(lstatSync(game).isDirectory(), true);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'kept');

  // node_modules: three.js from this build, TypeScript and esbuild as installed, each linked by its real folder.
  assert.deepEqual(
    tools.links.map(({ name }) => name),
    ['three', 'typescript', 'esbuild'],
  );
  assert.equal(readlinkSync(join(folder, 'node_modules', 'three')), realpathSync(join(WEB, 'three')));
  for (const { name, target } of tools.links) {
    assert.equal(readlinkSync(join(folder, 'node_modules', name)), target);
    assert.ok(
      tools.readable.some((place) => target === place || target.startsWith(place + '/')),
      name + ' is readable',
    );
  }
  // A package of the harness's own stays; one it put where a link goes is replaced by the link.
  mkdirSync(join(folder, 'node_modules', 'mine'));
  execFileSync('rm', [join(folder, 'node_modules', 'three')]);
  mkdirSync(join(folder, 'node_modules', 'three'));
  prepareFolder(folder, undefined, read, tools.links);
  assert.equal(lstatSync(join(folder, 'node_modules', 'three')).isSymbolicLink(), true);
  assert.equal(existsSync(join(folder, 'node_modules', 'mine')), true);
});

test('from the turn’s folder, three resolves, and TypeScript compiles and esbuild bundles, with no package.json there', (t) => {
  const folder = tempDir(t, 'zirbel-turn-');
  const tools = turnTools(WEB);
  prepareFolder(folder, undefined, () => Buffer.alloc(0), tools.links);
  mkdirSync(join(folder, 'src'));
  writeFileSync(
    join(folder, 'src', 'main.ts'),
    'const count: number = 41;\nexport const next = (): number => count + 1;\n',
  );
  const node = (...args: string[]) => execFileSync(process.execPath, args, { cwd: folder, encoding: 'utf8' });
  assert.match(node('node_modules/typescript/bin/tsc', '--version'), /Version 7\.0\.2/);
  node(
    'node_modules/typescript/bin/tsc',
    '--target',
    'es2022',
    '--module',
    'es2022',
    '--outDir',
    'game',
    'src/main.ts',
  );
  assert.match(readFileSync(join(folder, 'game', 'main.js'), 'utf8'), /export const next = \(\) => count \+ 1/);
  assert.equal(node('node_modules/esbuild/bin/esbuild', '--version').trim(), '0.28.2');
  writeFileSync(
    join(folder, 'src', 'scene.js'),
    "import { Vector3 } from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nconsole.log(new Vector3(1, 2, 2).length(), typeof OrbitControls);\n",
  );
  node(
    'node_modules/esbuild/bin/esbuild',
    'src/scene.js',
    '--bundle',
    '--format=esm',
    '--outfile=game/scene.js',
    '--log-level=error',
  );
  const bundled = readFileSync(join(folder, 'game', 'scene.js'), 'utf8');
  assert.match(bundled, /OrbitControls/);
  assert.equal(
    execFileSync(process.execPath, [join(folder, 'game', 'scene.js')], { encoding: 'utf8' }).trim(),
    '3 function',
  );
  assert.equal(existsSync(join(folder, 'package.json')), false);
});

test('game/ reads back as an imported folder does, refusing links out, bad paths and more than a game holds', (t) => {
  const folderOf = (files: Record<string, string>) => {
    const folder = tempDir(t, 'zirbel-turn-');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(folder, 'game', path, '..'), { recursive: true });
      writeFileSync(join(folder, 'game', path), content);
    }
    return folder;
  };
  const good = folderOf({
    'index.html': '<script src="js/a.js"></script>',
    'js/a.js': 'a()',
    'src/a.ts': 'a()',
    'models/ship.glb': 'glTF',
  });
  const { html, files } = readGameFolder(good);
  assert.equal(html, '<script src="js/a.js"></script>');
  assert.deepEqual([...files.keys()], ['js/a.js', 'models/ship.glb', 'src/a.ts']);
  assert.equal(files.get('js/a.js')?.toString(), 'a()');

  assert.throws(() => readGameFolder(tempDir(t, 'zirbel-turn-')), /no game\/ folder/);
  assert.throws(() => readGameFolder(folderOf({ 'js/a.js': 'a()' })), /no index\.html at its top/);
  // A link out of game/, to a file or a folder, is refused, and nothing is read through it.
  const secret = join(tempDir(t, 'zirbel-secret-'), 'secret.txt');
  writeFileSync(secret, 'secret');
  const linked = folderOf({ 'index.html': '<p>x</p>' });
  symlinkSync(secret, join(linked, 'game', 'notes.txt'));
  symlinkSync(join(secret, '..'), join(linked, 'game', 'assets'));
  assert.throws(() => readGameFolder(linked), /game\/ holds links, which a game can’t: game\/assets, game\/notes\.txt/);
  // So is game/ itself as a link, and a hard link to a file elsewhere.
  const outside = folderOf({ 'index.html': '<p>x</p>' });
  const whole = tempDir(t, 'zirbel-turn-');
  symlinkSync(join(outside, 'game'), join(whole, 'game'));
  assert.throws(() => readGameFolder(whole), /game\/ is not a folder/);
  const hard = folderOf({ 'index.html': '<p>x</p>' });
  linkSync(secret, join(hard, 'game', 'copy.txt'));
  assert.throws(() => readGameFolder(hard), /game\/copy\.txt/);
  // Paths and types a game folder doesn't take: a hidden file, an unknown type, a name starting with a dot, too deep.
  assert.throws(() => readGameFolder(folderOf({ 'index.html': '<p>x</p>', '.env': 'KEY=1' })), /game\/\.env/);
  assert.throws(
    () => readGameFolder(folderOf({ 'index.html': '<p>x</p>', 'art/ship.psd': 'x' })),
    /game\/art\/ship\.psd/,
  );
  assert.throws(
    () => readGameFolder(folderOf({ 'index.html': '<p>x</p>', '.cache/a.js': 'x' })),
    /game\/\.cache\/a\.js/,
  );
  assert.throws(
    () => readGameFolder(folderOf({ 'index.html': '<p>x</p>', 'a/b/c/d/e/f/g/h/i/j.js': 'x' })),
    /game\/a\/b\/c\/d\/e\/f\/g\/h\//,
  );
  // More than a game holds, and a page that isn't text.
  const big = folderOf({ 'index.html': '<p>x</p>', 'data.bin': '' });
  truncateSync(join(big, 'game', 'data.bin'), GAME_BYTES + 1);
  assert.throws(() => readGameFolder(big), /larger than a game can be/);
  const binary = folderOf({ 'index.html': '' });
  writeFileSync(join(binary, 'game', 'index.html'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => readGameFolder(binary), /not UTF-8/);
});
