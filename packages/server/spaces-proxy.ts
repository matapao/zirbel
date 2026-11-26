// /.skalet/* on Zirbel's listeners, passed to the spaces kernel Zirbel runs (spaces.ts): its modules, its HTTP routes and
// the WebSocket at /.skalet/spaces. Each request goes with the kernel's token (x-skalet-proxy), the listener of Zirbel's
// skalet.json it came by (x-skalet-listener: player or editor), the host its page named (x-forwarded-host) and the
// address it came from (x-forwarded-for); whatever x-skalet-* or forwarding headers a client sent are dropped. The kernel
// checks the rest: origins, credentials, its own limits. Under a host that runs the kernel, its front answers these
// paths before Zirbel sees them, so a request here then finds none.
import { request as outbound, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { refuseUpgrade, reply } from './http.ts';

export type SpacesTarget = () => { http: string; token: string } | null;

/** The kernel's paths. */
export const isSpacesPath = (pathname: string) => pathname === '/.skalet' || pathname.startsWith('/.skalet/');

const UNAVAILABLE = 'Multiplayer isn\'t available on this host now.';
/** Not passed on: the connection's own, and whatever says where a request came from but this proxy. */
const DROPPED = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);

function headersFor(request: IncomingMessage, listener: string, token: string, upgrade: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED.has(name) || name.startsWith('x-skalet-')) continue;
    headers[name] = value;
  }
  if (upgrade) Object.assign(headers, { connection: 'upgrade', upgrade: 'websocket' });
  return { ...headers, 'x-skalet-proxy': token, 'x-skalet-listener': listener, 'x-forwarded-host': request.headers.host ?? '',
    'x-forwarded-for': (request.socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.)/, ''), 'x-forwarded-proto': 'http' };
}

const address = (http: string) => {
  const url = new URL(http);
  return { host: url.hostname, port: Number(url.port) };
};

/** An HTTP request to /.skalet/*, answered by the kernel. */
export function proxySpaces(target: SpacesTarget, listener: string, request: IncomingMessage, response: ServerResponse) {
  const kernel = target();
  if (!kernel) { reply(response, { error: UNAVAILABLE }, 503); return; }
  const out = outbound({ ...address(kernel.http), method: request.method, path: request.url,
    headers: headersFor(request, listener, kernel.token, false) }, (answer) => {
    const headers = { ...answer.headers };
    for (const name of ['connection', 'keep-alive', 'transfer-encoding']) delete headers[name];
    response.writeHead(answer.statusCode ?? 502, headers);
    answer.pipe(response);
  });
  out.on('error', () => {
    if (!response.headersSent) reply(response, { error: UNAVAILABLE }, 502);
    else response.destroy();
  });
  request.pipe(out);
}

/** A WebSocket's upgrade at /.skalet/spaces, joined to the kernel's: its answer goes back as it is, and then the bytes
 *  both ways. */
export function proxySpacesUpgrade(target: SpacesTarget, listener: string, request: IncomingMessage, stream: Duplex, head: Buffer) {
  const kernel = target();
  if (!kernel) { refuseUpgrade(stream, 503, UNAVAILABLE); return; }
  const out = outbound({ ...address(kernel.http), method: 'GET', path: request.url,
    headers: headersFor(request, listener, kernel.token, true) });
  const answer = (status: number, message: string, raw: string[]) => {
    let text = 'HTTP/1.1 ' + status + ' ' + message + '\r\n';
    for (let at = 0; at + 1 < raw.length; at += 2) text += raw[at] + ': ' + raw[at + 1] + '\r\n';
    stream.write(text + '\r\n');
  };
  stream.on('error', () => out.destroy());
  out.on('upgrade', (upgraded, socket, upgradedHead) => {
    answer(101, 'Switching Protocols', upgraded.rawHeaders);
    if (upgradedHead.length) stream.write(upgradedHead);
    if (head.length) socket.write(head);
    socket.on('error', () => stream.destroy());
    stream.on('close', () => socket.destroy());
    socket.on('close', () => stream.destroy());
    socket.pipe(stream);
    stream.pipe(socket);
  });
  // Refused: its status and its (short) body, and the end of the connection.
  out.on('response', (refused) => {
    const chunks: Buffer[] = [];
    let length = 0;
    refused.on('data', (chunk: Buffer) => { if ((length += chunk.length) <= 65_536) chunks.push(chunk); });
    refused.on('end', () => {
      const body = Buffer.concat(chunks);
      answer(refused.statusCode ?? 502, refused.statusMessage ?? '', ['connection', 'close',
        'content-type', String(refused.headers['content-type'] ?? 'application/json; charset=utf-8'),
        'x-content-type-options', 'nosniff', 'content-length', String(body.length)]);
      stream.end(body);
    });
  });
  out.on('error', () => { if (stream.writable) refuseUpgrade(stream, 503, UNAVAILABLE); });
  out.end();
}
