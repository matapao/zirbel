// For the box contract: a box on loopback with the files its setup service would read and leave, this computer's own
// network address to reach it from as a device would, a client for both, and the normalizing of their answers.
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { launch, tempDir } from './helpers.ts';

/** This computer's address on a private network, which reaches the box as a device on its network would. */
export const lan = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4' &&
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
if (!lan) console.log('# No private network address: the box contract runs from loopback only.');

/** A box on loopback, with the files a setup request and a switch of the box's own Wi-Fi leave for the box's setup
 *  service, and where that service would keep the own Wi-Fi's name and password. */
export async function startBox(t: TestContext, command: string[]) {
  const root = tempDir(t, 'zirbel-box-');
  const account = join(root, 'account');
  mkdirSync(account, { mode: 0o700 });
  mkdirSync(join(root, 'run'));
  mkdirSync(join(root, 'tv'));
  const wake = join(root, 'run', 'request');
  const own = join(root, 'own-network.json');
  const tv = join(root, 'tv', 'wake');
  const pads = join(root, 'host.sock');
  // Its LAN player listener, which a box runs from start-up, on any free port, and the local socket for its controller
  // service.
  const { ready } = launch(t, command, ['--data', join(root, 'data'), '--port', '0', '--player-port', '0', '--box',
    '--pads-socket', pads],
    (line) => typeof line.editor === 'string' ? line.editor : undefined,
    { ZIRBEL_ACCOUNT_DIR: account, ZIRBEL_SETUP_REQUEST: wake, ZIRBEL_OWN_NETWORK: own, ZIRBEL_TV_WAKE: tv });
  return { editor: await ready, wake, own, network: join(root, 'run', 'network'), account, tv, pads };
}
export type Started = Awaited<ReturnType<typeof startBox>>;

export type Step = {
  status: number; body: unknown; location?: string | null; cookie?: string | undefined; headers?: Record<string, string | null> | undefined;
};
/** The pairing and edit pages' headers, which a browser's form and its Origin depend on. */
const PAGE_HEADERS = ['content-type', 'cache-control', 'referrer-policy', 'content-security-policy', 'x-content-type-options'];
/** session: an owner's, as its cookie carries it; editor: an editor's of one game. */
type Call = { json?: unknown; form?: Record<string, string>; origin?: boolean; session?: string; editor?: string; raw?: string };

/** A call's request body: its JSON, else its form, else none. */
function requestBody(json: unknown, form: Record<string, string> | undefined) {
  if (json !== undefined) return JSON.stringify(json);
  return form ? new URLSearchParams(form) : null;
}

export function client(base: string) {
  return async (method: string, path: string, { json, form, origin, session, editor, raw }: Call = {}): Promise<Step> => {
    const headers: Record<string, string> = {};
    if (origin) headers.origin = base;
    const cookies = [...(session ? ['zirbel_session=' + session] : []), ...(editor ? ['zirbel_editor=' + editor] : [])];
    if (cookies.length) headers.cookie = cookies.join('; ');
    if (json !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const body = raw ?? requestBody(json, form);
    const response = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* the pairing or edit page */ }
    const page = /^\/(?:pair|edit)(?:\?|$)/.test(path) && response.status < 300
      ? Object.fromEntries(PAGE_HEADERS.map((name) => [name, response.headers.get(name)])) : undefined;
    return { status: response.status, body: parsed, location: response.headers.get('location'),
      cookie: response.headers.getSetCookie().join('\n') || undefined, headers: page };
  };
}

export const token = (step: Step) => /zirbel_session=([\w-]{43})/.exec(step.cookie ?? '')?.[1] ?? '';
export const editorToken = (step: Step) => /zirbel_editor=([\w-]{43})/.exec(step.cookie ?? '')?.[1] ?? '';
/** What only one host has, compared by its presence or form. */
const HOST_SPECIFIC = new Set(['harnesses', 'canRunHarnesses', 'harnessesUnavailable', 'qr']);

export function normalizer() {
  const ids = new Map<string, string>();
  const text = (value: string) => value
    .replaceAll(lan ?? '\0', '<lan>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{40}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, '<id' + ids.size + '>');
      return ids.get(id)!;
    })
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<date>')
    .replace(/((?:127\.0\.0\.1|localhost|<lan>|\.local)):\d+/g, '$1:<port>')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, '<code>')
    .replace(/\b[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}\b/g, '<edit-code>')
    .replace(/\bcode=[2-9A-HJ-NP-Z]{6}\b/g, 'code=<edit-code>')
    .replace(/zirbel_(session|editor)=[\w-]{43}/g, 'zirbel_$1=<token>');
  const walk = (value: unknown, key = ''): unknown => {
    if (HOST_SPECIFIC.has(key)) return '<host-specific>';
    // A project grant: when it expires, and its secret.
    if (typeof value === 'number' && key === 'expires') return '<expires>';
    if (typeof value === 'string' && key === 'token') return text(value).replace(/\.[\w-]{32}$/, '.<secret>');
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.keys(value).filter((field) => !HOST_SPECIFIC.has(field) || field === 'harnesses' || field === 'qr')
        .sort().map((field) => [field, walk((value as Record<string, unknown>)[field], field)]));
    return value;
  };
  return (step: Step) => ({ status: step.status, location: step.location ? text(step.location) : null, cookie: step.cookie ? text(step.cookie) : null,
    headers: step.headers ?? null, ...(step.status >= 300 ? {} : { body: walk(step.body) }) });
}
