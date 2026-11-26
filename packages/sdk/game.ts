import { z } from 'zod';
import { compactProperties, MAX_REGISTERED_OBJECTS } from './bounded.ts';
import { CONTROL_INPUTS, KEY_CODE, MAX_PLACES, PLACE_COLOR, PLACE_NAME } from './controls.ts';

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
const pathWith = (extensions: string[]) => z.string().max(240)
  .regex(new RegExp('^(?:' + segment + '/){0,7}' + segment + '\\.(?:' + extensions.join('|') + ')$'));
export const gameFilePath = pathWith(Object.keys(GAME_FILE_TYPES));
// A game with net may name its adapter, the module that connects it to the net module: one of its own scripts, which the
// game page loads after the game's document, so the game itself carries nothing of Zirbel's.
export const adapterPath = pathWith(['js', 'mjs']);
export const MAX_GAME_FILES = 1000;
// The keys a game's zirbel.json gives gamepad inputs, for a game that reads only the keyboard, and each place's own keys,
// name and colour (controls.ts).
const controlKeys = z.partialRecord(z.enum(CONTROL_INPUTS), z.string().regex(KEY_CODE));
const gameControls = z.strictObject({
  keys: controlKeys.optional(),
  players: z.array(z.strictObject({
    keys: controlKeys.optional(), name: z.string().min(1).max(PLACE_NAME).optional(), color: z.string().regex(PLACE_COLOR).optional(),
  })).min(1).max(MAX_PLACES).optional(),
});
const gameFiles = z.record(gameFilePath, z.string().regex(/^[a-f0-9]{64}$/)).refine(
  (files) => Object.keys(files).length <= MAX_GAME_FILES && !Object.hasOwn(files, 'index.html'),
  'Provide up to 1000 files besides index.html.',
);

// The most players a game sharing state can have, and a game with its own netcode.
export const SHARED_PLAYERS = 4;
export const NET_PLAYERS = 16;

// The document owns the game's rendering, input, objects and rules. A game with net brings its own
// netcode, in a space of the spaces kernel the host runs (/.skalet/net.js): up to 16 players. Without it, players
// share state through window.zirbel: up to 4.
const gameFields = z.strictObject({
  html: z.string().trim().min(1).max(400_000),
  maxPlayers: z.number().int().min(1).max(NET_PLAYERS).default(1),
  net: z.literal(true).optional(),
  adapter: adapterPath.optional(),
  controls: gameControls.optional(),
  registerObjects: z.boolean().optional(),
  files: gameFiles.optional(),
});
const withinPlayers = (game: { maxPlayers: number; net?: true }) => game.maxPlayers <= SHARED_PLAYERS || game.net === true;
const playersError = { message: 'A game for more than 4 players needs net.', path: ['maxPlayers'] };
const ownAdapter = (game: { net?: true; adapter?: string; files?: Record<string, string> }) =>
  game.adapter === undefined || (game.net === true && game.files !== undefined && Object.hasOwn(game.files, game.adapter));
const adapterError = { message: 'An adapter is one of the game’s own files, in a game with net.', path: ['adapter'] };
export const gameDocument = gameFields.refine(withinPlayers, playersError).refine(ownAdapter, adapterError);
export type GameDocument = z.infer<typeof gameDocument>;
// What a proposal or a harness writes: files only arrive with their bytes, from an import, and so do the adapter and the
// controls their zirbel.json names.
export const editableGame = gameFields.omit({ files: true, adapter: true, controls: true }).refine(withinPlayers, playersError);

const registeredObject = z.strictObject({
  id: z.string().min(1).max(120),
  properties: z.custom<Record<string, unknown>>(compactProperties, 'Provide compact JSON properties.'),
});
export type RegisteredObject = z.infer<typeof registeredObject>;
export const objectRegistry = z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= MAX_REGISTERED_OBJECTS,
  'Provide at most 512 registered objects.').pipe(z.array(registeredObject))
  .refine((objects) => new Set(objects.map(({ id }) => id)).size === objects.length, 'Object IDs must be unique.');
