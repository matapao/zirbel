// Who may use which of the editor's API routes (box mode). Owners, the box itself and its paired devices, may use them
// all. An editor of one game works on that game alone: it reads it and its history, saves changes into it (proposals
// submitted, applied, discarded or restored, its title, notes, media and assets), playtests it and shares a development
// room of it, sees that game's rooms and the lobby's address, and gives its own agent an MCP grant for it. Any other
// route, or another game's, is refused: games, imports, releases, the lobby's offers, the box's harnesses and
// settings, pairing, and the game's edit code and editors. The routes it may use answer it as they answer an owner.
import { ZirbelError } from '../core/projects.ts';
import { ONE_GAME } from './box-editors.ts';
import type { Access } from './box-routes.ts';

export type ApiRoute = { method?: string; resource?: string; pathID?: string; action?: string; tail?: string };

/** Who sent a request, as GET /api/me tells the workspace: the machine the editor runs on (on a box, the box itself),
 *  an owner, or an editor of one game. */
export function whoIs(access: Access) {
  if (access.editor) return { role: 'editor' as const, game: access.editor.game };
  return { role: access.local ? 'box' as const : 'owner' as const };
}

/** Refuses an editor a route of another game, or one owners alone use. roomGame: the game an open room plays. */
export function checkRole(access: Access, route: ApiRoute, roomGame: (room: string) => string | undefined) {
  if (access.editor && !editorMay(access.editor.game, route, roomGame)) throw new ZirbelError(403, ONE_GAME);
}

/** An editor's routes in its game, by method and action. */
function gameRoute(method: string | undefined, action: string | undefined) {
  const read = method === 'GET';
  const write = method === 'POST';
  if (!action) return read;
  if (['proposals', 'media', 'grants'].includes(action)) return read || write;
  if (['apply', 'discard', 'restore', 'title', 'notes', 'asset', 'playtest', 'development-room'].includes(action)) return write;
  return action === 'export' && read;
}

function editorMay(game: string, { method, resource, pathID, action, tail }: ApiRoute, roomGame: (room: string) => string | undefined) {
  if (resource === 'health' || resource === 'me') return true;
  if (resource === 'lobby') return method === 'GET' && !pathID;
  if (resource === 'projects') return pathID ? pathID === game && gameRoute(method, action) : method === 'GET';
  if (resource !== 'rooms') return false;
  if (!pathID) return method === 'GET';
  // Its game's playtests and rooms; one already closed is answered as an owner's is.
  const room = (method === 'GET' && action === 'link') || (method === 'POST' && action === 'close');
  return room && !tail && (roomGame(pathID) ?? game) === game;
}
