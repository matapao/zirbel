// A thread's folder and session: one private folder per thread in the account folder, a session that later turns
// resume there, a new one when the harness changes or no longer has it, the turn marked running and, after an editor
// that ended mid-turn, interrupted; and everything gone with the project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatUpdate } from '../packages/sdk/chat-stream.ts';
import { EditorStopping } from '../packages/server/chat-runs.ts';
import { TurnEndedError, type ProcessorRun, type Processors } from '../packages/server/processors.ts';
import { inThread } from '../packages/server/thread-turns.ts';
import { CONTINUE_TEXT } from '../packages/sdk/chat-stream.ts';
import { projectThread, Threads, workspaceThread } from '../packages/server/threads.ts';
import { abortError, tempDir } from './helpers.ts';

type Call = { id: string; run: ProcessorRun };

/** Harnesses that record each start and answer as told; each new session is named by its turn. */
function recording(answer: (call: Call, index: number) => Promise<void> | void = () => {}) {
  const calls: Call[] = [];
  const removed: { id: string; cwd: string; sessionId: string }[] = [];
  const harnesses: Processors = {
    list: async () => [
      { id: 'codex', name: 'Codex', ready: true },
      { id: 'claude', name: 'Claude Code', ready: true },
    ],
    async start(id, _prompt, run = {}) {
      const call = { id, run };
      calls.push(call);
      await answer(call, calls.length - 1);
      const sessionId = run.place?.resume ? run.place.sessionId : 'session-' + calls.length;
      if (sessionId) run.session?.(sessionId);
      return {
        name: id,
        task: sessionId ?? '',
        stopReason: 'end_turn',
        text: '{"action":"reply","message":"ok"}',
        sessionId,
      };
    },
    async removeSession(id, session) {
      removed.push({ id, ...session });
    },
  };
  return { harnesses, calls, removed };
}

const turn = (id: string, harness = 'codex') => ({ id, harness, text: 'Make it' });

test('a thread keeps one private folder and one session, which its later turns resume', async (t) => {
  const root = join(tempDir(t, 'zirbel-threads-'), 'turns');
  const threads = new Threads(root, '/data/one');
  const key = projectThread('game-1', 'main');
  const { harnesses, calls, removed } = recording();
  const run = (id: string, harness = 'codex') =>
    inThread(threads, harnesses, key, turn(id, harness), {}, undefined, (harness_, folder) =>
      harness_.start(harness, 'Make it', {}).then((reply) => ({ reply, folder })),
    );

  const first = await run('turn-1');
  assert.equal(first.folder, join(root, 'game-1.main'));
  assert.equal(statSync(first.folder).mode & 0o777, 0o700);
  assert.deepEqual(calls[0]?.run.place, {
    cwd: first.folder,
    sessionId: undefined,
    resume: false,
    mcpServers: [],
    readable: [],
  });
  const state = threads.read(key);
  assert.equal(state?.sessionId, 'session-1');
  assert.equal(state?.harness, 'codex');
  assert.ok(state?.lastRun);
  assert.equal(state?.turn, undefined, 'no turn runs once it ended');
  // The state file is beside the folder, out of the harness's reach.
  assert.ok(existsSync(join(root, 'game-1.main.json')));

  await run('turn-2');
  assert.deepEqual(calls[1]?.run.place, {
    cwd: first.folder,
    sessionId: 'session-1',
    resume: true,
    mcpServers: [],
    readable: [],
  });
  assert.equal(threads.read(key)?.sessionId, 'session-1');

  // Another harness: a new session in the same folder, and the old session's transcript goes.
  await run('turn-3', 'claude');
  assert.deepEqual(removed, [{ id: 'codex', cwd: first.folder, sessionId: 'session-1' }]);
  assert.equal(calls[2]?.run.place?.resume, false);
  assert.equal(calls[2]?.run.place?.cwd, first.folder);
  assert.deepEqual([threads.read(key)?.harness, threads.read(key)?.sessionId], ['claude', 'session-3']);

  // A broken state file is refused, not taken for a new thread.
  writeFileSync(join(root, 'game-1.main.json'), '{"version":1,"folder":"../x"}');
  assert.throws(() => threads.read(key), /not valid/);
  assert.throws(() => projectThread('../x', 'main'));
});

test('a session the harness no longer has starts a new one in the same folder, and the thread is told', async (t) => {
  const threads = new Threads(join(tempDir(t, 'zirbel-threads-'), 'turns'), '/data/one');
  const key = projectThread('game-1', 'main');
  threads.update(key, { harness: 'codex', sessionId: 'gone' });
  const events: ChatUpdate[] = [];
  const { harnesses, calls } = recording(({ run }) => {
    if (run.place?.resume) throw new TurnEndedError('Codex', 'session-not-found');
  });
  await inThread(threads, harnesses, key, turn('turn-1'), {}, undefined, (harness) =>
    harness.start('codex', 'Go on', { update: (event) => events.push(event) }),
  );
  assert.deepEqual(
    calls.map(({ run }) => [run.place?.resume, run.place?.sessionId]),
    [
      [true, 'gone'],
      [false, undefined],
    ],
  );
  assert.equal(threads.read(key)?.sessionId, 'session-2');
  const notice = events.find((event) => event.type === 'activity' && event.entry.id === 'new-session');
  assert.ok(notice?.type === 'activity');
  assert.match(
    notice.entry.title,
    /Codex no longer has this thread’s session\. It starts a new session in the thread’s folder\./,
  );
  // Any other end is the turn's error, as it was.
  const failing = recording(() => {
    throw new TurnEndedError('Codex', 'usage-limit');
  });
  await assert.rejects(
    inThread(threads, failing.harnesses, key, turn('turn-2'), {}, undefined, (harness) =>
      harness.start('codex', 'Go on', {}),
    ),
    /usage limit/,
  );
});

test('a turn is marked running; the editor stopping, or ending mid-turn, leaves it interrupted until continued', async (t) => {
  const root = join(tempDir(t, 'zirbel-threads-'), 'turns');
  const threads = new Threads(root, '/data/one');
  const key = projectThread('game-1', 'main');
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const { harnesses } = recording(async ({ run }) => {
    // The harness names its session as it starts, long before the turn ends.
    run.session?.('live');
    started.resolve();
    await new Promise((_resolve, reject) =>
      run.signal?.addEventListener('abort', () => reject(abortError(run.signal)), { once: true }),
    );
  });
  const running = inThread(
    threads,
    harnesses,
    key,
    { ...turn('turn-1'), noteId: 'note-1' },
    {},
    controller.signal,
    (harness) => harness.start('codex', 'Make it', { signal: controller.signal }),
  );
  await started.promise;
  assert.deepEqual([threads.read(key)?.turn?.state, threads.read(key)?.turn?.pid], ['running', process.pid]);
  controller.abort(new EditorStopping());
  await assert.rejects(running);
  assert.deepEqual([threads.read(key)?.turn?.state, threads.read(key)?.turn?.noteId], ['interrupted', 'note-1']);

  // An editor that ended without stopping its turns: the next start marks them interrupted. A turn another editor,
  // with a data folder of its own, is still running stays as it is; one whose editor is gone is interrupted too.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => other.kill());
  const write = (name: string, pid: number, data: string) =>
    writeFileSync(
      join(root, name + '.json'),
      JSON.stringify({
        version: 1,
        folder: name,
        harness: 'codex',
        sessionId: 's',
        turn: {
          id: 'turn-x',
          state: 'running',
          harness: 'codex',
          text: 'Make it',
          startedAt: new Date().toISOString(),
          pid,
          data,
        },
      }),
    );
  write('game-2.main', other.pid!, '/data/one');
  write('game-3.main', other.pid!, '/data/two');
  write('game-4.main', 999_999, '/data/two');
  new Threads(root, '/data/one').interruptStale();
  const states = ['game-2.main', 'game-3.main', 'game-4.main'].map((name) => threads.read(name)?.turn?.state);
  assert.deepEqual(states, ['interrupted', 'running', 'interrupted']);
  assert.equal(CONTINUE_TEXT, 'The previous turn was interrupted. Continue where you left off.');

  // A new turn in the thread replaces the interrupted one.
  const next = recording();
  await inThread(threads, next.harnesses, key, turn('turn-2'), {}, undefined, (harness) =>
    harness.start('codex', CONTINUE_TEXT, {}),
  );
  assert.equal(threads.read(key)?.turn, undefined);
  assert.deepEqual(
    [next.calls[0]?.run.place?.resume, next.calls[0]?.run.place?.sessionId],
    [true, 'live'],
    'Continue resumes the same session',
  );
});

test('the chat before a project moves to the project it creates, and a removed project takes its threads along', async (t) => {
  const root = join(tempDir(t, 'zirbel-threads-'), 'turns');
  const threads = new Threads(root, '/data/one');
  const chat = workspaceThread('0f6c8d0e-6b8a-4c55-9a3e-2c7f5a1b9d10');
  const folder = threads.folder(chat);
  writeFileSync(join(folder, 'notes.md'), 'the harness’s own file');
  threads.update(chat, { harness: 'codex', sessionId: 'first', conversation: [{ role: 'creator', text: 'Hello' }] });
  threads.moveToProject(chat, 'game-1');
  const moved = threads.read(projectThread('game-1', 'main'));
  assert.deepEqual([moved?.folder, moved?.sessionId, moved?.harness], [chat, 'first', 'codex']);
  assert.equal(moved?.conversation, undefined);
  assert.equal(threads.read(chat)?.project, 'game-1');
  assert.equal(threads.folder(projectThread('game-1', 'main')), folder);
  assert.equal(readFileSync(join(folder, 'notes.md'), 'utf8'), 'the harness’s own file');

  threads.update(projectThread('game-1', 'side'), { harness: 'claude', sessionId: 'second' });
  const side = threads.folder(projectThread('game-1', 'side'));
  const keep = threads.folder(projectThread('game-2', 'main'));
  const removed: string[] = [];
  await threads.removeProject('game-1', async (harness, { cwd, sessionId }) => {
    removed.push(harness + ':' + sessionId + ':' + cwd);
  });
  assert.deepEqual(removed.sort(), ['claude:second:' + side, 'codex:first:' + folder]);
  assert.deepEqual([existsSync(folder), existsSync(side), existsSync(keep)], [false, false, true]);
  assert.deepEqual([threads.read(chat), threads.read(projectThread('game-1', 'main'))], [undefined, undefined]);
});
