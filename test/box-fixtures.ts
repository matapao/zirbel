// A box's context for the unit tests, and requests and responses as its door and routes see them.
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { TestContext } from 'node:test';
import { Editors } from '../packages/server/box-editors.ts';
import { Pairing } from '../packages/server/box-pairing.ts';
import type { BoxContext } from '../packages/server/box-routes.ts';
import { BoxHarnesses, BoxSettings, type Capabilities } from '../packages/server/box-settings.ts';
import { tempDir } from './helpers.ts';

export const roomy: Capabilities = { arch: 'arm64', memoryMB: 8064, model: 'Raspberry Pi 5 Model B Rev 1.0', harnesses: true };

/** A request as the box's door sees it, from an address, with a body when one is given. */
export function incoming(address: string, method: string, path: string, headers: Record<string, string> = {}, text = '') {
  return Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method, url: path, socket: { remoteAddress: address }, headers: { host: 'zirbel.local', ...headers },
  }) as unknown as IncomingMessage;
}

export function outgoing() {
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

/** lobby: the LAN player listener's port, while it runs; shared: the address others reach the box by. */
export function boxFor(t: TestContext, capabilities = roomy, turns = 0, lobby: () => number | undefined = () => 4174,
  shared: (host: string) => string | undefined = () => '192.168.1.2'): BoxContext {
  const folder = tempDir(t, 'zirbel-box-');
  const settings = new BoxSettings(folder, capabilities);
  mkdirSync(join(folder, 'run'));
  return { pairing: new Pairing(folder), editors: new Editors(folder), settings, capabilities, port: () => 80, turns: () => turns,
    lobbyPort: lobby, sharedHost: shared, qr: async (text) => 'data:qr,' + encodeURIComponent(text),
    setupRequest: join(folder, 'run', 'request'), ownNetwork: join(folder, 'own-network.json'),
    harnesses: new BoxHarnesses(() => { throw new Error('No harness in this test'); }, () => settings.read().harnesses) };
}

export const at = (path: string) => new URL(path, 'http://zirbel.local');
