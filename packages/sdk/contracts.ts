import { editableGame, gameDocument, NET_PLAYERS, SHARED_PLAYERS } from './game.ts';
import { ENTRY_LIMIT, STEP_ID_LIMIT, TITLE_LIMIT, TURN_LIMIT, TURN_STEPS, entryWeight } from './activity.ts';
import { z } from 'zod';

export const SDK_VERSION = '1.0.0';
export const PROTOCOL_VERSION = 1;
export const PORTABLE_FILE_LIMIT = 48_000_000;
export const WORLD = { width: 960, height: 600 };
export const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const template = z.enum(['blank', 'mosslight', 'tessellate', 'orbit-garden', 'lantern-quest']);
const objectKind = z.enum(['tree', 'rock', 'crystal', 'campfire', 'cabin', 'water', 'bridge', 'spawn', 'placeholder', 'npc', 'enemy']);
const sceneObject = z.strictObject({
  id, kind: objectKind, name: z.string().trim().min(1).max(80),
  x: z.number().min(0).max(WORLD.width), y: z.number().min(0).max(WORLD.height),
  size: z.number().min(8).max(340), color,
  description: z.string().max(2000).optional(),
  health: z.number().int().min(1).max(100).optional(),
  power: z.number().int().min(1).max(20).optional(),
  requires: id.optional(),
});
export const scene = z.strictObject({
  id, background: color, objects: z.array(sceneObject).max(160).refine(
    (objects) => new Set(objects.map((item) => item.id)).size === objects.length,
    'Object IDs must be unique.',
  ),
});
export const asset = z.strictObject({
  id, name: z.string().min(1).max(140), author: z.string().min(1).max(140),
  source: z.string().url().regex(/^https?:\/\//), license: z.enum(['CC0-1.0', 'CC-BY-4.0', 'MIT', 'local-only', 'unknown']),
  credit: z.string().max(600), hash,
  media: z.enum(['image/png', 'image/jpeg', 'image/webp']),
});
export const sceneReference = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('instance'), sceneId: id, revision: id, object: sceneObject }),
  z.strictObject({
    type: z.literal('region'), sceneId: id, revision: id,
    bounds: z.strictObject({
      x: z.number().min(0).max(WORLD.width), y: z.number().min(0).max(WORLD.height),
      width: z.number().positive().max(WORLD.width), height: z.number().positive().max(WORLD.height),
    }).refine((box) => box.x + box.width <= WORLD.width && box.y + box.height <= WORLD.height),
    objects: z.array(sceneObject).max(160),
  }),
]);
const change = sceneObject.omit({ id: true, kind: true }).partial().refine(
  (changes) => Object.keys(changes).length > 0, 'Provide at least one property.',
);
const sceneOperations = [
  z.strictObject({ op: z.literal('add'), object: sceneObject }),
  z.strictObject({ op: z.literal('update'), id, changes: change }),
  z.strictObject({ op: z.literal('remove'), id }),
  z.strictObject({ op: z.literal('background'), color }),
  z.strictObject({ op: z.literal('addAsset'), asset }),
  z.strictObject({ op: z.literal('removeAsset'), id }),
] as const;
// What a proposal may do: writeGame replaces the game with one document, never with files, which only arrive with
// their bytes (an import, or a harness turn's own folder).
const operation = z.discriminatedUnion('op', [z.strictObject({ op: z.literal('writeGame'), game: editableGame }), ...sceneOperations]);
export const proposalInput = z.strictObject({
  baseRevision: id, branch: id, label: z.string().trim().min(1).max(120),
  operations: z.array(operation).min(1).max(160),
});
// What the editor stages and stores: the same, but a harness turn's writeGame carries the files of its game/, which
// the editor itself stored by their hashes.
const storedOperation = z.discriminatedUnion('op', [z.strictObject({ op: z.literal('writeGame'), game: gameDocument }), ...sceneOperations]);
export const storedProposalInput = proposalInput.extend({ operations: z.array(storedOperation).min(1).max(160) });
// A revision in full. Its id is its commit's hash (docs/git-store.md); author: who made it, as its commit names them.
const revision = z.strictObject({
  id, parent: id.nullable(), restoredFrom: id.optional(),
  label: z.string().min(1).max(120), date: z.iso.datetime(), author: z.string().min(1).max(120).optional(),
  scene: scene.optional(), game: gameDocument.optional(), assets: z.array(asset).max(80),
});
// A branch or tag name as an import from a git URL takes one.
export const gitRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
  .refine((ref) => !/\.\.|\/\/|@\{|\/$|\.$|\.lock$|\/\./.test(ref), 'Name a branch or tag.');
// Where a game imported from a git URL came from, which Update from source fetches again.
const gitSource = z.strictObject({ url: z.string().min(1).max(2048), ref: gitRef.optional() });
export const attachment = z.strictObject({
  id,
  name: z.string().min(1).max(160),
  intent: z.enum(['Inspiration', 'Material to copy', 'Text to transcribe', 'Motion to study', 'Asset to place']),
  media: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'text/plain']),
  transcript: z.string().max(4000),
  original: id.optional(),
});
const chatUsage = z.strictObject({
  source: z.string().min(1).max(100),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
// The chat before a project exists, as the editor sends it with each message: its last messages.
export const workspaceHistory = z.array(z.strictObject({
  role: z.enum(['creator', 'assistant']),
  text: z.string().trim().min(1).max(4000),
  usage: chatUsage.optional(),
})).max(12);
export const note = z.strictObject({
  id, text: z.string().trim().min(1).max(4000), date: z.iso.datetime(), branch: id,
  references: z.array(sceneReference).max(32), attachments: z.array(id).max(12),
  role: z.enum(['creator', 'assistant']).optional(),
  usage: chatUsage.optional(),
  designPrompt: z.string().trim().min(1).max(3000).optional(),
});
// One step of a harness turn, as the Node editor keeps it beside the projects. Not part of the project file.
const activityEntry = z.strictObject({
  id: z.string().min(1).max(STEP_ID_LIMIT), title: z.string().max(TITLE_LIMIT),
  detail: z.string().max(ENTRY_LIMIT).optional(), diff: z.string().max(ENTRY_LIMIT).optional(),
  kind: z.enum(['message', 'plan', 'tool', 'helper', 'file', 'notice', 'request']),
  state: z.enum(['pending', 'running', 'waiting', 'idle', 'completed', 'failed']).optional(),
  parent: z.string().min(1).max(STEP_ID_LIMIT).optional(),
});
export const turnActivity = z.strictObject({
  version: z.literal(1), entries: z.array(activityEntry).max(TURN_STEPS), dropped: z.number().int().nonnegative(),
}).refine((record) => record.entries.reduce((total, entry) => total + entryWeight(entry), 0) <= TURN_LIMIT,
  'The turn activity exceeds its size limit.');
export const project = z.strictObject({
  version: z.literal(1), id, title: z.string().trim().min(1).max(80), template: template.optional(),
  branches: z.record(id, id), revisions: z.array(revision).min(1), notes: z.array(note), attachments: z.array(attachment),
  upstream: id.optional(), imported: z.literal(true).optional(), source: gitSource.optional(),
});
const filename = z.string().regex(/^(?:chunks\/)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/);
export const distribution = z.strictObject({ play: z.boolean(), download: z.boolean(), remix: z.boolean() });
const manifest = z.strictObject({
  format: z.literal(1), releaseId: id, gameId: id, sourceRevision: id, template: template.optional(),
  title: z.string().min(1).max(80), sdk: z.literal(SDK_VERSION), protocol: z.literal(PROTOCOL_VERSION),
  client: z.literal('player.html'), simulation: z.enum(['mosslight-v1', 'tessellate-v1', 'shared-state-v1', 'net-v2']).nullable(),
  players: z.strictObject({ min: z.number().int().min(1), max: z.number().int().min(1).max(NET_PLAYERS) })
    .refine((players) => players.min <= players.max),
  capabilities: z.array(z.enum(['multiplayer', 'webgl'])).max(2),
  permissions: distribution,
  assets: z.array(asset).max(80),
  credits: z.array(z.strictObject({ name: z.string(), credit: z.string(), license: z.string() })).max(90),
  files: z.record(filename, hash),
}).refine((manifest) => manifest.players.max <= SHARED_PLAYERS || manifest.simulation === 'net-v2',
  { message: 'A release for more than 4 players needs net.', path: ['players', 'max'] });
export const portableRelease = z.strictObject({
  manifest, scene: scene.optional(), game: gameDocument.optional(), sceneHash: hash,
  files: z.record(filename, z.string()),
  assets: z.record(hash, z.string()),
});

export const ClientMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hello'), version: z.literal(PROTOCOL_VERSION),
    credential: z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/), releaseId: id,
  }),
  // Each simulation validates its own action shape after the room checks the seat.
  z.strictObject({ type: z.literal('action'), sequence: z.number().int().positive().max(2 ** 31 - 1), action: z.unknown().nonoptional() }),
  z.strictObject({ type: z.literal('resync') }),
  z.strictObject({ type: z.literal('leave') }),
]);
const seatInfo = z.strictObject({
  id, name: z.string().min(1).max(24), role: z.enum(['player', 'spectator']), connected: z.boolean(),
});
export const ServerMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('welcome'), version: z.literal(PROTOCOL_VERSION), releaseId: id,
    seat: seatInfo, resume: z.string(), ack: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('snapshot'), tick: z.number().int().nonnegative(), ack: z.number().int().nonnegative(),
    seats: z.array(seatInfo), state: z.json(),
  }),
  z.strictObject({
    type: z.literal('error'), code: z.enum(['protocol', 'expired', 'full', 'forbidden', 'invalid-action', 'stale-action', 'closed']),
    message: z.string(),
  }),
  z.strictObject({ type: z.literal('closed'), message: z.string() }),
]);

// The lobby (packages/core/lobby.ts). A player's display name is as the player page's join form takes it; a code is
// read leniently (any case, spaces and dashes), so its shape is checked after this.
const playerName = z.string().trim().min(1).max(24);
export const lobbyStart = z.strictObject({ release: id, name: playerName });
export const lobbyJoin = z.strictObject({ code: z.string().max(16), name: playerName });
export const lobbyOffer = z.strictObject({ release: id, offered: z.boolean() });
/** lobby.json in the data folder: the releases the owner offers, at most one per game. */
export const lobbyFile = z.strictObject({ version: z.literal(1), offered: z.array(id).max(256) })
  .refine((file) => new Set(file.offered).size === file.offered.length, 'A release is offered once.');

// The pads socket (packages/core/pads.ts): what a screen and a phone send the host on /pads, each at most 1 KB, and what
// the box's controller service sends it on the local socket, each at most 4 KB. Pad state itself is binary (sdk/pads.ts).
// A place is a controller's on its screen, P1 to P8 (0 to 7 here).
const padPlace = z.number().int().min(0).max(7);
const padDevice = z.number().int().min(0).max(15);
export const padsScreenMessage = z.discriminatedUnion('type', [
  // place: the next controller whose A goes down takes it; without one, the next box gamepad on no screen joins.
  z.strictObject({ type: z.literal('claim'), place: padPlace.optional() }),
  z.strictObject({ type: z.literal('release'), slot: padPlace }),
  z.strictObject({ type: z.literal('rumble'), slot: padPlace, duration: z.number().min(0).max(5000),
    strong: z.number().min(0).max(1), weak: z.number().min(0).max(1) }),
  // Show on TV: a player page of this listener, as a path, for the box's own screen to open.
  z.strictObject({ type: z.literal('show'), link: z.string().max(256).regex(/^\/join\/[a-z0-9]{1,64}(?:#[A-Za-z0-9_.&=-]{1,180})?$/) }),
  z.strictObject({ type: z.literal('move'), from: padPlace, to: padPlace }),
  // What each place drives, as the game names it: all of them, the places left out having none.
  z.strictObject({ type: z.literal('labels'), labels: z.array(z.strictObject({ place: padPlace, name: z.string().min(1).max(24),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(8) }),
  // The places the screen's own device gamepads hold, which the host gives no other controller.
  z.strictObject({ type: z.literal('local'), places: z.array(padPlace).max(8) }),
]);
export const padsPadMessage = z.strictObject({ type: z.literal('place'), place: padPlace });
export const padsServiceMessage = z.discriminatedUnion('type', [
  // uid: who the gamepad is across a reconnect (its Bluetooth address, or the USB port it is in), so it keeps its place.
  z.strictObject({ type: z.literal('device'), device: padDevice, name: z.string().min(1).max(128), standard: z.boolean(),
    uid: z.string().min(1).max(128).optional() }),
  z.strictObject({ type: z.literal('gone'), device: padDevice }),
  // The service's view of the box's controllers and Bluetooth, which Box settings shows.
  z.looseObject({ type: z.literal('controllers') }),
]);

// The box's controllers (box mode): Box settings' requests, and the box's controllers service's view of its gamepads
// and Bluetooth (pi/controllers/view.py), which reaches the host over the pads' local socket. Names are at most 64
// characters there, which is at most 128 here.
const bluetoothAddress = z.string().regex(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/);
const controllerName = z.string().max(128);
export const controllersScan = z.strictObject({ on: z.boolean() });
export const controllersAddress = z.strictObject({ address: bluetoothAddress });
export const controllersView = z.strictObject({
  type: z.literal('controllers'),
  devices: z.array(z.strictObject({
    name: controllerName, kind: z.enum(['usb', 'bluetooth', 'other']), connected: z.boolean(),
    device: z.number().int().min(0).max(15).optional(), address: bluetoothAddress.optional(),
  })).max(32),
  found: z.array(z.strictObject({ address: bluetoothAddress, name: controllerName })).max(32),
  scanning: z.boolean(), bluetooth: z.boolean(), pairing: bluetoothAddress.nullable(), error: z.string().max(400).nullable(),
});

// The spaces kernel (packages/server/spaces.ts): the line its child prints first, and what its local socket answers
// Zirbel's calls with. Its objects may say more than Zirbel reads. A space's id is 12 hex digits, its credentials the
// kernel's secrets, its code the lobby's letters.
const spaceId = z.string().regex(/^[0-9a-f]{12}$/);
const spaceSecret = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const spaceCode = z.string().regex(/^[2-9A-HJ-NP-Z]{4}$/);
export const spacesStart = z.object({
  spaces: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
  socket: z.string().regex(/^(?:unix:\/[^\n]{1,1000}|tcp:127\.0\.0\.1:\d{1,5})$/),
  token: spaceSecret, pid: z.number().int().positive(),
});
export const spacesOpened = z.object({ space: spaceId, link: z.string().max(2048), code: spaceCode.optional() });
export const spacesTicket = z.object({ ticket: spaceSecret });
/** The member a page's proof names (space.member): one of the space's, by its number, name and role. */
export const spacesMember = z.object({ member: z.object({
  id: z.string().min(1).max(64), n: z.number().int().min(1).max(253), name: z.string().max(64), role: z.enum(['participant', 'observer']),
}) });
export const spacesList = z.array(z.object({
  space: spaceId, listener: z.string().max(32), code: spaceCode.optional(),
  members: z.array(z.object({ role: z.enum(['participant', 'observer']), connected: z.boolean(), away: z.boolean() })).max(300),
})).max(64);

export type SceneObject = z.infer<typeof sceneObject>;
export type Scene = z.infer<typeof scene>;
export function legacyScene(value: { scene?: Scene }) {
  if (!value.scene) throw new Error('This legacy project has no scene.');
  return value.scene;
}
export type Template = z.infer<typeof template>;
export type Asset = z.infer<typeof asset>;
export type Attachment = z.infer<typeof attachment>;
export type Reference = z.infer<typeof sceneReference>;
export type ChatUsage = z.infer<typeof chatUsage>;
export type Note = z.infer<typeof note>;
export type ActivityEntry = z.infer<typeof activityEntry>;
export type Operation = z.infer<typeof storedOperation>;
/** A revision as a project lists it: only a branch's head carries its content (scene, game, assets). */
export type Revision = Omit<z.infer<typeof revision>, 'assets'> & { assets?: Asset[] };
/** A revision with its content. */
export type FullRevision = z.infer<typeof revision>;
/** A project as the API answers it; a bundle's (export, import) has every revision in full. */
export type Project = Omit<z.infer<typeof project>, 'revisions'> & { revisions: Revision[] };
export type ProjectBundle = z.infer<typeof project>;
export type Manifest = z.infer<typeof manifest>;
export type Release = z.infer<typeof portableRelease>;
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type SeatInfo = z.infer<typeof seatInfo>;
export type PadsScreenMessage = z.infer<typeof padsScreenMessage>;
export type PadsServiceMessage = z.infer<typeof padsServiceMessage>;
export type PadsPadMessage = z.infer<typeof padsPadMessage>;
