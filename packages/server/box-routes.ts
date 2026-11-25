// The box's door and its own routes (box mode, --box). The editor listens on every interface, and a request from the
// box itself behaves as without box mode. A request from elsewhere must come from the box's own network, and then
// needs a paired device's session for everything but /pair, where a device pairs with a one-time code (or claims a
// box no device has paired with yet), and /mcp while external MCP access is on, which checks its own project grant.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { z } from 'zod';
import { ZirbelError } from '../core/projects.ts';
import { body, checkOrigin, failure, reply } from './http.ts';
import { normalizeCode, SESSION_COOKIE, type Pairing } from './box-pairing.ts';
import { harnessesUnavailable, settingsChange, type BoxHarnesses, type BoxSettings, type Capabilities } from './box-settings.ts';

export type BoxContext = {
  pairing: Pairing; settings: BoxSettings; harnesses: BoxHarnesses; capabilities: Capabilities;
  /** The editor's port, the turns running now, and a pairing link as a QR code. */
  port: () => number; turns: () => number; qr: (link: string) => Promise<string>;
};
/** Who sent a request: the box itself, or a paired device by its id (none for a project grant's /mcp request). */
export type Access = { local: boolean; device?: string };

/** The box's name on its network: its host name, in mDNS's .local. */
export function boxName() {
  return (hostname().split('.')[0] || 'zirbel').toLowerCase() + '.local';
}

const interfaces = () => Object.values(networkInterfaces()).flatMap((items) => items ?? []).filter((item) => !item.internal);

/** The host names a request may reach the box by: loopback, its .local name and its addresses now, IPv6 bracketed. */
export function boxHosts() {
  return ['localhost', '127.0.0.1', '[::1]', boxName(),
    ...interfaces().map((item) => item.family === 'IPv6' ? '[' + item.address + ']' : item.address)];
}

const plain = (address: string) => address.replace(/^::ffff:(?=\d+\.)/, '');
export const isLoopback = (address = '') => plain(address) === '::1' || plain(address).startsWith('127.');

/** Whether an address is on the box's own network: private, link-local or unique-local, or inside the prefix of one
 *  of the box's interfaces (a home network's global IPv6 addresses). */
export function onBoxNetwork(address = '') {
  const peer = plain(address);
  if (isLoopback(peer) || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(peer) ||
    /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(peer)) return true;
  const own = new BlockList();
  for (const item of interfaces()) {
    const [network, prefix] = item.cidr?.split('/') ?? [];
    if (network && prefix) own.addSubnet(network, Number(prefix), item.family === 'IPv6' ? 'ipv6' : 'ipv4');
  }
  return own.check(peer, peer.includes(':') ? 'ipv6' : 'ipv4');
}

const pairLink = (port: number, code: string) =>
  'http://' + boxName() + (port === 80 ? '' : ':' + port) + '/pair?code=' + encodeURIComponent(code);

/** The door: the request's access, or nothing when it answered the request itself. */
export async function boxDoor(box: BoxContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<Access | undefined> {
  const address = request.socket.remoteAddress ?? '';
  const local = isLoopback(address);
  if (!local && !onBoxNetwork(address)) throw new ZirbelError(403, 'This box answers only its own network.');
  if (url.pathname === '/pair') { await pairRoute(box, request, response, url, address); return; }
  if (local) return { local: true };
  // A turn's own MCP server is for the harness on the box alone.
  if (url.pathname === '/turn-mcp') throw new ZirbelError(404, 'Route does not exist.');
  if (url.pathname === '/mcp') {
    if (!box.settings.read().externalMcp) throw new ZirbelError(403, 'External MCP access is off on this box.');
    return { local: false };
  }
  const device = box.pairing.session(request.headers.cookie);
  if (device) return { local: false, device: device.id };
  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    response.writeHead(303, { location: '/pair', 'cache-control': 'no-store' });
    response.end();
    return;
  }
  throw new ZirbelError(401, 'Pair this device with the box first.');
}

const pairForm = z.strictObject({ code: z.string().max(40).optional(), claim: z.literal('1').optional() });

/** The pairing page: a code, or while no device has ever paired, a one-click claim. */
async function pairRoute(box: BoxContext, request: IncomingMessage, response: ServerResponse, url: URL, address: string) {
  if (request.method === 'GET') {
    if (box.pairing.session(request.headers.cookie)) { redirect(response, '/'); return; }
    page(response, 200, box.pairing.claimable, normalizeCode(url.searchParams.get('code') ?? '') ?? '');
    return;
  }
  if (request.method !== 'POST') throw new ZirbelError(405, 'Open the pairing page.');
  checkOrigin(request, true);
  let typed = '';
  try {
    const form = pairForm.parse(await formBody(request));
    typed = form.code ?? '';
    const agent = request.headers['user-agent'];
    const token = form.claim ? box.pairing.claim(agent) : box.pairing.redeem(typed, address, agent);
    response.setHeader('set-cookie', SESSION_COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000');
    redirect(response, '/');
  } catch (error) {
    const { status, message } = failure(error);
    page(response, status, box.pairing.claimable, normalizeCode(typed) ?? '', message);
  }
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

async function formBody(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')
    throw new ZirbelError(415, 'Send the pairing form.');
  let text = '';
  for await (const chunk of request) {
    text += (chunk as Buffer).toString('utf8');
    if (text.length > 1024) throw new ZirbelError(413, 'The pairing form is too long.');
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

function page(response: ServerResponse, status: number, claimable: boolean, code: string, error?: string) {
  const claim = claimable ? `<form method="post"><input type="hidden" name="claim" value="1">
    <p>No device is paired with this box yet. The first one to claim it can pair others.</p>
    <button>Claim this box</button></form><p class="or">or pair with a code</p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair with Zirbel</title><style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.2rem;color:#1d2b24}
h1{font-size:1.5rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.5rem;border:1px solid #8a9a90}
input{width:100%;box-sizing:border-box;letter-spacing:.15em;text-transform:uppercase}button{margin-top:.8rem;background:#274336;color:#fff;border:0}
.error{color:#a3271f}.or{color:#5c6b62;margin-top:1.6rem}</style></head><body><h1>Pair this device with Zirbel</h1>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}${claim}<form method="post">
<label for="code">Pairing code, from a device already paired or the box's setup</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" value="${escape(code)}" required>
<button>Pair this device</button></form></body></html>`;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    // A form posted under no-referrer carries the origin "null": this page's own forms carry its origin.
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(html);
}

const setupInput = z.strictObject({ requested: z.boolean() });

function settingsView(box: BoxContext) {
  const { harnesses, externalMcp, onboarded, setupRequested } = box.settings.read();
  return { harnesses, externalMcp, onboarded, setupRequested };
}

/** What the workspace knows of the box, in /api/health. */
export function boxHealth(box: BoxContext) {
  const { capabilities } = box;
  return { ...settingsView(box), canRunHarnesses: capabilities.harnesses, harnessesUnavailable: harnessesUnavailable(capabilities),
    memoryMB: capabilities.memoryMB, name: boxName() };
}

/** The box's own API: /api/pairing… and /api/box/…. Says whether it answered the request. */
export async function boxRequest(box: BoxContext, request: IncomingMessage, response: ServerResponse, access: Access,
  route: { resource?: string; pathID?: string; action?: string; tail?: string }) {
  const { resource, pathID, action, tail } = route;
  const method = request.method;
  if (method !== 'GET') checkOrigin(request, !access.local);
  if (resource === 'pairing' && !action && !tail) {
    if (!pathID && method === 'POST') {
      const { code, expiresAt } = box.pairing.createCode();
      const url = pairLink(box.port(), code);
      reply(response, { code, url, expiresAt, qr: await box.qr(url) }, 201);
      return true;
    }
    if (pathID === 'devices' && method === 'GET') { reply(response, { devices: box.pairing.devices(access.device) }); return true; }
  }
  if (resource === 'pairing' && pathID === 'devices' && action && !tail && method === 'DELETE') {
    box.pairing.revoke(z.string().regex(/^[a-z0-9-]{1,80}$/).parse(action));
    reply(response, {});
    return true;
  }
  if (resource !== 'box' || action || tail) return false;
  if (pathID === 'status' && method === 'GET') {
    if (!access.local) throw new ZirbelError(403, 'Only the box itself reads its status.');
    reply(response, { box: true, paired: box.pairing.count, claimable: box.pairing.claimable, settings: settingsView(box),
      capabilities: box.capabilities });
    return true;
  }
  if (pathID === 'settings' && method === 'GET') { reply(response, settingsView(box)); return true; }
  if (pathID === 'settings' && method === 'PUT') {
    const change = settingsChange.parse(await body(request, 4096));
    const unavailable = harnessesUnavailable(box.capabilities);
    if (change.harnesses && unavailable) throw new ZirbelError(409, unavailable);
    if (change.harnesses === false && box.settings.read().harnesses) {
      if (box.turns()) throw new ZirbelError(409, 'A turn is running. Stop it before turning harnesses off.');
      box.settings.update({ harnesses: false });
      await box.harnesses.off();
    }
    box.settings.update(change);
    reply(response, settingsView(box));
    return true;
  }
  if (pathID === 'setup' && method === 'POST') {
    const { requested } = setupInput.parse(await body(request, 1024));
    if (!requested && !access.local) throw new ZirbelError(403, 'Only the box itself ends its setup.');
    box.settings.update({ setupRequested: requested });
    reply(response, { setupRequested: requested });
    return true;
  }
  return false;
}
