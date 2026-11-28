// Each thread's working folder and harness session, in the account folder: turns/<thread>/ for the harness, private to
// this user, and beside it turns/<thread>.json for what the editor knows of it, out of the harness's reach. For now a
// thread is a project's branch (<projectId>.<branch>); the chat before a project exists is a thread of its own
// (new.<id>) until its first game, when its folder and session become that project's main thread. The first turn starts
// the session and later turns resume it in the same folder, so the harness keeps its own context and files. A turn
// that is running is marked so, and one whose editor ended meanwhile is interrupted until the person continues it.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { id, workspaceHistory } from '../sdk/contracts.ts';
import { atomicWrite, ZirbelError } from '../core/projects.ts';
import { privateDirectory } from './account.ts';
import { processorId } from './processors.ts';

/** A thread's name: a project and branch, or `new` and the chat's own id before a project exists. */
const threadName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.[a-z0-9][a-z0-9_-]{0,79}$/);
const runningTurn = z.strictObject({
  id,
  state: z.enum(['running', 'interrupted']),
  harness: processorId,
  text: z.string().min(1).max(3000),
  noteId: id.optional(),
  startedAt: z.iso.datetime(),
  /** The editor that runs it: its process, and the data folder it owns. */
  pid: z.number().int().positive(),
  data: z.string().min(1).max(4096),
});
const threadState = z.strictObject({
  version: z.literal(1),
  folder: threadName,
  harness: processorId.optional(),
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
  lastRun: z.iso.datetime().optional(),
  turn: runningTurn.optional(),
  /** A chat before a project: its messages so far, and once its first game exists, that project. */
  conversation: workspaceHistory.optional(),
  project: id.optional(),
});
export type ThreadState = z.infer<typeof threadState>;
export type ThreadTurn = z.infer<typeof runningTurn>;

export const projectThread = (projectId: string, branch: string) => threadName.parse(projectId + '.' + branch);
export const workspaceThread = (chat: string) => threadName.parse('new.' + chat);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Threads {
  readonly root: string;
  /** The project data folder this editor owns, which names its turns. */
  private readonly data: string;

  constructor(root: string, data: string) {
    this.root = root;
    this.data = data;
    privateDirectory(root);
  }

  private file(key: string) {
    return join(this.root, threadName.parse(key) + '.json');
  }

  read(key: string): ThreadState | undefined {
    let text: string;
    try {
      text = readFileSync(this.file(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return threadState.parse(JSON.parse(text));
    } catch {
      throw new ZirbelError(422, 'The thread’s saved state is not valid.');
    }
  }

  private write(key: string, state: ThreadState) {
    atomicWrite(this.file(key), JSON.stringify(threadState.parse(state)));
    return state;
  }

  /** The thread's state, made with a folder of its own when it has none yet. */
  open(key: string) {
    return this.read(key) ?? this.write(key, { version: 1, folder: threadName.parse(key) });
  }

  /** The thread's working folder, private to this user, made if it is missing. */
  folder(key: string) {
    const folder = join(this.root, this.open(key).folder);
    privateDirectory(folder);
    return folder;
  }

  update(key: string, change: Partial<Omit<ThreadState, 'version' | 'folder'>>) {
    const state = this.open(key);
    const next: ThreadState = { ...state, ...change };
    for (const [name, value] of Object.entries(change))
      if (value === undefined) delete next[name as keyof typeof change];
    return this.write(key, next);
  }

  /** Marks a turn as running in the thread, by this editor. */
  begin(key: string, turn: Omit<ThreadTurn, 'state' | 'pid' | 'data' | 'startedAt'>) {
    return this.update(key, {
      turn: { ...turn, state: 'running', startedAt: new Date().toISOString(), pid: process.pid, data: this.data },
    });
  }

  /** The turn's end: gone from the state, or interrupted when its editor stopped while it ran. */
  end(key: string, turnId: string, interrupted = false) {
    const state = this.read(key);
    if (state?.turn?.id !== turnId) return;
    this.update(
      key,
      interrupted
        ? { turn: { ...state.turn, state: 'interrupted' }, lastRun: new Date().toISOString() }
        : { turn: undefined, lastRun: new Date().toISOString() },
    );
  }

  /** As the editor starts: a turn its editor was running when it ended is interrupted. One that another editor, with
   *  a data folder of its own, is still running stays as it is. */
  interruptStale() {
    for (const key of this.keys()) {
      let state: ThreadState | undefined;
      try {
        state = this.read(key);
      } catch {
        continue;
      }
      const turn = state?.turn;
      if (turn?.state !== 'running' || (turn.data !== this.data && turn.pid !== process.pid && alive(turn.pid)))
        continue;
      this.update(key, { turn: { ...turn, state: 'interrupted' } });
    }
  }

  /** The chat before a project became the project's main thread: its folder and session go with it. */
  moveToProject(key: string, projectId: string) {
    const state = this.read(key);
    if (!state) return;
    const { conversation: _conversation, project: _project, ...thread } = state;
    this.write(projectThread(projectId, 'main'), { ...thread, turn: undefined });
    this.write(key, { version: 1, folder: state.folder, project: projectId });
  }

  /** Removes every thread of a project: its folder and, through remove, all its harness kept of each session. */
  async removeProject(
    projectId: string,
    remove: (harness: string, session: { cwd: string; sessionId: string }) => Promise<void>,
  ) {
    for (const key of this.keys()) {
      let state: ThreadState | undefined;
      try {
        state = this.read(key);
      } catch {
        continue;
      }
      if (!state || (!key.startsWith(projectId + '.') && state.project !== projectId)) continue;
      const cwd = join(this.root, state.folder);
      if (state.harness && state.sessionId)
        await remove(state.harness, { cwd, sessionId: state.sessionId }).catch(() =>
          console.warn('Could not remove a thread’s session.'),
        );
      await rm(cwd, { recursive: true, force: true, maxRetries: 2 }).catch(() =>
        console.warn('Could not remove a thread’s folder.'),
      );
      rmSync(this.file(key), { force: true });
    }
  }

  private keys() {
    return readdirSync(this.root)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((key) => threadName.safeParse(key).success);
  }
}
