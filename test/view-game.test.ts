// view_game: each turn's own MCP server with that one tool, for its own folder, behind the turn's credential; the
// game served through the player in a temporary solo room; and rendered in a real browser through the DevTools
// protocol (skipped where no Chrome, Edge or Chromium is installed), or by the desktop app over its IPC channel.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Rooms } from '../packages/core/rooms.ts';
import { appRenderer, chooseRenderer } from '../packages/server/browser-app.ts';
import { chromeRenderer, findBrowser, keyEvent, NO_BROWSER } from '../packages/server/browser-cdp.ts';
import { Players } from '../packages/server/hosting.ts';
import { TurnServers } from '../packages/server/turn-mcp.ts';
import type { Renderer, ViewRequest } from '../packages/server/view-game.ts';
import { install, tempDir } from './helpers.ts';

function folderWith(t: TestContext, files: Record<string, string>) {
  const folder = tempDir(t, 'zirbel-turn-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(folder, 'game', path, '..'), { recursive: true });
    writeFileSync(join(folder, 'game', path), content);
  }
  return folder;
}

const call = (id: number, name: string, args: unknown = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

test('a turn’s MCP server has view_game alone, for its own folder, behind the turn’s credential', async (t) => {
  const { projects, releases } = install(t);
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const seen: ViewRequest[] = [];
  let answer: Awaited<ReturnType<Renderer['render']>> = {
    images: [Buffer.from('png one'), Buffer.from('png two')],
    console: [{ level: 'log', text: 'ready' }],
  };
  const roomOf = (request?: ViewRequest) => new URL(request?.url ?? 'http://x/').pathname.split('/')[2] ?? '';
  const renderer: Renderer = {
    async render(request) {
      seen.push(request);
      assert.ok(rooms.get(roomOf(request)).solo, 'its solo room is open');
      return answer;
    },
  };
  const servers = new TurnServers(
    { projects, releases, rooms, playerPort: () => 4321, renderer },
    () => 'http://127.0.0.1:4173/turn-mcp',
  );
  const folder = folderWith(t, {
    'index.html': '<script type="module" src="./main.js"></script>',
    'main.js': 'console.log("ready")',
  });
  const turn = servers.open(folder, { title: 'Turn game', assets: [], maxPlayers: 1 });
  const [server] = turn.servers;
  assert.deepEqual(
    { ...server, headers: undefined },
    { name: 'zirbel', transport: 'http', url: 'http://127.0.0.1:4173/turn-mcp', headers: undefined },
  );
  const credential = server?.headers.authorization;
  assert.match(credential ?? '', /^Bearer [A-Za-z0-9_-]{43}$/);

  const init = await servers.handle(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    credential,
  );
  assert.deepEqual(init, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'zirbel', version: '0.1.0' },
    },
  });
  assert.equal(await servers.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, credential), undefined);
  const listed = (await servers.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, credential)) as {
    result: { tools: { name: string }[] };
  };
  assert.deepEqual(
    listed.result.tools.map(({ name }) => name),
    ['view_game'],
  );

  const viewed = (await servers.handle(
    call(3, 'view_game', { actions: [{ key: 'ArrowLeft' }, { wait: 50 }], captures: [0, 2], width: 320, height: 200 }),
    credential,
  )) as { result: { content: { type: string; data?: string; mimeType?: string; text?: string }[]; isError?: boolean } };
  assert.equal(viewed.result.isError, undefined, viewed.result.content.at(-1)?.text ?? 'view_game failed');
  assert.deepEqual(
    viewed.result.content
      .slice(0, 2)
      .map(({ type, mimeType, data }) => [type, mimeType, Buffer.from(data ?? '', 'base64').toString()]),
    [
      ['image', 'image/png', 'png one'],
      ['image', 'image/png', 'png two'],
    ],
  );
  assert.deepEqual(JSON.parse(viewed.result.content[2]?.text ?? '{}'), {
    screenshots: [{ afterActions: 0 }, { afterActions: 2 }],
    size: { width: 320, height: 200 },
    console: [{ level: 'log', text: 'ready' }],
  });
  // Through the player, in a solo room of its own on loopback, which is gone once the render ends.
  assert.match(seen[0]?.url ?? '', /^http:\/\/127\.0\.0\.1:4321\/game\/[a-z0-9]+\/[A-Za-z0-9_-]+\/$/);
  assert.equal(seen[0]?.origin, 'http://127.0.0.1:4321');
  assert.deepEqual(seen[0]?.captures, [0, 2]);
  assert.throws(() => rooms.get(roomOf(seen[0])), 'its room closed as the render ended');

  // Arguments are checked; one tool only; a game/ that can't be read says why.
  const refused = async (message: object) =>
    ((await servers.handle(message, credential)) as { result: { isError: boolean; content: { text: string }[] } })
      .result;
  assert.match((await refused(call(4, 'view_game', { captures: [3] }))).content[0]?.text ?? '', /Check the arguments/);
  assert.match(
    (await refused(call(5, 'view_game', { actions: Array.from({ length: 41 }, () => ({ wait: 1 })) }))).content[0]
      ?.text ?? '',
    /Check the arguments/,
  );
  assert.match((await refused(call(6, 'read_project'))).content[0]?.text ?? '', /view_game only/);
  writeFileSync(join(folder, 'game', '.secret'), 'x');
  assert.match((await refused(call(7, 'view_game'))).content[0]?.text ?? '', /game\/\.secret/);
  answer = { unavailable: NO_BROWSER };
  rmSync(join(folder, 'game', '.secret'));
  assert.equal((await refused(call(8, 'view_game'))).content[0]?.text, NO_BROWSER);

  // Another credential reaches nothing, and the turn's own reaches nothing once the turn has ended.
  await assert.rejects(servers.handle(call(9, 'view_game'), 'Bearer ' + 'x'.repeat(43)), /credential is not valid/);
  await assert.rejects(servers.handle(call(10, 'view_game'), undefined), /credential is not valid/);
  turn.revoke();
  await assert.rejects(servers.handle(call(11, 'view_game'), credential), /has ended/);
});

test('in the desktop app, the app renders: a request and its answer over the IPC channel', async () => {
  const sent: { id: string; request: ViewRequest }[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const renderer = appRenderer({
    send: (message) => sent.push(message as { id: string; request: ViewRequest }),
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const request: ViewRequest = {
    url: 'http://127.0.0.1:1/game/r/k/',
    origin: 'http://127.0.0.1:1',
    width: 64,
    height: 64,
    actions: [],
    captures: [0],
  };
  const rendering = renderer.render(request, new AbortController().signal);
  assert.deepEqual(sent[0]?.request, request);
  for (const listener of listeners) listener({ type: 'zirbel:view-game', id: 'another', images: [] });
  for (const listener of listeners)
    listener({
      type: 'zirbel:view-game',
      id: sent[0]?.id,
      images: [Buffer.from('png').toString('base64')],
      console: [{ level: 'info', text: 'hi' }],
    });
  const result = await rendering;
  assert.ok('images' in result);
  assert.deepEqual([result.images[0]?.toString(), result.console], ['png', [{ level: 'info', text: 'hi' }]]);
  assert.equal(listeners.size, 0, 'it stops listening once answered');
  const failing = renderer.render(request, new AbortController().signal);
  for (const listener of listeners)
    listener({ type: 'zirbel:view-game', id: sent[1]?.id, error: 'The app could not render the game.' });
  await assert.rejects(failing, /could not render/);
  // Without the app's IPC channel, it is an installed browser's turn.
  assert.notEqual(chooseRenderer({ ZIRBEL_VIEW_GAME: 'app' }), undefined);
  assert.deepEqual(keyEvent('ArrowRight'), { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
  assert.deepEqual(keyEvent('w'), { key: 'w', code: 'KeyW', keyCode: 87, text: 'w' });
  assert.equal(findBrowser({ ZIRBEL_BROWSER: '/no/such/browser' }), undefined);
  assert.deepEqual(await chromeRenderer(() => undefined).render(request, new AbortController().signal), {
    unavailable: NO_BROWSER,
  });
});

/** A PNG's width and height, from its header. */
const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

test(
  'an installed browser renders the game with WebGL, takes its keys, and lets nothing reach the network',
  { skip: !findBrowser() && 'no Chrome, Edge or Chromium installed', timeout: 120_000 },
  async (t) => {
    const { projects, releases } = install(t);
    const rooms = new Rooms();
    const players = new Players(rooms, releases, { playerPort: 0 });
    t.after(() => players.close());
    const local = await players.openLocal(0);
    const servers = new TurnServers(
      { projects, releases, rooms, playerPort: () => local.port, renderer: chromeRenderer() },
      () => '',
    );
    const folder = folderWith(t, {
      'index.html':
        '<!doctype html><html><body style="margin:0"><canvas width="320" height="200"></canvas><script type="module" src="./main.js"></script></body></html>',
      'main.js': `import { Color } from 'three';
const gl = document.querySelector('canvas').getContext('webgl', { preserveDrawingBuffer: true });
const paint = (color) => { gl.clearColor(color.r, color.g, color.b, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); console.log('webgl ' + pixel.join(',')); };
paint(new Color(1, 0, 0));
addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') paint(new Color(0, 1, 0)); });
fetch('https://example.com/').catch(() => console.log('no network'));`,
    });
    const {
      servers: [server],
    } = servers.open(folder, { title: 'WebGL', assets: [], maxPlayers: 1 });
    const viewed = (await servers.handle(
      call(1, 'view_game', {
        actions: [{ key: 'ArrowRight' }, { wait: 200 }],
        captures: [0, 2],
        width: 320,
        height: 200,
      }),
      server?.headers.authorization,
    )) as { result: { isError?: boolean; content: { type: string; data?: string; text?: string }[] } };
    assert.equal(viewed.result.isError, undefined, viewed.result.content.at(-1)?.text ?? 'view_game failed');
    const [before, after] = viewed.result.content
      .filter(({ type }) => type === 'image')
      .map(({ data }) => Buffer.from(data ?? '', 'base64'));
    assert.ok(before && after);
    assert.deepEqual(before.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual(size(before), [320, 200]);
    assert.notDeepEqual(before, after, 'the key changed what the page shows');
    const { console: lines } = JSON.parse(viewed.result.content.at(-1)?.text ?? '{}') as {
      console: { level: string; text: string }[];
    };
    const said = lines.map(({ text }) => text);
    assert.ok(said.includes('webgl 255,0,0,255'), said.join('\n'));
    assert.ok(said.includes('webgl 0,255,0,255'), said.join('\n'));
    assert.ok(said.includes('no network'), said.join('\n'));
  },
);
