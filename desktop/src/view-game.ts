// view_game in the desktop app: the editor this app started asks, over its IPC channel, for a game rendered in a real
// browser, and the app renders it with its own Electron: a hidden offscreen window in a session of its own, sandboxed,
// with no permission, in which only the game's own loopback origin answers. It takes the steps asked, and gives back
// PNG screenshots and the page's console. The editor's side is packages/server/browser-app.ts.
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';

export const VIEW_GAME = 'zirbel:view-game';

type Step = { key: string; hold?: number } | { click: { x: number; y: number } } | { wait: number } | { text: string };
export type ViewRequest = { url: string; origin: string; width: number; height: number; actions: Step[]; captures: number[] };
type Line = { level: string; text: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4096;

function step(value: unknown): value is Step {
  const step = record(value);
  if (!step) return false;
  const keys = Object.keys(step).sort().join();
  if (keys === 'key' || keys === 'hold,key')
    return typeof step.key === 'string' && step.key.length > 0 && step.key.length <= 32 && (step.hold === undefined || whole(step.hold, 0, 5000));
  if (keys === 'click') { const at = record(step.click); return Boolean(at && coordinate(at.x) && coordinate(at.y)); }
  if (keys === 'wait') return whole(step.wait, 0, 10_000);
  return keys === 'text' && typeof step.text === 'string' && step.text.length > 0 && step.text.length <= 1000;
}

/** A request from the editor, as the app takes it: a game page on loopback, at most 40 steps and 8 screenshots. */
function viewRequest(message: unknown): { id: string; request: ViewRequest } | undefined {
  const outer = record(message);
  const request = record(outer?.request);
  if (outer?.type !== VIEW_GAME || typeof outer.id !== 'string' || outer.id.length > 100 || !request) return undefined;
  const url = typeof request.url === 'string' ? URL.parse(request.url) : null;
  const { width, height, actions, captures } = request;
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/game/') ||
      request.origin !== url.origin || !whole(width, 64, 1920) || !whole(height, 64, 1200) ||
      !Array.isArray(actions) || actions.length > 40 || !actions.every(step) ||
      !Array.isArray(captures) || captures.length < 1 || captures.length > 8 || !captures.every((at) => whole(at, 0, actions.length)))
    return undefined;
  return { id: outer.id, request: { url: url.href, origin: url.origin, width, height, actions, captures } };
}

/** Keys by their name, as Electron's accelerators name them. */
const KEYS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Space: 'Space', Enter: 'Enter',
  Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Shift: 'Shift', Control: 'Control', Alt: 'Alt',
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function act(window: BrowserWindow, action: Step) {
  const contents = window.webContents;
  if ('wait' in action) return sleep(action.wait);
  if ('text' in action) return contents.insertText(action.text);
  if ('click' in action) {
    const { x, y } = action.click;
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return;
  }
  const keyCode = KEYS[action.key] ?? action.key;
  contents.sendInputEvent({ type: 'keyDown', keyCode });
  if (Array.from(action.key).length === 1) contents.sendInputEvent({ type: 'char', keyCode });
  await sleep(action.hold ?? 100);
  contents.sendInputEvent({ type: 'keyUp', keyCode });
}

/** Renders one game page, and gives its screenshots as base64 PNG and what its console said. */
async function renderGame(request: ViewRequest) {
  const partition = 'view-game-' + randomUUID();
  const own = session.fromPartition(partition);
  own.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  own.setPermissionCheckHandler(() => false);
  const lines: Line[] = [];
  own.webRequest.onBeforeRequest((details, answer) => {
    const allowed = details.url.startsWith(request.origin + '/') || /^(?:data|blob):/.test(details.url);
    if (!allowed) lines.push({ level: 'error', text: 'Blocked a request to ' + details.url.slice(0, 300) + ': the game has no network.' });
    answer({ cancel: !allowed });
  });
  const window = new BrowserWindow({
    show: false, width: request.width, height: request.height, useContentSize: true,
    webPreferences: { offscreen: true, partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webviewTag: false, backgroundThrottling: false },
  });
  try {
    window.webContents.setZoomFactor(1);
    window.webContents.on('console-message', (event) => lines.push({ level: event.level, text: event.message }));
    await window.loadURL(request.url);
    await sleep(300);
    const images: string[] = [];
    for (let done = 0; done <= request.actions.length; done++) {
      for (const moment of request.captures) {
        if (moment !== done) continue;
        images.push((await window.webContents.capturePage()).toPNG().toString('base64'));
      }
      const action = request.actions[done];
      if (action) await act(window, action);
    }
    return { images, console: lines };
  } finally {
    window.destroy();
    await own.clearStorageData().catch(() => undefined);
  }
}

/** Answers one message from the editor, if it is a view_game request. */
export async function answerView(message: unknown, send: (reply: unknown) => void) {
  const asked = viewRequest(message);
  if (!asked) {
    const id = record(message)?.id;
    if (record(message)?.type === VIEW_GAME && typeof id === 'string') send({ type: VIEW_GAME, id, error: 'The app refused that request.' });
    return;
  }
  try {
    send({ type: VIEW_GAME, id: asked.id, ...(await renderGame(asked.request)) });
  } catch (error) {
    send({ type: VIEW_GAME, id: asked.id, error: 'The app could not render the game: ' + (error as Error).message.slice(0, 500) });
  }
}
