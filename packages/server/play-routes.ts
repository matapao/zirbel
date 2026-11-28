// The editor API's routes of what is played: releases (/api/releases), the lobby's offers (/api/lobby) and rooms
// (/api/rooms), for who asked and the host name its player is reached on.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { id, lobbyOffer, PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { ZirbelError } from '../core/projects.ts';
import type { Releases } from '../core/releases.ts';
import type { Rooms } from '../core/rooms.ts';
import { authorOf } from './authors.ts';
import type { Access } from './box-routes.ts';
import type { Players } from './hosting.ts';
import { body, reply } from './http.ts';

export type PlayRoutes = { releases: Releases; rooms: Rooms; players: Players };

/** Answers /api/releases, /api/lobby and /api/rooms (only: the one game an editor may use): says whether it did. */
export async function playRoutes(ctx: PlayRoutes, request: IncomingMessage, response: ServerResponse,
  route: { resource?: string | undefined; pathID?: string | undefined; action?: string | undefined },
  asker: { access: Access; only: string | undefined; playerHost: string | undefined }) {
  const { resource, pathID, action } = route;
  const { access, only, playerHost } = asker;
  const { releases, rooms, players } = ctx;
  const method = request.method;
  if (resource === 'releases') {
    if (method === 'GET' && !pathID) { reply(response, releases.list()); return true; }
    if (method === 'POST' && pathID && action === 'play') {
      const release = releases.read(pathID);
      if (!release.manifest.permissions.play) throw new ZirbelError(403, 'The creator has disabled play for this release.');
      reply(response, players.solo(release, playerHost), 201); return true;
    }
    if (method === 'GET' && pathID && action === 'download') {
      const release = releases.read(pathID);
      if (!release.manifest.permissions.download) throw new ZirbelError(403, 'The creator has disabled downloads.');
      reply(response, release, 200, { 'content-disposition': 'attachment; filename="zirbel-release.json"' }); return true;
    }
    if (method === 'POST' && pathID === 'import') { reply(response, releases.import(await body(request, PORTABLE_FILE_LIMIT)).manifest, 201); return true; }
    if (method === 'POST' && pathID && action === 'remix') { reply(response, releases.remix(pathID, authorOf(access)), 201); return true; }
  }
  if (resource === 'lobby' && !action) {
    if (method === 'GET' && !pathID) {
      reply(response, { offered: players.lobby.offered(), link: players.lobbyLink(playerHost) }); return true;
    }
    if (method === 'POST' && pathID === 'offer') {
      const input = lobbyOffer.parse(await body(request, 4096));
      reply(response, players.lobby.offer(input.release, input.offered)); return true;
    }
  }
  if (resource === 'rooms') {
    if (method === 'GET' && !pathID) {
      reply(response, rooms.list().filter((room) => !only || room.manifest.gameId === only)); return true;
    }
    if (method === 'POST' && !pathID) {
      const input = z.strictObject({ releaseId: id, lan: z.boolean() }).parse(await body(request));
      reply(response, await players.start(input.releaseId, input.lan, playerHost), 201); return true;
    }
    if (method === 'GET' && pathID && action === 'link') { reply(response, await players.describe(rooms.get(pathID), playerHost)); return true; }
    if (method === 'POST' && pathID && action === 'close') { rooms.close(pathID); reply(response, {}); return true; }
  }
  return false;
}
