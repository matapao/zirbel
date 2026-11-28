import { claimDirectory } from './service-lock.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import QRCode from 'qrcode';
import { atomicWrite, newId, Projects, ZirbelError } from '../core/projects.ts';
import { Releases } from '../core/releases.ts';
import { body, checkOrigin, fail, listen, refuseUpgrade, reply, requestUrl, secure, staticFile } from './http.ts';
import { ChatRuns } from './chat-runs.ts';
import { chatRequest, type ChatContext } from './chat-routes.ts';
import { accountDirectory } from './account.ts';
import { exitWithParent } from './parent.ts';
import { Threads } from './threads.ts';
import { turnTools } from './turn-tools.ts';
import { TurnServers } from './turn-mcp.ts';
import { chooseRenderer } from './browser-app.ts';
import { ActivityStore } from './activity-log.ts';
import { Rooms } from '../core/rooms.ts';
import { importReleases, Players, readLanHost, readPort, stopOnSignal } from './hosting.ts';
import { localHarnesses } from './local-harnesses.ts';
import type { Processors } from './processors.ts';
import { Mcp, stdioMcp } from './mcp.ts';
import { readGuides } from './mcp-guides.ts';
import { Pairing } from './box-pairing.ts';
import { boxDoor, boxHealth, boxHosts, boxRequest, isLoopback, onBoxNetwork, type Access, type BoxContext } from './box-routes.ts';
import { boxCapabilities, BoxHarnesses, BoxSettings } from './box-settings.ts';
import { ownLoopback } from './loopback-owner.ts';
import { BoxControllers } from './box-controllers.ts';
import { Editors } from './box-editors.ts';
import { editorsRequest } from './box-edit-routes.ts';
import { checkRole, whoIs } from './box-roles.ts';
import { requireGit } from '../core/git.ts';
import { authorOf } from './authors.ts';
import { gitRequest, writeHooks } from './git-http.ts';
import { gitRoutes } from './git-routes.ts';
import { processorRoutes } from './processor-routes.ts';
import { projectRoutes, type ProjectRoutes } from './project-routes.ts';
import { playRoutes, type PlayRoutes } from './play-routes.ts';
import { GitTokens } from './git-tokens.ts';
import { isSpacesPath, proxySpaces, proxySpacesUpgrade } from './spaces-proxy.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' }, port: { type: 'string' }, 'player-port': { type: 'string' },
    'lan': { type: 'boolean' }, 'enable-mcp': { type: 'boolean' }, box: { type: 'boolean' },
    'player-host': { type: 'string' }, 'pads-socket': { type: 'string' }, 'spaces-binary': { type: 'string' },
    release: { type: 'string', multiple: true }, import: { type: 'string', multiple: true },
    open: { type: 'boolean' }, help: { type: 'boolean' },
  },
});

const port = readPort(values.port ?? process.env.ZIRBEL_PORT ?? '4173');
const playerPort = readPort(values['player-port'] ?? process.env.ZIRBEL_PLAYER_PORT ?? '4174');
const lanHost = readLanHost(values['player-host'] ?? process.env.ZIRBEL_LAN_HOST);
const enableMcp = values['enable-mcp'] || process.env.ZIRBEL_ENABLE_MCP === '1';
// A box: the editor on its own network for paired devices (box-routes.ts), with the box's switches.
const boxMode = values.box || process.env.ZIRBEL_BOX === '1';
// Where the box's controller service brings its gamepads (pads-socket.ts).
const padsSocket = values['pads-socket'] || process.env.ZIRBEL_PADS_SOCKET;
const boot = newId();

function browser(url: string) {
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

// What the editor is built from: tests pass their own harnesses, the built web files and the account folder, where the
// threads' working folders are.
type EditorOptions = { harnesses?: (root: string) => Processors; webRoot?: string; account?: string };

async function start({ harnesses: harnessesFor = localHarnesses, webRoot = fileURLToPath(new URL('./web/', import.meta.url)),
  account = accountDirectory() }: EditorOptions) {
  const root = resolve(values.data ?? process.env.ZIRBEL_DATA ?? join(homedir(), '.zirbel'));
  // Every game is a git repository (AGENTS.md: The git store): no git, no editor.
  requireGit();
  // Built before the claim so a missing build fails without holding the directory.
  const projects = new Projects(root);
  const releases = new Releases(projects, webRoot);
  const rooms = new Rooms();
  let editorPort = port;
  // On a box, the lobby's players come from its own network, those who own it pair at the editor's /pair, and those
  // with a game's edit code redeem it at its /edit.
  const editorAt = (host: string) => 'http://' + host + (editorPort === 80 ? '' : ':' + editorPort);
  const players = new Players(rooms, releases, { playerPort, lanHost,
    spacesBinary: values['spaces-binary'] || process.env.ZIRBEL_SPACES_BINARY || undefined,
    qr: (link) => QRCode.toDataURL(link, { margin: 2, width: 240 }),
    box: boxMode ? { reach: { hosts: boxHosts, network: onBoxNetwork },
      pair: (host) => editorAt(host) + '/pair', edit: (host) => editorAt(host) + '/edit' } : undefined });
  const claim = claimDirectory(root, { pid: process.pid, port, boot, editor: true });
  if (!claim.owner) {
    if (claim.editor && claim.port) {
      const url = 'http://127.0.0.1:' + claim.port;
      try {
        const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(2000) });
        const info = await response.json() as { boot?: string };
        if (response.ok && info.boot === claim.boot) {
          if (values.open) browser(url + '/');
          console.log(JSON.stringify({ editor: url, pid: claim.pid, existing: true }));
          return;
        }
      } catch { /* Report the process holding the project directory. */ }
    }
    throw new Error('This project directory is owned by process ' + claim.pid + '.');
  }

  const { file: serviceFile, release: releaseDirectory } = claim;
  let editor: ReturnType<typeof createServer> | undefined;
  let closeHarnesses: (() => Promise<void>) | undefined;
  let closeTurns: (() => Promise<void>) | undefined;
  const requests = new Set<Promise<void>>();
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    editor?.close();
    editor?.closeAllConnections();
    // A running turn is interrupted, to be continued after the next start. Hold the directory claim until it and all
    // editor handlers and any LAN startup have settled.
    await closeTurns?.();
    await Promise.allSettled(requests);
    await closeHarnesses?.();
    await players.close();
    releaseDirectory();
  }

  try {
    projects.archiveLegacyPreviews();
    const migrated = projects.migrate();
    if (migrated) console.error('Zirbel kept ' + migrated + ' game' + (migrated === 1 ? '' : 's') + ' as git repositories; their old files are in ' +
      join(root, 'migrated-projects') + '.');
    // The check every push to a game runs before its branch moves, with the Node and the build running now.
    const hooks = writeHooks(root, join(webRoot, '..', 'server.mjs'));
    const chat = new ChatRuns();
    let box: BoxContext | undefined;
    let harnesses: Processors;
    if (boxMode) {
      // On a box, the harnesses are built only while their switch is on, and only where they are made for the system.
      const capabilities = boxCapabilities();
      const settings = new BoxSettings(join(account, 'box'), capabilities);
      const switched = new BoxHarnesses(() => harnessesFor(root), () => capabilities.harnesses && settings.read().harnesses);
      harnesses = switched;
      box = { pairing: new Pairing(join(account, 'box')), editors: new Editors(join(account, 'box')), settings, harnesses: switched,
        capabilities, port: () => editorPort, lobbyPort: () => players.lanPort, sharedHost: (host) => players.sharedHost(host),
        turns: () => chat.count, qr: (link) => QRCode.toDataURL(link, { margin: 2, width: 240 }),
        setupRequest: process.env.ZIRBEL_SETUP_REQUEST || '/run/zirbel-setup/request',
        ownNetwork: process.env.ZIRBEL_OWN_NETWORK || '/var/lib/zirbel-setup/own-network.json',
        tvWake: process.env.ZIRBEL_TV_WAKE || '/run/zirbel-tv/wake', ownLoopback,
        controllers: new BoxControllers(players.pads) };
    } else harnesses = harnessesFor(root);
    closeHarnesses = async () => { await harnesses.close?.(); };
    closeTurns = () => chat.close();
    const activity = new ActivityStore(root);
    const threads = new Threads(join(account, 'turns'), root);
    threads.interruptStale();
    // What a turn's folder links to and may read: three.js from this build, TypeScript and esbuild as installed.
    const { links, readable } = turnTools(webRoot);
    // Each turn's own MCP server, with view_game for its folder, on this loopback listener.
    const views = new TurnServers({ projects, releases, rooms, playerPort: () => players.local?.port, renderer: chooseRenderer() },
      () => editorOrigin() + '/turn-mcp');
    const chatContext: ChatContext = { projects, harnesses, chat, activity, threads, tools: { readable }, links, views };
    const mcp = new Mcp(projects, readGuides(webRoot));
    const tokens = box ? new GitTokens(join(account, 'box')) : undefined;
    const git = { projects, mcp, box, tokens, hooks };
    const gitApi = { projects, tokens, port: () => editorPort };
    importReleases(releases, values.import ?? []);

    const editorOrigin = () => 'http://127.0.0.1:' + editorPort;
    const mcpOn = () => enableMcp || Boolean(box?.settings.read().externalMcp);
    const projectApi: ProjectRoutes = { chatContext, releases, rooms, players, mcp, box, lanHost, mcpOn };
    const playApi: PlayRoutes = { releases, rooms, players };
    /** The editor's origin on the host name a device reached the box by, and on loopback. */
    const boxEditorOrigins = (host: string) => [editorAt(host), editorOrigin(), 'http://localhost:' + editorPort];
    async function editorRequest(request: IncomingMessage, response: ServerResponse) {
      secure(response);
      try {
        const url = requestUrl(request, editorPort, box ? boxHosts() : ['127.0.0.1', 'localhost']);
        let access: Access = { local: true };
        if (box) {
          const opened = await boxDoor(box, request, response, url);
          if (!opened) return;
          access = opened;
        }
        // The spaces kernel's paths, for the owner's pages (never an editor's of one game): the editor listener of
        // Zirbel's skalet.json, whose audience is the owner.
        if (isSpacesPath(url.pathname)) {
          if (access.editor) throw new ZirbelError(403, 'This is for the box\'s owners.');
          proxySpaces(() => players.spaces.target, 'editor', request, response);
          return;
        }
        // On a box, the player is reached on the host name the editor was.
        const playerHost = box ? url.hostname : undefined;
        const mcpRequest = mcpOn() && url.pathname === '/mcp';
        const turnRequest = url.pathname === '/turn-mcp';
        // MCP authenticates every request by project grant. Node HTTP clients can send
        // Sec-Fetch-Mode without Origin; browsers supplying Origin must still match this editor.
        if ((!mcpRequest && !turnRequest) || request.headers.origin !== undefined) checkOrigin(request);
        const local = players.local;
        if (!local || stopping) throw new ZirbelError(503, 'The editor is unavailable.');
        // A game's repository over git's smart HTTP, with its own credentials off a box (git-http.ts).
        if (await gitRequest(git, request, response, url, access)) return;
        const method = request.method;
        if (turnRequest) {
          // A turn's own server: its credential names the turn, and its tool reaches that turn's folder alone.
          if (method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          const result = await views.handle(await body(request, 64_000), request.headers.authorization);
          if (!result) { response.writeHead(202); response.end(); } else reply(response, result);
          return;
        }
        if (mcpRequest) {
          const credential = request.headers.authorization;
          mcp.verify(credential);
          if (method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          const message = await body(request);
          // Reading the request yields to the event loop. The owner can revoke a grant while we wait.
          const result = mcp.handle(message, credential);
          if (!result) { response.writeHead(202); response.end(); } else reply(response, result);
          return;
        }
        const [, prefix, resource, pathID, action, tail, ...extra] = url.pathname.split('/');
        if (prefix !== 'api') {
          if (method !== 'GET') throw new ZirbelError(404, 'Route does not exist.');
          const playerOrigin = 'http://' + (playerHost ?? '127.0.0.1') + ':' + local.port;
          response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src " + playerOrigin + "; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          staticFile(response, webRoot, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
          return;
        }
        if (extra.length) throw new ZirbelError(404, 'Route does not exist.');
        // On a box, an editor of one game uses that game's routes alone (box-roles.ts).
        checkRole(access, { method, resource, pathID, action, tail }, (room) => rooms.find(room)?.release.manifest.gameId);
        const only = access.editor?.game;
        if (resource === 'me' && !pathID && method === 'GET') { reply(response, whoIs(access)); return; }
        if (resource === 'health' && method === 'GET') {
          // chat: this editor runs harness chat and keeps each turn's activity; turns: how many are running.
          reply(response, { status: 'ok', pid: process.pid, boot, editor: editorOrigin(), mcp: mcpOn(), chat: true,
            turns: chat.count, ...(box ? { box: boxHealth(box) } : {}) });
          return;
        }
        if (resource === 'processors' && harnesses &&
          await processorRoutes(harnesses, request, response, access, { pathID, action, tail })) return;
        if (box && (resource === 'pairing' || resource === 'box') &&
          await boxRequest(box, request, response, access, { resource, pathID, action, tail })) return;
        if (resource === 'chat' && await chatRequest(chatContext, request, response, pathID, action, tail)) return;
        if (box && resource === 'projects' && await editorsRequest(box, projects, request, response, access, url, { pathID, action, tail })) return;
        if (resource === 'projects' && await gitRoutes(gitApi, request, response, access, url, { pathID, action, tail })) return;
        const author = authorOf(access);
        if (resource === 'projects' && await projectRoutes(projectApi, request, response, url, { pathID, action, tail },
          { author, only, playerHost })) return;
        if (await playRoutes(playApi, request, response, { resource, pathID, action }, { access, only, playerHost })) return;
        throw new ZirbelError(404, 'Editor route does not exist.');
      } catch (error) { fail(response, error); }
    }

    editor = createServer((request, response) => {
      const handling = editorRequest(request, response);
      requests.add(handling);
      void handling.then(() => requests.delete(handling), (error) => {
        requests.delete(handling);
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    // The spaces kernel's socket, for this device's own pages: a box's network reaches the editor with a session's cookie,
    // which only its requests carry through the door.
    editor.on('upgrade', (request, stream, head) => {
      const local = !box || (isLoopback(request.socket.remoteAddress) && ownLoopback(request.socket));
      try {
        const url = requestUrl(request, editorPort, box ? boxHosts() : ['127.0.0.1', 'localhost']);
        if (url.pathname !== '/.skalet/spaces' || !local) { refuseUpgrade(stream, 403, 'This socket is for this device\'s own pages.'); return; }
        proxySpacesUpgrade(() => players.spaces.target, 'editor', request, stream, head);
      } catch { stream.destroy(); }
    });
    // Long enough for a push of a game's history over a slow network (git-http.ts); headers still come within 10 s.
    editor.requestTimeout = 300_000;
    editor.headersTimeout = 10_000;
    editorPort = await listen(editor, port, box ? '::' : '127.0.0.1').catch((error: NodeJS.ErrnoException) => {
      // A box without IPv6 listens on IPv4 alone.
      if (!box || error.code !== 'EAFNOSUPPORT') throw error;
      return listen(editor!, port, '0.0.0.0');
    });
    await players.startSpaces();
    const local = box ? await players.openLocal(0, boxEditorOrigins, { hosts: boxHosts, network: onBoxNetwork })
      : await players.openLocal(0, [editorOrigin(), 'http://localhost:' + editorPort, ]);
    // A box's lobby is on its LAN listener, where its door sends the devices that aren't paired.
    if (values.lan || box) await players.startLan();
    if (padsSocket) await players.listenForPads(padsSocket);
    for (const id of values.release ?? []) console.log(JSON.stringify(await players.start(id, Boolean(values.lan))));
    const info = { pid: process.pid, port: editorPort, boot, editor: true };
    atomicWrite(serviceFile, JSON.stringify(info));
    console.log(JSON.stringify({ pid: process.pid, data: root, editor: editorOrigin(),
      player: 'http://127.0.0.1:' + local.port, mcp: mcpOn(), ...(box ? { box: true } : {}) }));
    if (values.open) browser(editorOrigin() + '/');
    process.once('SIGINT', () => void stopOnSignal(stop));
    process.once('SIGTERM', () => void stopOnSignal(stop));
    exitWithParent(stop);
  } catch (error) { await stop(); throw error; }
}

/** Runs the command line: the editor, `--help` or the stdio MCP bridge. */
export async function main(options: EditorOptions = {}) {
  try {
    if (values.help) console.log('Zirbel\n  start: [--data DIR] [--port PORT] [--open] [--enable-mcp] [--box] [--pads-socket PATH] [--spaces-binary PATH]\n  host: --host-only [--lan] [--player-port PORT] [--player-host HOST] [--pads-socket PATH] [--spaces-binary PATH] [--import FILE] [--release ID]\n  mcp: set ZIRBEL_MCP_TOKEN and optional ZIRBEL_MCP_URL');
    else if (positionals[0] === 'mcp') await stdioMcp(process.env.ZIRBEL_MCP_URL ?? 'http://127.0.0.1:4173/mcp', z.string().min(1).parse(process.env.ZIRBEL_MCP_TOKEN));
    else if (positionals.length) throw new Error('Unknown command. Use --help.');
    else await start(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
