// Games imported as a built folder: index.html becomes the game document, and every other file is
// stored by its content hash and listed in the document's files.
import { z } from 'zod';
import { PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { gameDocument, gameFilePath, MAX_GAME_FILES } from '../sdk/game.ts';
import { ZirbelError, type Projects } from './projects.ts';

const base64 = z.string().max(PORTABLE_FILE_LIMIT).regex(/^[A-Za-z0-9+/]*={0,2}$/);

// The body of POST /api/projects/import-game: a built folder, each file as base64.
export const gameFolder = z.strictObject({
  title: z.string().trim().min(1).max(80).optional(),
  files: z.record(gameFilePath, base64),
});

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
  return projects.createRevision(title ?? 'Imported game', {
    game: { html, maxPlayers: 1, files: stored }, assets: [], label: 'Imported game folder',
  });
}
