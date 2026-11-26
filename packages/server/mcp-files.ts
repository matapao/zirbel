// The game's files over the project MCP server, by path: read_file reads one from a branch head or a revision, and
// write_files stages a revision that writes or removes some of them. Files arrive only with their bytes, so a grant
// can't reach another project's files by their hashes. What a change leaves keeps to an imported folder's rules: the
// paths and types of packages/sdk/game.ts, 1000 files besides index.html, and the 36 MB a game's folder can hold.
// host/mcp_files.go does the same, and the MCP contract test holds the two together.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { id, PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { gameDocument, gameFilePath, MAX_GAME_FILES, type GameDocument } from '../sdk/game.ts';
import { describedGame } from '../core/game-files.ts';
import { assertCurrent, head, ZirbelError, type Projects } from '../core/projects.ts';
import { GAME_BYTES } from './turn-folder.ts';
import type { Ident } from '../core/git.ts';

/** Base64 in whole groups of four, as the import reads it. */
const base64 = z.string().max(PORTABLE_FILE_LIMIT).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const readFileInput = z.strictObject({ path: gameFilePath, branch: id.default('main'), revision: id.optional() });
const change = z.union([
  z.strictObject({ path: gameFilePath, text: z.string().max(PORTABLE_FILE_LIMIT) }),
  z.strictObject({ path: gameFilePath, base64 }),
  z.strictObject({ path: gameFilePath, remove: z.literal(true) }),
]);
export const writeFilesInput = z.strictObject({
  branch: id.default('main'), baseRevision: id, label: z.string().trim().min(1).max(120),
  files: z.array(change).min(1).max(MAX_GAME_FILES + 1),
});

const utf8 = (bytes: Buffer, ignoreBOM: boolean) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM }).decode(bytes); }
  catch { return undefined; }
};

/** One file of a revision's game: UTF-8 text as text, anything else as base64. */
export function readGameFile(projects: Projects, projectId: string, { path, branch, revision }: z.output<typeof readFileInput>) {
  const source = revision === undefined ? head(projects.read(projectId), branch) : projects.revision(projectId, revision);
  const game = source.game;
  if (!game) throw new ZirbelError(404, 'This revision has no game.');
  let bytes: Buffer;
  if (path === 'index.html') bytes = Buffer.from(game.html, 'utf8');
  else {
    const hash = game.files && Object.hasOwn(game.files, path) ? game.files[path] : undefined;
    if (hash === undefined) throw new ZirbelError(404, 'The game has no file at ' + path + '.');
    bytes = projects.readAsset(hash);
  }
  // The text is the file's bytes exactly, a byte order mark included.
  const text = utf8(bytes, true);
  return { revision: source.id, path, size: bytes.length, ...(text === undefined ? { base64: bytes.toString('base64') } : { text }) };
}

/** A stored game file's size, from the asset store. */
function storedSize(projects: Projects, hash: string) {
  try { return statSync(join(projects.root, 'assets', hash)).size; }
  catch { throw new ZirbelError(422, 'An asset file is missing.'); }
}

/** Stages the branch head's game with these files written or removed, and the rest as they are. */
export function stageFiles(projects: Projects, projectId: string, input: z.output<typeof writeFilesInput>, author?: Ident) {
  const { branch, baseRevision, label } = input;
  const paths = new Set<string>();
  for (const { path } of input.files) {
    if (paths.has(path)) throw new ZirbelError(400, 'Name each file once: ' + path + '.');
    paths.add(path);
  }
  const base = assertCurrent(projects.read(projectId), branch, baseRevision);
  let html = base.game?.html;
  // zirbel.json says how many play and names the adapter, as in an imported folder: read again from the files the
  // game ends with whenever it, or the adapter it names, changes.
  let described = paths.has('zirbel.json') || (base.game?.adapter !== undefined && paths.has(base.game.adapter));
  const kept = new Map(Object.entries(base.game?.files ?? {}));
  const written = new Map<string, Buffer>();
  for (const item of input.files) {
    const { path } = item;
    if ('remove' in item) {
      if (path === 'index.html') throw new ZirbelError(422, 'A game keeps its index.html: write it instead.');
      if (!kept.delete(path)) throw new ZirbelError(404, 'The game has no file at ' + path + '.');
      continue;
    }
    const bytes = 'text' in item ? Buffer.from(item.text, 'utf8') : Buffer.from(item.base64, 'base64');
    if (path === 'index.html') {
      // As an import reads it: UTF-8, without a byte order mark or the white space around it.
      const text = utf8(bytes, false);
      if (text === undefined) throw new ZirbelError(422, 'index.html must be UTF-8 text.');
      const parsed = gameDocument.shape.html.safeParse(text);
      if (!parsed.success) throw new ZirbelError(422, 'index.html must hold the game’s page, at most 400,000 characters.');
      html = parsed.data;
      continue;
    }
    kept.delete(path);
    written.set(path, bytes);
  }
  if (html === undefined) throw new ZirbelError(422, 'This project has no game yet: write its index.html too.');
  const count = kept.size + written.size;
  if (base.game?.files && Object.keys(base.game.files).length && !count)
    throw new ZirbelError(422, 'A game imported as a folder keeps at least one file beside index.html.');
  if (count > MAX_GAME_FILES) throw new ZirbelError(413, 'A game folder holds up to 1000 files besides index.html.');
  let size = Buffer.byteLength(html, 'utf8');
  for (const hash of kept.values()) size += storedSize(projects, hash);
  for (const bytes of written.values()) size += bytes.length;
  if (size > GAME_BYTES) throw new ZirbelError(413, 'The game would be larger than a game can be (' + Math.floor(GAME_BYTES / 1e6) + ' MB).');
  const stored = new Map(kept);
  for (const [path, bytes] of written) stored.set(path, projects.storeAsset(bytes));
  // Sorted, as the Go host writes a map, so both hosts stage the same document.
  const files = Object.fromEntries([...stored].sort(([a], [b]) => (a < b ? -1 : 1)));
  if (!described && base.game?.adapter !== undefined && !stored.has(base.game.adapter)) described = true;
  const manifest = written.get('zirbel.json') ?? (kept.has('zirbel.json') ? projects.readAsset(kept.get('zirbel.json')!) : undefined);
  const players = described ? describedGame(manifest?.toString('base64'), (path) => stored.has(path))
    : { maxPlayers: base.game?.maxPlayers ?? 1, ...(base.game?.net ? { net: true as const } : {}),
      ...(base.game?.adapter === undefined ? {} : { adapter: base.game.adapter }) };
  const game: GameDocument = { html, ...players,
    ...(base.game?.registerObjects === undefined ? {} : { registerObjects: base.game.registerObjects }),
    ...(count || base.game?.files ? { files } : {}) };
  return projects.submit(projectId, { branch, baseRevision, label, operations: [{ op: 'writeGame', game }] }, true, author);
}
