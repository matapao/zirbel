// Shared fixtures for the unit and contract tests.
import { spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { PROTOCOL_VERSION, type ServerMessage } from '../packages/sdk/contracts.ts';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { type Peer, type Room } from '../packages/core/rooms.ts';
import { starterScene, templates } from '../packages/games/templates.ts';
import type { Template } from '../packages/sdk/contracts.ts';

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

// The spaces kernels a host runs in the tests: the fake (test/fake-spaces.mjs) unless a test says otherwise, the real
// binary `pnpm run deps` builds, when it is there, and none.
export const FAKE_SPACES = join(import.meta.dirname, 'fake-spaces.mjs');
export const REAL_SPACES = join(import.meta.dirname, '..', 'deps', 'skalet', 'bin', 'skalet' + (process.platform === 'win32' ? '.exe' : ''));
export const NO_SPACES = join(tmpdir(), 'zirbel-test-no-spaces-kernel');
/** The kernels a contract runs against: the fake, and the real one once it is built. */
export function kernelsUnderTest() {
  const kernels = [{ name: 'fake', binary: FAKE_SPACES }];
  if (existsSync(REAL_SPACES)) kernels.push({ name: 'real', binary: REAL_SPACES });
  else console.log('# Skipping the real spaces kernel: run `git submodule update --init && pnpm run deps` to build it.');
  return kernels;
}

// Start a host that is stopped when the test ends. `ready` resolves with the
// first value `pick` returns for one of the JSON lines the host prints. It runs the fake spaces kernel unless env names
// another (ZIRBEL_SPACES_BINARY).
export function launch<T>(t: TestContext, command: string[], args: string[], pick: (line: Record<string, unknown>) => T | undefined,
  env?: Record<string, string>) {
  const child = spawn(command[0]!, [...command.slice(1), ...args], { env: { ...process.env, ZIRBEL_SPACES_BINARY: FAKE_SPACES, ...env } });
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
// A net-v2 game (net: the player's origin) may also import the spaces kernel's modules and reach its socket.
export function sandboxPolicy(runtime: string, base: string, ancestors: string, net?: string) {
  const addons = runtime + 'three/addons/';
  return "sandbox allow-scripts allow-pointer-lock; default-src 'none'; " +
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + ' ' + runtime + 'game-sdk.js ' + runtime + 'three.module.js ' + addons +
    (net ? ' ' + net + '/.skalet/net.js ' + net + '/.skalet/spaces.js' : '') + '; ' +
    "style-src 'unsafe-inline' " + base + '; img-src data: blob: ' + base + '; media-src data: blob: ' + base + '; font-src data: ' + base + '; ' +
    'connect-src ' + base + ' ' + addons + ' data: blob:' + (net ? ' ' + net.replace(/^http/, 'ws') + '/.skalet/spaces' : '') +
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

// A built game folder whose zirbel.json is for this many players: it imports as a net game, with a data file beside it.
export const NET_RULES = { kills: 25 };
export function netGame(projects: Projects, players: number, title = 'Relay') {
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  return importGameFolder(projects, { title, files: {
    'index.html': base64('<!doctype html><canvas></canvas>'), 'zirbel.json': base64(JSON.stringify({ players: { max: players } })),
    'data/rules.json': base64(JSON.stringify(NET_RULES)) } });
}
