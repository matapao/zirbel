// Checks of a running desktop app that the test of the app from desktop/ (app.ts) and the test of the packed app
// (packed.ts) share.
import assert from 'node:assert/strict';
import type { ElectronApplication, Page } from 'playwright-core';
import { sleep, until } from './support.js';

const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** The page has no Node, no Web Bluetooth and no <webview>, its renderer runs in the system's sandbox, and no preload is
 *  registered. */
export async function checkHardening(app: ElectronApplication, page: Page) {
  const globals = await page.evaluate(() => {
    document.body.append(Object.assign(document.createElement('webview'), { src: 'https://example.com/' }));
    return [typeof require, typeof process, typeof module, typeof Buffer, typeof Reflect.get(navigator, 'bluetooth')];
  });
  assert.deepEqual(
    globals,
    ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
    'no Node globals in the page, and no Web Bluetooth',
  );
  await sleep(500);
  const renderer = await app.evaluate(({ app: electronApp, session, webContents }, url) => {
    const contents = webContents.getAllWebContents();
    const pid = contents.find((page) => page.getURL() === url)?.getOSProcessId();
    return {
      sandboxed: electronApp.getAppMetrics().find((process) => process.pid === pid)?.sandboxed ?? null,
      preloads: session.defaultSession.getPreloadScripts().length,
      webviews: contents.filter((page) => page.getType() === 'webview').length,
    };
  }, page.url());
  assert.deepEqual(renderer, { sandboxed: true, preloads: 0, webviews: 0 });
}

/** Replaces the app's way to the system browser with a list the test reads. */
async function stubBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const state = globalThis as { opened?: string[] };
    if (state.opened) return;
    const opened: string[] = (state.opened = []);
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);

/** Outside web addresses, by navigation, window.open or a link, go to the system browser and leave the window where it
 *  was; other schemes, and another loopback origin in the editor's window, go nowhere. */
export async function checkWayOut(app: ElectronApplication, page: Page) {
  await stubBrowser(app);
  const at = page.url();
  const count = await windows(app);
  await page.evaluate(() => {
    location.href = 'https://example.com/navigated';
  });
  await page.evaluate(() => {
    window.open('https://example.com/opened');
    const link = Object.assign(document.createElement('a'), { href: 'https://example.com/link', target: '_blank' });
    document.body.append(link);
    link.click();
    link.remove();
  });
  await until(async () => (await opened(app)).length >= 3, 'the outside addresses in the browser');
  await page.evaluate(() => {
    window.open('file:///etc/hosts');
    window.open('zirbel-test://elsewhere');
    location.href = 'http://127.0.0.1:9/another-loopback-origin';
  });
  await sleep(1000);
  const expected = ['https://example.com/link', 'https://example.com/navigated', 'https://example.com/opened'];
  assert.deepEqual([...(await opened(app))].sort(), expected, 'outside addresses only, each once');
  assert.equal(page.url(), at, 'the window stayed on the editor');
  assert.equal(await windows(app), count, 'no window opened for any of them');
}

/** A playtest of an example project, opened as the editor opens a game: a blank window, then the player's address. */
export async function openPlaytest(app: ElectronApplication, page: Page, project: unknown): Promise<Page> {
  const link = await page.evaluate(async (example) => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return (await response.json()) as Record<string, unknown>;
    };
    const imported = await post('/api/projects/import', example);
    return String((await post(`/api/projects/${String(imported.id)}/playtest`, { branch: 'main' })).link);
  }, project);
  const player = new URL(link);
  assert.equal(player.hostname, '127.0.0.1');
  assert.notEqual(player.origin, new URL(page.url()).origin, "the player's own origin");
  const [child] = await Promise.all([
    app.waitForEvent('window'),
    page.evaluate((address) => {
      window.open('about:blank', '_blank')?.location.replace(address);
    }, link),
  ]);
  await child.waitForURL((url) => url.origin === player.origin, { timeout: 30_000 });
  await child.waitForLoadState();
  // from the game's window, too: an outside address goes to the browser
  await stubBrowser(app);
  await child.evaluate(() => {
    location.href = 'https://example.com/from-the-game';
  });
  await until(
    async () => (await opened(app)).some((url) => url === 'https://example.com/from-the-game'),
    "the game window's link in the browser",
  );
  assert.equal(new URL(child.url()).origin, player.origin, 'the game window stayed on the player');
  return child;
}

/** Camera, microphone, location and notifications are denied; fullscreen is allowed. The app has a camera and a
 *  microphone on any machine (Chromium's fake ones, as the test launches it), so asking for them reaches the app's own
 *  permission handler, and its refusal is what the page hears: NotAllowedError, never no device's NotFoundError. */
export async function checkPermissions(app: ElectronApplication, page: Page) {
  const answers = await page.evaluate(async () => {
    const state = (name: string) =>
      navigator.permissions.query({ name: name as PermissionName }).then(
        (status) => status.state,
        () => 'unsupported',
      );
    const kinds = (await navigator.mediaDevices.enumerateDevices()).map((device) => device.kind);
    const devices = { camera: kinds.includes('videoinput'), microphone: kinds.includes('audioinput') };
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(
      (stream) => {
        for (const track of stream.getTracks()) track.stop();
        return 'granted';
      },
      (error: Error) => error.name,
    );
    const position = await new Promise<string>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (error) => resolve(error.code === error.PERMISSION_DENIED ? 'denied' : `error ${error.code}`),
        { timeout: 5000 },
      );
    });
    return {
      devices,
      camera: await state('camera'),
      microphone: await state('microphone'),
      geolocation: await state('geolocation'),
      notifications: await state('notifications'),
      media,
      position,
      notification: await Notification.requestPermission(),
    };
  });
  assert.deepEqual(answers, {
    devices: { camera: true, microphone: true },
    camera: 'denied',
    microphone: 'denied',
    geolocation: 'denied',
    notifications: 'denied',
    media: 'NotAllowedError',
    position: 'denied',
    notification: 'denied',
  });
  const fullScreen = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isFullScreen()));
  const entered = await page.evaluate(() =>
    document.documentElement.requestFullscreen().then(
      () => 'granted',
      (e: Error) => e.name,
    ),
  );
  assert.equal(entered, 'granted', 'fullscreen is allowed');
  await until(fullScreen, 'the window in fullscreen');
  await sleep(1000); // the system's own transition
  await page.evaluate(() => document.exitFullscreen());
  await until(async () => !(await fullScreen()), 'the window back from fullscreen');
}

/** Quits the app as a person does, and waits until its process has ended. */
export async function quit(app: ElectronApplication) {
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 50);
    })
    .catch(() => undefined);
  await closed;
}
