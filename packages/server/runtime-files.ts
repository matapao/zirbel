import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
export const acceptsGzip = (request: IncomingMessage) =>
  /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
const IMMUTABLE = 'private, max-age=31536000, immutable';

// Runtime files are fixed for the life of the process. Each is hashed once and gzipped once, off the event loop;
// text and WebAssembly over 1 KB are sent gzipped once that is done. host/webfiles keeps the same rules.
export type RuntimeEntry = { body: Buffer; etag: string; gzip?: Buffer };
function runtimeEntry(name: string, body: Buffer) {
  const entry: RuntimeEntry = { body, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' };
  if (/\.(?:js|css|html|txt|wasm)$/.test(name) && body.length > 1024)
    gzipAsync(body).then(
      (data) => {
        entry.gzip = data;
      },
      () => {},
    );
  return entry;
}

// The release runtime, prepared once and shared by the local and LAN listeners.
const prepared = new WeakMap<ReadonlyMap<string, Buffer>, Map<string, RuntimeEntry>>();
export function prepareRuntime(runtime: ReadonlyMap<string, Buffer>) {
  let entries = prepared.get(runtime);
  if (entries) return entries;
  entries = new Map([...runtime].map(([name, file]) => [name, runtimeEntry(name, file)]));
  prepared.set(runtime, entries);
  return entries;
}

// A file at a release's own address never changes there; one at a fixed address (the lobby's page) is checked against
// its etag on each use, so a box that is updated hands every page the new one.
export function sendImmutable(
  request: IncomingMessage,
  response: ServerResponse,
  type: string,
  entry: RuntimeEntry,
  cache = IMMUTABLE,
) {
  const headers = { 'content-type': type, 'cache-control': cache, etag: entry.etag, vary: 'accept-encoding' };
  if (request.headers['if-none-match'] === entry.etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const compressed = entry.gzip && acceptsGzip(request) ? entry.gzip : undefined;
  response.writeHead(200, compressed ? { ...headers, 'content-encoding': 'gzip' } : headers);
  response.end(compressed ?? entry.body);
}

// three.js's addons (web/three/examples/jsm), served to games at <runtime>three/addons/<name>. They come with
// three.module.js, so a release names neither. A game uses a few of the hundreds there, so each file is read on its
// first request and kept; only the names listed here at startup are ever read.
export type Addons = (name: string) => RuntimeEntry | undefined;
export function threeAddons(webRoot: string): Addons {
  const root = join(webRoot, 'three', 'examples', 'jsm');
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    throw new Error('The player runtime is missing three/; run `pnpm build`.');
  }
  const names = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')),
  );
  const loaded = new Map<string, RuntimeEntry>();
  return (name) => {
    if (!names.has(name)) return undefined;
    let entry = loaded.get(name);
    if (!entry) loaded.set(name, (entry = runtimeEntry(name, readFileSync(join(root, name)))));
    return entry;
  };
}

/** The lobby's page and the files it loads (public/lobby.html, packages/web/lobby.ts), served on every player listener
 *  at / and beside it, the TV page's (public/tv.html, packages/web/tv.ts) at /tv, and the pad page's (public/pad.html,
 *  packages/web/pad.ts) at /pad. They are the host's own, not a release's. */
const LOBBY_FILES = [
  'lobby.html',
  'lobby.js',
  'lobby.css',
  'tv.html',
  'tv.js',
  'tv.css',
  'pad.html',
  'pad.js',
  'pad.css',
] as const;
export type LobbyFiles = ReadonlyMap<string, RuntimeEntry>;
export function lobbyFiles(webRoot: string): LobbyFiles {
  return new Map(
    LOBBY_FILES.map((name) => {
      let body;
      try {
        body = readFileSync(join(webRoot, name));
      } catch {
        throw new Error('The player runtime is missing ' + name + '; run `pnpm build`.');
      }
      return [name, runtimeEntry(name, body)];
    }),
  );
}
