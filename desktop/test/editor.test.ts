// The editor process as editor.ts runs it, with small stand-ins for dist/server.mjs on plain Node: each one prints
// what the real command prints, and records how it was started.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startEditor } from '../src/editor.js';
import { alive, until } from './support.js';

const folder = mkdtempSync(path.join(tmpdir(), 'zirbel-desktop-editor-'));
test.after(() => rmSync(folder, { recursive: true, force: true }));

const ADDRESS = 'http://127.0.0.1:41234';
const RECORD = path.join(folder, 'started.json');

/** A stand-in editor: it records its arguments, its node mode and its pid, then runs the given code. */
function standIn(name: string, code: string) {
  const file = path.join(folder, name + '.mjs');
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify({ args: process.argv.slice(2), asNode: process.env.ELECTRON_RUN_AS_NODE, pid: process.pid }));
${code}\n`,
  );
  return file;
}
const started = () => JSON.parse(readFileSync(RECORD, 'utf8')) as { args: string[]; asNode?: string; pid: number };
const announce = (fields: object) => `console.log(JSON.stringify(${JSON.stringify({ editor: ADDRESS, ...fields })}));`;
const KEEP_RUNNING = 'setInterval(() => {}, 1000);';

test('the editor starts on a free port, run as Node, and stops on SIGTERM', async () => {
  const server = standIn(
    'graceful',
    `console.log('a line before the address');
${announce({ pid: 1, data: '/tmp', player: 'http://127.0.0.1:41235' })}
process.on('SIGTERM', () => process.exit(0));
${KEEP_RUNNING}`,
  );
  const editor = await startEditor({ runtime: process.execPath, server });
  assert.deepEqual({ url: editor.url, owned: editor.owned }, { url: ADDRESS, owned: true });
  const { args, asNode, pid } = started();
  assert.deepEqual(args, ['--port', '0']);
  assert.equal(asNode, '1');
  assert.ok(alive(pid));
  await editor.stop();
  assert.ok(!alive(pid), 'the editor ended');
});

test('an editor that does not stop on SIGTERM is killed after the grace period', async () => {
  const server = standIn(
    'stubborn',
    `process.on('SIGTERM', () => {});
${announce({})}
${KEEP_RUNNING}`,
  );
  const editor = await startEditor({ runtime: process.execPath, server, graceMs: 300 });
  const { pid } = started();
  const before = Date.now();
  await editor.stop();
  assert.ok(Date.now() - before >= 250, 'it was given the grace period');
  assert.ok(!alive(pid), 'the editor was killed');
});

test('an editor that already owns the data folder is opened and left alone', async () => {
  let exits = 0;
  const server = standIn('existing', announce({ pid: 4242, existing: true }));
  const editor = await startEditor({ runtime: process.execPath, server, onExit: () => exits++ });
  assert.deepEqual({ url: editor.url, owned: editor.owned }, { url: ADDRESS, owned: false });
  await until(() => !alive(started().pid), 'the command to exit');
  await editor.stop();
  assert.equal(exits, 0, 'its command exiting is no unexpected stop');
});

test('an editor that ends on its own is reported', async () => {
  const ended = Promise.withResolvers<[number | null, NodeJS.Signals | null]>();
  const server = standIn(
    'crashing',
    `${announce({})}
setTimeout(() => process.exit(3), 100);`,
  );
  await startEditor({ runtime: process.execPath, server, onExit: (code, signal) => ended.resolve([code, signal]) });
  assert.deepEqual(await ended.promise, [3, null]);
});

test("a failed start is reported with the editor's own message", async () => {
  const server = standIn(
    'refused',
    `console.error('This project directory is owned by process 99.');
process.exit(1);`,
  );
  await assert.rejects(startEditor({ runtime: process.execPath, server }), {
    message: 'This project directory is owned by process 99.',
  });
});

test('an address off loopback is refused, and that editor is stopped', async () => {
  const server = standIn(
    'elsewhere',
    `console.log(JSON.stringify({ editor: 'http://example.com:4173' }));
${KEEP_RUNNING}`,
  );
  await assert.rejects(startEditor({ runtime: process.execPath, server }), /loopback address/);
  await until(() => !alive(started().pid), 'the editor to be stopped');
});

test('an editor that names no address in time is stopped', async () => {
  const server = standIn('silent', KEEP_RUNNING);
  await assert.rejects(startEditor({ runtime: process.execPath, server, startTimeoutMs: 300 }), /did not start within/);
  await until(() => !alive(started().pid), 'the editor to be stopped');
});
