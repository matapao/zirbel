// The spaces kernel on both hosts, `node dist/server.mjs` and the Go host, each with the fake kernel (test/fake-spaces.mjs)
// and with the real binary once `pnpm run deps` has built it: the child each host runs (its start line, its stdin, its
// restart), the /.skalet/* proxy on the player and editor listeners with its headers, a net game's room as a space, and
// a host that runs none because the environment names one already.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import {
  FAKE_SPACES,
  hostsUnderTest,
  kernelsUnderTest,
  launch,
  NO_SPACES,
  sandboxPolicy,
  stopHost,
} from './helpers.ts';
import { alive, call, error, kernelOf, member, roomInfo, spaceLink, spacesFixtures, until } from './spaces-fixtures.ts';

const hosts = hostsUnderTest();
const kernels = kernelsUnderTest();

/** A headless host that opens a room for the net game, with the kernel at binary: its player address, its room's link,
 *  and its process. */
async function headless(t: TestContext, command: string[], binary: string) {
  const data = spacesFixtures(t);
  const links: string[] = [];
  const { child, ready } = launch(
    t,
    command,
    ['--host-only', '--player-port', '0', '--data', data.data, ...data.imports, '--release', data.net.id],
    (line) => {
      if (typeof line.player === 'string') return line.player;
      if (typeof line.link === 'string') links.push(line.link);
      return undefined;
    },
    { ZIRBEL_SPACES_BINARY: binary },
  );
  return { player: await ready, link: links[0], child };
}

for (const host of hosts)
  for (const kernel of kernels) {
    const name = host.name + ' host with the ' + kernel.name + ' kernel';

    test(name + " plays a net game's room in a space, through /.skalet/* on its player listener", async (t) => {
      const { player, link } = await headless(t, host.command, kernel.binary);
      const room = spaceLink(link);
      assert.deepEqual([room.origin, room.kind], [player, 'invite']);

      // The kernel's modules, for pages and for games in their opaque origin; a client's own x-skalet-* go nowhere.
      for (const headers of [{}, { 'x-skalet-proxy': 'not-the-token-at-all', 'x-skalet-listener': 'editor' }] as Record<
        string,
        string
      >[]) {
        const module = await fetch(player + '/.skalet/spaces.js', { headers });
        assert.deepEqual(
          [module.status, module.headers.get('content-type'), module.headers.get('access-control-allow-origin')],
          [200, 'text/javascript; charset=utf-8', '*'],
        );
        assert.equal((await fetch(player + '/.skalet/net.js', { headers })).status, 200);
      }
      // The space's summary, for a holder of its invitation.
      const summary = await call(player, 'GET', '/.skalet/spaces/' + room.space, undefined, {
        authorization: 'Bearer ' + room.credential,
      });
      assert.deepEqual([summary.status, (summary.body as { space: string }).space], [200, room.space]);

      // Its members join through the listener's socket: with the invitation, from the page's own origin or a sandbox's.
      const ada = await member(t, player, room.space, { invite: room.credential, name: 'Ada', role: 'participant' });
      assert.deepEqual([ada.member?.n, ada.seated], [1, ['Ada', 'participant']]);
      assert.ok(ada.features?.includes('handover.v1') && ada.features.includes('proof.v1'));
      const bo = await member(
        t,
        player,
        room.space,
        { invite: room.credential, name: 'Bo', role: 'participant' },
        'null',
      );
      assert.deepEqual(bo.seated, ['Bo', 'participant']);
      await assert.rejects(
        member(
          t,
          player,
          room.space,
          { invite: room.credential, name: 'Mal', role: 'participant' },
          'http://evil.example',
        ),
      );

      // The room is for its space's members, by a proof a member's own connection made, once: neither the space's id, in
      // every link, nor anything made up opens it. Its game page may import the kernel's modules and reach its socket.
      for (const credential of [room.space, room.credential, 'abcdefabcdefabcdefabcdef', ''])
        assert.equal((await roomInfo(player, room.room, credential)).status, 403, credential);
      const proof = (await ada.ask<{ proof: string }>('space.proof')).proof;
      const info = await roomInfo(player, room.room, proof);
      assert.deepEqual([info.status, info.body.manifest.simulation], [200, 'net-v2']);
      assert.equal((await roomInfo(player, room.room, proof)).status, 403);
      const { gameUrl } = info.body;
      assert.match(gameUrl, new RegExp('^/game/' + room.room + '/[\\w-]{32}/$'));
      const page = await fetch(player + gameUrl);
      assert.equal(
        page.headers.get('content-security-policy'),
        sandboxPolicy(player + '/runtime/' + room.room + '/', player + gameUrl, "'self'", player),
      );

      // A member hands its own place over: the link is the join page on the host it came by, its ticket good once, a new
      // one in place of the one before. Whoever opens it is the same member; the old connection ends as replaced, and the
      // proofs it made are good no more.
      const first = await ada.ask<{ ticket: string }>('space.handover');
      const { link: handed, ticket } = await ada.ask<{ link: string; ticket: string }>('space.handover');
      assert.equal(handed, player + '/join#skalet.space=' + room.space + '&skalet.ticket=' + ticket);
      assert.equal((await member(t, player, room.space, { ticket: first.ticket })).error?.data?.code, 'expired');
      const stale = (await ada.ask<{ proof: string }>('space.proof')).proof;
      const tv = await member(t, player, room.space, { ticket });
      assert.deepEqual([tv.member?.id, tv.member?.n, tv.seated], [ada.member?.id, 1, ['Ada', 'participant']]);
      assert.equal(await ada.closed, 4001);
      assert.equal((await member(t, player, room.space, { ticket })).error?.data?.code, 'expired');
      assert.equal((await roomInfo(player, room.room, stale)).status, 403);
      assert.equal(
        (await roomInfo(player, room.room, (await tv.ask<{ proof: string }>('space.proof')).proof)).status,
        200,
      );

      // The relay and the earlier client are gone from every listener.
      for (const path of ['/zirbel-net.js', '/zirbel-net/SKILL.md', '/mp'])
        assert.equal((await fetch(player + path)).status, 404, path);
      await assert.rejects(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(player.replace('http', 'ws') + '/mp');
          ws.once('open', () => {
            ws.close();
            resolve(undefined);
          });
          ws.once('error', reject);
        }),
      );
    });

    test(name + ' runs one kernel child, which ends with the host however the host ends', async (t) => {
      const { player, child } = await headless(t, host.command, kernel.binary);
      const pid = await until('the kernel child', () => kernelOf(child.pid!));
      assert.ok(alive(pid));
      // Killed, the host can say nothing: the child ends as its stdin closes.
      child.kill('SIGKILL');
      await until('the child to end', () => !alive(pid) || undefined);
      await assert.rejects(fetch(player + '/health'));
    });
  }

for (const host of hosts) {
  test(
    host.name + " host passes /.skalet/* with the proxy's headers, its own token and the listener each came by",
    async (t) => {
      const data = spacesFixtures(t);
      const { editor, player } = await launch(
        t,
        host.command,
        ['--data', data.data, '--port', '0', '--player-port', '0'],
        (line) =>
          typeof line.editor === 'string' && typeof line.player === 'string'
            ? { editor: line.editor, player: line.player }
            : undefined,
      ).ready;
      const echo = async (base: string) =>
        (
          await call(base, 'GET', '/.skalet/echo?x=1', undefined, {
            'x-skalet-proxy': 'not-the-token',
            'x-skalet-listener': 'editor',
            'x-skalet-audience': 'owner',
            'x-forwarded-for': '10.9.8.7',
            'x-forwarded-host': 'evil.example',
            forwarded: 'for=10.9.8.7',
          })
        ).body as { url: string; headers: Record<string, string> };
      for (const [base, listener] of [
        [player, 'player'],
        [editor, 'editor'],
      ] as const) {
        const { url, headers } = await echo(base);
        assert.equal(url, '/.skalet/echo?x=1');
        assert.deepEqual(
          [
            headers['x-skalet-listener'],
            headers['x-forwarded-host'],
            headers['x-forwarded-for'],
            headers['x-forwarded-proto'],
          ],
          [listener, new URL(base).host, '127.0.0.1', 'http'],
          listener,
        );
        assert.match(headers['x-skalet-proxy'] ?? '', /^[\w-]{32}$/);
        assert.equal('x-skalet-audience' in headers || 'forwarded' in headers, false);
      }
      // The editor's socket is for this device's own pages, and only the kernel's.
      const refused = await new Promise<number>((resolve) => {
        const ws = new WebSocket(editor.replace('http', 'ws') + '/elsewhere');
        ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        ws.once('open', () => resolve(101));
      });
      assert.equal(refused, 403);
      const socket = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(editor.replace('http', 'ws') + '/.skalet/spaces', ['skalet.spaces.v1.json'], {
          origin: editor,
        });
        ws.once('open', () => {
          resolve(ws.protocol);
          ws.close();
        });
        ws.once('error', reject);
      });
      assert.equal(socket, 'skalet.spaces.v1.json');
    },
  );

  test(host.name + ' host without a kernel plays net games alone and says multiplayer is not available', async (t) => {
    const data = spacesFixtures(t);
    const player = await launch(
      t,
      host.command,
      ['--host-only', '--player-port', '0', '--data', data.data, ...data.imports, '--release', data.net.id],
      (line) => (typeof line.player === 'string' ? line.player : undefined),
      { ZIRBEL_SPACES_BINARY: NO_SPACES },
    ).ready;
    for (const path of ['/.skalet/spaces.js', '/.skalet/net.js', '/.skalet/spaces'])
      assert.deepEqual(
        error(await call(player, 'GET', path)),
        [503, "Multiplayer isn't available on this host now."],
        path,
      );
  });

  test(host.name + ' host under a host that runs the kernel uses that one and runs none', async (t) => {
    const data = spacesFixtures(t);
    // The kernel a host gives its apps: the fake, run here, its socket and token in the environment.
    const given = spawn(process.execPath, [FAKE_SPACES, 'spaces', '--manifest', 'skalet.json'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    t.after(() => stopHost(given));
    const started = JSON.parse(
      await new Promise<string>((resolve) => createInterface({ input: given.stdout }).once('line', resolve)),
    ) as { socket: string; token: string };
    const { child, ready } = launch(
      t,
      host.command,
      ['--host-only', '--player-port', '0', '--data', data.data, ...data.imports, '--release', data.net.id],
      (line) => (typeof line.link === 'string' ? line.link : undefined),
      { SKALET_SPACES: started.socket, SKALET_SPACES_TOKEN: started.token },
    );
    // Its room's space is the given kernel's; its front answers /.skalet/*, so the host's own listener has none to pass on.
    const room = spaceLink(await ready);
    assert.equal(room.kind, 'invite');
    assert.equal(kernelOf(child.pid!), undefined);
    const player = room.origin;
    assert.equal((await call(player, 'GET', '/.skalet/spaces.js')).status, 503);
  });
}
