// Git over HTTP on the editor's listener: /git/<project>.git, smart HTTP alone, served by `git http-backend` as CGI. The
// machine the editor runs on (on a box, the box itself) clones and pushes every game without credentials; from a box's
// network a git client sends a git token (a paired device's, for every game; an editor's, for its game) or a project
// grant (its game; pushes with a write grant alone), as its Basic password or a bearer token. A push is checked by the
// host's own pre-receive hook (git-hook.ts) before any ref moves. docs/git-store.md is the design.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ZirbelError, type Projects } from '../core/projects.ts';
import { gitEnvironment, ident, OWNER, type Ident } from '../core/git.ts';
import { authorOf, grantAuthor } from './authors.ts';
import { checkOrigin } from './http.ts';
import type { Access, BoxContext } from './box-routes.ts';
import type { GitTokens } from './git-tokens.ts';
import type { Mcp } from './mcp.ts';

/** What a push may bring in all. */
const PUSH_BYTES = 128 * 1024 * 1024;
const route = /^\/git\/([a-z0-9][a-z0-9_-]{0,79})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const services = ['git-upload-pack', 'git-receive-pack'];
const SIGN_IN = 'Sign in with this device’s git token: the editor shows it in Clone with git.';

export type GitContext = {
  projects: Projects; mcp: Mcp; box?: BoxContext; tokens?: GitTokens;
  /** Where the hook that checks pushes is (writeHooks). */
  hooks: string;
};

/** Who may use a game over git: one game or all, whether to push, and whether as a project grant, whose pushes move
 *  the branches the game has and make none (git-hook.ts). */
type GitAccess = { game?: string; write: boolean; author: Ident; grant?: true };

/** The token a git client sent: a Basic password, or a bearer token. */
function credential(header = '') {
  const bearer = /^Bearer (\S+)$/.exec(header);
  if (bearer) return bearer[1];
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
  if (!basic) return undefined;
  const text = Buffer.from(basic[1]!, 'base64').toString('utf8');
  return text.slice(text.indexOf(':') + 1) || undefined;
}

function gitAccess(ctx: GitContext, request: IncomingMessage, access: Access): GitAccess {
  if (access.local) return { write: true, author: OWNER };
  const token = credential(request.headers.authorization);
  if (token && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/.test(token)) {
    if (ctx.box && !ctx.box.settings.read().externalMcp) throw new ZirbelError(403, 'External MCP access is off on this box.');
    const grant = ctx.mcp.verify('Bearer ' + token);
    return { game: grant.projectId, write: grant.write, author: grantAuthor(grant.id), grant: true };
  }
  const holder = token ? ctx.tokens?.holder(token) : undefined;
  if (holder?.kind === 'o') {
    const device = ctx.box?.pairing.devices().find((known) => known.id === holder.id);
    if (device) return { write: true, author: ident(device.label, 'device.' + device.id + '@zirbel.invalid') };
  }
  if (holder?.kind === 'e') {
    const editor = ctx.box?.editors.editor(holder.id);
    if (editor) return { game: editor.project, write: true, author: ident(editor.name, 'editor.' + editor.id + '@zirbel.invalid') };
  }
  // A browser's session, which the door read.
  if (access.device) return { write: true, author: authorOf(access) };
  if (access.editor) return { game: access.editor.game, write: true, author: authorOf(access) };
  throw new ZirbelError(401, SIGN_IN);
}

/** The CGI variables git http-backend takes, and the settings it serves with. */
function backendEnvironment(ctx: GitContext, request: IncomingMessage, url: URL, path: string, { author, grant }: GitAccess) {
  const settings: [string, string][] = [['http.receivepack', 'true'], ['receive.denyNonFastForwards', 'true'],
    ['receive.denyDeletes', 'true'], ['receive.fsckObjects', 'true'], ['receive.maxInputSize', String(PUSH_BYTES)],
    ['receive.autogc', 'false'], ['transfer.hideRefs', 'refs/zirbel'], ['core.hooksPath', ctx.hooks]];
  const { headers } = request;
  const protocol = headers['git-protocol'];
  return gitEnvironment({
    GIT_PROJECT_ROOT: join(ctx.projects.root, 'git'), GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: path,
    REQUEST_METHOD: request.method ?? 'GET', QUERY_STRING: url.search.slice(1), CONTENT_TYPE: headers['content-type'] ?? '',
    REMOTE_ADDR: request.socket.remoteAddress ?? '', REMOTE_USER: author.name, ...(grant ? { ZIRBEL_GIT_GRANT: '1' } : {}),
    ...(headers['content-length'] ? { CONTENT_LENGTH: headers['content-length'] } : {}),
    ...(typeof headers['content-encoding'] === 'string' ? { HTTP_CONTENT_ENCODING: headers['content-encoding'] } : {}),
    ...(typeof protocol === 'string' && /^[A-Za-z0-9=:,._-]{1,200}$/.test(protocol) ? { GIT_PROTOCOL: protocol } : {}),
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(settings.flatMap(([key, value], index) => [['GIT_CONFIG_KEY_' + index, key], ['GIT_CONFIG_VALUE_' + index, value]])),
  });
}

/** Serves /git/…: says whether the request was git's. */
export async function gitRequest(ctx: GitContext, request: IncomingMessage, response: ServerResponse, url: URL, access: Access) {
  if (!url.pathname.startsWith('/git/')) return false;
  const match = route.exec(url.pathname);
  const service = match?.[2] === 'info/refs' ? url.searchParams.get('service') : match?.[2];
  if (!match || !service || !services.includes(service)) throw new ZirbelError(404, 'Git serves /git/<game>.git over smart HTTP alone.');
  const method = match[2] === 'info/refs' ? 'GET' : 'POST';
  if (request.method !== method) { response.writeHead(405, { allow: method }); response.end(); return true; }
  if (request.headers.origin !== undefined) checkOrigin(request);
  let who: GitAccess;
  try { who = gitAccess(ctx, request, access); } catch (error) {
    if (error instanceof ZirbelError && error.status === 401) response.setHeader('www-authenticate', 'Basic realm="Zirbel", charset="UTF-8"');
    throw error;
  }
  const projectId = match[1]!;
  if (!ctx.projects.has(projectId)) throw new ZirbelError(404, 'Project does not exist.');
  if (who.game && who.game !== projectId) throw new ZirbelError(403, 'This credential reaches another game.');
  const push = service === 'git-receive-pack';
  if (push && !who.write) throw new ZirbelError(403, 'This grant fetches only: pushing needs a write grant.');
  await backend(request, response, backendEnvironment(ctx, request, url, '/' + projectId + '.git/' + match[2], who));
  return true;
}

/** Runs git http-backend for one request, its CGI answer as the response. */
function backend(request: IncomingMessage, response: ServerResponse, env: Record<string, string>) {
  return new Promise<void>((resolve) => {
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString('utf8')).slice(-2000); });
    request.pipe(child.stdin);
    child.stdin.on('error', () => { /* the backend ended first */ });
    response.once('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (started) { response.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const crlf = head.indexOf('\r\n\r\n'), lf = head.indexOf('\n\n');
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
      if (end < 0) return;
      started = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const name = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
        if (name === 'status') status = Number(value.split(' ')[0]) || 500;
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.write(head.subarray(end + (end === crlf ? 4 : 2)));
    });
    child.once('close', (code) => {
      if (!started && !response.headersSent) {
        if (errors) console.error('git http-backend: ' + errors.trim().split('\n').at(-1));
        response.writeHead(code === 0 ? 200 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end();
      resolve();
    });
  });
}

/** The hooks every push runs, written at each start: pre-receive runs this editor's own check (git-hook.ts), with the
 *  Node (or the desktop app's program as Node) and the built server it runs now. */
export function writeHooks(root: string, server: string) {
  const directory = join(root, 'git-hooks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const hook = join(directory, 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(server) + ' git-hook pre-receive\n', { mode: 0o700 });
  chmodSync(hook, 0o700);
  return directory;
}
