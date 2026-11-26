// view_game in the desktop app: the app's own Electron renders a game page from loopback in a hidden window, with
// WebGL, takes the keys it is given, and lets nothing else reach the network; a request that isn't one is refused.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { folders, launchEnv, removeFolders } from './support.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const MAIN = path.join(import.meta.dirname, 'view-main.js');

const page = `<!doctype html><html><body style="margin:0"><canvas width="320" height="200"></canvas><script>
const gl = document.querySelector('canvas').getContext('webgl', { preserveDrawingBuffer: true });
const paint = (r, g) => { gl.clearColor(r, g, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); console.log('webgl ' + pixel.join(',')); };
paint(1, 0);
addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') paint(0, 1); });
fetch('https://example.com/').catch(() => console.log('no network'));
</script></body></html>`;

type Reply = { type: string; id: string; images?: string[]; console?: { level: string; text: string }[]; error?: string };

test('the app renders a game with its own Electron: WebGL, keys, its console, and no network', { timeout: 90_000 }, async (t) => {
  const made = folders('zirbel-desktop-view-');
  t.after(() => removeFolders(made));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const origin = 'http://127.0.0.1:' + (address && typeof address === 'object' ? address.port : 0);
  const request = { url: origin + '/game/room/key/', origin, width: 320, height: 200,
    actions: [{ key: 'ArrowRight' }, { wait: 200 }], captures: [0, 2] };
  // Not a game page on loopback, or more than a render takes: refused.
  const refused = [
    { type: 'zirbel:view-game', id: 'elsewhere', request: { ...request, url: 'https://example.com/game/', origin: 'https://example.com' } },
    { type: 'zirbel:view-game', id: 'many', request: { ...request, captures: [0, 1, 2, 3, 4, 5, 6, 7, 8] } },
  ];
  const output = await new Promise<string>((resolve, reject) =>
    execFile(ELECTRON, [MAIN, '--use-mock-keychain'], {
      env: { ...launchEnv(made), VIEW_PROFILE: made.profile, VIEW_REQUEST: JSON.stringify(request), VIEW_MESSAGES: JSON.stringify(refused) },
      timeout: 80_000,
    }, (error, stdout) => {
      // execFile's error is an Error whose type lost its base (Omit<…>): it is passed on as one.
      if (error) reject(error instanceof Error ? error : new Error(error.message));
      else resolve(stdout);
    }));
  const replies = JSON.parse(output.trim().split('\n').at(-1) ?? '[]') as Reply[];
  assert.deepEqual(replies.slice(0, 2).map(({ id, error }) => [id, error]),
    [['elsewhere', 'The app refused that request.'], ['many', 'The app refused that request.']]);
  const rendered = replies[2];
  assert.equal(rendered?.error, undefined, rendered?.error);
  const [before, after] = (rendered?.images ?? []).map((image) => Buffer.from(image, 'base64'));
  assert.ok(before && after, 'two screenshots');
  assert.equal(before.subarray(1, 4).toString(), 'PNG');
  assert.notDeepEqual(before, after, 'the key changed what the page shows');
  const said = (rendered?.console ?? []).map(({ text }) => text);
  for (const line of ['webgl 255,0,0,255', 'webgl 0,255,0,255', 'no network']) assert.ok(said.includes(line), said.join('\n'));
  assert.ok(said.some((line) => line.startsWith('Blocked a request to https://example.com/')), said.join('\n'));
});
