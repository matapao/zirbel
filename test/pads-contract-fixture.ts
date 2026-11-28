// For the pads contract: a host with --lan, one room open and its local socket, and the pads socket by hand, through
// the pages' own client, and as the box's controller service on that socket.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { encodePad, openScreen, type PadInfo, type ScreenInfo } from '../packages/web/pads-client.ts';
import { launch, rights, tempDir } from './helpers.ts';

// The Unix socket's path, short enough for macOS's limit.
export const unix = process.platform !== 'win32';

type Message = { type: string; [key: string]: unknown };
type Started = { lan: string; room: string; socket: string };

/** The host with --lan, one room open, and its local socket for the box's controller service. */
export async function startHost(t: TestContext, command: string[]): Promise<Started> {
  const root = tempDir(t, 'zirbel-pads-');
  const projects = new Projects(join(root, 'source'));
  const release = new Releases(projects, 'dist/web').package(
    projects.createGame('Pads', { html: '<!doctype html><canvas></canvas>', maxPlayers: 2 }).id,
    'main',
    rights,
    false,
  );
  const file = join(root, 'release.json');
  writeFileSync(file, JSON.stringify(release));
  const socket = join(root, 'host.sock');
  let room: { id: string; link: string } | undefined;
  const player = await launch(
    t,
    command,
    [
      '--host-only',
      '--lan',
      '--player-port',
      '0',
      '--data',
      join(root, 'data'),
      '--import',
      file,
      '--release',
      release.manifest.releaseId,
      ...(unix ? ['--pads-socket', socket] : []),
    ],
    (line) => {
      if (typeof line.link === 'string') room = line as typeof room;
      return typeof line.player === 'string' ? line.player : undefined;
    },
  ).ready;
  assert.ok(room && player);
  return { lan: 'http://127.0.0.1:' + new URL(room.link).port, room: room.id, socket };
}

/** Messages as they come, and a wait for the first that passes a check. */
export function inbox<T>() {
  const items: T[] = [];
  let changed = () => {};
  return {
    items,
    push(item: T) {
      items.push(item);
      changed();
    },
    async next(check: (item: T) => boolean = () => true, what = 'a message'): Promise<T> {
      const deadline = Date.now() + 4000;
      for (;;) {
        const index = items.findIndex(check);
        if (index >= 0) return items.splice(index, 1)[0]!;
        if (Date.now() > deadline) throw new Error('No ' + what + ' in ' + JSON.stringify(items));
        await new Promise<void>((resolve) => {
          changed = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
  };
}
export const ofType = (type: string) => (message: Message) => message.type === type;

/** A socket to /pads by hand: its JSON messages and frames, and the code it closed with. */
export function raw(t: TestContext, origin: string, query: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/pads?' + query, { headers });
  t.after(() => ws.terminate());
  const messages = inbox<Message>(),
    frames = inbox<Uint8Array>();
  ws.on('message', (data: Buffer, binary) => {
    if (binary) frames.push(new Uint8Array(data));
    else messages.push(JSON.parse(data.toString('utf8')) as Message);
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const refused = new Promise<number>((resolve) =>
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)),
  );
  ws.on('error', () => {});
  return {
    ws,
    messages,
    frames,
    closed,
    refused,
    send(value: object | Uint8Array) {
      ws.send(value instanceof Uint8Array ? value : JSON.stringify(value));
    },
  };
}

/** A screen through the pages' own client. */
export function screen(t: TestContext, origin: string, resume?: string) {
  const screens = inbox<ScreenInfo>(),
    lists = inbox<PadInfo[]>(),
    frames = inbox<Uint8Array>(),
    opens = inbox<string>(),
    closes = inbox<number>();
  const held = openScreen({
    origin,
    resume,
    onScreen: (info) => screens.push(info),
    onPads: (pads) => lists.push(pads),
    onFrame: (_pad, frame) => frames.push(frame.slice()),
    onOpen: (link) => opens.push(link),
    onClosed: (code) => closes.push(code),
  });
  t.after(() => held.close());
  return { held, screens, lists, frames, opens, closes };
}

export const state = (pressed: number[] = [], slot = 0) =>
  encodePad({
    slot,
    standard: true,
    axes: [0.5, -1, 0, 0],
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: pressed.includes(index),
      value: pressed.includes(index) ? 1 : 0,
    })),
  });
export const slotted = (frame: Uint8Array, slot: number) => [slot, ...frame.subarray(1)];

/** The box's controller service on the local socket: u16 length (LE), then 0 and JSON, or 1, a device and a pad state. */
export async function service(t: TestContext, path: string) {
  const socket: Socket = connect(path);
  t.after(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const messages = inbox<Message>();
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16LE(0)) {
      const frame = pending.subarray(2, 2 + pending.readUInt16LE(0));
      pending = pending.subarray(2 + frame.length);
      if (frame[0] === 0) messages.push(JSON.parse(frame.subarray(1).toString('utf8')) as Message);
    }
  });
  const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const frame = (payload: Buffer) => {
    const head = Buffer.alloc(2);
    head.writeUInt16LE(payload.length);
    socket.write(Buffer.concat([head, payload]));
  };
  return {
    socket,
    messages,
    ended,
    frame,
    json(value: object) {
      frame(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value))]));
    },
    input(device: number, pad: Uint8Array) {
      frame(Buffer.concat([Buffer.from([1, device]), pad]));
    },
  };
}
