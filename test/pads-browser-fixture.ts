// What the pads e2e tests share (`pnpm test:browser` runs pads-browser.ts and pads-browser-hosts.ts): a host playing a
// two-player game that logs its gamepads and keys, a wait for what a page shows, and the game's frame and its log.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Frame, Page } from 'playwright';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { launch, NO_SPACES, rights, tempDir } from './helpers.ts';

const node = [process.execPath, 'dist/server.mjs'];
const game = `<!doctype html><pre id="log"></pre><p id="pads"></p><script>
  const log = (line) => { document.getElementById('log').textContent += line + '\\n'; };
  addEventListener('gamepadconnected', (event) => log('connected ' + event.gamepad.index + ' ' + event.gamepad.id));
  addEventListener('gamepaddisconnected', (event) => log('disconnected ' + event.gamepad.index));
  addEventListener('keydown', (event) => log('keydown ' + event.code + ' ' + JSON.stringify(event.key) + ' ' + event.keyCode));
  addEventListener('keyup', (event) => log('keyup ' + event.code));
  globalThis.rumble = (index) => navigator.getGamepads()[index].vibrationActuator.playEffect('dual-rumble',
    { duration: 200, strongMagnitude: 1, weakMagnitude: 0.5 });
  setInterval(() => { document.getElementById('pads').textContent = navigator.getGamepads()
    .map((pad) => pad ? pad.index + ':' + pad.buttons.filter((button) => button.pressed).length : '-').join(' '); }, 30);
  try { zirbel.register('tree', { at: [1, 2] }); log('registered'); } catch (error) { log('register failed: ' + error.message); }
</script>`;
export const encoded = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')]));

export async function startHost(t: TestContext, more: string[] = [], command = node) {
  const root = tempDir(t, 'zirbel-pads-browser-');
  const projects = new Projects(join(root, 'source'));
  const project = importGameFolder(projects, {
    title: 'Pads',
    files: encoded({
      'index.html': game,
      'zirbel.json': JSON.stringify({
        players: { max: 2 },
        controls: {
          players: [
            { keys: { a: 'KeyF' }, name: 'Red car', color: '#d03030' },
            { keys: { a: 'Space', up: 'ArrowUp' } },
          ],
        },
      }),
    }),
  });
  const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
  const file = join(root, 'release.json');
  writeFileSync(file, JSON.stringify(release));
  // Without the spaces kernel: the game, for two by its zirbel.json, has a seat of its room's own, which Show on TV hands
  // over (a net game's member in a space goes to the TV in the last test, in pads-browser-hosts.ts).
  return launch(
    t,
    command,
    [
      '--host-only',
      ...more,
      '--player-port',
      '0',
      '--data',
      join(root, 'data'),
      '--import',
      file,
      '--release',
      release.manifest.releaseId,
    ],
    (line) => (typeof line.link === 'string' ? line.link : undefined),
    { ZIRBEL_SPACES_BINARY: NO_SPACES },
  ).ready;
}

export async function until(check: () => boolean | Promise<boolean>, what: string) {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Waited in vain for ' + what);
    await new Promise((done) => setTimeout(done, 25));
  }
}
export const gameFrame = (page: Page) => page.frames().find((frame) => frame.url().includes('/game/'))!;
export const logged = async (frame: Frame) => (await frame.locator('#log').textContent()) ?? '';
