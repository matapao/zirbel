// A box over plain http on its network: the built editor in box mode by the name a device reached it by, and the
// pages it serves, which may call nothing that needs a secure page.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { test } from 'node:test';
import { boxName } from '../packages/server/box-routes.ts';
import { launch, tempDir } from './helpers.ts';

/** A request to a local port with a Host header of its own, as a device that reached the box by its name sends. */
function send(port: number, host: string, method: string, path: string, payload?: object) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, method, path,
      headers: { host, ...(payload ? { 'content-type': 'application/json' } : {}) } }, (incoming) => {
      let text = '';
      incoming.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text }));
    });
    outgoing.on('error', reject);
    outgoing.end(payload ? JSON.stringify(payload) : undefined);
  });
}

test('the built editor in box mode answers its .local name, pairs, and puts its player on the host it was reached by', async (t) => {
  const data = tempDir(t, 'zirbel-box-data-');
  const account = tempDir(t, 'zirbel-box-account-');
  const { ready } = launch(t, [process.execPath, 'dist/server.mjs'], ['--box', '--data', data, '--port', '0', '--player-port', '0'],
    (line) => typeof line.editor === 'string' ? line : undefined, { ZIRBEL_ACCOUNT_DIR: account });
  const started = await ready;
  assert.equal(started.box, true);
  const port = Number(new URL(String(started.editor)).port);
  const name = boxName() + ':' + port;
  const health = JSON.parse((await send(port, name, 'GET', '/api/health')).text);
  assert.equal(health.box.onboarded, false);
  assert.equal(health.box.name, boxName());
  assert.equal((await send(port, 'evil.example:' + port, 'GET', '/api/health')).status, 403);
  const code = JSON.parse((await send(port, '127.0.0.1:' + port, 'POST', '/api/pairing', {})).text);
  assert.equal(code.url, 'http://' + name + '/pair?code=' + code.code);
  assert.match((await send(port, name, 'GET', '/pair')).text, /Claim this box/);
  const status = JSON.parse((await send(port, name, 'GET', '/api/box/status')).text);
  assert.deepEqual([status.paired, status.claimable, status.settings.externalMcp], [0, true, false]);
  // The workspace frames the player on the host name it was opened by, and the player answers that name.
  const page = await send(port, name, 'GET', '/');
  const frame = /frame-src (http:\/\/[^ ;]+)/.exec(String(page.headers['content-security-policy']))?.[1] ?? '';
  assert.equal(new URL(frame).hostname, boxName());
  const playerPort = Number(new URL(frame).port);
  assert.equal((await send(playerPort, boxName() + ':' + playerPort, 'GET', '/health')).status, 200);
});

// A box serves the editor, the lobby and the player over plain http on its network address, which isn't a secure
// page: there crypto.randomUUID and crypto.subtle don't exist, and a page that calls them stops at its first call.
test('pages a box serves over plain http call nothing that needs a secure page', () => {
  const web = new URL('../packages/web/', import.meta.url);
  const calls = readdirSync(web).filter((file) => file.endsWith('.ts')).flatMap((file) =>
    readFileSync(new URL(file, web), 'utf8').split('\n').map((line, index) => [file + ':' + (index + 1), line] as const)
      .filter(([, line]) => !/^\s*\/\//.test(line) && /crypto\.(randomUUID|subtle)\b/.test(line)).map(([where]) => where));
  assert.deepEqual(calls, []);
});
