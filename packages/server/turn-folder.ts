// A thread's working folder at a turn's start, and its game/ read back at the end. game/ is the game: index.html at
// its top and the files it loads beside it. Each turn starts with game/ written afresh from the current revision, so
// edits made elsewhere (History, a proposal applied) are what the harness sees, and with node_modules/ linking the
// packages the editor provides, which the harness may read and never write. The rest of the folder is the harness's
// and stays as it left it. Read back, game/ keeps to an imported folder's rules: index.html at the top, the file types
// and paths a game can hold, the per-file and total limits, regular files only (no links, so nothing outside game/).
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { gameDocument, gameFilePath, MAX_GAME_FILES, type GameDocument } from '../sdk/game.ts';
import { ZirbelError } from '../core/projects.ts';

/** A package the folder's node_modules links to: node_modules/<name> → target. */
export type ToolLink = { name: string; target: string };

/** What game/ may hold in all, as an imported folder may: what 48 MB of base64 carries. */
export const GAME_BYTES = Math.floor(PORTABLE_FILE_LIMIT * 3 / 4);
/** Folders deeper than a game path can be, and entries a game/ can hold before it is plainly not a game. */
const DEPTH = 8;
const ENTRIES = 4 * MAX_GAME_FILES;

const fail = (message: string) => new ZirbelError(422, message);
const listed = (paths: string[]) => paths.slice(0, 8).map((path) => 'game/' + path).join(', ') + (paths.length > 8 ? ', …' : '');

/** Removes what is at a path, whatever it is, never following a link: a link goes, and what it leads to stays. */
function clear(path: string) {
  rmSync(path, { recursive: true, force: true });
}

/** Readies a thread's folder for a turn: game/ from the revision's game (empty for none), and node_modules' links. */
export function prepareFolder(folder: string, game: GameDocument | undefined, read: (hash: string) => Buffer, links: ToolLink[]) {
  const root = join(folder, 'game');
  clear(root);
  mkdirSync(root, { mode: 0o700 });
  if (game) {
    writeFileSync(join(root, 'index.html'), game.html, { flag: 'wx' });
    for (const [path, hash] of Object.entries(game.files ?? {})) {
      const file = join(root, gameFilePath.parse(path));
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, read(hash), { flag: 'wx' });
    }
  }
  const modules = join(folder, 'node_modules');
  let kept = false;
  try { kept = lstatSync(modules).isDirectory(); } catch { /* none yet */ }
  if (!kept) { clear(modules); mkdirSync(modules, { mode: 0o700 }); }
  for (const { name, target } of links) {
    const link = join(modules, name);
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    clear(link);
    symlinkSync(target, link, 'dir');
  }
}

/** One regular file's bytes, opened without following a link, and the same file the walk found. */
function readFile(path: string, found: { dev: number; ino: number }, room: number) {
  let handle: number;
  try { handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw fail('A file in game/ could not be read.'); }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.dev !== found.dev || stat.ino !== found.ino || stat.nlink > 1)
      throw fail('A file in game/ changed while it was read.');
    if (stat.size > room) throw fail('game/ is larger than a game can be (' + Math.floor(GAME_BYTES / 1e6) + ' MB).');
    const bytes = Buffer.alloc(stat.size);
    for (let at = 0, read = 1; at < bytes.length && read > 0; at += read) read = readSync(handle, bytes, at, bytes.length - at, null);
    return bytes;
  } finally { closeSync(handle); }
}

/** game/ read back: its index.html and every other file, each checked as an imported folder's are. */
export function readGameFolder(folder: string) {
  const root = join(folder, 'game');
  let top;
  try { top = lstatSync(root); } catch { throw fail('The harness left no game/ folder in its working folder.'); }
  if (!top.isDirectory()) throw fail('game/ is not a folder: the game must be a folder of its own in the working folder.');
  const found: { path: string; dev: number; ino: number }[] = [];
  const links: string[] = [];
  const refused: string[] = [];
  let entries = 0;
  const walk = (relative: string, depth: number) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (++entries > ENTRIES) throw fail('game/ holds more than a game can (' + MAX_GAME_FILES + ' files besides index.html).');
      const path = relative ? relative + '/' + entry.name : entry.name;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) links.push(path);
      else if (stat.isDirectory()) {
        if (depth >= DEPTH) refused.push(path + '/');
        else walk(path, depth + 1);
      } else if (!stat.isFile() || stat.nlink > 1) refused.push(path);
      else if (path === 'index.html' || gameFilePath.safeParse(path).success) found.push({ path, dev: stat.dev, ino: stat.ino });
      else refused.push(path);
    }
  };
  walk('', 0);
  if (links.length) throw fail('game/ holds links, which a game can’t: ' + listed(links) + '. Its files must be in game/ itself.');
  if (refused.length)
    throw fail('game/ holds what a game can’t: ' + listed(refused) + '. A game holds regular files of the types a game folder takes, at most 8 folders deep, with no names starting with a dot.');
  const entry = found.find(({ path }) => path === 'index.html');
  if (!entry) throw fail('game/ has no index.html at its top.');
  if (found.length > MAX_GAME_FILES + 1) throw fail('game/ holds more than ' + MAX_GAME_FILES + ' files besides index.html.');
  let room = GAME_BYTES;
  const files = new Map<string, Buffer>();
  for (const file of found.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const bytes = readFile(join(root, file.path), file, room);
    room -= bytes.length;
    files.set(file.path, bytes);
  }
  let html: string;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(files.get('index.html')); }
  catch { throw fail('game/index.html is not UTF-8 text.'); }
  if (!gameDocument.shape.html.safeParse(html).success)
    throw fail('game/index.html must hold the game’s page, at most 400,000 characters.');
  files.delete('index.html');
  return { html, files };
}
