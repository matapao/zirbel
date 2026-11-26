// Writes contracts/*.schema.json from the Zod schemas in packages/sdk. The Zod
// schemas stay the source of truth; other hosts (the Go host) validate against
// these files. Run `pnpm contracts` after changing packages/sdk/contracts.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { projectBundle, savedNote, savedProposal, storedProject } from '../packages/core/projects.ts';
import { importInput, updateInput } from '../packages/core/git-source.ts';
import { gameFolder } from '../packages/core/game-files.ts';
import {
  asset, attachment, ClientMessage, controllersAddress, controllersScan, controllersView, id, lobbyFile, lobbyJoin, lobbyOffer,
  lobbyStart, portableRelease, project, proposalInput, scene, ServerMessage,
} from '../packages/sdk/contracts.ts';
import { gameDocument } from '../packages/sdk/game.ts';
import { grantSchema, toolDescriptors } from '../packages/server/mcp.ts';
import { readFileInput, writeFilesInput } from '../packages/server/mcp-files.ts';
import { guideResources, instructions } from '../packages/server/mcp-guides.ts';
import { sceneDocument, sceneResource } from '../packages/server/scene-app.ts';

// Reserve is defined beside the player listener, which imports the editor's HTTP
// helpers; restate it here rather than pull those in.
const reserve = z.strictObject({
  invite: z.string().regex(/^[a-zA-Z0-9_-]{32}$/), name: z.string().trim().min(1).max(24),
  role: z.enum(['player', 'spectator']),
});

// What the editor stores and accepts. The upload bodies are validated inline in
// packages/server/main.ts, which starts the editor when imported, so those
// three are restated here; the rest are the schemas the editor itself uses.
const editor = {
  'saved-proposal': savedProposal,
  'note-input': savedNote,
  'media-upload': attachment.omit({ id: true }).extend({ data: z.string().max(24_000_000) }),
  'asset-upload': asset.omit({ id: true, hash: true }).extend({ data: z.string().max(7_000_000), branch: id.default('main'), baseRevision: id }),
  transcript: attachment.pick({ transcript: true, intent: true }),
  'project-bundle': projectBundle,
  'game-folder': gameFolder,
  grant: grantSchema,
  // projects/<id>.json since git keeps the revisions (docs/git-store.md), and the git routes' bodies.
  'stored-project': storedProject,
  'import-git': importInput,
  'update-from-source': updateInput,
  // A revision's .zirbel/assets.json, which the Go host reads from a tree (git-tree.ts reads it as this, ids unique).
  'asset-list': z.array(asset).max(80),
};

const schemas = {
  'client-message': ClientMessage, 'server-message': ServerMessage, release: portableRelease,
  'game-document': gameDocument, project, proposal: proposalInput, reserve, scene, ...editor,
  'lobby-start': lobbyStart, 'lobby-join': lobbyJoin, 'lobby-offer': lobbyOffer, 'lobby-file': lobbyFile,
  // The arguments of the MCP tools for the game's files (packages/server/mcp-files.ts).
  'mcp-read-file': readFileInput, 'mcp-write-files': writeFilesInput,
  // Box settings' controllers, and the controllers service's view of them (packages/server/box-controllers.ts).
  'controllers-scan': controllersScan, 'controllers-address': controllersAddress, 'controllers-view': controllersView,
};

// Zod trims some strings, and its URL check trims and drops tabs and newlines,
// before the length and pattern checks after it. JSON Schema cannot say so:
// x-zirbel-prepare names that first step, and the Go validator applies it.
function prepare({ zodSchema, jsonSchema }: { zodSchema: z.core.$ZodTypes; jsonSchema: z.core.JSONSchema.BaseSchema }) {
  const { def } = zodSchema._zod;
  if (def.type !== 'string') return;
  const steps = (def.checks ?? []).map(({ _zod }) => {
    const step = _zod.def as { check: string; format?: string; tx?: (value: string) => unknown };
    if (step.check === 'overwrite' && step.tx?.(' a ') !== 'a') throw new Error('Only trim may rewrite a contract string.');
    return step.check === 'overwrite' ? 'trim' : step.check === 'string_format' && step.format === 'url' ? 'url' : undefined;
  });
  if (steps.slice(1).some(Boolean)) throw new Error('A trim or URL check must come first in a contract string.');
  if (steps[0]) jsonSchema['x-zirbel-prepare'] = steps[0];
}

// Refinements (unique IDs, min <= max) cannot be expressed in JSON Schema. Hosts
// enforce those in code; the schemas cover shape, types, lengths and patterns.
const generated: Record<string, string> = {};
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw', override: prepare });
  generated['contracts/' + name + '.schema.json'] =
    JSON.stringify({ $id: 'https://zirbel.app/contracts/' + name + '.schema.json', ...json }, null, 2) + '\n';
}
// MCP: the orientation at initialize, the guides (their text is in the build), the advertised tools and the Scene app
// page, served verbatim by every host.
generated['contracts/mcp-tools.json'] = JSON.stringify({ instructions, guides: guideResources, resource: sceneResource,
  tools: toolDescriptors }, null, 2) + '\n';
generated['contracts/mcp-scene.html'] = sceneDocument;

const check = process.argv.includes('--check');
let stale = false;
mkdirSync('contracts', { recursive: true });
for (const [path, text] of Object.entries(generated)) {
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* new contract */ }
  if (current === text) continue;
  if (check) { console.error(path + ' is out of date. Run pnpm contracts.'); stale = true; }
  else writeFileSync(path, text);
}
if (stale) process.exitCode = 1;
