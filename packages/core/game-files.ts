// Games imported as a built folder: index.html becomes the game document, and every other file is
// stored by its content hash and listed in the document's files.
import { z } from 'zod';
import { PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { checkedKeys, type ControlKeys } from '../sdk/controls.ts';
import { adapterPath, gameDocument, gameFilePath, MAX_GAME_FILES, NET_PLAYERS, type GameDocument } from '../sdk/game.ts';
import { ZirbelError } from './errors.ts';
import type { Projects } from './projects.ts';
import type { Ident } from './git.ts';

const base64 = z.string().max(PORTABLE_FILE_LIMIT).regex(/^[A-Za-z0-9+/]*={0,2}$/);

// The body of POST /api/projects/import-game: a built folder, each file as base64.
export const gameFolder = z.strictObject({
  title: z.string().trim().min(1).max(80).optional(),
  files: z.record(gameFilePath, base64),
});

// A built folder can carry zirbel.json, the earlier Zirbel's description of a game. players.max above
// 1 there says the game brings its own netcode (zirbel-net): it plays over the host's relay, with up to
// 16 players. A file that says otherwise, can't be read or is over 64 KB leaves a game for one. Such a
// game's multiplayer.adapter names its adapter, one of the folder's .js or .mjs files (has): anything
// else leaves it without one. Any game's controls.keys maps gamepad inputs to keyboard codes (sdk/controls.ts): an object
// of known inputs and their codes, at least one, or else no controls.
const MANIFEST_BASE64 = Math.ceil(65_536 / 3) * 4;
/** What a game's index.html and files may hold in all, as an imported folder may: what 48 MB of base64 carries. */
export const GAME_BYTES = Math.floor(PORTABLE_FILE_LIMIT * 3 / 4);
type Described = { players?: { max?: unknown }; multiplayer?: { adapter?: unknown }; controls?: { keys?: unknown } } | null;
export function describedGame(manifest: string | undefined, has: (path: string) => boolean):
  Pick<GameDocument, 'maxPlayers' | 'net' | 'adapter' | 'controls'> {
  if (manifest === undefined || manifest.length > MANIFEST_BASE64) return { maxPlayers: 1 };
  let described: Described;
  try { described = JSON.parse(Buffer.from(manifest, 'base64').toString('utf8')) as Described; }
  catch { return { maxPlayers: 1 }; }
  const keys = describedKeys(described?.controls?.keys);
  const controls = keys ? { controls: { keys } } : {};
  const max = described?.players?.max, adapter = described?.multiplayer?.adapter;
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 1) return { maxPlayers: 1, ...controls };
  return { maxPlayers: Math.min(max, NET_PLAYERS), net: true,
    ...(adapterPath.safeParse(adapter).success && has(adapter as string) ? { adapter: adapter as string } : {}), ...controls };
}

/** controls.keys as gameControls reads it, its inputs sorted (as the Go host writes a map): none when empty or wrong. */
function describedKeys(keys: unknown): ControlKeys | undefined {
  const checked = checkedKeys(keys);
  return checked && Object.fromEntries(Object.entries(checked).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function importGameFolder(projects: Projects, raw: unknown, author?: Ident) {
  const { title, files } = gameFolder.parse(raw);
  const entry = files['index.html'];
  if (entry === undefined) throw new ZirbelError(422, 'A game folder needs an index.html at its top.');
  if (Object.keys(files).length > MAX_GAME_FILES + 1) throw new ZirbelError(413, 'A game folder holds up to 1000 files besides index.html.');
  if (Object.values(files).some((data) => data.length % 4)) throw new ZirbelError(400, 'files · Invalid base64');
  let html: string;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(entry, 'base64')); }
  catch { throw new ZirbelError(422, 'index.html must be UTF-8 text.'); }
  gameDocument.shape.html.parse(html); // before anything is stored
  // Sorted, as the Go host writes a map, so both hosts hash the same document.
  const stored: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) {
    if (path !== 'index.html') stored[path] = projects.storeAsset(Buffer.from(files[path]!, 'base64'));
  }
  return projects.createRevision(title ?? 'Imported game', {
    game: { html, ...describedGame(files['zirbel.json'], (path) => Object.hasOwn(stored, path)), files: stored }, assets: [],
    label: 'Imported game folder',
  }, author);
}
