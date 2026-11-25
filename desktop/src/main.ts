// Zirbel's desktop app. It starts the editor from the built dist/server.mjs on loopback (editor.ts) and shows it in a
// window of its own, or opens the editor that already owns the data folder and leaves that one running. The editor's
// window stays on the editor's origin; playtests and games open in child windows on loopback player origins; any other
// web address opens in the system browser, and other schemes are refused (routes.ts). Every window is sandboxed, with
// context isolation, no Node integration and no preload, and pages get no permission but fullscreen. Quitting stops the
// editor this app started, after asking when a harness turn is running; an editor never outlives the app (editor.ts).
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import { mayQuit, startEditor, type Editor } from './editor.js';
import { mayNavigate, mayOpen, place } from './routes.js';
import { answerView } from './view-game.js';

// Chromium's profile goes apart from the harness account folder, which has the app's name in the same place.
app.setPath('userData', process.env.ZIRBEL_DESKTOP_DATA || path.join(app.getPath('appData'), 'Zirbel Desktop'));
app.enableSandbox();

/** The built editor: inside the packed app, or the checkout's dist/ when the app runs from desktop/. */
const SERVER = app.isPackaged
  ? path.join(process.resourcesPath, 'editor', 'server.mjs')
  : path.join(import.meta.dirname, '..', '..', '..', 'dist', 'server.mjs');
const PERMITTED = new Set(['fullscreen']);

const windowOptions: BrowserWindowConstructorOptions = {
  width: 1440,
  height: 900,
  backgroundColor: '#141717',
  autoHideMenuBar: true,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
};

let starting: Promise<Editor> | undefined;
let origin = '';
let main: BrowserWindow | undefined;
let quitting = false;
let stopped = false;
/** Quit was asked and is waiting for the person's answer; a signal quits without asking. */
let confirming = false;
let signalled = false;
const editorPages = new WeakSet<WebContents>();

function fail(message: string) {
  console.error(`Zirbel: ${message}`);
  if (!quitting) dialog.showErrorBox('Zirbel', message);
  app.quit();
}

function openInBrowser(url: string) {
  shell.openExternal(url).catch((error: Error) => console.error(`Zirbel: could not open ${url}: ${error.message}`));
}

function showEditor() {
  if (!origin || quitting) return;
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.focus();
    return;
  }
  main = new BrowserWindow({ ...windowOptions, title: 'Zirbel' });
  editorPages.add(main.webContents);
  main.loadURL(origin + '/').catch((error: Error & { code?: string }) => {
    if (error.code !== 'ERR_ABORTED') fail(`The editor at ${origin} did not load: ${error.message}`);
  });
}

/** Every page's way out: window.open, navigation and redirects, checked against the editor's origin. */
function guard(contents: WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    const where = place(url, origin);
    if (mayOpen(where)) return { action: 'allow', overrideBrowserWindowOptions: windowOptions };
    if (where === 'web') openInBrowser(url);
    return { action: 'deny' };
  });
  const navigate = (event: { preventDefault(): void }, url: string) => {
    const where = place(url, origin);
    if (mayNavigate(where, editorPages.has(contents))) return;
    event.preventDefault();
    if (where === 'web') openInBrowser(url);
  };
  contents.on('will-navigate', (event) => navigate(event, event.url));
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) navigate(event, event.url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Asks before quitting while a turn runs: the turn is interrupted, and the thread offers to continue it. */
async function confirmQuit() {
  const options = {
    type: 'question' as const,
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'A turn is running. Quit anyway? You can continue it later.',
  };
  const answer = main && !main.isDestroyed() ? await dialog.showMessageBox(main, options) : await dialog.showMessageBox(options);
  return answer.response === 0;
}

async function start() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, answer) =>
    answer(PERMITTED.has(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => PERMITTED.has(permission));
  session.defaultSession.setDevicePermissionHandler(() => false);
  starting = startEditor({
    runtime: process.execPath,
    server: SERVER,
    onExit: (code, signal) => {
      if (!quitting) fail(`The editor stopped (${signal ?? `exit code ${code}`}).`);
    },
  });
  try {
    const editor = await starting;
    origin = editor.url;
    // The editor renders games for view_game with this app's own Electron (view-game.ts).
    editor.messages.on((message) => void answerView(message, (reply) => editor.messages.send(reply)));
  } catch (error) {
    fail(`The editor did not start: ${(error as Error).message}`);
    return;
  }
  showEditor();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('web-contents-created', (_event, contents) => guard(contents));
  app.on('second-instance', showEditor);
  app.on('activate', showEditor);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Quit stops the editor this app started (gracefully, then killed after a grace period) before the app exits; while
  // it runs a turn, the person is asked first.
  app.on('before-quit', (event) => {
    if (!starting || stopped) return;
    event.preventDefault();
    if (quitting || confirming) return;
    confirming = true;
    void starting
      .then(
        (editor) => mayQuit(editor, signalled, confirmQuit),
        () => true,
      )
      .then((quit) => {
        confirming = false;
        if (!quit) {
          showEditor();
          return;
        }
        quitting = true;
        for (const window of BrowserWindow.getAllWindows()) window.hide();
        void starting!
          .then(
            (editor) => editor.stop(),
            () => undefined,
          )
          .finally(() => {
            stopped = true;
            app.quit();
          });
      });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      signalled = true;
      app.quit();
    });
  void app.whenReady().then(start, (error: Error) => fail(error.message));
}
