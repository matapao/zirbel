// /pads on a player listener: the WebSocket screens and phones open (packages/core/pads.ts routes between them), and the
// local socket the box's controller service brings the box's own gamepads over. Text frames carry JSON control
// messages, binary frames pad state (packages/sdk/pads.ts).
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { loopback } from '../core/lobby.ts';
import { PADS_CLOSE, type Access, type Pads, type PadsLink } from '../core/pads.ts';
import { padsPadMessage, padsScreenMessage, padsServiceMessage } from '../sdk/contracts.ts';
import { MAX_PAD_FRAME } from '../sdk/pads.ts';
import { refuseUpgrade, upgradeOrigin } from './http.ts';

/** The largest message on /pads: a control message's 1 KB (a pad frame is far smaller). */
const MESSAGE = 1024;
/** Screens are pinged this often, and one that missed its pong is dropped; a phone that sent nothing this long is (it
 *  sends its state at 4 Hz while still). */
const PING = 10_000;
const SILENCE = 10_000;
/** Pad frames to a reader this far behind are dropped, and a reader of control messages this far behind is. */
const FRAME_BACKLOG = 65_536;
const BACKLOG = 262_144;
/** On the local socket: a control message's 4 KB, and the kind byte before it. */
const SERVICE_MESSAGE = 4096;

/** A text frame's JSON message as the contract reads it, or the code that closes the socket: 1007 for one that isn't
 *  JSON, 1008 for one that isn't a message. */
function read<T>(data: Buffer, contract: { safeParse(value: unknown): { success: true; data: T } | { success: false } }) {
  let value: unknown;
  try { value = JSON.parse(data.toString('utf8')); } catch { return 1007; }
  const message = contract.safeParse(value);
  return message.success ? message : 1008;
}

const linkOf = (socket: WebSocket): PadsLink => ({
  text(message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BACKLOG) { socket.terminate(); return; }
    socket.send(JSON.stringify(message));
  },
  binary(frame) { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= FRAME_BACKLOG) socket.send(frame); },
  close(code) { socket.close(code); },
});

/** The pads sockets of one player listener, for the screens and phones of its own access. */
export function padsSockets(pads: Pads, access: Access) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MESSAGE, perMessageDeflate: false });
  const screens = new Map<WebSocket, { alive: boolean }>();
  const phones = new Map<WebSocket, { lastRx: number }>();
  let pinged = performance.now();
  const sweep = setInterval(() => {
    const now = performance.now();
    for (const [socket, phone] of phones) if (now - phone.lastRx > SILENCE) socket.terminate();
    if (now - pinged < PING) return;
    pinged = now;
    for (const [socket, screen] of screens) {
      if (!screen.alive) { socket.terminate(); continue; }
      screen.alive = false;
      socket.ping();
    }
  }, 1000).unref();

  function screen(socket: WebSocket, request: IncomingMessage, resume: string) {
    const link = linkOf(socket);
    const held = pads.openScreen(link, access, loopback(request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''), resume);
    if (!held) return;
    const watch = { alive: true };
    screens.set(socket, watch);
    socket.on('pong', () => { watch.alive = true; });
    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN || !Buffer.isBuffer(data)) return;
      // A screen sends no pad frames.
      if (binary) { socket.close(PADS_CLOSE.unsupported); return; }
      const message = read(data, padsScreenMessage);
      if (typeof message === 'number') socket.close(message);
      else pads.screenMessage(held, link, message.data);
    });
    socket.on('close', (code) => {
      screens.delete(socket);
      pads.screenGone(held, link, code);
    });
  }

  function pad(socket: WebSocket, request: IncomingMessage, query: URLSearchParams) {
    const link = linkOf(socket);
    const place = query.get('place') ?? '';
    const phone = pads.openPad(link, access, request.socket.remoteAddress ?? '', query.get('code') ?? '',
      /^[0-7]$/.test(place) ? Number(place) : undefined, query.get('resume') ?? '');
    if (!phone) return;
    const watch = { lastRx: performance.now() };
    phones.set(socket, watch);
    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN || !Buffer.isBuffer(data)) return;
      watch.lastRx = performance.now();
      if (binary) { pads.padFrame(phone, data); return; }
      const message = read(data, padsPadMessage);
      if (typeof message === 'number') socket.close(message);
      else pads.padMessage(phone, message.data);
    });
    socket.on('close', () => {
      phones.delete(socket);
      pads.padGone(phone);
    });
  }

  return {
    upgrade(request: IncomingMessage, stream: Duplex, head: Buffer, url: URL) {
      // Pages of this listener open it; a game's opaque-origin frame never does.
      if (request.headers.origin === 'null' || !upgradeOrigin(request)) { refuseUpgrade(stream, 403, 'Cross-origin requests are denied.'); return; }
      const role = url.searchParams.get('role');
      if (role !== 'screen' && role !== 'pad') { refuseUpgrade(stream, 400, 'Open the pads socket as a screen or a pad.'); return; }
      sockets.handleUpgrade(request, stream, head, (socket) => {
        // A message over maxPayload closes the socket with 1009 by itself; the error only reports it.
        socket.on('error', () => {});
        if (role === 'screen') screen(socket, request, url.searchParams.get('resume') ?? '');
        else pad(socket, request, url.searchParams);
      });
    },
    close() {
      clearInterval(sweep);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    },
  };
}

/** The local socket at path the box's controller service connects to, one connection at a time. Frames both ways are a
 *  u16 length (LE), then a payload: 0 and a JSON control message, or 1, a gamepad's number and its pad state. */
export async function padsService(pads: Pads, path: string) {
  // A socket left behind by an earlier run is taken over; anything else at the path is not.
  try { if (lstatSync(path).isSocket()) unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const connections = new Set<Socket>();
  const server = createServer((connection) => {
    connections.add(connection);
    serve(pads, connection);
    connection.on('close', () => connections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(path, 0o660);
  return {
    close() {
      server.close();
      for (const connection of connections) connection.destroy();
    },
  };
}

function serve(pads: Pads, connection: Socket) {
  const link: PadsLink = {
    text(message) {
      if (connection.writableLength > BACKLOG) { connection.destroy(); return; }
      const payload = Buffer.from(JSON.stringify(message));
      const head = Buffer.alloc(3);
      head.writeUInt16LE(payload.length + 1, 0);
      connection.write(Buffer.concat([head, payload]));
    },
    binary() {},
    close() { connection.destroy(); },
  };
  pads.attachService(link);
  let pending = Buffer.alloc(0);
  // A frame that isn't one ends the connection; the service connects again.
  const payload = (frame: Buffer) => {
    if (frame[0] === 1 && frame.length >= 2 && frame.length <= 2 + MAX_PAD_FRAME) return pads.serviceInput(link, frame[1]!, frame.subarray(2));
    if (frame[0] !== 0 || frame.length > 1 + SERVICE_MESSAGE) return false;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(1))); } catch { return false; }
    const message = padsServiceMessage.safeParse(value);
    if (message.success) pads.serviceMessage(link, message.data);
    return message.success;
  };
  connection.on('data', (data) => {
    // No encoding is set on the socket, so its data are bytes.
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 2) {
      const length = pending.readUInt16LE(0);
      if (length < 1 || length > 1 + SERVICE_MESSAGE) { connection.destroy(); return; }
      if (pending.length < 2 + length) return;
      const frame = pending.subarray(2, 2 + length);
      pending = pending.subarray(2 + length);
      if (!payload(frame)) { connection.destroy(); return; }
    }
  });
  connection.on('error', () => {});
  connection.on('close', () => pads.serviceGone(link));
}
