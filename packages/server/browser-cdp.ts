// view_game's renderer in the browser and on the command line: an installed Chrome, Edge or Chromium, headless, with
// a throwaway profile, driven through the DevTools protocol over a pipe (no debugging port for another program to
// reach). Only the game's own loopback origin answers; every other request fails, and says so in the console.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ConsoleLine, Renderer, Step, ViewRequest } from './view-game.ts';

/** An installed Chromium browser: ZIRBEL_BROWSER when it names one, else Chrome, Edge or Chromium where they install. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ZIRBEL_BROWSER) return isAbsolute(env.ZIRBEL_BROWSER) && existsSync(env.ZIRBEL_BROWSER) ? env.ZIRBEL_BROWSER : undefined;
  const apps = (root: string) => ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'Chromium.app/Contents/MacOS/Chromium'].map((app) => join(root, app));
  const windows = (root: string | undefined) => root ? ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe',
    'Chromium/Application/chrome.exe'].map((exe) => join(root, exe)) : [];
  const onPath = (env.PATH ?? '').split(delimiter).filter((dir) => isAbsolute(dir)).flatMap((dir) =>
    ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].map((name) => join(dir, name)));
  const candidates = process.platform === 'darwin' ? [...apps('/Applications'), ...apps(join(homedir(), 'Applications'))]
    : process.platform === 'win32' ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].flatMap(windows) : onPath;
  return candidates.find((file) => existsSync(file));
}

export const NO_BROWSER = 'No browser available to render the game: install Chrome, Edge or Chromium on this computer.';

/** Keys by their name, as the DevTools protocol takes them; any other single character types itself. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 }, ' ': { code: 'Space', keyCode: 32, text: ' ' }, Space: { code: 'Space', keyCode: 32, text: ' ' },
  Shift: { code: 'ShiftLeft', keyCode: 16 }, Control: { code: 'ControlLeft', keyCode: 17 }, Alt: { code: 'AltLeft', keyCode: 18 },
};
export function keyEvent(key: string) {
  const named = KEYS[key];
  if (named) return { key: key === 'Space' ? ' ' : key, ...named };
  if (/^[a-z]$/i.test(key)) return { key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0), text: key };
  if (/^\d$/.test(key)) return { key, code: 'Digit' + key, keyCode: 48 + Number(key), text: key };
  return { key, code: '', keyCode: 0, ...(Array.from(key).length === 1 ? { text: key } : {}) };
}

type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>;
  error?: { message: string } };
type RemoteObject = { type?: string; value?: unknown; description?: string; unserializableValue?: string };

const describe = (value: RemoteObject) => value.value !== undefined
  ? (typeof value.value === 'string' ? value.value : JSON.stringify(value.value)) : value.description ?? value.unserializableValue ?? value.type ?? '';

/** One browser for one render: started, driven and gone with its profile once the render ends. */
class Session {
  private next = 0;
  private waiting = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private events = new Set<(message: Message) => void>();
  private buffered = '';
  sessionId?: string;

  constructor(private input: Writable, output: Readable) {
    // A browser that ended closes its pipes: what still waits on it hears so, and nothing else breaks.
    input.on('error', (error) => this.fail(error));
    output.on('error', (error) => this.fail(error));
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      const parts = (this.buffered + chunk).split('\0');
      this.buffered = parts.pop() ?? '';
      for (const part of parts) this.receive(JSON.parse(part) as Message);
    });
  }

  private receive(message: Message) {
    if (message.id !== undefined) {
      const call = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.events) listener(message);
  }

  on(listener: (message: Message) => void) { this.events.add(listener); }

  send(method: string, params: Record<string, unknown> = {}, page = true) {
    if (this.input.destroyed || this.input.writableEnded) return Promise.reject(new Error('The browser has ended.'));
    const id = ++this.next;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.input.write(JSON.stringify({ id, method, params, ...(page && this.sessionId ? { sessionId: this.sessionId } : {}) }) + '\0');
    return promise;
  }

  fail(error: Error) {
    for (const call of this.waiting.values()) call.reject(error);
    this.waiting.clear();
  }
}

/** A wait that a render's end cuts short; one that only bounds another never fails. */
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(signal.reason as Error); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

async function act(session: Session, action: Step, signal: AbortSignal) {
  if ('wait' in action) return sleep(action.wait, signal);
  if ('text' in action) { await session.send('Input.insertText', { text: action.text }); return; }
  if ('click' in action) {
    const { x, y } = action.click;
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    return;
  }
  const { key, code, keyCode, text } = keyEvent(action.key);
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await sleep(action.hold ?? 100, signal);
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

const ARGS = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--mute-audio',
  '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  // Nothing but loopback, which no proxy takes: anything else goes to a port where nothing answers.
  '--proxy-server=http://127.0.0.1:9'];

async function drive(session: Session, request: ViewRequest, signal: AbortSignal, lines: ConsoleLine[]) {
  const { targetId } = await session.send('Target.createTarget', { url: 'about:blank' }, false);
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true }, false);
  session.sessionId = String(sessionId);
  const loaded = Promise.withResolvers<void>();
  session.on(({ method, params = {}, sessionId: from }) => {
    if (from !== session.sessionId) return;
    if (method === 'Page.loadEventFired') loaded.resolve();
    if (method === 'Runtime.consoleAPICalled')
      lines.push({ level: String(params.type), text: ((params.args as RemoteObject[] | undefined) ?? []).map(describe).join(' ') });
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined;
      lines.push({ level: 'error', text: details?.exception?.description ?? details?.text ?? 'Uncaught error' });
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry as { level?: string; text?: string } | undefined;
      lines.push({ level: entry?.level ?? 'info', text: entry?.text ?? '' });
    }
    if (method === 'Fetch.requestPaused') {
      const url = String((params.request as { url?: string } | undefined)?.url ?? '');
      const requestId = params.requestId;
      if (url.startsWith(request.origin + '/')) void session.send('Fetch.continueRequest', { requestId }).catch(() => {});
      else {
        lines.push({ level: 'error', text: 'Blocked a request to ' + url.slice(0, 300) + ': the game has no network.' });
        void session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    }
  });
  await Promise.all([session.send('Page.enable'), session.send('Runtime.enable'), session.send('Log.enable'),
    session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }),
    session.send('Emulation.setDeviceMetricsOverride', { width: request.width, height: request.height, deviceScaleFactor: 1, mobile: false }),
    session.send('Emulation.setFocusEmulationEnabled', { enabled: true })]);
  await session.send('Page.navigate', { url: request.url });
  await Promise.race([loaded.promise, delay(20_000)]);
  await sleep(300, signal);
  const images: Buffer[] = [];
  for (let done = 0; done <= request.actions.length; done++) {
    for (const moment of request.captures) {
      if (moment !== done) continue;
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      images.push(Buffer.from(String(data), 'base64'));
    }
    const action = request.actions[done];
    if (action) await act(session, action, signal);
  }
  return images;
}

/** Renders with the browser findBrowser finds, or says there is none. */
export function chromeRenderer(find = () => findBrowser()): Renderer {
  return {
    async render(request, signal) {
      const browser = find();
      if (!browser) return { unavailable: NO_BROWSER };
      const profile = await mkdtemp(join(tmpdir(), 'zirbel-view-'));
      let child: ChildProcess | undefined;
      try {
        child = spawn(browser, [...ARGS, '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        const [, , , input, output] = child.stdio;
        const session = new Session(input as Writable, output as Readable);
        const exited = new Promise<never>((_resolve, reject) => child?.once('exit', () => reject(new Error('The browser ended before the game was rendered.'))));
        const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Rendering the game took too long.')), { once: true }));
        // Either may settle after the render is done: that is no one's error.
        exited.catch(() => {});
        stopped.catch(() => {});
        child.once('error', (error) => session.fail(error));
        child.once('exit', () => session.fail(new Error('The browser has ended.')));
        const lines: ConsoleLine[] = [];
        try {
          const images = await Promise.race([drive(session, request, signal, lines), exited, stopped]);
          return { images, console: lines };
        } finally {
          await Promise.race([session.send('Browser.close', {}, false).catch(() => {}), delay(2000)]);
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    },
  };
}
