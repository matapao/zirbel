// Games imported as a built folder: index.html becomes the game document, and every other file is
// stored by its content hash and listed in the document's files.
import { z } from 'zod';
import { PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { gameDocument, gameFilePath, MAX_GAME_FILES, NET_PLAYERS } from '../sdk/game.ts';
import { ZirbelError, type Projects } from './projects.ts';

const base64 = z.string().max(PORTABLE_FILE_LIMIT).regex(/^[A-Za-z0-9+/]*={0,2}$/);

// The body of POST /api/projects/import-game: a built folder, each file as base64.
export const gameFolder = z.strictObject({
  title: z.string().trim().min(1).max(80).optional(),
  files: z.record(gameFilePath, base64),
});

// A built folder can carry zirbel.json, the earlier Zirbel's description of a game. players.max above
// 1 there says the game brings its own netcode (zirbel-net): it plays over the host's relay, with up to
// 16 players. A file that says otherwise, can't be read or is over 64 KB leaves a game for one.
const MANIFEST_BASE64 = Math.ceil(65_536 / 3) * 4;
export function netPlayers(manifest: string | undefined): number {
  if (manifest === undefined || manifest.length > MANIFEST_BASE64) return 1;
  let max: unknown;
  try { max = (JSON.parse(Buffer.from(manifest, 'base64').toString('utf8')) as { players?: { max?: unknown } } | null)?.players?.max; }
  catch { return 1; }
  return typeof max === 'number' && Number.isInteger(max) && max > 1 ? Math.min(max, NET_PLAYERS) : 1;
}

export function importGameFolder(projects: Projects, raw: unknown) {
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
  const players = netPlayers(files['zirbel.json']);
  return projects.createRevision(title ?? 'Imported game', {
    game: { html, maxPlayers: players, ...(players > 1 ? { net: true as const } : {}), files: stored }, assets: [], label: 'Imported game folder',
  });
}
