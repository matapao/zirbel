import { z } from 'zod';
import { compactProperties, MAX_REGISTERED_OBJECTS } from './bounded.ts';

export { boundedJson, MAX_REGISTERED_OBJECTS } from './bounded.ts';

// A game imported as a built folder also has files: each path beside index.html, stored by its
// content hash, and served beside the document in the game's sandbox. The extension sets the
// content type; the Go host keeps the same table in host/gamefiles.go.
export const GAME_FILE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', wasm: 'application/wasm',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', ktx2: 'image/ktx2',
  obj: 'model/obj', mtl: 'model/mtl', fbx: 'application/octet-stream', hdr: 'image/vnd.radiance', exr: 'image/x-exr',
  // Shaders, and a game's own source: plain text, which a browser never runs.
  glsl: 'text/plain; charset=utf-8', vert: 'text/plain; charset=utf-8', frag: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
};
const segment = '[A-Za-z0-9_][A-Za-z0-9._-]*';
// Relative, at most 8 deep, no segment starting with a dot, and an extension from the table.
export const gameFilePath = z.string().max(240)
  .regex(new RegExp('^(?:' + segment + '/){0,7}' + segment + '\\.(?:' + Object.keys(GAME_FILE_TYPES).join('|') + ')$'));
export const MAX_GAME_FILES = 1000;
const gameFiles = z.record(gameFilePath, z.string().regex(/^[a-f0-9]{64}$/)).refine(
  (files) => Object.keys(files).length <= MAX_GAME_FILES && !Object.hasOwn(files, 'index.html'),
  'Provide up to 1000 files besides index.html.',
);

// The most players a game sharing state can have, and a game with its own netcode.
export const SHARED_PLAYERS = 4;
export const NET_PLAYERS = 16;

// The document owns the game's rendering, input, objects and rules. A game with net brings its own
// netcode over the host's relay (/zirbel-net.js, protocol v2): up to 16 players. Without it, players
// share state through window.zirbel: up to 4.
const gameFields = z.strictObject({
  html: z.string().trim().min(1).max(400_000),
  maxPlayers: z.number().int().min(1).max(NET_PLAYERS).default(1),
  net: z.literal(true).optional(),
  registerObjects: z.boolean().optional(),
  files: gameFiles.optional(),
});
const withinPlayers = (game: { maxPlayers: number; net?: true }) => game.maxPlayers <= SHARED_PLAYERS || game.net === true;
const playersError = { message: 'A game for more than 4 players needs net.', path: ['maxPlayers'] };
export const gameDocument = gameFields.refine(withinPlayers, playersError);
export type GameDocument = z.infer<typeof gameDocument>;
// What a proposal or a harness writes: files only arrive with their bytes, from an import.
export const editableGame = gameFields.omit({ files: true }).refine(withinPlayers, playersError);

const registeredObject = z.strictObject({
  id: z.string().min(1).max(120),
  properties: z.custom<Record<string, unknown>>(compactProperties, 'Provide compact JSON properties.'),
});
export type RegisteredObject = z.infer<typeof registeredObject>;
export const objectRegistry = z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= MAX_REGISTERED_OBJECTS,
  'Provide at most 512 registered objects.').pipe(z.array(registeredObject))
  .refine((objects) => new Set(objects.map(({ id }) => id)).size === objects.length, 'Object IDs must be unique.');
