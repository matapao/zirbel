// A revision's tree: the game's folder as a client sees it after git clone (index.html and its files at the top, and
// the game's own zirbel.json), with the host's own files under .zirbel/ (the document's own fields, an older project's
// scene, imported assets), and anything else kept as it is. readTree reads one into a revision's content under the
// rules every host applies; treeChanges writes content over a base tree, touching only what the host manages.
// The git store in AGENTS.md is the design; the Go host follows it.
import { z } from 'zod';
import { asset, PORTABLE_FILE_LIMIT, scene, type Asset, type Scene } from '../sdk/contracts.ts';
import {
  gameDocument,
  gameFilePath,
  MAX_GAME_FILES,
  NET_PLAYERS,
  SHARED_PLAYERS,
  type GameDocument,
} from '../sdk/game.ts';
import { describedGame, GAME_BYTES } from './game-files.ts';
import { blobId, identName, type CommitInfo, type Entry, type FastImport } from './git.ts';

/** A revision's content: an older project's scene, the game, and the imported assets. */
export type Content = { scene?: Scene | undefined; game?: GameDocument | undefined; assets: Asset[] };
/** A revision as history lists it. */
export type RevisionMeta = {
  id: string;
  parent: string | null;
  restoredFrom?: string;
  label: string;
  date: string;
  author: string;
};

/** Entries a tree may hold before it is plainly not a game. */
export const TREE_ENTRIES = 4 * MAX_GAME_FILES;
const GAME_JSON = '.zirbel/game.json';
const SCENE_JSON = '.zirbel/scene.json';
export const ASSETS_JSON = '.zirbel/assets.json';
const ASSET_DIRECTORY = '.zirbel/assets/';
const EXTENSIONS: Record<Asset['media'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const assetPath = ({ hash, media }: Pick<Asset, 'hash' | 'media'>) => ASSET_DIRECTORY + hash + '.' + EXTENSIONS[media];

/** The game document's own fields, for what the game's zirbel.json doesn't say. */
const ownFields = z.strictObject({
  maxPlayers: z.number().int().min(1).max(NET_PLAYERS).optional(),
  net: z.literal(true).optional(),
  registerObjects: z.boolean().optional(),
});
const assetList = z
  .array(asset)
  .max(80)
  .refine((list) => new Set(list.map(({ id }) => id)).size === list.length, 'Asset IDs must be unique.');

/** What reading a tree needs besides its entries: some blobs' bytes, the SHA-256 of the game files' blobs, and the
 *  imported assets' bytes checked (and kept, where the host keeps them): the problems found. */
export type TreeSource = {
  bytes(oids: string[]): Map<string, Buffer>;
  sha256(entries: Entry[]): Map<string, string>;
  assets(found: { asset: Asset; entry: Entry }[]): string[];
};

const regular = (entry: Entry | undefined): entry is Entry =>
  entry?.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
const listed = (paths: string[]) => paths.slice(0, 8).join(', ') + (paths.length > 8 ? ', …' : '');
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const utf8 = (bytes: Buffer) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};
function parsed<T>(schema: z.ZodType<T>, bytes: Buffer | undefined): T | undefined {
  if (!bytes) return undefined;
  const text = utf8(bytes);
  if (text === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** The paths of a tree that are the game's: index.html and every path a game file can have. */
const isGamePath = (path: string) => path === 'index.html' || gameFilePath.safeParse(path).success;

/** A tree's content, and its problems: hard ones (too many entries, links or submodules, too large) leave it without
 *  content; a part that can't be read is left out. A push, import or update is refused for any problem. */
export function readTree(entries: Entry[], source: TreeSource): { content: Content; problems: string[] } {
  const content: Content = { assets: [] };
  if (entries.length > TREE_ENTRIES)
    return { content, problems: ['It holds more than ' + TREE_ENTRIES + ' files, more than a game can.'] };
  const odd = entries.filter((entry) => entry.type !== 'blob' || entry.mode === '120000').map(({ path }) => path);
  if (odd.length)
    return { content, problems: ['It holds links or submodules, which a game can’t: ' + listed(odd) + '.'] };
  if (entries.reduce((total, { size }) => total + size, 0) > PORTABLE_FILE_LIMIT)
    return { content, problems: ['It is larger than ' + PORTABLE_FILE_LIMIT / 1e6 + ' MB.'] };
  const problems: string[] = [];
  const at = new Map(entries.map((entry) => [entry.path, entry]));
  const small = ['index.html', 'zirbel.json', GAME_JSON, SCENE_JSON, ASSETS_JSON]
    .map((path) => at.get(path))
    .filter(regular);
  const bytes = source.bytes(small.map(({ oid }) => oid));
  const of = (path: string) => {
    const entry = at.get(path);
    return regular(entry) ? bytes.get(entry.oid) : undefined;
  };

  const index = at.get('index.html');
  if (regular(index)) {
    const game = readGame(entries, index, of, source, problems);
    if (game) content.game = game;
  }
  const sceneFile = of(SCENE_JSON);
  if (sceneFile) {
    const found = parsed(scene, sceneFile);
    if (found) content.scene = found;
    else problems.push(SCENE_JSON + ' is not a scene Zirbel reads.');
  }
  const assetsFile = of(ASSETS_JSON);
  if (assetsFile) {
    const list = parsed(assetList, assetsFile);
    if (!list) problems.push(ASSETS_JSON + ' is not a list of assets Zirbel reads.');
    else {
      const found = list.map((item) => ({ asset: item, entry: at.get(assetPath(item)) }));
      const missing = found.filter(({ entry }) => !regular(entry)).map(({ asset: item }) => item.name);
      if (missing.length) problems.push('The bytes of these assets are missing: ' + listed(missing) + '.');
      else {
        const wrong = source.assets(found as { asset: Asset; entry: Entry }[]);
        problems.push(...wrong);
        if (!wrong.length) content.assets = list;
      }
    }
  }
  return {
    content: {
      ...(content.scene ? { scene: content.scene } : {}),
      ...(content.game ? { game: content.game } : {}),
      assets: content.assets,
    },
    problems,
  };
}

function readGame(
  entries: Entry[],
  index: Entry,
  of: (path: string) => Buffer | undefined,
  source: TreeSource,
  problems: string[],
) {
  const text = utf8(of('index.html') ?? Buffer.alloc(0));
  if (text === undefined) {
    problems.push('index.html must be UTF-8 text.');
    return;
  }
  const html = gameDocument.shape.html.safeParse(text);
  if (!html.success) {
    problems.push('index.html must hold the game’s page, at most 400,000 characters.');
    return;
  }
  const files = entries.filter(
    (entry) => entry.path !== 'index.html' && regular(entry) && gameFilePath.safeParse(entry.path).success,
  );
  if (files.length > MAX_GAME_FILES) {
    problems.push('A game holds up to ' + MAX_GAME_FILES + ' files besides index.html.');
    return;
  }
  if (files.reduce((total, { size }) => total + size, index.size) > GAME_BYTES) {
    problems.push('The game is larger than a game can be (' + Math.floor(GAME_BYTES / 1e6) + ' MB).');
    return;
  }
  const ownFile = of(GAME_JSON);
  const own = ownFile ? parsed(ownFields, ownFile) : {};
  if (!own) {
    problems.push(GAME_JSON + ' is not one Zirbel reads.');
    return;
  }
  const paths = new Set(files.map(({ path }) => path));
  const manifest = paths.has('zirbel.json') ? of('zirbel.json') : undefined;
  const described = describedGame(manifest?.toString('base64'), (path) => paths.has(path));
  const players = described.net
    ? described
    : { maxPlayers: own.maxPlayers ?? 1, ...(own.net ? { net: true as const } : {}) };
  if (players.maxPlayers > SHARED_PLAYERS && !players.net) {
    problems.push(GAME_JSON + ' gives more than ' + SHARED_PLAYERS + ' players to a game without net.');
    return;
  }
  const hashes = source.sha256(files);
  const listedFiles = Object.fromEntries(
    files.map(({ path, oid }) => [path, hashes.get(oid) ?? ''] as const).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const game: GameDocument = {
    html: html.data,
    maxPlayers: players.maxPlayers,
    ...(players.net ? { net: true as const } : {}),
    ...(players.adapter ? { adapter: players.adapter } : {}),
    ...(described.controls ? { controls: described.controls } : {}),
    ...(own.registerObjects === undefined ? {} : { registerObjects: own.registerObjects }),
    ...(files.length ? { files: listedFiles } : {}),
  };
  if (!gameDocument.safeParse(game).success) {
    problems.push('The game’s files could not be read.');
    return;
  }
  return game;
}

/** What .zirbel/game.json holds for a game: the fields its zirbel.json doesn't set, where they aren't the defaults. */
function ownGameFields(game: GameDocument, manifest: Buffer | undefined) {
  const files = game.files ?? {};
  const described = describedGame(manifest?.toString('base64'), (path) => Object.hasOwn(files, path));
  const own = described.net
    ? {}
    : { ...(game.maxPlayers !== 1 ? { maxPlayers: game.maxPlayers } : {}), ...(game.net ? { net: true } : {}) };
  const fields = { ...own, ...(game.registerObjects === undefined ? {} : { registerObjects: game.registerObjects }) };
  return Object.keys(fields).length ? fields : undefined;
}

/** The changes that make a base tree hold this content: the host's own paths only (index.html, the game's paths and
 *  .zirbel/), each written when its bytes change. read: a file's bytes by its SHA-256. The new blobs' SHA-256s. */
export function treeChanges(
  base: Entry[],
  sha256: (oid: string) => string | undefined,
  next: Content,
  read: (hash: string) => Buffer,
  stream: FastImport,
) {
  const at = new Map(base.map((entry) => [entry.path, entry]));
  const changes: Array<['M', string, string, string] | ['D', string]> = [];
  const hashes: [string, string][] = [];
  const write = (path: string, bytes: Buffer, hash?: string) => {
    const oid = blobId(bytes);
    if (hash) hashes.push([oid, hash]);
    if (regular(at.get(path)) && at.get(path)!.oid === oid) return;
    changes.push(['M', '100644', stream.blob(bytes), path]);
  };
  const remove = (path: string) => {
    if (at.has(path)) changes.push(['D', path]);
  };
  if (next.game) {
    const files = next.game.files ?? {};
    write('index.html', Buffer.from(next.game.html, 'utf8'));
    for (const { path } of base)
      if (path !== 'index.html' && isGamePath(path) && !Object.hasOwn(files, path)) remove(path);
    for (const [path, hash] of Object.entries(files)) {
      const entry = at.get(path);
      if (regular(entry) && sha256(entry.oid) === hash) continue;
      write(path, read(hash), hash);
    }
    const own = ownGameFields(next.game, Object.hasOwn(files, 'zirbel.json') ? read(files['zirbel.json']!) : undefined);
    if (own) write(GAME_JSON, json(own));
    else remove(GAME_JSON);
  }
  if (next.scene) write(SCENE_JSON, json(next.scene));
  else remove(SCENE_JSON);
  const wanted = new Map(next.assets.map((item) => [assetPath(item), item]));
  for (const { path } of base) if (path.startsWith(ASSET_DIRECTORY) && !wanted.has(path)) remove(path);
  for (const [path, item] of wanted) if (!at.has(path)) write(path, read(item.hash));
  if (next.assets.length) write(ASSETS_JSON, json(next.assets));
  else remove(ASSETS_JSON);
  return { changes, hashes };
}

/** A commit's message: the label on one line, then its trailers. */
export function commitMessage(label: string, trailers: [string, string][] = []) {
  const subject = label.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return (
    subject +
    '\n' +
    (trailers.length ? '\n' + trailers.map(([key, value]) => key + ': ' + value).join('\n') + '\n' : '')
  );
}

const codePoints = (text: string, most: number) => Array.from(text).slice(0, most).join('');

/** A commit as history lists it. */
export function revisionMeta(info: CommitInfo): RevisionMeta {
  const label = codePoints(info.message.split('\n')[0]!.trim(), 120).trim() || 'Untitled revision';
  const restored = /^Zirbel-Restored-From: ([0-9a-f]{40})$/m.exec(info.message)?.[1];
  return {
    id: info.id,
    parent: info.parents[0] ?? null,
    ...(restored ? { restoredFrom: restored } : {}),
    label,
    date: new Date(info.time * 1000).toISOString(),
    author: identName(info.author),
  };
}
