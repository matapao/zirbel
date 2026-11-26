// Shared fixtures for the unit and contract tests.
import { spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '../packages/sdk/contracts.ts';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { type Peer, type Room } from '../packages/core/rooms.ts';
import { starterScene, templates } from '../packages/games/templates.ts';
import type { Template } from '../packages/sdk/contracts.ts';
import { Reader, Writer } from '../packages/net/codec.ts';
import { Cursor, writeHello } from '../packages/net/internal.ts';

export const rights = { play: true, download: true, remix: true };

export function legacyProject(projects: Projects, template: Template, title = templates[template].title,
  initial = { scene: starterScene(template), assets: [], label: 'Initial scene' }) {
  return projects.createRevision(title, { template, ...initial });
}

// A temporary directory that is removed when the test ends.
export function tempDir(t: TestContext, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

export function install(t: TestContext) {
  const root = tempDir(t, 'zirbel-test-');
  const projects = new Projects(root);
  const releases = new Releases(projects, 'dist/web');
  return { root, projects, releases };
}

export function joinRoom(room: Room, credential: string) {
  const messages: ServerMessage[] = [];
  let closed: number | undefined;
  const peer: Peer = { send: (message) => messages.push(structuredClone(message)), close: (code) => { closed = code; } };
  const id = room.connect({ type: 'hello', version: PROTOCOL_VERSION, releaseId: room.release.manifest.releaseId, credential }, peer);
  assert.ok(id);
  const welcome = messages.find((message) => message.type === 'welcome');
  assert.ok(welcome);
  return { id, welcome, messages, peer, get closed() { return closed; },
    send(sequence: number, action: object) {
      room.message(id, peer, { type: 'action', sequence, action: JSON.parse(JSON.stringify(action)) });
    } };
}

// The Go host under test; ZIRBEL_GO_HOST picks a coverage build (scripts/coverage-go.mjs).
const goHost = process.env.ZIRBEL_GO_HOST ?? 'host/bin/zirbel-host' + (process.platform === 'win32' ? '.exe' : '');

// The hosts a contract runs against: Node, and Go once `pnpm build:host` has built it.
export function hostsUnderTest() {
  const hosts = [{ name: 'node', command: [process.execPath, 'dist/server.mjs'] }];
  if (existsSync(goHost)) hosts.push({ name: 'go', command: [goHost] });
  else console.log('# Skipping the Go host: run `pnpm build:host` to include it.');
  return hosts;
}

// Stop a host gracefully so a coverage build writes its counters, then force it.
export function stopHost(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((done) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(force); done(); });
    child.kill('SIGTERM');
  });
}

// Start a host that is stopped when the test ends. `ready` resolves with the
// first value `pick` returns for one of the JSON lines the host prints.
export function launch<T>(t: TestContext, command: string[], args: string[], pick: (line: Record<string, unknown>) => T | undefined,
  env?: Record<string, string>) {
  const child = spawn(command[0]!, [...command.slice(1), ...args], env ? { env: { ...process.env, ...env } } : {});
  t.after(() => stopHost(child));
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  const ready = new Promise<T>((resolve, reject) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const found = pick(JSON.parse(line) as Record<string, unknown>);
      if (found !== undefined) resolve(found);
    });
    child.once('exit', (code) => reject(new Error('The host exited with ' + code + ': ' + errors)));
  });
  return { child, ready };
}

// The policy and import map every game gets, a single document or a built folder, written out in full: the unit
// tests hold game-page.ts to them and the contract tests hold both hosts.
// A net-v2 game (net: the player's origin) may also import zirbel-net's client and open the relay socket.
export function sandboxPolicy(runtime: string, base: string, ancestors: string, net?: string) {
  const addons = runtime + 'three/addons/';
  return "sandbox allow-scripts allow-pointer-lock; default-src 'none'; " +
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + ' ' + runtime + 'game-sdk.js ' + runtime + 'three.module.js ' + addons +
    (net ? ' ' + net + '/zirbel-net.js' : '') + '; ' +
    "style-src 'unsafe-inline' " + base + '; img-src data: blob: ' + base + '; media-src data: blob: ' + base + '; font-src data: ' + base + '; ' +
    'connect-src ' + base + ' ' + addons + ' data: blob:' + (net ? ' ' + net.replace(/^http/, 'ws') + '/mp' : '') +
    '; worker-src ' + base + " blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; " +
    'frame-ancestors ' + ancestors;
}
export const importMap = (runtime: string) => '<script type="importmap">{"imports":{"three":"' + runtime + 'three.module.js",' +
  '"three/addons/":"' + runtime + 'three/addons/"}}</script>';

// A glTF binary (GLB) holding one triangle, a mesh named Tri, for the loader tests.
export function triangleGlb() {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: positions.length }], buffers: [{ byteLength: positions.length }],
  }));
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  // The JSON chunk is padded with spaces to four bytes; the 36 bytes of positions need none.
  const body = Buffer.concat([chunk(0x4e4f534a, Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)])),
    chunk(0x004e4942, positions)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

// The status a host answers for another Host header (the DNS-rebinding check).
// fetch cannot override Host, so this goes through node:http.
export function statusForHost(url: string, host: string) {
  return new Promise<number>((resolve, reject) => {
    request(url, { headers: { host } }, (response) => { response.resume(); resolve(response.statusCode!); })
      .on('error', reject).end();
  });
}

// A built game folder whose zirbel.json is for this many players: it imports as a net game. Its data/rules.json is
// what zirbel-net's data('rules.json') reads.
export const NET_RULES = { kills: 25 };
export function netGame(projects: Projects, players: number, title = 'Relay') {
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  return importGameFolder(projects, { title, files: {
    'index.html': base64('<!doctype html><canvas></canvas>'), 'zirbel.json': base64(JSON.stringify({ players: { max: players } })),
    'data/rules.json': base64(JSON.stringify(NET_RULES)) } });
}

// zirbel-net protocol v2 on the wire (packages/net/protocol.ts), for the relay tests.
export type Wire = { type: number; peer: number; unreliable: boolean; payload: Uint8Array };
export function wire(frame: Uint8Array): Wire[] {
  const messages: Wire[] = [];
  if (frame[0] !== 0) return messages;
  const c = new Cursor().reset(frame, 1, frame.length);
  while (c.next()) messages.push({ type: c.type, peer: c.peer, unreliable: c.unreliable, payload: frame.slice(c.start, c.end) });
  return messages;
}
export function frameOf(...messages: { type: number; peer: number; payload?: Uint8Array | number[]; unreliable?: boolean }[]) {
  const w = new Writer().u8(0);
  for (const message of messages) {
    const payload = Uint8Array.from(message.payload ?? []);
    w.u8(message.type).u8(message.peer).varint(payload.length * 2 + (message.unreliable ? 1 : 0)).raw(payload);
  }
  return w.view().slice();
}
export const hello = (room: string, key: string, more: { token?: string; nonce?: string; version?: number; game?: string } = {}) =>
  writeHello({ version: more.version ?? 2, game: more.game ?? 'game', room, key, token: more.token ?? '', nonce: more.nonce ?? 'nonce', caps: 0 });
export function welcomeOf(message: Wire) {
  const r = new Reader(message.payload);
  const id = r.u8(), host = r.u8(), token = r.str(), time = r.f64(), resumed = r.u8(), caps = r.u8();
  const peers = Array.from({ length: r.varint() }, () => r.u8());
  const welcome = { id, host, token, time, resumed, caps, peers, maxMsg: r.varint(), revision: r.str(), base: r.str() };
  assert.equal(r.overrun || r.left() > 0, false, 'a WELCOME of exactly its fields');
  return welcome;
}
export function errorOf(message: Wire) {
  const r = new Reader(message.payload);
  return { code: r.u8(), message: r.str() };
}

// A zirbel-net connection to the relay, speaking protocol v2 by hand.
export function relaySocket(player: string, origin?: string) {
  const ws = new WebSocket(player.replace('http', 'ws') + '/mp', origin ? { origin } : {});
  const messages: Wire[] = [];
  let changed = () => {};
  ws.on('message', (data: Buffer) => { messages.push(...wire(new Uint8Array(data))); changed(); });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return {
    ws, closed, opened, pending: messages,
    send(frame: Uint8Array) { ws.send(frame); },
    /** The first message that passes check, taken from those received. */
    async next(check: (message: Wire) => boolean = () => true) {
      const deadline = Date.now() + 3000;
      for (;;) {
        const index = messages.findIndex(check);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        if (Date.now() > deadline) throw new Error('No matching relay message in ' + JSON.stringify(messages));
        await new Promise<void>((resolve) => { changed = resolve; setTimeout(resolve, 50); });
      }
    },
  };
}
export const about = (type: number, seat: number) => (message: Wire) => message.type === type && message.payload[0] === seat;
