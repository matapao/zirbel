#!/usr/bin/env node
// A fake of the spaces kernel's `spaces` mode, for Zirbel's own tests on both hosts: the hosts run it as they run the
// real binary (ZIRBEL_SPACES_BINARY). It prints the start line, ends when its stdin closes or on SIGTERM, answers the
// local socket's calls Zirbel makes (app.hello, space.open, space.list, space.info, space.ticket, space.close), and
// behind the proxy's token the HTTP routes and a minimal /.skalet/spaces WebSocket: a hello seats a member by its
// ticket, invitation or resume, and the member goes when its socket closes. GET /.skalet/echo, the fake's alone, answers
// with the request as the proxy passed it on.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { createServer as net } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const at = args.indexOf('--manifest');
if (args[0] !== 'spaces' || at < 0 || !args[at + 1]) {
  console.error('fake-spaces spaces --manifest <skalet.json>');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(args[at + 1], 'utf8'));
if (!manifest.spaces || !manifest.listeners) { console.error('skalet.json has no spaces block'); process.exit(2); }

const secret = () => randomBytes(24).toString('base64url');
const token = secret();
const LETTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** id → { id, listener, code?, invite, participants, observers, tickets: Map(ticket → { name, role, member? }),
 *  members: Map(id → { id, n, name, role, kind, resume, socket? }) } */
const spaces = new Map();
const join_ = (listener) => manifest.spaces.join?.[listener] ?? '/';

function summary(space) {
  return { space: space.id, listener: space.listener, rules: null, ...(space.code ? { code: space.code } : {}),
    members: [...space.members.values()].map(({ id, n, name, role, kind, socket }) =>
      ({ id, n, name, role, kind, connected: Boolean(socket), away: false })) };
}
const failure = (code, message) => ({ code: -32000, message, data: { code } });
const counted = (space, role) => [...space.members.values()].filter((m) => m.role === role).length +
  [...space.tickets.values()].filter((t) => !t.member && t.role === role).length;

function call(method, params) {
  const space = spaces.get(params?.space);
  switch (method) {
    case 'space.open': {
      if (params.listener !== 'player' && params.listener !== 'editor') return { error: failure('protocol', 'No such listener.') };
      if (spaces.size >= (manifest.spaces.limits?.openSpaces ?? 32)) return { error: failure('full', 'Too many spaces.') };
      // As the kernel takes it: 5 to 600 s, within the app's limits.graceSeconds (90 by default).
      if (params.graceSeconds !== undefined && !(Number.isInteger(params.graceSeconds) && params.graceSeconds >= 5 &&
        params.graceSeconds <= Math.min(600, manifest.spaces.limits?.graceSeconds ?? 90)))
        return { error: failure('protocol', 'graceSeconds is out of range.') };
      const id = randomBytes(6).toString('hex');
      let code;
      if (params.code) do code = Array.from(randomBytes(4), (b) => LETTERS[b & 31]).join('');
      while ([...spaces.values()].some((other) => other.code === code));
      const opened = { id, listener: params.listener, code, invite: secret(), participants: params.members?.participants ?? 8,
        observers: params.members?.observers ?? 0, tickets: new Map(), members: new Map() };
      spaces.set(id, opened);
      return { result: { space: id, link: join_(params.listener) + '#skalet.space=' + id + '&skalet.invite=' + opened.invite,
        ...(code ? { code } : {}) } };
    }
    case 'space.list': return { result: [...spaces.values()].map(summary) };
  }
  if (!space) return { error: failure('expired', 'The app has no such space open.') };
  switch (method) {
    case 'space.info': return { result: summary(space) };
    case 'space.close':
      spaces.delete(space.id);
      for (const member of space.members.values()) member.socket?.close(4002, 'The app closed this space.');
      return { result: {} };
    case 'space.ticket': {
      if (params.member) {
        if (!space.members.has(params.member)) return { error: failure('expired', 'No such member is in the space.') };
        const ticket = secret();
        space.tickets.set(ticket, { member: params.member });
        return { result: { ticket, link: join_(space.listener) + '#skalet.space=' + space.id + '&skalet.ticket=' + ticket } };
      }
      if (!params.name || !['participant', 'observer'].includes(params.role)) return { error: { code: -32602, message: 'Invalid params.' } };
      if (counted(space, params.role) >= (params.role === 'participant' ? space.participants : space.observers))
        return { error: failure('full', 'That space is full.') };
      const ticket = secret();
      space.tickets.set(ticket, { name: params.name, role: params.role });
      return { result: { ticket, link: join_(space.listener) + '#skalet.space=' + space.id + '&skalet.ticket=' + ticket } };
    }
  }
  return { error: { code: -32601, message: 'No method ' + method + '.' } };
}

// The local socket.
const folder = mkdtempSync(join(tmpdir(), 'fake-spaces-'));
const socketPath = join(folder, 'spaces.sock');
const local = net((connection) => {
  let hello = false, buffer = '';
  connection.setEncoding('utf8');
  connection.on('error', () => connection.destroy());
  connection.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const answer = (reply) => connection.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\n');
      if (!hello) {
        hello = message.method === 'app.hello' && message.params?.token === token && message.params?.protocol === 1;
        answer(hello ? { result: { protocol: 1, app: manifest.id } } : { error: failure('forbidden', 'That is no app\'s token.') });
        if (!hello) connection.end();
        continue;
      }
      answer(call(message.method, message.params ?? {}));
    }
  });
});

// The HTTP routes, behind the proxy's token.
const reply = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
};
/** The request as the proxy passed it on, or why it isn't one. */
function proxied(request) {
  if (request.headers['x-skalet-proxy'] !== token) return 'Spaces answers through the app\'s own proxy only.';
  if (!Object.hasOwn(manifest.listeners, String(request.headers['x-skalet-listener']))) return 'Name the app\'s listener.';
}
const holds = (space, credential) => credential && (credential === space.invite || space.tickets.has(credential) ||
  [...space.members.values()].some((member) => member.resume === credential));
const server = http((request, response) => {
  const url = new URL(request.url, 'http://fake');
  if (url.pathname === '/health') { reply(response, 200, { ok: true }); return; }
  const refused = proxied(request);
  if (refused) { reply(response, 403, { error: refused }); return; }
  if (request.method === 'GET' && (url.pathname === '/.skalet/spaces.js' || url.pathname === '/.skalet/net.js')) {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' });
    response.end('export const fake = ' + JSON.stringify(url.pathname) + ';\n');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/.skalet/echo') {
    reply(response, 200, { method: request.method, url: request.url, headers: request.headers });
    return;
  }
  const info = /^\/\.skalet\/spaces\/([0-9a-f]{12})$/.exec(url.pathname)?.[1];
  if (info && request.method === 'GET') {
    const space = spaces.get(info);
    const credential = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!space || !holds(space, credential)) reply(response, 404, { error: 'No such space here, or not for this credential.' });
    else reply(response, 200, summary(space));
    return;
  }
  reply(response, 404, { error: 'Spaces has no such path.' });
});

// The WebSocket: a hello seats a member; nothing else is carried but an echo of what the member sends.
const sockets = new WebSocketServer({ noServer: true,
  handleProtocols: (offered) => [...offered].find((p) => p === 'skalet.spaces.v1.json' || p === 'skalet.spaces.v1.bin') ?? false });
server.on('upgrade', (request, stream, head) => {
  // As the kernel: a page of the front's own origin, or one in an opaque-origin sandbox, or a program.
  const origin = request.headers.origin;
  const refused = proxied(request) ?? (new URL(request.url, 'http://fake').pathname === '/.skalet/spaces' ? undefined : 'No such path.') ??
    (origin && origin !== 'null' && origin !== 'http://' + request.headers['x-forwarded-host'] ? 'Other origins are refused.' : undefined);
  if (refused) { stream.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); return; }
  sockets.handleUpgrade(request, stream, head, (socket) => {
    let member, space;
    socket.on('message', (data) => {
      const message = JSON.parse(new TextDecoder().decode(data));
      const answer = (reply) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
      if (member) { socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'fake.echo', params: message })); return; }
      space = spaces.get(message.params?.space);
      const credential = message.params?.credential ?? {};
      if (message.method !== 'space.hello' || !space) {
        answer({ error: failure('expired', 'This space doesn\'t exist here, or has closed.') });
        socket.close(4003);
        return;
      }
      const resumed = [...space.members.values()].find((m) => credential.resume && m.resume === credential.resume);
      const ticket = credential.ticket && space.tickets.get(credential.ticket);
      if (credential.ticket) space.tickets.delete(credential.ticket);
      const handed = ticket?.member && space.members.get(ticket.member);
      const invited = credential.invite === space.invite && credential.name && credential.role ? credential : undefined;
      if (resumed || handed) {
        member = resumed ?? handed;
        member.socket?.close(4001, 'Connected again elsewhere.');
        if (handed) member.resume = secret();
      } else if ((ticket && !ticket.member) || invited) {
        const asked = ticket || invited;
        const n = Math.max(0, ...[...space.members.values()].map((m) => m.n)) + 1;
        member = { id: randomBytes(16).toString('hex'), n, name: asked.name, role: asked.role, kind: 'person', resume: secret() };
        space.members.set(member.id, member);
      } else {
        answer({ error: failure('expired', 'This ticket has expired or was used. Join again.') });
        socket.close(4003);
        return;
      }
      member.socket = socket;
      const { id, n, name, role, kind } = member;
      answer({ result: { protocol: 1, features: [], member: { id, n, name, role, kind }, resume: member.resume, ack: 0,
        rules: { id: null }, limits: { jsonBytes: 16384, binaryBytes: 1048576, messagesPerSecond: 60 }, time: Date.now() } });
    });
    socket.on('close', () => {
      if (member?.socket === socket) { member.socket = undefined; space?.members.delete(member.id); }
    });
  });
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const client of sockets.clients) client.terminate();
  server.close();
  local.close();
  rmSync(folder, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (process.env.SKALET_EXIT_WITH_STDIN === '1') { process.stdin.on('end', stop); process.stdin.resume(); }

local.listen(socketPath, () => server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write(JSON.stringify({ spaces: 'http://127.0.0.1:' + port, socket: 'unix:' + socketPath, token,
    mcp: 'http://127.0.0.1:' + port + '/.skalet/mcp', pid: process.pid }) + '\n');
}));
