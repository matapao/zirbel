// What the desktop app's tests share: folders of their own for everything the app and the editor write, so the
// person's projects, harness accounts and the app's own profile stay as they are, and small waits.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type Folders = { root: string; data: string; account: string; profile: string; home: string };

export function folders(prefix: string): Folders {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const named = (name: string) => path.join(root, name);
  const made = { root, data: named('data'), account: named('account'), profile: named('profile'), home: named('home') };
  mkdirSync(made.home);
  return made;
}

export function removeFolders(made: Folders) {
  rmSync(made.root, { recursive: true, force: true, maxRetries: 3 });
}

/** The environment the app is launched with: this process's, without ELECTRON_RUN_AS_NODE (an editor's terminal can
 *  pass it on, and Electron started with it runs as plain Node), and with every folder the test's own. */
export function launchEnv(made: Folders): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[0] !== 'ELECTRON_RUN_AS_NODE' && typeof entry[1] === 'string',
  );
  return {
    ...Object.fromEntries(inherited),
    HOME: made.home,
    CODEX_HOME: path.join(made.home, '.codex'),
    ZIRBEL_DATA: made.data,
    ZIRBEL_ACCOUNT_DIR: made.account,
    ZIRBEL_DESKTOP_DATA: made.profile,
  };
}

/** The editor that owns a data folder, as its claim names it, while one does. */
export function claim(data: string): { pid: number; port: number } | undefined {
  try {
    return JSON.parse(readFileSync(path.join(data, 'service.json'), 'utf8')) as { pid: number; port: number };
  } catch {
    return undefined;
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(check: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(100);
  }
}
