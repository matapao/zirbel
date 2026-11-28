// The editor API's project routes (/api/projects[/<id>/…]): the list, a game made, imported or removed, its title,
// proposals and restores, notes, media and assets, export, releases, playtests, development rooms and MCP grants.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { attachment, asset, distribution, id, PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { assertCurrent, mediaMatches, newId, safeId, ZirbelError } from '../core/projects.ts';
import type { Releases } from '../core/releases.ts';
import type { Rooms } from '../core/rooms.ts';
import { importGameFolder } from '../core/game-files.ts';
import type { Ident } from '../core/git.ts';
import { body, bytes, lanAddresses, reply } from './http.ts';
import { projectChat, type ChatContext } from './chat-routes.ts';
import type { BoxContext } from './box-routes.ts';
import type { Players } from './hosting.ts';
import type { Mcp } from './mcp.ts';

const branchInput = z.object({ branch: id.default('main') });
const scope = branchInput.extend({ baseRevision: id });
const permissionsInput = branchInput.extend({ baseRevision: id.optional(), permissions: distribution });
const assetMetadata = asset.omit({ id: true, hash: true });
const shareDefaults = { play: true, download: true, remix: true };

/** What the project routes reach: the chat's context (the store, harnesses, turns and threads) and the editor's own. */
export type ProjectRoutes = {
  chatContext: ChatContext; releases: Releases; rooms: Rooms; players: Players; mcp: Mcp; box: BoxContext | undefined;
  lanHost: string | undefined; mcpOn: () => boolean;
};

/** Answers /api/projects and a project's routes for who asked (author; only, the one game an editor may use) and the
 *  host name its player is reached on: says whether it did. */
export async function projectRoutes(ctx: ProjectRoutes, request: IncomingMessage, response: ServerResponse, url: URL,
  route: { pathID?: string | undefined; action?: string | undefined; tail?: string | undefined },
  asker: { author: Ident; only: string | undefined; playerHost: string | undefined }) {
  const { pathID, action, tail } = route;
  const { author, only, playerHost } = asker;
  const { chatContext, releases, rooms, players, mcp, box, lanHost, mcpOn } = ctx;
  const { projects, harnesses, chat, threads } = chatContext;
  const method = request.method;
  if (!pathID && method === 'GET') {
    reply(response, projects.summaries().filter((game) => !only || game.id === only)); return true;
  }
  if (!pathID && method === 'POST') {
    const input = z.strictObject({ title: z.string().optional() }).parse(await body(request));
    reply(response, projects.createGame(input.title, undefined, author), 201); return true;
  }
  if (pathID === 'import-game' && method === 'POST') {
    reply(response, importGameFolder(projects, await body(request, PORTABLE_FILE_LIMIT), author), 201); return true;
  }
  if (pathID === 'import' && method === 'POST') {
    reply(response, projects.import(await body(request, PORTABLE_FILE_LIMIT), author), 201); return true;
  }
  const projectId = safeId(pathID);
  if (!action && method === 'GET') { reply(response, projects.read(projectId)); return true; }
  if (action === 'remove' && !tail && method === 'POST') {
    projects.read(projectId);
    // Its threads go with it: their turns stop, and their folders and sessions are removed.
    await chat.stopThreads((thread) => thread.startsWith(projectId + '.'));
    projects.remove(projectId);
    // On a box, its edit code and its editors go too.
    box?.editors.removeProject(projectId);
    rooms.closeProject(projectId);
    await threads.removeProject(projectId, (harness, session) => harnesses.removeSession?.(harness, session) ?? Promise.resolve());
    reply(response, {});
    return true;
  }
  if (action === 'title' && method === 'POST') {
    const { title } = z.strictObject({ title: z.string() }).parse(await body(request));
    reply(response, projects.rename(projectId, title)); return true;
  }
  if (action === 'proposals' && method === 'GET') {
    reply(response, tail ? projects.preview(projectId, safeId(tail)) :
      projects.proposals(projectId, safeId(url.searchParams.get('branch') ?? 'main'))); return true;
  }
  if (action === 'proposals' && method === 'POST') { reply(response, projects.submit(projectId, await body(request), false, author), 201); return true; }
  if (action === 'discard' && method === 'POST') { projects.discard(projectId, safeId(tail)); reply(response, {}); return true; }
  if (action === 'apply' && method === 'POST') {
    const { fork } = z.strictObject({ fork: id.optional() }).parse(await body(request));
    reply(response, projects.commit(projectId, safeId(tail), fork)); return true;
  }
  if (action === 'restore' && method === 'POST') {
    const input = scope.extend({ target: id }).parse(await body(request));
    reply(response, projects.restore(projectId, input.branch, input.baseRevision, input.target, author)); return true;
  }
  if (await projectChat(chatContext, request, response, url, projectId, action, tail, author)) return true;
  if (action === 'notes' && method === 'POST') { reply(response, projects.addNote(projectId, await body(request)), 201); return true; }
  if (action === 'media' && method === 'POST' && !tail) {
    const { data, ...input } = attachment.omit({ id: true }).extend({ data: z.string().max(24_000_000) })
      .parse(await body(request, 25_000_000));
    const file = Buffer.from(data, 'base64');
    if (!mediaMatches(input.media, file)) throw new ZirbelError(400, 'The attachment does not match its media type.');
    reply(response, projects.addMedia(projectId, input, file), 201); return true;
  }
  if (action === 'media' && method === 'GET' && tail) {
    const file = projects.readMedia(projectId, safeId(tail));
    bytes(response, file.bytes, file.item.media); return true;
  }
  if (action === 'media' && method === 'POST' && tail) {
    const { transcript, intent } = attachment.pick({ transcript: true, intent: true }).parse(await body(request));
    reply(response, projects.editTranscript(projectId, safeId(tail), transcript, intent)); return true;
  }
  if (action === 'asset' && method === 'POST') {
    const { data, branch, baseRevision, ...metadata } = assetMetadata.extend({
      data: z.string().max(7_000_000), ...scope.shape,
    }).parse(await body(request, 7_500_000));
    const file = Buffer.from(data, 'base64');
    if (!mediaMatches(metadata.media, file)) throw new ZirbelError(400, 'The asset does not match its media type.');
    assertCurrent(projects.read(projectId), branch, baseRevision);
    const hash = projects.storeAsset(file);
    reply(response, projects.submit(projectId, { branch, baseRevision, label: ('Import ' + metadata.name).slice(0, 120),
      operations: [{ op: 'addAsset', asset: { ...metadata, id: newId(), hash } }] }, false, author), 201);
    return true;
  }
  if (action === 'export' && method === 'GET') {
    reply(response, projects.export(projectId), 200, { 'content-disposition': 'attachment; filename="zirbel-project.json"' });
    return true;
  }
  if (action === 'release' && method === 'POST') {
    const input = permissionsInput.parse(await body(request));
    if (input.baseRevision) assertCurrent(projects.read(projectId), input.branch, input.baseRevision);
    reply(response, releases.package(projectId, input.branch, input.permissions, true).manifest, 201); return true;
  }
  if (action === 'development-room' && method === 'POST') {
    const input = scope.parse(await body(request));
    const release = releases.package(projectId, input.branch,
      { play: true, download: false, remix: false }, false);
    if (release.manifest.sourceRevision !== input.baseRevision)
      throw new ZirbelError(409, 'The branch changed. Refresh before sharing.');
    if (!release.manifest.simulation) throw new ZirbelError(422, 'Enable multiplayer in the game before sharing a development room.');
    if (!lanHost && !lanAddresses().length) throw new ZirbelError(409, 'Connect the host to your local network to share a development room.');
    await players.startLan();
    projects.read(projectId);
    reply(response, await players.describe(await rooms.withSpace(rooms.create(release, false, 'lan', true)), playerHost), 201);
    return true;
  }
  if (action === 'playtest' && method === 'POST') {
    const input = branchInput.extend({ proposalId: id.optional(), baseRevision: id.optional() }).parse(await body(request));
    if (input.baseRevision) assertCurrent(projects.read(projectId), input.branch, input.baseRevision);
    // Draft play stays on loopback. Delivery rights are checked when sharing or exporting.
    const release = releases.package(projectId, input.branch, shareDefaults, false, true, input.proposalId);
    reply(response, players.solo(release, playerHost), 201); return true;
  }
  if (action === 'grants' && mcpOn()) {
    if (method === 'POST' && !tail) {
      const input = z.strictObject({ write: z.boolean(), hours: z.number() }).parse(await body(request));
      reply(response, mcp.create({ ...input, projectId }), 201); return true;
    }
    if (method === 'POST' && tail) { mcp.revoke(projectId, safeId(tail)); reply(response, {}); return true; }
    if (method === 'GET') { reply(response, mcp.list(projectId)); return true; }
  }
  return false;
}
