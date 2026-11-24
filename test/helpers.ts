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

// Start a host that is stopped when the test ends. `ready` resolves with the
// first value `pick` returns for one of the JSON lines the host prints.
export function launch<T>(t: TestContext, command: string[], args: string[], pick: (line: Record<string, unknown>) => T | undefined) {
  const child = spawn(command[0]!, [...command.slice(1), ...args]);
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

// The status a host answers for another Host header (the DNS-rebinding check).
// fetch cannot override Host, so this goes through node:http.
export function statusForHost(url: string, host: string) {
  return new Promise<number>((resolve, reject) => {
    request(url, { headers: { host } }, (response) => { response.resume(); resolve(response.statusCode!); })
      .on('error', reject).end();
  });
}
