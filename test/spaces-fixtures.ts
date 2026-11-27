// What the spaces contracts share: a net game's release to import, a member's socket on a space through a listener's
// /.skalet/spaces (the hello both the fake kernel and the real one take), and the kernel child a host runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import type { Release } from '../packages/sdk/contracts.ts';
import { netGame, rights, tempDir } from './helpers.ts';

export function spacesFixtures(t: TestContext) {
  const root = tempDir(t, 'zirbel-spaces-');
  const projects = new Projects(join(root, 'source'));
  const releases = new Releases(projects, 'dist/web');
  const write = (name: string, release: Release) => {
    const file = join(root, name + '.json');
    writeFileSync(file, JSON.stringify(release));
    return { file, id: release.manifest.releaseId };
  };
  const net = write('net', releases.package(netGame(projects, 2, 'Derby').id, 'main', rights, false));
  return { root, data: join(root, 'data'), net, imports: ['--import', net.file] };
}

/** A link into a room's space: the player page with the space and its credential in the fragment. */
export function spaceLink(link: unknown) {
  const match = /^(http:\/\/127\.0\.0\.1:\d+)\/join\/([a-f0-9]{12})#skalet\.space=([0-9a-f]{12})&skalet\.(invite|ticket)=([\w-]{16,128})$/
    .exec(String(link));
  assert.ok(match, 'a link into a space: ' + String(link));
  return { origin: match[1]!, room: match[2]!, space: match[3]!, kind: match[4] as 'invite' | 'ticket', credential: match[5]! };
}

type Failure = { message: string; data?: { code?: string } };
type Hello = { member?: { id: string; n: number; name: string; role: string }; resume?: string; features?: string[]; error?: Failure };
/** A member's socket, which asks for the features a page's SDK does (its own hand-over and proofs): the hello's answer,
 *  how the socket ended, and its requests after the hello (their result, or the error's data.code). The socket stays
 *  until the test ends. */
export async function member(t: TestContext, base: string, space: string, credential: Record<string, string>, origin = base) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/.skalet/spaces', ['skalet.spaces.v1.json'], { origin });
  t.after(() => ws.terminate());
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waiting = new Map<number, (message: { result?: unknown; error?: Failure }) => void>();
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as { id?: number; result?: unknown; error?: Failure };
    if (typeof message.id === 'number') waiting.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method: string, params?: object) => new Promise<{ result?: unknown; error?: Failure }>((resolve) => {
    waiting.set(++next, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: next, method, ...(params ? { params } : {}) }));
  });
  const answer = await request('space.hello', { protocol: 1, space, credential,
    features: ['members.v1', 'handover.v1', 'proof.v1'], client: { name: 'zirbel-test', version: '1' } });
  const hello: Hello = answer.error ? { error: answer.error } : answer.result as Hello;
  /** A request of the member's: its result, or a refusal's word. */
  const ask = async <T>(method: string) => {
    const { result, error } = await request(method);
    if (error) throw new Error(error.data?.code ?? error.message);
    return result as T;
  };
  return { ...hello, ws, closed, ask, seated: hello.member ? [hello.member.name, hello.member.role] : undefined };
}

/** A room's info for the holder of a credential (a member's proof, for a net game's room): its status and code. */
export async function roomInfo(base: string, room: string, credential: string) {
  const info = await call(base, 'GET', '/rooms/' + room + '/info', undefined, { authorization: 'Bearer ' + credential });
  return { status: info.status, body: info.body as { code?: string; solo: boolean; gameUrl: string; manifest: { simulation: string } } };
}

/** The kernel child a host runs: its pid, or none. */
export function kernelOf(host: number) {
  try {
    return execFileSync('pgrep', ['-P', String(host)], { encoding: 'utf8' }).trim().split('\n').map(Number).find((pid) => pid > 0);
  } catch { return undefined; }
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Waits until check passes, a little at a time. */
export async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('Waited in vain for ' + what);
    await new Promise((done) => setTimeout(done, 100));
  }
}

type Answer = { status: number; body: unknown; headers: Headers };
/** A request with the base's own origin unless headers say otherwise, its JSON body when it has one. */
export async function call(base: string, method: string, path: string, json?: unknown, headers: Record<string, string> = { origin: base }):
  Promise<Answer> {
  const response = await fetch(base + path, { method, body: json === undefined ? null : JSON.stringify(json),
    headers: { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a page or a file */ }
  return { status: response.status, body, headers: response.headers };
}
export const error = (answer: Answer) => [answer.status, (answer.body as { error?: string }).error];
