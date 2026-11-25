// A box (--box) on both hosts: `node dist/server.mjs --box` and the Go host's --box. Each runs one scripted session,
// from the box itself (loopback) and from this computer's own network address, and their normalized answers must
// match: the door, the pairing page and its codes and claim, the paired devices, the switches, the setup flag and
// external MCP access. What the hosts differ in by design is compared by its form only: harnesses run in the Node
// editor alone, and only it draws a pairing link's QR code.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hostsUnderTest, launch, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();
/** This computer's address on a private network, which reaches the box as a device on its network would. */
const lan = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4' &&
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
if (!lan) console.log('# No private network address: the box contract runs from loopback only.');

/** A box on loopback, with the file a setup request leaves for the box's setup service. */
async function startBox(t: TestContext, command: string[]) {
  const root = tempDir(t, 'zirbel-box-');
  const account = join(root, 'account');
  mkdirSync(account, { mode: 0o700 });
  mkdirSync(join(root, 'run'));
  const wake = join(root, 'run', 'request');
  const { ready } = launch(t, command, ['--data', join(root, 'data'), '--port', '0', '--box'],
    (line) => typeof line.editor === 'string' ? line.editor : undefined, { ZIRBEL_ACCOUNT_DIR: account, ZIRBEL_SETUP_REQUEST: wake });
  return { editor: await ready, wake };
}

type Step = { status: number; body: unknown; location?: string | null; cookie?: string; headers?: Record<string, string | null> };
/** The pairing page's headers, which a browser's form and its Origin depend on. */
const PAGE_HEADERS = ['content-type', 'cache-control', 'referrer-policy', 'content-security-policy', 'x-content-type-options'];
type Call = { json?: unknown; form?: Record<string, string>; origin?: boolean; session?: string; raw?: string };

function client(base: string) {
  return async (method: string, path: string, { json, form, origin, session, raw }: Call = {}): Promise<Step> => {
    const headers: Record<string, string> = {};
    if (origin) headers.origin = base;
    if (session) headers.cookie = 'zirbel_session=' + session;
    if (json !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const body = raw ?? (json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined);
    const response = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* the pairing page */ }
    const page = path.startsWith('/pair') && response.status < 300
      ? Object.fromEntries(PAGE_HEADERS.map((name) => [name, response.headers.get(name)])) : undefined;
    return { status: response.status, body: parsed, location: response.headers.get('location'), cookie: response.headers.getSetCookie()[0],
      headers: page };
  };
}

const token = (step: Step) => /zirbel_session=([\w-]{43})/.exec(step.cookie ?? '')?.[1] ?? '';
/** What only one host has, compared by its presence or form. */
const HOST_SPECIFIC = new Set(['harnesses', 'canRunHarnesses', 'harnessesUnavailable', 'qr']);

function normalizer() {
  const ids = new Map<string, string>();
  const text = (value: string) => value
    .replaceAll(lan ?? '\0', '<lan>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      if (!ids.has(id)) ids.set(id, '<id' + ids.size + '>');
      return ids.get(id)!;
    })
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<date>')
    .replace(/((?:127\.0\.0\.1|localhost|<lan>|\.local)):\d+/g, '$1:<port>')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, '<code>')
    .replace(/zirbel_session=[\w-]{43}/g, 'zirbel_session=<token>');
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
  return (step: Step) => ({ status: step.status, location: step.location ?? null, cookie: step.cookie ? text(step.cookie) : null,
    headers: step.headers ?? null, ...(step.status >= 300 ? {} : { body: walk(step.body) }) });
}

async function session(base: string, wake: string) {
  const steps: Step[] = [];
  const box = client(base);
  const record = async (step: Promise<Step>) => { const result = await step; steps.push(result); return result; };
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  // From the box itself, as its setup service asks: no pairing.
  const status = await box('GET', '/api/box/status');
  assert.equal(typeof (status.body as { capabilities: { memoryMB: unknown } }).capabilities.memoryMB, 'number');
  await record(Promise.resolve(status));
  const health = await box('GET', '/api/health');
  await record(Promise.resolve({ ...health, body: (health.body as { box: unknown }).box }));
  await record(box('GET', '/api/box/settings'));
  await record(box('PUT', '/api/box/settings', { json: { onboarded: true } }));
  await record(box('PUT', '/api/box/settings', { json: { nope: true } }));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: 'yes' } }));
  await record(box('PUT', '/api/box/settings', { raw: '{"onboarded":null}' }));
  await record(box('POST', '/api/box/setup', { json: { requested: true }, origin: true }));
  // The request wakes the box's setup service through its file.
  assert.ok(existsSync(wake), 'a setup request leaves the file that wakes the setup service');
  rmSync(wake);
  await record(box('POST', '/api/box/setup', { json: {}, origin: true }));
  await record(box('POST', '/api/pairing', { json: {}, origin: true }));
  await record(box('GET', '/pair'));
  await record(box('GET', '/pair?code=abcd%20efgh'));
  await record(box('PUT', '/pair'));
  const project = (await box('POST', '/api/projects', { json: { title: 'Box' }, origin: true })).body as { id: string };
  if (!lan) return steps;

  // From a device on the box's network.
  const device = client(base.replace('127.0.0.1', lan));
  await record(device('GET', '/api/projects'));
  await record(device('GET', '/'));
  await record(device('GET', '/api/box/status'));
  await record(device('POST', '/pair', { form: { claim: '1' } }));
  await record(device('POST', '/pair', { form: { claim: '1' }, origin: true }));
  const first = token(steps.at(-1)!);
  await record(device('POST', '/pair', { form: { claim: '1' }, origin: true }));
  await record(device('POST', '/pair', { form: { claim: '2' }, origin: true }));
  await record(device('GET', '/pair', { session: first }));
  await record(device('GET', '/api/pairing/devices', { session: first }));
  await record(device('GET', '/api/box/status', { session: first }));
  await record(device('PUT', '/api/box/settings', { json: { onboarded: false }, session: first }));
  await record(device('PUT', '/api/box/settings', { json: { onboarded: false }, session: first, origin: true }));
  const code = ((await record(device('POST', '/api/pairing', { json: {}, session: first, origin: true }))).body as { code: string }).code;
  await record(device('POST', '/pair', { form: { code: 'ZZZZ-ZZZZ' }, origin: true }));
  await record(device('POST', '/pair', { form: { code: code.toLowerCase().replace('-', '') }, origin: true }));
  const second = token(steps.at(-1)!);
  await record(device('POST', '/pair', { form: { code }, origin: true }));
  const listed = await record(device('GET', '/api/pairing/devices', { session: second }));
  const secondId = (listed.body as { devices: { id: string; current: boolean }[] }).devices.find((item) => item.current)!.id;
  await record(device('DELETE', '/api/pairing/devices/' + secondId, { session: first, origin: true }));
  await record(device('GET', '/api/projects', { session: second }));
  await record(device('DELETE', '/api/pairing/devices/' + secondId, { session: first, origin: true }));
  await record(device('DELETE', '/api/pairing/devices/NOT_AN_ID', { session: first, origin: true }));
  await record(device('POST', '/api/box/setup', { json: { requested: false }, session: first, origin: true }));
  await record(device('POST', '/api/box/setup', { json: { requested: true }, session: first, origin: true }));
  assert.ok(existsSync(wake), 'a paired device’s setup request wakes the setup service too');
  await record(device('POST', '/turn-mcp', { json: ping, session: first, origin: true }));

  // External MCP access: off, the network gets no MCP; on, a project grant opens it.
  await record(device('POST', '/mcp', { json: ping }));
  await record(box('POST', '/api/projects/' + project.id + '/grants', { json: { write: false, hours: 1 }, origin: true }));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: true } }));
  const grant = (await record(box('POST', '/api/projects/' + project.id + '/grants', { json: { write: false, hours: 1 }, origin: true }))).body as { token: string };
  const mcp = (credential: string) => fetch(base.replace('127.0.0.1', lan) + '/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential }, body: JSON.stringify(ping) })
    .then(async (response) => ({ status: response.status, body: await response.json() as unknown }));
  await record(mcp(grant.token));
  await record(mcp('nope'));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: false } }));
  await record(mcp(grant.token));

  // Wrong codes from one address: ten in a minute, then none.
  for (let tries = 0; tries < 10; tries++) await record(device('POST', '/pair', { form: { code: 'ZZZZ-ZZZY' }, origin: true }));
  return steps;
}

const results = new Map<string, Step[]>();

for (const host of hosts) {
  test(host.name + ' box runs the scripted session', async (t) => {
    const { editor, wake } = await startBox(t, host.command);
    const steps = await session(editor, wake);
    for (const [index, step] of steps.entries()) assert.ok(step.status < 500, 'step ' + index + ': ' + step.status + ' ' + JSON.stringify(step.body));
    results.set(host.name, steps);
  });
}

if (hosts.length > 1) {
  test('both boxes answer the session identically', (t) => {
    const node = results.get('node')!.map(normalizer());
    const go = results.get('go')!.map(normalizer());
    t.diagnostic(node.length + ' steps: ' + node.map(({ status }) => status).join(' '));
    assert.equal(go.length, node.length);
    for (const [index, step] of node.entries()) assert.deepEqual(go[index], step, 'step ' + index);
  });
}

test('the Go box runs no harnesses and says why', { skip: !hosts.some((host) => host.name === 'go') }, async (t) => {
  const { editor } = await startBox(t, hosts.find((host) => host.name === 'go')!.command);
  const box = client(editor);
  const status = (await box('GET', '/api/box/status')).body as { capabilities: { harnesses: boolean }; settings: { harnesses: boolean } };
  assert.equal(status.capabilities.harnesses, false);
  assert.equal(status.settings.harnesses, false);
  const refused = await box('PUT', '/api/box/settings', { json: { harnesses: true } });
  assert.equal(refused.status, 409);
  assert.match((refused.body as { error: string }).error, /Use your own agent over MCP instead\./);
  assert.deepEqual((await box('GET', '/api/processors')).body, { processors: [] });
});
