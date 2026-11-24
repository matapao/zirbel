import { claimDirectory } from './service-lock.ts';
import { objectRegistry } from '../sdk/game.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import QRCode from 'qrcode';
import { attachment, asset, distribution, id, PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { assertCurrent, atomicWrite, head, mediaMatches, newId, Projects, safeId, ZirbelError } from '../core/projects.ts';
import { runHarnessChat, runWorkspaceChat, workspaceHistory } from './harness-chat.ts';
import { Releases } from '../core/releases.ts';
import { body, bytes, checkOrigin, fail, lanAddresses, listen, reply, requestUrl, secure, staticFile } from './http.ts';
import { ChatRuns } from './chat-runs.ts';
import { Rooms } from '../core/rooms.ts';
import { importReleases, Players, readLanHost, readPort, stopOnSignal } from './hosting.ts';
import { localHarnesses } from './local-harnesses.ts';
import { modelId, modelSelection, processorId, type Processors } from './processors.ts';
import { Mcp, stdioMcp } from './mcp.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' }, port: { type: 'string' }, 'player-port': { type: 'string' },
    'lan': { type: 'boolean' }, 'enable-mcp': { type: 'boolean' },
    'player-host': { type: 'string' },
    release: { type: 'string', multiple: true }, import: { type: 'string', multiple: true },
    open: { type: 'boolean' }, help: { type: 'boolean' },
  },
});

const port = readPort(values.port ?? process.env.ZIRBEL_PORT ?? '4173');
const playerPort = readPort(values['player-port'] ?? process.env.ZIRBEL_PLAYER_PORT ?? '4174');
const lanHost = readLanHost(values['player-host'] ?? process.env.ZIRBEL_LAN_HOST);
const enableMcp = values['enable-mcp'] || process.env.ZIRBEL_ENABLE_MCP === '1';
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

// What the editor is built from: tests pass their own harnesses and the built web files.
type EditorOptions = { harnesses?: (root: string) => Processors; webRoot?: string };

async function start({ harnesses: harnessesFor = localHarnesses, webRoot = fileURLToPath(new URL('./web/', import.meta.url)) }: EditorOptions) {
  const root = resolve(values.data ?? process.env.ZIRBEL_DATA ?? join(homedir(), '.zirbel'));
  // Built before the claim so a missing build fails without holding the directory.
  const projects = new Projects(root);
  const releases = new Releases(projects, webRoot);
  const rooms = new Rooms();
  const players = new Players(rooms, releases, { playerPort, lanHost,
    qr: (link) => QRCode.toDataURL(link, { margin: 2, width: 240 }) });
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
  const requests = new Set<Promise<void>>();
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    editor?.close();
    editor?.closeAllConnections();
    // A disconnected chat can still finish and save. Hold the directory claim
    // until all editor handlers and any LAN startup have settled.
    await Promise.allSettled(requests);
    await players.close();
    releaseDirectory();
  }

  try {
    projects.archiveLegacyPreviews();
    const harnesses = harnessesFor(root);
    const chat = new ChatRuns();
    const mcp = new Mcp(projects);
    importReleases(releases, values.import ?? []);

    let editorPort = port;
    const editorOrigin = () => 'http://127.0.0.1:' + editorPort;
    async function editorRequest(request: IncomingMessage, response: ServerResponse) {
      secure(response);
      try {
        const url = requestUrl(request, editorPort, ['127.0.0.1', 'localhost']);
        const mcpRequest = enableMcp && url.pathname === '/mcp';
        // MCP authenticates every request by project grant. Node HTTP clients can send
        // Sec-Fetch-Mode without Origin; browsers supplying Origin must still match this editor.
        if (!mcpRequest || request.headers.origin !== undefined) checkOrigin(request);
        const local = players.local;
        if (!local || stopping) throw new ZirbelError(503, 'The editor is unavailable.');
        const method = request.method;
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
          const playerOrigin = 'http://127.0.0.1:' + local.port;
          response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src " + playerOrigin + "; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          staticFile(response, webRoot, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
          return;
        }
        if (extra.length) throw new ZirbelError(404, 'Route does not exist.');
        if (resource === 'health' && method === 'GET') {
          reply(response, { status: 'ok', pid: process.pid, boot, editor: editorOrigin(), mcp: Boolean(enableMcp) });
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
            reply(response, code === undefined ? await harnesses.beginSignIn(processor) : harnesses.submitSignInCode(processor, code));
            return;
          }
        }
        if (resource === 'chat' && method === 'POST' && harnesses) {
          if (!pathID) {
            const input = z.strictObject({ text: z.string().trim().min(1).max(3000),
              provider: processorId, conversation: workspaceHistory.default([]), registerObjects: z.boolean().default(true),
              modelSettings: modelSelection.optional() }).parse(await body(request));
            await chat.reply(request, response, (run) => runWorkspaceChat(harnesses, input.provider, projects, input.text,
              input.conversation, { ...run, selection: input.modelSettings }, input.registerObjects));
            return;
          }
          if (action === 'stop' && !tail) {
            checkOrigin(request, true);
            chat.stop(safeId(pathID));
            reply(response, {});
            return;
          }
          if (action === 'actions' && tail) {
            checkOrigin(request, true);
            chat.answer(safeId(pathID), safeId(tail), await body(request, 64_000));
            reply(response, {});
            return;
          }
        }
        if (resource === 'projects') {
          if (!pathID && method === 'GET') { reply(response, projects.summaries()); return; }
          if (!pathID && method === 'POST') {
            const input = z.strictObject({ title: z.string().optional() }).parse(await body(request));
            reply(response, projects.createGame(input.title), 201); return;
          }
          if (pathID === 'import' && method === 'POST') {
            reply(response, projects.import(await body(request, PORTABLE_FILE_LIMIT)), 201); return;
          }
          const projectId = safeId(pathID);
          if (!action && method === 'GET') { reply(response, projects.read(projectId)); return; }
          if (action === 'remove' && !tail && method === 'POST') {
            projects.remove(projectId);
            rooms.closeProject(projectId);
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
          if (action === 'proposals' && method === 'POST') { reply(response, projects.submit(projectId, await body(request)), 201); return; }
          if (action === 'discard' && method === 'POST') { projects.discard(projectId, safeId(tail)); reply(response, {}); return; }
          if (action === 'apply' && method === 'POST') {
            const { fork } = z.strictObject({ fork: id.optional() }).parse(await body(request));
            reply(response, projects.commit(projectId, safeId(tail), fork)); return;
          }
          if (action === 'restore' && method === 'POST') {
            const input = scope.extend({ target: id }).parse(await body(request));
            reply(response, projects.restore(projectId, input.branch, input.baseRevision, input.target)); return;
          }
          if (action === 'prompt' && method === 'POST' && harnesses) {
            const input = scope.extend({
              text: z.string().trim().min(1).max(3000), references: z.array(z.unknown()).max(32).default([]),
              attachments: z.array(id).max(12).default([]), proposalId: id.optional(), playing: z.boolean().default(false),
              provider: processorId, registerObjects: z.boolean().default(true), modelSettings: modelSelection.optional(),
              objects: objectRegistry.optional(), markedIds: z.array(z.string().max(120)).max(32).optional(),
            }).parse(await body(request));
            if (input.attachments.length) throw new ZirbelError(422, 'Harness chat accepts text and marked references.');
            const references = projects.select(projectId, input.branch, input.baseRevision, input.references);
            const project = projects.read(projectId);
            const base = head(project, input.branch);
            await chat.reply(request, response, (run) => {
              const note = projects.addNote(projectId, { text: input.text, branch: input.branch, role: 'creator', references, attachments: [] });
              run.update?.({ type: 'note', note });
              return runHarnessChat(harnesses, input.provider, projects, project, base, input, references,
                { ...run, selection: input.modelSettings });
            }, 201);
            return;
          }
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
              operations: [{ op: 'addAsset', asset: { ...metadata, id: newId(), hash } }] }), 201);
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
            reply(response, await players.describe(rooms.create(release, false, 'lan', true)), 201);
            return;
          }
          if (action === 'playtest' && method === 'POST') {
            const input = branchInput.extend({ proposalId: id.optional(), baseRevision: id.optional() }).parse(await body(request));
            if (input.baseRevision) assertCurrent(projects.read(projectId), input.branch, input.baseRevision);
            // Draft play stays on loopback. Delivery rights are checked when sharing or exporting.
            const release = releases.package(projectId, input.branch, shareDefaults, false, true, input.proposalId);
            reply(response, players.solo(release), 201); return;
          }
          if (action === 'grants' && enableMcp) {
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
            reply(response, players.solo(release), 201); return;
          }
          if (method === 'GET' && pathID && action === 'download') {
            const release = releases.read(pathID);
            if (!release.manifest.permissions.download) throw new ZirbelError(403, 'The creator has disabled downloads.');
            reply(response, release, 200, { 'content-disposition': 'attachment; filename="zirbel-release.json"' }); return;
          }
          if (method === 'POST' && pathID === 'import') { reply(response, releases.import(await body(request, PORTABLE_FILE_LIMIT)).manifest, 201); return; }
          if (method === 'POST' && pathID && action === 'remix') { reply(response, releases.remix(pathID), 201); return; }
        }
        if (resource === 'rooms') {
          if (method === 'GET' && !pathID) { reply(response, rooms.list()); return; }
          if (method === 'POST' && !pathID) {
            const input = z.strictObject({ releaseId: id, lan: z.boolean() }).parse(await body(request));
            reply(response, await players.start(input.releaseId, input.lan), 201); return;
          }
          if (method === 'GET' && pathID && action === 'link') { reply(response, await players.describe(rooms.get(pathID))); return; }
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
    editor.requestTimeout = 25_000;
    editor.headersTimeout = 10_000;
    editorPort = await listen(editor, port, '127.0.0.1');
    const local = await players.openLocal(0, [editorOrigin(), 'http://localhost:' + editorPort, ]);
    if (values.lan) await players.startLan();
    for (const id of values.release ?? []) console.log(JSON.stringify(await players.start(id, Boolean(values.lan))));
    const info = { pid: process.pid, port: editorPort, boot, editor: true };
    atomicWrite(serviceFile, JSON.stringify(info));
    console.log(JSON.stringify({ pid: process.pid, data: root, editor: editorOrigin(),
      player: 'http://127.0.0.1:' + local.port, mcp: Boolean(enableMcp) }));
    if (values.open) browser(editorOrigin() + '/');
    process.once('SIGINT', () => void stopOnSignal(stop));
    process.once('SIGTERM', () => void stopOnSignal(stop));
  } catch (error) { await stop(); throw error; }
}

/** Runs the command line: the editor, `--help` or the stdio MCP bridge. */
export async function main(options: EditorOptions = {}) {
  try {
    if (values.help) console.log('Zirbel\n  start: [--data DIR] [--port PORT] [--open] [--enable-mcp]\n  host: --host-only [--lan] [--player-port PORT] [--player-host HOST] [--import FILE] [--release ID]\n  mcp: set ZIRBEL_MCP_TOKEN and optional ZIRBEL_MCP_URL');
    else if (positionals[0] === 'mcp') await stdioMcp(process.env.ZIRBEL_MCP_URL ?? 'http://127.0.0.1:4173/mcp', z.string().min(1).parse(process.env.ZIRBEL_MCP_TOKEN));
    else if (positionals.length) throw new Error('Unknown command. Use --help.');
    else await start(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
