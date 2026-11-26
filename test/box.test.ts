// A Zirbel box (box mode): pairing with one-time codes, claiming a box no device has paired with, the paired devices'
// sessions, the box's switches and what is off not running, its own Wi-Fi, the network it answers, and its door.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { networkWake, readOwnNetwork, wifiJoinText } from '../packages/server/box-network.ts';
import { CODE_MS, deviceLabel, normalizeCode, Pairing, sessionToken, WRONG_CODES } from '../packages/server/box-pairing.ts';
import { boxDoor, boxHosts, boxName, boxRequest, isLoopback, onBoxNetwork, type BoxContext } from '../packages/server/box-routes.ts';
import { BoxHarnesses, BoxSettings, harnessesUnavailable, type Capabilities } from '../packages/server/box-settings.ts';
import type { Processors } from '../packages/server/processors.ts';
import { launch, tempDir } from './helpers.ts';

const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const roomy: Capabilities = { arch: 'arm64', memoryMB: 8064, model: 'Raspberry Pi 5 Model B Rev 1.0', harnesses: true };

test('a pairing code is eight unambiguous characters, typed in any case, and pairs one device once', (t) => {
  const pairing = new Pairing(tempDir(t, 'zirbel-box-'));
  const { code, expiresAt } = pairing.createCode();
  assert.match(code, CODE);
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.equal(normalizeCode(code.toLowerCase().replace('-', ' ')), code);
  assert.equal(normalizeCode('abcd-efgo'), 'ABCD-EFG0');
  assert.equal(normalizeCode('1il1-0o00'), '1111-0000');
  for (const wrong of ['ABCD-EFG', 'ABCD-EFGHU', 'ABCD-EF!H', '']) assert.equal(normalizeCode(wrong), undefined, wrong);
  const token = pairing.redeem(code.toLowerCase(), '192.168.1.20', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => pairing.redeem(code, '192.168.1.20'), /wrong or has expired/);
  const [device] = pairing.devices();
  assert.equal(device?.label, 'Safari on iPhone');
  assert.equal(pairing.session('other=1; zirbel_session=' + token)?.id, device?.id);
});

test('a code expires after ten minutes, and wrong codes are limited per address', (t) => {
  let now = Date.parse('2026-11-25T12:00:00Z');
  const pairing = new Pairing(tempDir(t, 'zirbel-box-'), () => now);
  const stale = pairing.createCode().code;
  now += CODE_MS;
  assert.throws(() => pairing.redeem(stale, '10.0.0.5'), /wrong or has expired/);
  const fresh = pairing.createCode().code;
  for (let attempt = 1; attempt < WRONG_CODES; attempt++) assert.throws(() => pairing.redeem('AAAA-AAAA', '10.0.0.5'), /wrong/);
  // The limit holds for the right code too, from that address, until a minute has passed; another address may go on.
  assert.throws(() => pairing.redeem(fresh, '10.0.0.5'), /Too many wrong codes/);
  assert.ok(pairing.redeem(fresh, '10.0.0.6'));
  now += 60_000;
  assert.throws(() => pairing.redeem('AAAA-AAAA', '10.0.0.5'), /wrong or has expired/);
});

test('sessions are kept hashed, are known by their cookie alone, and end when their device is removed', (t) => {
  const folder = tempDir(t, 'zirbel-box-');
  const pairing = new Pairing(folder);
  const token = pairing.redeem(pairing.createCode().code, '192.168.1.20', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36');
  assert.ok(!readFileSync(join(folder, 'paired.json'), 'utf8').includes(token));
  assert.equal(sessionToken('zirbel_session=' + token + '; theme=dark'), token);
  assert.equal(sessionToken('zirbel_session=short'), undefined);
  assert.equal(pairing.session('zirbel_session=' + 'A'.repeat(43)), undefined);
  const device = pairing.session('zirbel_session=' + token);
  assert.deepEqual(pairing.devices(device?.id).map(({ label, current }) => ({ label, current })), [{ label: 'Chrome on Linux', current: true }]);
  pairing.revoke(device!.id);
  assert.equal(pairing.session('zirbel_session=' + token), undefined);
  assert.throws(() => pairing.revoke(device!.id), /not paired/);
  assert.equal(deviceLabel(), 'A browser');
});

test('a box no device has paired with may be claimed once, and stays claimed after every device is removed', (t) => {
  const folder = tempDir(t, 'zirbel-box-');
  const pairing = new Pairing(folder);
  assert.equal(pairing.claimable, true);
  const first = pairing.claim('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Firefox/140.0');
  assert.equal(pairing.claimable, false);
  assert.throws(() => pairing.claim(), /already claimed/);
  pairing.revoke(pairing.session('zirbel_session=' + first)!.id);
  assert.equal(pairing.count, 0);
  assert.equal(new Pairing(folder).claimable, false);
  // A box paired first through a code (its Bluetooth or hotspot setup) is claimed too.
  const other = new Pairing(tempDir(t, 'zirbel-box-'));
  other.redeem(other.createCode().code, '127.0.0.1');
  assert.equal(other.claimable, false);
});

test('the switches start by what the box can do and how much memory it has, and what is off is never built', async (t) => {
  assert.equal(new BoxSettings(tempDir(t, 'zirbel-box-'), roomy).read().harnesses, true);
  assert.equal(new BoxSettings(tempDir(t, 'zirbel-box-'), { arch: 'arm64', memoryMB: 906, harnesses: true }).read().harnesses, false);
  const thirtyTwo: Capabilities = { arch: 'arm', memoryMB: 924, model: 'Raspberry Pi 2 Model B Rev 1.1', harnesses: false };
  assert.equal(new BoxSettings(tempDir(t, 'zirbel-box-'), thirtyTwo).read().harnesses, false);
  assert.match(harnessesUnavailable(thirtyTwo) ?? '', /aren’t made for this box’s arm system/);
  const folder = tempDir(t, 'zirbel-box-');
  const settings = new BoxSettings(folder, roomy);
  assert.deepEqual(settings.update({ externalMcp: true }),
    { version: 1, harnesses: true, externalMcp: true, onboarded: false, setupRequested: false, ownNetwork: false });
  assert.equal(new BoxSettings(folder, roomy).read().externalMcp, true);
  // Settings from before the box's own Wi-Fi have it off; a null is no setting.
  const older = tempDir(t, 'zirbel-box-');
  writeFileSync(join(older, 'settings.json'), JSON.stringify({ version: 1, harnesses: false, externalMcp: true, onboarded: true, setupRequested: false }));
  assert.equal(new BoxSettings(older, roomy).read().ownNetwork, false);
  writeFileSync(join(older, 'settings.json'), JSON.stringify({ version: 1, harnesses: false, externalMcp: true, onboarded: true,
    setupRequested: false, ownNetwork: null }));
  assert.throws(() => new BoxSettings(older, roomy).read(), /could not be read/);

  let built = 0;
  let closed = 0;
  const fake: Processors = { list: async () => [{ id: 'claude', name: 'Claude Code', ready: true }],
    start: async () => ({ name: 'Claude Code', task: 't', stopReason: 'end_turn' }), close: async () => { closed++; } };
  let on = false;
  const harnesses = new BoxHarnesses(() => { built++; return fake; }, () => on);
  assert.deepEqual(await harnesses.list(), []);
  await assert.rejects(harnesses.start('claude', 'Build it.'), /Harnesses are off on this box/);
  await assert.rejects(harnesses.beginSignIn('claude'), /Harnesses are off/);
  await harnesses.removeSession('claude', { cwd: '/tmp/x', sessionId: 's' });
  assert.equal(built, 0);
  on = true;
  assert.equal((await harnesses.list()).length, 1);
  await harnesses.start('claude', 'Build it.');
  assert.equal(built, 1);
  await harnesses.off();
  assert.equal(closed, 1);
});

test('the box answers loopback, private, link-local and unique-local addresses, and refuses the internet', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(address), address);
  for (const address of ['192.168.1.20', '::ffff:10.0.0.4', '172.20.1.1', '169.254.3.3', 'fe80::1', 'fd12:3456::9'])
    assert.ok(onBoxNetwork(address), address);
  for (const address of ['8.8.8.8', '::ffff:1.1.1.1', '172.32.0.1', '2001:4860:4860::8888']) assert.ok(!onBoxNetwork(address), address);
  assert.match(boxName(), /^[a-z0-9-]+\.local$/);
  // Its plain name too, for devices that resolve it through the home router rather than .local.
  assert.ok(boxHosts().includes(boxName().replace(/\.local$/, '')));
});

/** A request as the box's door sees it, from an address, with a body when one is given. */
function incoming(address: string, method: string, path: string, headers: Record<string, string> = {}, text = '') {
  return Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method, url: path, socket: { remoteAddress: address }, headers: { host: 'zirbel.local', ...headers },
  }) as unknown as IncomingMessage;
}
function outgoing() {
  const sent = { status: 0, headers: {} as Record<string, unknown>, body: '' };
  const response = {
    setHeader(name: string, value: unknown) { sent.headers[name.toLowerCase()] = value; },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      sent.status = status;
      for (const [name, value] of Object.entries(headers)) sent.headers[name.toLowerCase()] = value;
      return response;
    },
    end(body?: string | Buffer) { sent.body = body ? body.toString() : ''; },
  };
  return { response: response as unknown as ServerResponse, sent };
}
/** lobby: the LAN player listener's port, while it runs. */
function boxFor(t: Parameters<typeof tempDir>[0], capabilities = roomy, turns = 0, lobby: () => number | undefined = () => 4174): BoxContext {
  const folder = tempDir(t, 'zirbel-box-');
  const settings = new BoxSettings(folder, capabilities);
  mkdirSync(join(folder, 'run'));
  return { pairing: new Pairing(folder), settings, capabilities, port: () => 80, turns: () => turns, lobbyPort: lobby,
    qr: async (text) => 'data:qr,' + encodeURIComponent(text),
    setupRequest: join(folder, 'run', 'request'), ownNetwork: join(folder, 'own-network.json'),
    harnesses: new BoxHarnesses(() => { throw new Error('No harness in this test'); }, () => settings.read().harnesses) };
}
const at = (path: string) => new URL(path, 'http://zirbel.local');

test('the door lets the box itself in, sends an unpaired device to the lobby or pairing, and lets a paired one in', async (t) => {
  const box = boxFor(t);
  assert.deepEqual(await boxDoor(box, incoming('127.0.0.1', 'GET', '/'), outgoing().response, at('/')), { local: true });
  // Its / goes to the lobby on the LAN player listener, by the name the device asked for; the editor's pages to pairing.
  const page = outgoing();
  assert.equal(await boxDoor(box, incoming('192.168.1.20', 'GET', '/'), page.response, at('/')), undefined);
  assert.deepEqual([page.sent.status, page.sent.headers.location], [303, 'http://zirbel.local:4174/']);
  const byAddress = outgoing();
  await boxDoor(box, incoming('fd00::20', 'GET', '/', { host: '[fd00::1]' }), byAddress.response, new URL('http://[fd00::1]/'));
  assert.equal(byAddress.sent.headers.location, 'http://[fd00::1]:4174/');
  const editorPage = outgoing();
  await boxDoor(box, incoming('192.168.1.20', 'GET', '/workspace.js'), editorPage.response, at('/workspace.js'));
  assert.deepEqual([editorPage.sent.status, editorPage.sent.headers.location], [303, '/pair']);
  const noLobby = outgoing();
  await boxDoor(boxFor(t, roomy, 0, () => undefined), incoming('192.168.1.20', 'GET', '/'), noLobby.response, at('/'));
  assert.equal(noLobby.sent.headers.location, '/pair');
  await assert.rejects(boxDoor(box, incoming('192.168.1.20', 'GET', '/api/projects'), outgoing().response, at('/api/projects')), /Pair this device/);
  await assert.rejects(boxDoor(box, incoming('8.8.8.8', 'GET', '/pair'), outgoing().response, at('/pair')), /only its own network/);
  await assert.rejects(boxDoor(box, incoming('192.168.1.20', 'POST', '/turn-mcp'), outgoing().response, at('/turn-mcp')), /does not exist/);
  await assert.rejects(boxDoor(box, incoming('192.168.1.20', 'POST', '/mcp'), outgoing().response, at('/mcp')), /External MCP access is off/);
  box.settings.update({ externalMcp: true });
  assert.deepEqual(await boxDoor(box, incoming('192.168.1.20', 'POST', '/mcp'), outgoing().response, at('/mcp')), { local: false });

  // The pairing page offers the claim while no device has paired; claiming needs this box's own origin.
  const claim = outgoing();
  await boxDoor(box, incoming('192.168.1.20', 'GET', '/pair'), claim.response, at('/pair'));
  assert.match(claim.sent.body, /Claim this box/);
  await assert.rejects(boxDoor(box, incoming('192.168.1.20', 'POST', '/pair', { origin: 'http://evil.example',
    'content-type': 'application/x-www-form-urlencoded' }, 'claim=1'), outgoing().response, at('/pair')), /Cross-origin/);
  assert.equal(box.pairing.claimable, true);
  const claimed = outgoing();
  await boxDoor(box, incoming('192.168.1.20', 'POST', '/pair', { origin: 'http://zirbel.local',
    'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0' }, 'claim=1'),
  claimed.response, at('/pair'));
  assert.equal(claimed.sent.status, 303);
  const cookie = String(claimed.sent.headers['set-cookie']);
  assert.match(cookie, /^zirbel_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
  const session = cookie.split(';')[0]!;
  const access = await boxDoor(box, incoming('192.168.1.20', 'GET', '/api/projects', { cookie: session }), outgoing().response, at('/api/projects'));
  assert.equal(access?.local, false);
  assert.ok(access?.device);
  const after = outgoing();
  await boxDoor(box, incoming('192.168.1.30', 'GET', '/pair'), after.response, at('/pair'));
  assert.doesNotMatch(after.sent.body, /Claim this box/);

  // A code pairs a second device through the same page; a wrong one says so on the page.
  const { code } = box.pairing.createCode();
  const wrong = outgoing();
  await boxDoor(box, incoming('192.168.1.30', 'POST', '/pair', { origin: 'http://zirbel.local',
    'content-type': 'application/x-www-form-urlencoded' }, 'code=AAAA-AAAA'), wrong.response, at('/pair'));
  assert.equal(wrong.sent.status, 403);
  assert.match(wrong.sent.body, /wrong or has expired/);
  const paired = outgoing();
  await boxDoor(box, incoming('192.168.1.30', 'POST', '/pair', { origin: 'http://zirbel.local',
    'content-type': 'application/x-www-form-urlencoded' }, 'code=' + code.toLowerCase()), paired.response, at('/pair'));
  assert.equal(paired.sent.status, 303);
  assert.equal(box.pairing.count, 2);
});

test('the box API: codes, devices, switches and setup (which wakes the setup service), each from whom it may come', async (t) => {
  const box = boxFor(t, { arch: 'arm', memoryMB: 924, harnesses: false });
  const local = { local: true };
  const paired = { local: false, device: 'device' };
  const call = async (access: typeof local, method: string, route: Parameters<typeof boxRequest>[4], payload?: object) => {
    const { response, sent } = outgoing();
    const headers: Record<string, string> = payload ? { 'content-type': 'application/json', origin: 'http://zirbel.local' } : { origin: 'http://zirbel.local' };
    await boxRequest(box, incoming('192.168.1.20', method, '/', headers, payload ? JSON.stringify(payload) : ''), response, access, route);
    return { status: sent.status, json: JSON.parse(sent.body || '{}') };
  };
  const created = await call(paired, 'POST', { resource: 'pairing' }, {});
  assert.equal(created.status, 201);
  assert.match(created.json.code, CODE);
  assert.equal(created.json.url, 'http://' + boxName() + '/pair?code=' + created.json.code);
  const status = await call(local, 'GET', { resource: 'box', pathID: 'status' });
  assert.deepEqual(Object.keys(status.json), ['box', 'paired', 'claimable', 'settings', 'capabilities']);
  assert.deepEqual(status.json.capabilities, { arch: 'arm', memoryMB: 924, harnesses: false });
  await assert.rejects(call(paired, 'GET', { resource: 'box', pathID: 'status' }), /Only the box itself/);
  await assert.rejects(call(paired, 'PUT', { resource: 'box', pathID: 'settings' }, { harnesses: true }), /aren’t made for this box/);
  assert.equal((await call(paired, 'PUT', { resource: 'box', pathID: 'settings' }, { externalMcp: true, onboarded: true })).json.externalMcp, true);
  await assert.rejects(call(paired, 'PUT', { resource: 'box', pathID: 'settings' }, { setupRequested: false }), /Unrecognized key/);
  assert.equal((await call(paired, 'POST', { resource: 'box', pathID: 'setup' }, { requested: true })).json.setupRequested, true);
  // The request wakes the setup service through its file, which the service removes when it is done.
  assert.ok(existsSync(box.setupRequest));
  await assert.rejects(call(paired, 'POST', { resource: 'box', pathID: 'setup' }, { requested: false }), /Only the box itself/);
  assert.equal((await call(local, 'POST', { resource: 'box', pathID: 'setup' }, { requested: false })).json.setupRequested, false);

  const running = boxFor(t, roomy, 1);
  const { response } = outgoing();
  await assert.rejects(boxRequest(running, incoming('192.168.1.20', 'PUT', '/', { 'content-type': 'application/json',
    origin: 'http://zirbel.local' }, '{"harnesses":false}'), response, paired, { resource: 'box', pathID: 'settings' }), /A turn is running/);
});

test('the box’s own Wi-Fi: read as the setup service keeps it, joined by a QR code, switched only where it can be', async (t) => {
  const box = boxFor(t);
  const wake = networkWake(box.setupRequest);
  assert.equal(wake, join(dirname(box.setupRequest), 'network'));
  const paired = { local: false, device: 'device' };
  const call = async (method: string, pathID: string, payload?: object) => {
    const { response, sent } = outgoing();
    const headers: Record<string, string> = { origin: 'http://zirbel.local', ...(payload ? { 'content-type': 'application/json' } : {}) };
    await boxRequest(box, incoming('10.42.0.20', method, '/', headers, payload ? JSON.stringify(payload) : ''), response, paired,
      { resource: 'box', pathID });
    return JSON.parse(sent.body || '{}');
  };
  // A box without its Wi-Fi setup has no network to make, and can't switch it on.
  assert.deepEqual(await call('GET', 'network'), { ownNetwork: false, network: null });
  await assert.rejects(call('PUT', 'settings', { ownNetwork: true }), /can’t make its own Wi-Fi/);
  assert.ok(!existsSync(wake));

  writeFileSync(box.ownNetwork, JSON.stringify({ version: 1, name: 'Zirbel 3F2A', password: 'abcd-efgh-jkmn' }));
  assert.deepEqual(await call('GET', 'network'), { ownNetwork: false,
    network: { name: 'Zirbel 3F2A', password: 'abcd-efgh-jkmn', qr: 'data:qr,' + encodeURIComponent('WIFI:T:WPA;S:Zirbel 3F2A;P:abcd-efgh-jkmn;;') } });
  // Switching it wakes the setup service, which changes the Wi-Fi; setting it to what it is wakes nothing.
  assert.equal((await call('PUT', 'settings', { ownNetwork: true })).ownNetwork, true);
  assert.ok(existsSync(wake));
  rmSync(wake);
  await call('PUT', 'settings', { ownNetwork: true, onboarded: true });
  assert.ok(!existsSync(wake));
  assert.equal((await call('GET', 'network')).ownNetwork, true);
  assert.equal(box.settings.read().setupRequested, false, 'the box’s own Wi-Fi is no setup request');
  assert.ok(!existsSync(box.setupRequest));
  assert.equal((await call('PUT', 'settings', { ownNetwork: false })).ownNetwork, false);
  assert.ok(existsSync(wake));

  // The kept file is checked as a network takes it.
  assert.equal(readOwnNetwork(join(dirname(box.ownNetwork), 'none.json')), undefined);
  for (const kept of [{ version: 1, name: 'Zirbel', password: 'short' }, { version: 1, name: 'x'.repeat(33), password: 'long enough' },
    { version: 1, name: 'Zirbel', password: 'naïve password' }, { version: 1, name: 'Zirbel', password: 'long enough', extra: 1 }]) {
    writeFileSync(box.ownNetwork, JSON.stringify(kept));
    assert.throws(() => readOwnNetwork(box.ownNetwork), /could not be read/, JSON.stringify(kept));
  }
  writeFileSync(box.ownNetwork, ' '.repeat(4097));
  assert.throws(() => readOwnNetwork(box.ownNetwork), /could not be read/);
  // The QR code's text escapes what the WIFI: scheme reserves.
  assert.equal(wifiJoinText({ name: 'A;B,C:D"E\\F', password: 'pass:word;' }), 'WIFI:T:WPA;S:A\\;B\\,C\\:D\\"E\\\\F;P:pass\\:word\\;;;');
});

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
