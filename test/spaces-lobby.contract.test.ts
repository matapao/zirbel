// A lobby session of a net game is a space of the spaces kernel, on both hosts and with the fake kernel and the real one:
// starting it opens the space (its code the session's), its links hold tickets into it, joining by the code takes one,
// the lobby lists its members as the kernel counts them, ending it closes the space, and a kernel that goes takes its
// sessions with it until the host has started another.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { hostsUnderTest, kernelsUnderTest, launch } from './helpers.ts';
import { alive, call, error, kernelOf, member, roomInfo, spaceLink, spacesFixtures, until } from './spaces-fixtures.ts';

const hosts = hostsUnderTest();
const kernels = kernelsUnderTest();
const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function editorWith(t: TestContext, command: string[], binary: string, env: Record<string, string> = {}) {
  const data = spacesFixtures(t);
  const { child, ready } = launch(
    t,
    command,
    ['--data', data.data, '--port', '0', '--player-port', '0', ...data.imports],
    (line) =>
      typeof line.editor === 'string' && typeof line.player === 'string'
        ? { editor: line.editor, player: line.player }
        : undefined,
    { ZIRBEL_SPACES_BINARY: binary, ...env },
  );
  const { editor, player } = await ready;
  const owner = (method: string, path: string, json?: unknown) => call(editor, method, '/api/' + path, json);
  assert.equal((await owner('POST', 'lobby/offer', { release: data.net.id, offered: true })).status, 200);
  const lobby = (path: string, json?: unknown) =>
    call(player, json === undefined ? 'GET' : 'POST', '/lobby/' + path, json);
  const players = async () =>
    ((await lobby('state')).body as { sessions: { players: number }[] }).sessions.map((item) => item.players);
  return { data, child, player, owner, lobby, players };
}

for (const host of hosts)
  for (const kernel of kernels) {
    test(
      host.name + ' host with the ' + kernel.name + " kernel plays a net game's lobby sessions in spaces",
      async (t) => {
        const { data, player, owner, lobby, players } = await editorWith(t, host.command, kernel.binary);
        const state = (await lobby('state')).body as { games: { multiplayer: boolean }[]; spaces: boolean };
        assert.deepEqual([state.spaces, state.games.map((game) => game.multiplayer)], [true, [true]]);

        // Starting a session opens its space with the code the host chose for it, the session's; the link holds a ticket
        // into it. Its info is for its members, by their proofs.
        const started = await lobby('sessions', { release: data.net.id, name: 'Ada' });
        assert.equal(started.status, 201);
        const { code, link } = started.body as { code: string; link: string };
        assert.match(code, CODE);
        const ada = spaceLink(link);
        assert.deepEqual([ada.origin, ada.kind], [player, 'ticket']);
        assert.deepEqual(await players(), [0]);
        assert.equal((await roomInfo(player, ada.room, ada.space)).status, 403);
        const seated = await member(t, player, ada.space, { ticket: ada.credential });
        assert.deepEqual(seated.seated, ['Ada', 'participant']);
        const info = await roomInfo(player, ada.room, (await seated.ask<{ proof: string }>('space.proof')).proof);
        assert.deepEqual([info.status, info.body.code, info.body.solo], [200, code, false]);
        const space = await call(player, 'GET', '/.skalet/spaces/' + ada.space, undefined, {
          authorization: 'Bearer ' + String(seated.resume),
        });
        assert.deepEqual([space.status, (space.body as { code?: string }).code], [200, code]);
        // A ticket is good once.
        assert.equal((await member(t, player, ada.space, { ticket: ada.credential })).error?.data?.code, 'expired');
        assert.deepEqual(
          await until('the kernel to count Ada', async () => ((await players())[0] === 1 ? [1] : undefined)),
          [1],
        );

        // Joining by the code, in any case and with a dash: a player's place while there is one, then an observer's.
        const dashed = code.toLowerCase().slice(0, 2) + '-' + code.toLowerCase().slice(2);
        const bo = spaceLink(((await lobby('join', { code: dashed, name: 'Bo' })).body as { link: string }).link);
        assert.deepEqual([bo.room, bo.space, bo.kind], [ada.room, ada.space, 'ticket']);
        assert.deepEqual((await member(t, player, bo.space, { ticket: bo.credential })).seated, ['Bo', 'participant']);
        const eve = spaceLink(((await lobby('join', { code, name: 'Eve' })).body as { link: string }).link);
        assert.deepEqual((await member(t, player, eve.space, { ticket: eve.credential })).seated, ['Eve', 'observer']);
        await until('the kernel to count Bo', async () => (await players())[0] === 2 || undefined);

        // A proof is for its own space's room alone.
        const other = (await lobby('sessions', { release: data.net.id, name: 'Cy' })).body as {
          code: string;
          link: string;
        };
        const cy = spaceLink(other.link);
        assert.notEqual(other.code, code);
        const proof = (await seated.ask<{ proof: string }>('space.proof')).proof;
        assert.equal((await roomInfo(player, cy.room, proof)).status, 403);
        assert.equal((await roomInfo(player, ada.room, proof)).status, 200);
        assert.equal((await owner('POST', 'rooms/' + cy.room + '/close', {})).status, 200);

        // A link the kernel formed names the space alone: the lobby page at /join finds its room.
        const page = await call(player, 'GET', '/join');
        assert.deepEqual([page.status, page.headers.get('content-security-policy')], [200, PAGE_POLICY]);
        assert.deepEqual((await lobby('spaces/' + ada.space)).body, { room: ada.room });
        assert.deepEqual(error(await lobby('spaces/abcdefabcdef')), [404, 'This session has ended.']);

        // The owner's rooms carry the code; ending the session closes its space, and its members hear it.
        const rooms = (await owner('GET', 'rooms')).body as { id: string; code?: string }[];
        assert.deepEqual(
          rooms.map((room) => [room.id, room.code]),
          [[ada.room, code]],
        );
        assert.equal((await owner('POST', 'rooms/' + ada.room + '/close', {})).status, 200);
        assert.equal(await seated.closed, 4002);
        assert.deepEqual(await players(), []);
        assert.deepEqual(error(await lobby('join', { code, name: 'Late' })), [404, 'No session has that code.']);
      },
    );
  }

for (const host of hosts) {
  test(
    host.name + " host chooses another code for a session's space when the kernel says another space has it",
    async (t) => {
      // The fake refuses the first nine codes the host chooses: a session gives up after eight, and the next opens with
      // its second.
      const { data, player, lobby } = await editorWith(t, host.command, kernelsUnderTest()[0]!.binary, {
        FAKE_SPACES_TAKEN: '9',
      });
      assert.deepEqual(error(await lobby('sessions', { release: data.net.id, name: 'Ada' })), [
        503,
        "Multiplayer isn't available on this host now. Try again soon.",
      ]);
      const started = await lobby('sessions', { release: data.net.id, name: 'Ada' });
      assert.equal(started.status, 201);
      const { code, link } = started.body as { code: string; link: string };
      const ada = spaceLink(link);
      const seated = await member(t, player, ada.space, { ticket: ada.credential });
      const space = await call(player, 'GET', '/.skalet/spaces/' + ada.space, undefined, {
        authorization: 'Bearer ' + String(seated.resume),
      });
      assert.deepEqual(
        [
          (space.body as { code?: string }).code,
          (await roomInfo(player, ada.room, (await seated.ask<{ proof: string }>('space.proof')).proof)).body.code,
        ],
        [code, code],
      );
    },
  );

  test(host.name + ' host drops the sessions of a kernel that went, and starts another', async (t) => {
    const { data, child, lobby, players } = await editorWith(t, host.command, kernelsUnderTest()[0]!.binary);
    assert.equal((await lobby('sessions', { release: data.net.id, name: 'Ada' })).status, 201);
    assert.deepEqual(await players(), [0]);
    const first = await until('the kernel child', () => kernelOf(child.pid!));
    process.kill(first, 'SIGKILL');
    await until('the session to go with its kernel', async () => (await players()).length === 0 || undefined);
    const second = await until('another kernel child', () => {
      const pid = kernelOf(child.pid!);
      return pid !== first ? pid : undefined;
    });
    assert.ok(alive(second));
    await until(
      'the lobby to have spaces again',
      async () => ((await lobby('state')).body as { spaces: boolean }).spaces || undefined,
    );
    const again = await lobby('sessions', { release: data.net.id, name: 'Ada' });
    assert.deepEqual([again.status, spaceLink((again.body as { link: string }).link).kind], [201, 'ticket']);
  });

  test(host.name + " host without a kernel starts a net game's session for one, played alone", async (t) => {
    const { data, lobby } = await editorWith(t, host.command, '/nonexistent/spaces-kernel');
    const state = (await lobby('state')).body as { games: { multiplayer: boolean }[]; spaces: boolean };
    assert.deepEqual([state.spaces, state.games.map((game) => game.multiplayer)], [false, [false]]);
    const started = (await lobby('sessions', { release: data.net.id, name: 'Ada' })).body as {
      code: unknown;
      link: string;
    };
    assert.equal(started.code, null);
    assert.match(started.link, /\/join\/[a-f0-9]{12}#seat=[\w-]{32}$/);
  });
}
