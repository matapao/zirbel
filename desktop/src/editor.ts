// The editor process: the built dist/server.mjs, run by the app's own program as Node (ELECTRON_RUN_AS_NODE), on
// loopback and a free port. Its first line on stdout is JSON naming the editor's address. When another editor already
// owns the data folder, the command prints { "existing": true, "editor": url } and exits: the app opens that editor
// and leaves it running. This module has no Electron import, so its tests run on plain Node.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { editorOrigin } from './routes.js';

export type Editor = {
  /** The editor's origin, such as http://127.0.0.1:53124. */
  url: string;
  /** Whether this app started it. An editor that already owned the data folder is left running. */
  owned: boolean;
  /** Ends an editor this app started: SIGTERM, then SIGKILL if it is still running after the grace period. */
  stop(): Promise<void>;
};

export type EditorOptions = {
  /** The program that runs the server as Node: the app's own executable. */
  runtime: string;
  /** The built server entry point, dist/server.mjs. */
  server: string;
  env?: NodeJS.ProcessEnv;
  /** How long the editor may take to print its address. */
  startTimeoutMs?: number;
  /** How long a stopping editor may take before it is killed. */
  graceMs?: number;
  /** An editor this app started ended without stop(): its exit code, or the signal that ended it. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

type Announcement = { editor?: unknown; existing?: unknown };

function announcement(line: string): Announcement | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && 'editor' in value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function startEditor(options: EditorOptions): Promise<Editor> {
  const { runtime, server, env = process.env, startTimeoutMs = 60_000, graceMs = 10_000, onExit } = options;
  const child = spawn(runtime, [server, '--port', '0'], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const running = () => child.exitCode === null && child.signalCode === null;
  let stopping = false;
  let owned = false;
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    process.stderr.write(text);
    errors = (errors + text).slice(-4000);
  });

  const stop = async () => {
    if (!owned || !running()) return;
    stopping = true;
    child.kill('SIGTERM');
    const kill = setTimeout(() => {
      if (running()) child.kill('SIGKILL');
    }, graceMs);
    await exited;
    clearTimeout(kill);
  };

  return new Promise<Editor>((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (running()) child.kill('SIGKILL');
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`The editor did not start within ${startTimeoutMs / 1000} seconds.`),
      startTimeoutMs,
    );
    createInterface({ input: child.stdout }).on('line', (line) => {
      const said = settled ? undefined : announcement(line);
      if (!said) {
        process.stdout.write(line + '\n');
        return;
      }
      const url = typeof said.editor === 'string' ? editorOrigin(said.editor) : undefined;
      if (!url) {
        fail('The editor did not report a loopback address.');
        return;
      }
      settled = true;
      clearTimeout(timer);
      owned = said.existing !== true;
      resolve({ url, owned, stop });
    });
    child.once('error', (error) => fail(`The editor could not start: ${error.message}`));
    // 'close' comes after the last line of its output, which 'exit' can overtake.
    child.once('close', (code, signal) => {
      const last = errors.trim().split('\n').at(-1);
      fail(last || `The editor stopped as it started (${signal ?? `exit code ${code}`}).`);
      if (owned && !stopping) onExit?.(code, signal);
    });
  });
}
