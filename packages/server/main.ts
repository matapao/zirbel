import { claimDirectory } from './service-lock.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import QRCode from 'qrcode';
import { attachment, asset, distribution, id, lobbyOffer, PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { assertCurrent, atomicWrite, mediaMatches, newId, Projects, safeId, ZirbelError } from '../core/projects.ts';
import { Releases } from '../core/releases.ts';
import { importGameFolder } from '../core/game-files.ts';
import { body, bytes, checkOrigin, fail, lanAddresses, listen, reply, requestUrl, secure, staticFile } from './http.ts';
import { ChatRuns } from './chat-runs.ts';
import { chatRequest, projectChat, type ChatContext } from './chat-routes.ts';
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
import { modelId, processorId, type Processors } from './processors.ts';
import { Mcp, stdioMcp } from './mcp.ts';
import { readGuides } from './mcp-guides.ts';
import { Pairing } from './box-pairing.ts';
import { boxDoor, boxHealth, boxHosts, boxRequest, onBoxNetwork, type Access, type BoxContext } from './box-routes.ts';
import { boxCapabilities, BoxHarnesses, BoxSettings } from './box-settings.ts';
import { Editors } from './box-editors.ts';
import { editorsRequest } from './box-edit-routes.ts';
import { checkRole, whoIs } from './box-roles.ts';
import { requireGit } from '../core/git.ts';
import { authorOf } from './authors.ts';
import { gitRequest, writeHooks } from './git-http.ts';
import { gitRoutes } from './git-routes.ts';
import { GitTokens } from './git-tokens.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' }, port: { type: 'string' }, 'player-port': { type: 'string' },
    'lan': { type: 'boolean' }, 'enable-mcp': { type: 'boolean' }, box: { type: 'boolean' },
    'player-host': { type: 'string' }, 'pads-socket': { type: 'string' },
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

const branchInput = z.object({ branch: id.default('main') });
const scope = branchInput.extend({ baseRevision: id });
const permissionsInput = branchInput.extend({ baseRevision: id.optional(), permissions: distribution });
const assetMetadata = asset.omit({ id: true, hash: true });
const shareDefaults = { play: true, download: true, remix: true };

// What the editor is built from: tests pass their own harnesses, the built web files and the account folder, where the
// threads' working folders are.
type EditorOptions = { harnesses?: (root: string) => Processors; webRoot?: string; account?: string };

async function start({ harnesses: harnessesFor = localHarnesses, webRoot = fileURLToPath(new URL('./web/', import.meta.url)),
  account = accountDirectory() }: EditorOptions) {
  const root = resolve(values.data ?? process.env.ZIRBEL_DATA ?? join(homedir(), '.zirbel'));
  // Every game is a git repository (docs/git-store.md): no git, no editor.
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
        ownNetwork: process.env.ZIRBEL_OWN_NETWORK || '/var/lib/zirbel-setup/own-network.json' };
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
        if (resource === 'processors' && harnesses) {
          if (!pathID && method === 'GET') {
            reply(response, { processors: await harnesses.list() }); return;
          }
          if (action === 'model-settings' && !tail && method === 'POST' && harnesses.settings) {
            checkOrigin(request, true);
            const { model } = z.strictObject({ model: modelId.optional() }).parse(await body(request, 4096));
            const disconnected = new AbortController();
            response.once('close', () => disconnected.abort(new ZirbelError(409, 'The model settings request closed.')));
            const settings = await harnesses.settings(processorId.parse(pathID), model, disconnected.signal);
            if (!response.destroyed) reply(response, settings);
            return;
          }
          if (action === 'sign-in' && !tail && method === 'GET' && harnesses.signInStatus) {
            reply(response, harnesses.signInStatus(processorId.parse(pathID))); return;
          }
          if (action === 'sign-in' && !tail && method === 'POST' && harnesses.beginSignIn && harnesses.submitSignInCode) {
            checkOrigin(request, true);
            const processor = processorId.parse(pathID);
            const { code } = z.strictObject({ code: z.string().trim().min(1).max(2048).regex(/^\S+$/).optional() }).parse(await body(request));
            // On a box, a paired device signs in from elsewhere than the box the harness runs on.
            reply(response, code === undefined ? await harnesses.beginSignIn(processor, { elsewhere: !access.local })
              : harnesses.submitSignInCode(processor, code));
            return;
          }
        }
        if (box && (resource === 'pairing' || resource === 'box') &&
          await boxRequest(box, request, response, access, { resource, pathID, action, tail })) return;
        if (resource === 'chat' && await chatRequest(chatContext, request, response, pathID, action, tail)) return;
        if (box && resource === 'projects' && await editorsRequest(box, projects, request, response, access, url, { pathID, action, tail })) return;
        if (resource === 'projects' && await gitRoutes(gitApi, request, response, access, url, { pathID, action, tail })) return;
        const author = authorOf(access);
        if (resource === 'projects') {
          if (!pathID && method === 'GET') {
            reply(response, projects.summaries().filter((game) => !only || game.id === only)); return;
          }
          if (!pathID && method === 'POST') {
            const input = z.strictObject({ title: z.string().optional() }).parse(await body(request));
            reply(response, projects.createGame(input.title, undefined, author), 201); return;
          }
          if (pathID === 'import-game' && method === 'POST') {
            reply(response, importGameFolder(projects, await body(request, PORTABLE_FILE_LIMIT), author), 201); return;
          }
          if (pathID === 'import' && method === 'POST') {
            reply(response, projects.import(await body(request, PORTABLE_FILE_LIMIT), author), 201); return;
          }
          const projectId = safeId(pathID);
          if (!action && method === 'GET') { reply(response, projects.read(projectId)); return; }
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
            return;
          }
          if (action === 'title' && method === 'POST') {
            const { title } = z.strictObject({ title: z.string() }).parse(await body(request));
            reply(response, projects.rename(projectId, title)); return;
          }
          if (action === 'proposals' && method === 'GET') {
            reply(response, tail ? projects.preview(projectId, safeId(tail)) :
              projects.proposals(projectId, safeId(url.searchParams.get('branch') ?? 'main'))); return;
          }
          if (action === 'proposals' && method === 'POST') { reply(response, projects.submit(projectId, await body(request), false, author), 201); return; }
          if (action === 'discard' && method === 'POST') { projects.discard(projectId, safeId(tail)); reply(response, {}); return; }
          if (action === 'apply' && method === 'POST') {
            const { fork } = z.strictObject({ fork: id.optional() }).parse(await body(request));
            reply(response, projects.commit(projectId, safeId(tail), fork)); return;
          }
          if (action === 'restore' && method === 'POST') {
            const input = scope.extend({ target: id }).parse(await body(request));
            reply(response, projects.restore(projectId, input.branch, input.baseRevision, input.target, author)); return;
          }
          if (await projectChat(chatContext, request, response, url, projectId, action, tail, author)) return;
          if (action === 'notes' && method === 'POST') { reply(response, projects.addNote(projectId, await body(request)), 201); return; }
          if (action === 'media' && method === 'POST' && !tail) {
            const { data, ...input } = attachment.omit({ id: true }).extend({ data: z.string().max(24_000_000) })
              .parse(await body(request, 25_000_000));
            const file = Buffer.from(data, 'base64');
            if (!mediaMatches(input.media, file)) throw new ZirbelError(400, 'The attachment does not match its media type.');
            reply(response, projects.addMedia(projectId, input, file), 201); return;
          }
          if (action === 'media' && method === 'GET' && tail) {
            const file = projects.readMedia(projectId, safeId(tail));
            bytes(response, file.bytes, file.item.media); return;
          }
          if (action === 'media' && method === 'POST' && tail) {
            const { transcript, intent } = attachment.pick({ transcript: true, intent: true }).parse(await body(request));
            reply(response, projects.editTranscript(projectId, safeId(tail), transcript, intent)); return;
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
            return;
          }
          if (action === 'export' && method === 'GET') {
            reply(response, projects.export(projectId), 200, { 'content-disposition': 'attachment; filename="zirbel-project.json"' });
            return;
          }
          if (action === 'release' && method === 'POST') {
            const input = permissionsInput.parse(await body(request));
            if (input.baseRevision) assertCurrent(projects.read(projectId), input.branch, input.baseRevision);
            reply(response, releases.package(projectId, input.branch, input.permissions, true).manifest, 201); return;
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
            reply(response, await players.describe(rooms.create(release, false, 'lan', true), playerHost), 201);
            return;
          }
          if (action === 'playtest' && method === 'POST') {
            const input = branchInput.extend({ proposalId: id.optional(), baseRevision: id.optional() }).parse(await body(request));
            if (input.baseRevision) assertCurrent(projects.read(projectId), input.branch, input.baseRevision);
            // Draft play stays on loopback. Delivery rights are checked when sharing or exporting.
            const release = releases.package(projectId, input.branch, shareDefaults, false, true, input.proposalId);
            reply(response, players.solo(release, playerHost), 201); return;
          }
          if (action === 'grants' && mcpOn()) {
            if (method === 'POST' && !tail) {
              const input = z.strictObject({ write: z.boolean(), hours: z.number() }).parse(await body(request));
              reply(response, mcp.create({ ...input, projectId }), 201); return;
            }
            if (method === 'POST' && tail) { mcp.revoke(projectId, safeId(tail)); reply(response, {}); return; }
            if (method === 'GET') { reply(response, mcp.list(projectId)); return; }
          }
        }
        if (resource === 'releases') {
          if (method === 'GET' && !pathID) { reply(response, releases.list()); return; }
          if (method === 'POST' && pathID && action === 'play') {
            const release = releases.read(pathID);
            if (!release.manifest.permissions.play) throw new ZirbelError(403, 'The creator has disabled play for this release.');
            reply(response, players.solo(release, playerHost), 201); return;
          }
          if (method === 'GET' && pathID && action === 'download') {
            const release = releases.read(pathID);
            if (!release.manifest.permissions.download) throw new ZirbelError(403, 'The creator has disabled downloads.');
            reply(response, release, 200, { 'content-disposition': 'attachment; filename="zirbel-release.json"' }); return;
          }
          if (method === 'POST' && pathID === 'import') { reply(response, releases.import(await body(request, PORTABLE_FILE_LIMIT)).manifest, 201); return; }
          if (method === 'POST' && pathID && action === 'remix') { reply(response, releases.remix(pathID, authorOf(access)), 201); return; }
        }
        if (resource === 'lobby' && !action) {
          if (method === 'GET' && !pathID) {
            reply(response, { offered: players.lobby.offered(), link: players.lobbyLink(playerHost) }); return;
          }
          if (method === 'POST' && pathID === 'offer') {
            const input = lobbyOffer.parse(await body(request, 4096));
            reply(response, players.lobby.offer(input.release, input.offered)); return;
          }
        }
        if (resource === 'rooms') {
          if (method === 'GET' && !pathID) {
            reply(response, rooms.list().filter((room) => !only || room.manifest.gameId === only)); return;
          }
          if (method === 'POST' && !pathID) {
            const input = z.strictObject({ releaseId: id, lan: z.boolean() }).parse(await body(request));
            reply(response, await players.start(input.releaseId, input.lan, playerHost), 201); return;
          }
          if (method === 'GET' && pathID && action === 'link') { reply(response, await players.describe(rooms.get(pathID), playerHost)); return; }
          if (method === 'POST' && pathID && action === 'close') { rooms.close(pathID); reply(response, {}); return; }
        }
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
    // Long enough for a push of a game's history over a slow network (git-http.ts); headers still come within 10 s.
    editor.requestTimeout = 300_000;
    editor.headersTimeout = 10_000;
    editorPort = await listen(editor, port, box ? '::' : '127.0.0.1').catch((error: NodeJS.ErrnoException) => {
      // A box without IPv6 listens on IPv4 alone.
      if (!box || error.code !== 'EAFNOSUPPORT') throw error;
      return listen(editor!, port, '0.0.0.0');
    });
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
    if (values.help) console.log('Zirbel\n  start: [--data DIR] [--port PORT] [--open] [--enable-mcp] [--box] [--pads-socket PATH]\n  host: --host-only [--lan] [--player-port PORT] [--player-host HOST] [--pads-socket PATH] [--import FILE] [--release ID]\n  mcp: set ZIRBEL_MCP_TOKEN and optional ZIRBEL_MCP_URL');
    else if (positionals[0] === 'mcp') await stdioMcp(process.env.ZIRBEL_MCP_URL ?? 'http://127.0.0.1:4173/mcp', z.string().min(1).parse(process.env.ZIRBEL_MCP_TOKEN));
    else if (positionals.length) throw new Error('Unknown command. Use --help.');
    else await start(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
