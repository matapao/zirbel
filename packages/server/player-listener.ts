import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Peer, Room, Rooms } from '../core/rooms.ts';
import { ZirbelError } from '../core/projects.ts';
import { ClientMessage } from '../sdk/contracts.ts';
import { gamePage } from './game-page.ts';
import { body, bytes, checkOrigin, contentType, fail, lanAddresses, listen, reply, requestUrl, secure, typeFor } from './http.ts';

const privateAddress = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.|127\.)/;

const gzipAsync = promisify(gzip);
const acceptsGzip = (request: IncomingMessage) => /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
const IMMUTABLE = 'private, max-age=31536000, immutable';

// Runtime files are fixed for the life of the process. Hash and gzip each once,
// off the event loop, and share the result between the local and LAN listeners.
type RuntimeEntry = { etag: string; gzip?: Buffer };
const prepared = new WeakMap<ReadonlyMap<string, Buffer>, Map<string, RuntimeEntry>>();
function prepareRuntime(runtime: ReadonlyMap<string, Buffer>) {
  let entries = prepared.get(runtime);
  if (entries) return entries;
  entries = new Map();
  prepared.set(runtime, entries);
  for (const [name, file] of runtime) {
    const entry: RuntimeEntry = { etag: '"' + createHash('sha256').update(file).digest('base64url') + '"' };
    entries.set(name, entry);
    if (/\.(?:js|css|html|txt)$/.test(name) && file.length > 1024)
      gzipAsync(file).then((data) => { entry.gzip = data; }, () => {});
  }
  return entries;
}

function sendImmutable(request: IncomingMessage, response: ServerResponse, body: Buffer, type: string, entry: RuntimeEntry) {
  const headers = { 'content-type': type, 'cache-control': IMMUTABLE, etag: entry.etag, vary: 'accept-encoding' };
  if (request.headers['if-none-match'] === entry.etag) { response.writeHead(304, headers); response.end(); return; }
  const compressed = entry.gzip && acceptsGzip(request) ? entry.gzip : undefined;
  response.writeHead(200, compressed ? { ...headers, 'content-encoding': 'gzip' } : headers);
  response.end(compressed ?? body);
}

// The game page embeds its assets (up to tens of MB), so build and gzip it once
// per room and origin rather than on every load.
type GamePage = { policy: string; html: string; gzip: Promise<Buffer> };
const gamePages = new WeakMap<Room, Map<string, GamePage>>();
function cachedGamePage(room: Room, origin: string, ancestors: string) {
  const byOrigin = gamePages.get(room) ?? new Map<string, GamePage>();
  gamePages.set(room, byOrigin);
  let page = byOrigin.get(origin);
  if (!page) {
    const built = gamePage(room.release, origin + '/runtime/' + room.id + '/', ancestors);
    const created: GamePage = { ...built, gzip: gzipAsync(built.html) };
    created.gzip.catch(() => byOrigin.delete(origin));
    byOrigin.set(origin, created);
    page = created;
  }
  return page;
}

const reserveSchema = z.strictObject({
  invite: z.string().regex(/^[a-zA-Z0-9_-]{32}$/), name: z.string().trim().min(1).max(24),
  role: z.enum(['player', 'spectator']),
});

export async function playerListener(rooms: Rooms, runtime: ReadonlyMap<string, Buffer>, config: {
  port: number; bind: string; lan: boolean; editorOrigins?: string[]; extraHosts?: string[];
}) {
  let port: number;
  const hosts = () => ['localhost', '127.0.0.1', ...(config.lan ? lanAddresses() : []), ...(config.extraHosts ?? [])];
  const allows = (room: { access: 'local' | 'lan' }) => {
    if (room.access !== (config.lan ? 'lan' : 'local'))
      throw new ZirbelError(404, 'This room is unavailable on this listener.');
  };
  const isLocalNetwork = (request: IncomingMessage) => !config.lan ||
    privateAddress.test(request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '');
  const runtimeFile = (name: string) => {
    const file = runtime.get(name);
    if (!file) throw new ZirbelError(404, 'Runtime file does not exist.');
    return file;
  };
  const playerPage = runtimeFile('player.html').toString('utf8');
  const runtimeEntries = prepareRuntime(runtime);
  async function handle(request: IncomingMessage, response: ServerResponse) {
    secure(response);
    try {
      if (!isLocalNetwork(request)) throw new ZirbelError(403, 'LAN access requires a local network address.');
      const url = requestUrl(request, port, hosts());
      const [, route, roomId, ...parts] = url.pathname.split('/');
      if (request.method === 'GET' && url.pathname === '/health') { reply(response, { status: 'ok', role: 'player' }); return; }
      if (!roomId) throw new ZirbelError(404, 'Open the invitation link from the host.');
      const room = rooms.get(roomId);
      allows(room);
      const frame = config.lan ? "'none'" : ["'self'", ...(config.editorOrigins ?? [])].join(' ');
      const playerPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;" +
        // The LAN player is plain HTTP by design, so its room socket is ws: on this same host.
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        " connect-src 'self' ws://" + url.host + "; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors " + frame;
      response.setHeader('content-security-policy', playerPolicy);
      if (route === 'game' && request.method === 'GET' && parts.length === 1 && room.release.game && parts[0] === room.documentKey) {
        const ancestors = ["'self'", ...(config.editorOrigins ?? [])].join(' ');
        const page = cachedGamePage(room, url.origin, ancestors);
        response.setHeader('content-security-policy', page.policy);
        response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        if (!acceptsGzip(request)) { bytes(response, page.html, contentType.html!); return; }
        bytes(response, await page.gzip, contentType.html!, { 'content-encoding': 'gzip', vary: 'accept-encoding' });
        return;
      }
      if (route === 'join' && !parts.length && request.method === 'GET') {
        const html = playerPage.replace('<head>', '<head><base href="/runtime/' + room.id + '/">');
        bytes(response, html, contentType.html!);
        return;
      }
      if (route === 'rooms' && parts[0] === 'info' && parts.length === 1 && request.method === 'GET') {
        if (!room.mayView((request.headers.authorization ?? '').replace(/^Bearer /, '')))
          throw new ZirbelError(403, 'An invitation or current seat is required.');
        reply(response, { ...room.summary(), scene: room.release.scene,
          registerObjects: room.release.game?.registerObjects,
          gameUrl: room.release.game ? '/game/' + room.id + '/' + room.documentKey : undefined });
        return;
      }
      if (route === 'rooms' && parts[0] === 'reserve' && parts.length === 1 && request.method === 'POST') {
        checkOrigin(request, true);
        const input = reserveSchema.parse(await body(request, 4096));
        reply(response, { ticket: room.reserve(input.invite, input.name, input.role) }, 201);
        return;
      }
      if (route === 'runtime' && request.method === 'GET') {
        const name = parts.join('/');
        // Game assets are inlined as data URLs in the game page; only runtime files are served here.
        if (name === 'three.module.js' || name === 'game-sdk.js') response.setHeader('access-control-allow-origin', '*');
        sendImmutable(request, response, runtimeFile(name), typeFor(name), runtimeEntries.get(name)!);
        return;
      }
      throw new ZirbelError(404, 'Player route does not exist.');
    } catch (error) { fail(response, error); }
  }
  const player = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  player.requestTimeout = 20_000;
  player.headersTimeout = 10_000;
  // 24 rooms with up to eight seats each, plus room for page loads and handshakes.
  player.maxConnections = 256;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false, autoPong: false });
  const handshakes = new Set<WebSocket>();
  const waitingForPong = new WeakSet<WebSocket>();
  player.on('upgrade', (request, stream, head) => {
    try {
      if (!isLocalNetwork(request)) throw new ZirbelError(403, 'LAN access requires a local network address.');
      const url = requestUrl(request, port, hosts());
      const match = /^\/rooms\/([a-z0-9]+)\/socket$/.exec(url.pathname);
      if (!match?.[1]) throw new ZirbelError(404, 'Room socket does not exist.');
      checkOrigin(request, true);
      const room = rooms.get(match[1]);
      allows(room);
      if (handshakes.size >= 32) { stream.destroy(); return; }
      sockets.handleUpgrade(request, stream, head, (socket) => {
        handshakes.add(socket);
        socket.on('pong', () => waitingForPong.delete(socket));
        let pongPending = false;
        socket.on('ping', (payload) => {
          if (pongPending || socket.readyState !== WebSocket.OPEN) return;
          pongPending = true;
          socket.pong(payload, false, (error) => {
            pongPending = false;
            if (error) socket.terminate();
          });
        });
        let seat: string | undefined;
        let received = 0;
        let window = Date.now();
        const timeout = setTimeout(() => socket.terminate(), 5000);
        const peer: Peer = {
          send(message) {
            if (socket.readyState !== WebSocket.OPEN) return;
            if (socket.bufferedAmount > 256_000) { socket.close(1008, 'Slow connection'); return; }
            socket.send(JSON.stringify(message));
          },
          close(code = 1000) { socket.close(code); },
        };
        socket.on('error', () => socket.terminate());
        socket.on('message', (data, binary) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - window > 1000) { window = Date.now(); received = 0; }
          if (++received > 60 || binary || !Buffer.isBuffer(data)) { socket.close(1008, 'Unsupported traffic'); return; }
          let value: unknown;
          try { value = JSON.parse(data.toString('utf8')); } catch { socket.close(1007, 'Invalid JSON'); return; }
          const message = ClientMessage.safeParse(value);
          if (!message.success) {
            peer.send({ type: 'error', code: 'protocol', message: 'Invalid message or protocol version.' });
            if (!seat) socket.close(1008, 'Protocol mismatch');
            return;
          }
          if (!seat) {
            if (message.data.type !== 'hello') { socket.close(1008, 'Expected handshake'); return; }
            seat = room.connect(message.data, peer);
            if (seat) { clearTimeout(timeout); handshakes.delete(socket); }
            else socket.close(1008, 'Join failed');
          } else room.message(seat, peer, message.data);
        });
        socket.on('close', () => {
          clearTimeout(timeout);
          handshakes.delete(socket);
          if (seat) room.disconnected(seat, peer);
        });
      });
    } catch { stream.destroy(); }
  });
  port = await listen(player, config.port, config.bind);
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (waitingForPong.has(socket)) { socket.terminate(); continue; }
      waitingForPong.add(socket);
      socket.ping();
    }
  }, 30_000).unref();
  return {
    port, server: player,
    close() {
      clearInterval(heartbeat);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      player.close();
      player.closeAllConnections();
    },
  };
}
