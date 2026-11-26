// One harness turn in its thread (threads.ts): the thread's folder made ready, the turn marked running until it ends
// (interrupted when the editor stops meanwhile), the thread's session continued, and the turn's own MCP server for as
// long as it runs. A new session starts in the same folder when the harness changes, the old one's transcript going
// with it, and when the harness no longer has the session, which the thread is told.
import type { McpServerSpec } from 'celler/harness';
import { EditorStopping } from './chat-runs.ts';
import { TurnEndedError, type Processors } from './processors.ts';
import type { Threads } from './threads.ts';

/** What a turn gets besides its folder and session. */
export type TurnTools = {
  /** Readies the thread's folder before the harness starts. */
  prepare?(folder: string): void;
  /** The turn's own MCP servers, for this folder, given up as the turn ends. */
  server?(folder: string): { servers: McpServerSpec[]; revoke(): void };
  /** Places outside the folder that the harness may read. */
  readable?: string[];
};

type Turn = { id: string; harness: string; text: string; noteId?: string };

/** The harnesses as one thread's turn sees them: each start in the thread's folder, continuing its session. */
function threadHarness(harnesses: Processors, threads: Threads, key: string, folder: string,
  extra: { mcpServers: McpServerSpec[]; readable: string[] }): Processors {
  const start: Processors['start'] = async (id, prompt, run = {}) => {
    let state = threads.open(key);
    if (state.sessionId && state.harness && state.harness !== id) {
      // A session of another harness is discarded: a new one starts here, and all the old one's harness kept of it goes.
      await harnesses.removeSession?.(state.harness, { cwd: folder, sessionId: state.sessionId })
        .catch(() => console.warn('Could not remove a thread’s earlier session.'));
      state = threads.update(key, { sessionId: undefined, harness: id });
    }
    const attempt = async (resume: boolean) => {
      const reply = await harnesses.start(id, prompt, { ...run,
        place: { cwd: folder, sessionId: resume ? state.sessionId : undefined, resume, ...extra },
        session: (sessionId) => { threads.update(key, { harness: id, sessionId }); run.session?.(sessionId); } });
      if (reply.sessionId) threads.update(key, { harness: id, sessionId: reply.sessionId });
      return reply;
    };
    const resume = Boolean(state.sessionId && state.harness === id);
    try { return await attempt(resume); }
    catch (error) {
      if (!resume || !(error instanceof TurnEndedError) || error.ended !== 'session-not-found') throw error;
      run.signal?.throwIfAborted();
      run.update?.({ type: 'activity', entry: { id: 'new-session', kind: 'notice',
        title: error.message + ' It starts a new session in the thread’s folder.' } });
      state = threads.update(key, { sessionId: undefined });
      return attempt(false);
    }
  };
  return { ...harnesses, list: () => harnesses.list(), start };
}

/** Runs work as one turn of the thread `key`, with the thread's harness and folder. */
export async function inThread<T>(threads: Threads, harnesses: Processors, key: string, turn: Turn, tools: TurnTools,
  signal: AbortSignal | undefined, work: (harness: Processors, folder: string) => Promise<T>): Promise<T> {
  const folder = threads.folder(key);
  threads.begin(key, turn);
  let interrupted = false;
  const own = tools.server?.(folder);
  try {
    tools.prepare?.(folder);
    return await work(threadHarness(harnesses, threads, key, folder,
      { mcpServers: own?.servers ?? [], readable: tools.readable ?? [] }), folder);
  } catch (error) {
    interrupted = signal?.reason instanceof EditorStopping;
    throw error;
  } finally {
    own?.revoke();
    threads.end(key, turn.id, interrupted);
  }
}
