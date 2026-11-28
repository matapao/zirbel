// The editor API's git routes: a revision in full (GET /api/projects/<id>/revisions/<revision>), the clone command
// with this device's git token (GET /api/projects/<id>/clone), an import from a public repository
// (POST /api/projects/import-git) and an update from a game's source (POST /api/projects/<id>/update-from-source).
// The git store in AGENTS.md is the design.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { importGit, updateFromSource } from '../core/git-source.ts';
import { safeId, type Projects } from '../core/projects.ts';
import { authorOf } from './authors.ts';
import type { Access } from './box-routes.ts';
import type { GitTokens } from './git-tokens.ts';
import { body, checkOrigin, reply } from './http.ts';

export type GitRoutes = { projects: Projects; tokens?: GitTokens | undefined; port: () => number };

/** Whom a git token is for: the editor of one game, else the paired device; no one on the box itself. */
function tokenHolder(access: Access) {
  if (access.local) return undefined;
  if (access.editor) return { kind: 'e' as const, id: access.editor.id };
  return access.device ? { kind: 'o' as const, id: access.device } : undefined;
}

/** The clone command for a game, on the host name the request came by: with this device's git token off the box. */
function clone({ tokens, port }: GitRoutes, access: Access, url: URL, projectId: string) {
  const at = url.hostname + (port() === 80 ? '' : ':' + port());
  const address = 'http://' + at + '/git/' + projectId + '.git';
  const holder = tokenHolder(access);
  const token = holder && tokens?.token(holder);
  return {
    url: address,
    command: 'git clone ' + (token ? 'http://zirbel:' + token + '@' + at + '/git/' + projectId + '.git' : address),
    ...(token ? { token } : {}),
  };
}

/** Answers the git routes of /api/projects: says whether it did. */
export async function gitRoutes(
  ctx: GitRoutes,
  request: IncomingMessage,
  response: ServerResponse,
  access: Access,
  url: URL,
  route: { pathID?: string | undefined; action?: string | undefined; tail?: string | undefined },
) {
  const { pathID, action, tail } = route;
  const { projects } = ctx;
  const method = request.method;
  if (pathID === 'import-git' && !action && method === 'POST') {
    checkOrigin(request, !access.local);
    reply(response, await importGit(projects, await body(request, 8192)), 201);
    return true;
  }
  if (!pathID) return false;
  if (action === 'revisions' && tail && method === 'GET') {
    reply(response, projects.revision(safeId(pathID), safeId(tail)));
    return true;
  }
  if (action === 'clone' && !tail && method === 'GET') {
    projects.read(safeId(pathID));
    reply(response, clone(ctx, access, url, safeId(pathID)));
    return true;
  }
  if (action === 'update-from-source' && !tail && method === 'POST') {
    checkOrigin(request, !access.local);
    const input = await body(request, 4096);
    reply(response, await updateFromSource(projects, safeId(pathID), input, authorOf(access)));
    return true;
  }
  return false;
}
