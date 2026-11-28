// An editor that a program started ends when that program goes away, even when it was killed: through the IPC
// channel it was started with (as the desktop app starts it), or its stdin with ZIRBEL_EXIT_WITH_STDIN=1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';

const SERVER = resolve('dist/server.mjs');

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('Timed out waiting for ' + what);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** A parent that starts the editor as told, then waits to be killed; it prints the editor's pid once it has started. */
function parentOf(stdio: string, env: Record<string, string>, t: Parameters<typeof tempDir>[0]) {
  const root = tempDir(t, 'zirbel-parent-');
  const data = join(root, 'data');
  const script = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(SERVER)}, '--port', '0', '--data', ${JSON.stringify(data)}],
  { stdio: ${stdio}, env: { ...process.env, ...${JSON.stringify(env)}, ZIRBEL_ACCOUNT_DIR: ${JSON.stringify(join(root, 'account'))} } });
child.stdout.once('data', () => console.log(child.pid));
setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => parent.kill('SIGKILL'));
  return { parent, data };
}

for (const [way, stdio, env] of [
  ['its IPC channel closes', "['ignore', 'pipe', 'inherit', 'ipc']", {}],
  ['its stdin ends, when asked to', "['pipe', 'pipe', 'inherit']", { ZIRBEL_EXIT_WITH_STDIN: '1' }],
] as const) {
  test(
    'the editor ends when the program that started it is killed: ' + way,
    { skip: !existsSync(SERVER) && 'pnpm build first' },
    async (t) => {
      const { parent, data } = parentOf(stdio, env, t);
      const first = await createInterface({ input: parent.stdout })[Symbol.asyncIterator]().next();
      const editor = Number(first.value);
      assert.ok(alive(editor), 'the editor started');
      await until(() => existsSync(join(data, 'service.json')), 'the editor to claim its data folder');
      parent.kill('SIGKILL');
      await until(() => !alive(editor), 'the editor to end');
      assert.equal(
        existsSync(join(data, 'service.json')),
        false,
        'it stopped as on SIGTERM, releasing its data folder',
      );
    },
  );
}
