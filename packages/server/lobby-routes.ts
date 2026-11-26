// The lobby on a player listener (core/lobby.ts): its page at /, the files beside it, and its API under /lobby/. Anyone
// the listener answers may use it: it lists the offered games and the sessions without their codes, starts a session of
// an offered game, and seats someone in a session by its code, each with a one-time ticket in the link it hands back.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Lobby } from '../core/lobby.ts';
import { ZirbelError } from '../core/projects.ts';
import { lobbyJoin, lobbyStart } from '../sdk/contracts.ts';
import { body, checkOrigin, reply, typeFor } from './http.ts';
import { sendImmutable, type LobbyFiles } from './runtime-files.ts';

/** The lobby page runs its own script and style alone, and talks only to its listener. */
const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** pair: on a box, the pairing page's address on the host name a device reached the lobby by. */
export type LobbyContext = { lobby: Lobby; files: LobbyFiles; pair?: (host: string) => string };

/** The player page in a room, holding a seat's one-time ticket: it goes straight in. */
const seatLink = (origin: string, room: { id: string }, ticket: string) => origin + '/join/' + room.id + '#seat=' + ticket;

/** Answers a lobby request on a listener for access, or says it is none. */
export async function lobbyRequest(context: LobbyContext, access: 'local' | 'lan', request: IncomingMessage, response: ServerResponse,
  url: URL) {
  const { pathname } = url;
  const method = request.method;
  const file = pathname === '/' ? 'lobby.html' : pathname === '/lobby.js' || pathname === '/lobby.css' ? pathname.slice(1) : undefined;
  const entry = file && context.files.get(file);
  if (file && entry && method === 'GET') {
    if (file === 'lobby.html') response.setHeader('content-security-policy', PAGE_POLICY);
    sendImmutable(request, response, typeFor(file), entry, 'no-cache');
    return true;
  }
  if (!pathname.startsWith('/lobby/')) return false;
  const address = request.socket.remoteAddress ?? '';
  if (pathname === '/lobby/state' && method === 'GET') {
    reply(response, { ...context.lobby.state(access), pair: context.pair?.(url.hostname) ?? null });
    return true;
  }
  if (pathname === '/lobby/sessions' && method === 'POST') {
    checkOrigin(request, true);
    const input = lobbyStart.parse(await body(request, 4096));
    const { room, ticket } = context.lobby.start(access, address, input.release, input.name);
    reply(response, { code: room.code, link: seatLink(url.origin, room, ticket) }, 201);
    return true;
  }
  if (pathname === '/lobby/join' && method === 'POST') {
    checkOrigin(request, true);
    const input = lobbyJoin.parse(await body(request, 4096));
    const { room, ticket } = context.lobby.join(access, address, input.code, input.name);
    reply(response, { link: seatLink(url.origin, room, ticket) });
    return true;
  }
  throw new ZirbelError(404, 'Lobby route does not exist.');
}
