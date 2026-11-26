// The game page on both hosts, byte for byte as game-page.ts writes it: a net game whose zirbel.json names an adapter
// loads it last, as a module from beside its document, and every other game's page is as it was.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { gamePage } from '../packages/server/game-page.ts';
import { hostsUnderTest, launch, netGame, rights, sandboxPolicy, tempDir } from './helpers.ts';

const encoded = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')]));
const adapterGame = encoded({
  'index.html': '<!doctype html><p id="out">alone</p><script type="module" src="./game.js"></script>',
  'game.js': 'globalThis.gameHooks = {};', 'net/adapter.js': 'export {};',
  'zirbel.json': JSON.stringify({ players: { max: 2 }, multiplayer: { adapter: 'net/adapter.js' } }),
});

for (const host of hostsUnderTest()) {
  test(host.name + ' host loads a net game\'s adapter after its document, and leaves every other game page as it was', async (t) => {
    const root = tempDir(t, 'zirbel-game-page-');
    const projects = new Projects(join(root, 'source'));
    const releases = new Releases(projects, 'dist/web');
    const games = Object.entries({
      adapter: importGameFolder(projects, { title: 'Adapter', files: adapterGame }),
      net: netGame(projects, 2),
      built: importGameFolder(projects, { title: 'Built', files: encoded({ 'index.html': '<p>built</p>', 'main.js': 'export {};' }) }),
      single: projects.createGame('Single', { html: '<canvas></canvas>', maxPlayers: 1 }),
    }).map(([name, project]) => {
      const release = releases.package(project.id, 'main', rights, false);
      writeFileSync(join(root, name + '.json'), JSON.stringify(release));
      return { name, release };
    });
    const rooms: { link: string; manifest: { releaseId: string } }[] = [];
    const player = await launch(t, host.command, ['--host-only', '--player-port', '0', '--data', join(root, 'data'),
      ...games.flatMap(({ name, release }) => ['--import', join(root, name + '.json'), '--release', release.manifest.releaseId])], (line) => {
      if (typeof line.player === 'string') return line.player;
      rooms.push(line as unknown as typeof rooms[number]);
      return undefined;
    }).ready;
    for (const { name, release } of games) {
      const room = rooms.find(({ manifest }) => manifest.releaseId === release.manifest.releaseId)!;
      const [roomId, invite] = room.link.split('/join/')[1]!.split('#') as [string, string];
      const { gameUrl } = await (await fetch(player + '/rooms/' + roomId + '/info', { headers: { authorization: 'Bearer ' + invite } }))
        .json() as { gameUrl: string };
      const page = await fetch(player + gameUrl);
      const runtime = player + '/runtime/' + roomId + '/';
      const expected = gamePage(release, runtime, "'self'", player + gameUrl);
      assert.deepEqual([page.headers.get('content-security-policy'), await page.text()], [expected.policy, expected.html], name);
      const adapter = '<script type="module" src="' + player + gameUrl + 'net/adapter.js"></script>';
      assert.equal(expected.html.endsWith(release.game!.html.replace(/^<!doctype html>/, '') + adapter), name === 'adapter', name);
      if (name !== 'adapter') continue;
      // The policy lets the module load from beside the document, as the net game's policy always did; the module is a
      // CORS request from the game's opaque origin.
      assert.equal(expected.policy, sandboxPolicy(runtime, player + gameUrl, "'self'", player));
      const module = await fetch(player + gameUrl + 'net/adapter.js');
      assert.deepEqual([module.status, module.headers.get('content-type'), module.headers.get('access-control-allow-origin'), await module.text()],
        [200, 'text/javascript; charset=utf-8', '*', 'export {};']);
    }
  });
}
