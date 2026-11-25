// Anthropic's Agent SDK, which an editor installed without it fetches on first use: only when it is missing, kept only
// when its tarball matches the lockfile's hash, and only as the regular files of its own package.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { ClaudeSdk } from '../packages/server/claude-sdk.ts';

const SLOT = Symbol.for('zirbel.claude-agent-sdk');
afterEach(() => {
  Reflect.deleteProperty(globalThis, SLOT);
});

type Entry = { name: string; content?: string; type?: string };
/** A gzipped ustar archive, as npm publishes a package. */
function tarball(entries: Entry[]) {
  const blocks: Buffer[] = [];
  for (const { name, content = '', type = '0' } of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('        ', 148);
    header.write(type, 156);
    header.write('ustar\x0000', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const integrity = (bytes: Buffer) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const sdkPackage = (version: string, extra: Entry[] = [], name = '@anthropic-ai/claude-agent-sdk') =>
  tarball([
    { name: 'package/package.json', content: JSON.stringify({ name, version }) },
    { name: 'package/sdk.mjs', content: `export const query = () => 'sdk ${version}';` },
    ...extra,
  ]);
const loaded = () => (Reflect.get(globalThis, SLOT) as { query(): string } | undefined)?.query();

/** A registry serving the tarballs by version, that says what it was asked for and can hold its answers back. */
async function registry(t: TestContext, tarballs: Record<string, Buffer>, hold?: Promise<void>) {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    const prefix = '/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-';
    const url = request.url ?? '';
    const version = url.startsWith(prefix) && url.endsWith('.tgz') ? url.slice(prefix.length, -'.tgz'.length) : '';
    const body = Object.hasOwn(tarballs, version) ? tarballs[version] : undefined;
    void Promise.resolve(hold).then(() => response.writeHead(body ? 200 : 404).end(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}
const account = () => mkdtempSync(join(tmpdir(), 'zirbel-claude-sdk-'));

test('an editor without the SDK fetches it on the first turn, and only then', async (t) => {
  const sdk100 = sdkPackage('1.0.0');
  const npm = await registry(t, { '1.0.0': sdk100 });
  const folder = account();
  const pin = { version: '1.0.0', integrity: integrity(sdk100) };
  const sdk = new ClaudeSdk(folder, { pin, registry: npm.url, withEditor: () => false });
  assert.equal(sdk.available, true);
  assert.match(
    (await sdk.ready())?.detail ?? '',
    /Claude Agent SDK 1\.0\.0 came from the npm registry, matched this editor's lockfile/,
  );
  assert.equal(loaded(), 'sdk 1.0.0');
  assert.equal(await sdk.ready(), undefined);
  // The next editor finds the one fetched before, and asks npm for nothing.
  Reflect.deleteProperty(globalThis, SLOT);
  assert.equal(await new ClaudeSdk(folder, { pin, registry: npm.url, withEditor: () => false }).ready(), undefined);
  assert.equal(loaded(), 'sdk 1.0.0');
  assert.deepEqual(npm.asked, ['/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-1.0.0.tgz']);
  assert.deepEqual(readdirSync(folder), ['1.0.0']);
});

test('an SDK installed with the editor is used as it is, and one without a pin is not fetched', async () => {
  const folder = account();
  const editor = new ClaudeSdk(folder, { pin: undefined, registry: 'http://127.0.0.1:9', withEditor: () => true });
  assert.equal(editor.available, true);
  assert.equal(await editor.ready(), undefined);
  const neither = new ClaudeSdk(folder, { pin: undefined, withEditor: () => false });
  assert.equal(neither.available, false);
  await assert.rejects(neither.ready(), /Claude Code is unavailable in this editor/);
  assert.deepEqual(readdirSync(folder), []);
  assert.throws(
    () => new ClaudeSdk(folder, { pin: { version: '../1', integrity: 'sha512-x' } }),
    /not a version and a sha512 hash/,
  );
});

test("a tarball that doesn't match the lockfile, or isn't the SDK's own regular files, is not kept", async (t) => {
  // What npm sends, why it is refused, and what the lockfile holds the hash of, when not what was sent.
  const cases: [Buffer, RegExp, Buffer?][] = [
    [
      sdkPackage('1.0.0', [{ name: 'package/core.mjs', content: 'changed' }]),
      /doesn't match this editor's lockfile/,
      sdkPackage('1.0.0'),
    ],
    [sdkPackage('1.0.0', [{ name: 'package/bin', type: '2' }]), /holds a link or a special file/],
    [sdkPackage('1.0.0', [{ name: 'package/../escape.mjs' }]), /a file is outside the package/],
    [sdkPackage('1.0.0', [{ name: 'other/file.mjs' }]), /a file is outside the package/],
    [sdkPackage('1.0.0', [], 'another-package'), /not the Claude Agent SDK this editor was built with/],
    [Buffer.from('not a tarball'), /could not be unpacked/],
  ];
  for (const [sent, refusal, locked = sent] of cases) {
    const npm = await registry(t, { '1.0.0': sent });
    const folder = account();
    const pin = { version: '1.0.0', integrity: integrity(locked) };
    await assert.rejects(new ClaudeSdk(folder, { pin, registry: npm.url, withEditor: () => false }).ready(), refusal);
    assert.deepEqual(
      readdirSync(folder).filter((name) => !name.startsWith('.')),
      [],
      refusal.source,
    );
    assert.equal(loaded(), undefined);
  }
});

test('what npm lacks is said, and the version an earlier editor fetched goes once a newer one is kept', async (t) => {
  const sdk100 = sdkPackage('1.0.0');
  const sdk110 = sdkPackage('1.1.0');
  const npm = await registry(t, { '1.0.0': sdk100, '1.1.0': sdk110 });
  const folder = account();
  const missing = new ClaudeSdk(folder, {
    pin: { version: '2.0.0', integrity: integrity(sdk110) },
    registry: npm.url,
    withEditor: () => false,
  });
  await assert.rejects(missing.ready(), /did not send Claude Code's SDK \(HTTP 404\)/);
  await new ClaudeSdk(folder, {
    pin: { version: '1.0.0', integrity: integrity(sdk100) },
    registry: npm.url,
    withEditor: () => false,
  }).ready();
  Reflect.deleteProperty(globalThis, SLOT);
  await new ClaudeSdk(folder, {
    pin: { version: '1.1.0', integrity: integrity(sdk110) },
    registry: npm.url,
    withEditor: () => false,
  }).ready();
  assert.equal(loaded(), 'sdk 1.1.0');
  assert.deepEqual(readdirSync(folder), ['1.1.0']);
});

test('a turn stopped while the SDK is fetched stops waiting, and the fetch still finishes for the next turn', async (t) => {
  const sdk100 = sdkPackage('1.0.0');
  let answer!: () => void;
  const npm = await registry(
    t,
    { '1.0.0': sdk100 },
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const sdk = new ClaudeSdk(account(), {
    pin: { version: '1.0.0', integrity: integrity(sdk100) },
    registry: npm.url,
    withEditor: () => false,
  });
  const stop = new AbortController();
  const stopped = sdk.ready(stop.signal);
  const next = sdk.ready();
  while (!npm.asked.length) await new Promise((resolve) => setImmediate(resolve));
  stop.abort(new Error('Stopped.'));
  await assert.rejects(stopped, /Stopped/);
  answer();
  assert.match((await next)?.title ?? '', /Fetched Claude Code's SDK/);
  assert.equal(loaded(), 'sdk 1.0.0');
  assert.equal(npm.asked.length, 1);
});
