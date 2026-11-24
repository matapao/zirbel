import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { chatStreamType, type ChatEvent, type ChatUpdate } from '../sdk/chat-stream.ts';
import { ZirbelError } from '../core/projects.ts';

export const contentType: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8',
};
export const typeFor = (name: string) => contentType[name.split('.').at(-1) ?? ''] ?? 'application/octet-stream';
const editorFiles = /^(?:editor-chunks\/[a-zA-Z0-9_.-]+|workspace\.js|workspace\.css|favicon\.svg)$/;

export function reply(response: ServerResponse, data: unknown, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

export function bytes(response: ServerResponse, file: Buffer | string, type: string, headers = {}) {
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  response.end(file);
}

function failure(error: unknown) {
  if (error instanceof ZirbelError) return { status: error.status, message: error.message };
  if (error instanceof z.ZodError) return { status: 400, message: error.issues.slice(0, 3)
    .map((issue) => (issue.path.length ? issue.path.join('.') + ' · ' : '') + issue.message).join(' · ') };
  console.error(error instanceof Error ? error.message : 'Unknown request failure');
  return { status: 500, message: 'The server could not complete that request.' };
}

export function fail(response: ServerResponse, error: unknown) {
  const { status, message } = failure(error);
  reply(response, { error: message }, status);
}

export async function chatReply(request: IncomingMessage, response: ServerResponse,
  run: (update: ((event: ChatUpdate) => void) | undefined, signal: AbortSignal) => Promise<unknown>, status = 200) {
  if (response.destroyed) return;
  const disconnected = new AbortController();
  const close = () => disconnected.abort(new ZirbelError(409, 'The chat connection closed.'));
  response.once('close', close);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const send = (event: ChatEvent<unknown>) => {
    if (response.destroyed) return;
    if (response.writableLength > 2_000_000) { response.destroy(); return; }
    response.write(JSON.stringify(event) + '\n');
  };
  try {
    if (request.headers.accept !== chatStreamType) {
      const result = await run(undefined, disconnected.signal);
      if (!response.destroyed) reply(response, result, status);
      return;
    }
    response.writeHead(status, { 'content-type': chatStreamType + '; charset=utf-8', 'cache-control': 'no-store' });
    response.flushHeaders();
    heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15_000).unref();
    try { send({ type: 'result', result: await run(send, disconnected.signal) }); }
    catch (error) { send({ type: 'error', error: failure(error).message }); }
    finally { response.end(); }
  } finally {
    clearInterval(heartbeat);
    response.removeListener('close', close);
  }
}

export async function body(request: IncomingMessage, max = 512_000): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new ZirbelError(415, 'Send application/json.');
  if (Number(request.headers['content-length'] ?? 0) > max) throw new ZirbelError(413, 'This file exceeds the upload limit.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > max) throw new ZirbelError(413, 'This file exceeds the upload limit.');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ZirbelError(400, 'Invalid JSON.'); }
}

function baseFor(request: IncomingMessage) { return new URL('http://' + request.headers.host).origin; }

export function checkOrigin(request: IncomingMessage, requireClient = false) {
  const { origin } = request.headers;
  const browserMutation = request.method === 'POST' && request.headers['sec-fetch-mode'] !== undefined;
  if ((origin && origin !== baseFor(request)) || (!origin && (requireClient || browserMutation)))
    throw new ZirbelError(403, 'Cross-origin requests are denied.');
}

export function secure(response: ServerResponse) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

export function requestUrl(request: IncomingMessage, port: number, hosts: string[]) {
  const allowed = hosts.flatMap((host) => port === 80 ? [host, host + ':80'] : [host + ':' + port]);
  if (!allowed.includes(request.headers.host ?? '')) throw new ZirbelError(403, 'This host name is not configured.');
  if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new ZirbelError(400, 'Invalid request URL.');
  const origin = baseFor(request);
  const url = new URL(request.url, origin);
  if (url.origin !== origin) throw new ZirbelError(400, 'Invalid request origin.');
  return url;
}

export function staticFile(response: ServerResponse, root: string, name: string) {
  if (name !== 'index.html' && !editorFiles.test(name)) throw new ZirbelError(404, 'File does not exist.');
  try {
    bytes(response, readFileSync(join(root, name)), typeFor(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ZirbelError(404, 'File does not exist.');
    throw error;
  }
}

export function lanAddresses() {
  return Object.values(networkInterfaces()).flatMap((interfaces) => interfaces ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal &&
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(item.address))
    .map((item) => item.address);
}

export function listen(server: Server, port: number, host: string) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (address && typeof address !== 'string') resolve(address.port);
      else reject(new Error('Unable to determine the listener address.'));
    });
  });
}

export function roomLink(base: string, room: { id: string; invite: string }) {
  return base + '/join/' + room.id + '#' + room.invite;
}
