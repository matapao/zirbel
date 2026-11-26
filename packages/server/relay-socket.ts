// /mp on a player listener: the WebSocket a game's zirbel-net client opens (packages/net). Each connection's first
// frame names its room in a HELLO; packages/core/relay.ts does the rest.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { join, MAX_FRAME, type Link } from '../core/relay.ts';
import type { Rooms } from '../core/rooms.ts';

/** A connection that hasn't sent its HELLO in this long is dropped, and so is a seated one that has gone quiet. */
const HELLO_TIME = 10_000;
const SILENCE = 15_000;
/** At most this many connections wait for their HELLO at once. */
const WAITING = 32;
/** A reader this far behind is dropped (its seat goes away) rather than held in memory. */
const BACKLOG = 8 * 1024 * 1024;

/** Games run in an opaque-origin sandbox, so their sockets say Origin: null; a page of this host says its own. */
export function relayOrigin(request: IncomingMessage) {
  const { origin } = request.headers;
  if (origin === undefined || origin === 'null') return true;
  try { return new URL(origin).host === (request.headers.host ?? '').toLowerCase(); } catch { return false; }
}

function forbidden(stream: Duplex) {
  const body = JSON.stringify({ error: 'Cross-origin requests are denied.' });
  stream.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-type: application/json; charset=utf-8\r\n' +
    'x-content-type-options: nosniff\r\ncontent-length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}

type Held = Link & { readonly born: number };

/** The relay sockets of one player listener, which reaches the rooms of its own access. */
export function relaySockets(rooms: Rooms, access: 'local' | 'lan') {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const links = new Map<WebSocket, Held>();
  let waiting = 0;
  const find = (id: string) => {
    const room = rooms.find(id);
    return room?.relay && room.access === access ? { relay: room.relay, key: room.documentKey } : undefined;
  };
  const sweep = setInterval(() => {
    const now = performance.now();
    for (const [socket, link] of links) {
      if (now - (link.relay ? link.lastRx : link.born) > (link.relay ? SILENCE : HELLO_TIME)) socket.terminate();
    }
  }, 1000).unref();

  function accept(socket: WebSocket) {
    waiting++;
    let seated = false;
    const link: Held = {
      born: performance.now(), lastRx: performance.now(),
      send(frame) {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > BACKLOG) { socket.terminate(); return; }
        socket.send(frame);
      },
      buffered: () => socket.bufferedAmount,
      close(code) { socket.close(code); },
      drop() { socket.terminate(); },
    };
    links.set(socket, link);
    // A message over maxPayload closes the socket with 1009 by itself; the error only reports it.
    socket.on('error', () => {});
    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN || !binary || !Buffer.isBuffer(data)) return;
      link.lastRx = performance.now();
      if (link.relay) { link.relay.receive(link, data); return; }
      if (seated) return;
      join(link, data, find);
      if (link.relay) { seated = true; waiting--; }
    });
    socket.on('close', (code) => {
      links.delete(socket);
      if (!seated) waiting--;
      seated = true;
      link.relay?.gone(link, code);
    });
  }

  return {
    upgrade(request: IncomingMessage, stream: Duplex, head: Buffer) {
      if (!relayOrigin(request)) { forbidden(stream); return; }
      if (waiting >= WAITING) { stream.destroy(); return; }
      sockets.handleUpgrade(request, stream, head, accept);
    },
    close() {
      clearInterval(sweep);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    },
  };
}
