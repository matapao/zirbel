import { editableGame, gameDocument } from './game.ts';
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
const revision = z.strictObject({
  id, parent: id.nullable(), restoredFrom: id.optional(),
  label: z.string().min(1).max(120), date: z.iso.datetime(),
  scene: scene.optional(), game: gameDocument.optional(), assets: z.array(asset).max(80),
});
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
  upstream: id.optional(), imported: z.literal(true).optional(),
});
const filename = z.string().regex(/^(?:chunks\/)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/);
export const distribution = z.strictObject({ play: z.boolean(), download: z.boolean(), remix: z.boolean() });
const manifest = z.strictObject({
  format: z.literal(1), releaseId: id, gameId: id, sourceRevision: id, template: template.optional(),
  title: z.string().min(1).max(80), sdk: z.literal(SDK_VERSION), protocol: z.literal(PROTOCOL_VERSION),
  client: z.literal('player.html'), simulation: z.enum(['mosslight-v1', 'tessellate-v1', 'shared-state-v1']).nullable(),
  players: z.strictObject({ min: z.number().int().min(1), max: z.number().int().min(1).max(4) })
    .refine((players) => players.min <= players.max),
  capabilities: z.array(z.enum(['multiplayer', 'webgl'])).max(2),
  permissions: distribution,
  assets: z.array(asset).max(80),
  credits: z.array(z.strictObject({ name: z.string(), credit: z.string(), license: z.string() })).max(90),
  files: z.record(filename, hash),
});
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
export type Revision = z.infer<typeof revision>;
export type Project = z.infer<typeof project>;
export type Manifest = z.infer<typeof manifest>;
export type Release = z.infer<typeof portableRelease>;
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type SeatInfo = z.infer<typeof seatInfo>;
