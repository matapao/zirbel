// The turns the editor owns (chat-runs.ts): a turn runs on its own, requests stream it and attach to it with its steps
// and open requests, and only Stop or the editor stopping ends it.
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { chatStreamType, type ChatEvent } from '../packages/sdk/chat-stream.ts';
import { abortError } from './helpers.ts';

/** A streaming request and its response, with every frame the response is sent. */
function streamed(t: TestContext) {
  const request = new IncomingMessage(new Socket());
  request.headers.accept = chatStreamType;
  const response = new ServerResponse(request);
  const frames: ChatEvent<unknown>[] = [];
  const listeners = new Set<(event: ChatEvent<unknown>) => void>();
  t.mock.method(response, 'flushHeaders', () => {});
  t.mock.method(response, 'write', (line: string) => {
    const event = JSON.parse(line) as ChatEvent<unknown>;
    frames.push(event);
    for (const listener of listeners) listener(event);
    return true;
  });
  t.mock.method(response, 'end', () => response);
  const next = (match: (event: ChatEvent<unknown>) => boolean) =>
    new Promise<ChatEvent<unknown>>((resolve) => {
      const seen = frames.find(match);
      if (seen) {
        resolve(seen);
        return;
      }
      const listener = (event: ChatEvent<unknown>) => {
        if (match(event)) {
          listeners.delete(listener);
          resolve(event);
        }
      };
      listeners.add(listener);
    });
  return { request, response, frames, next, close: () => response.emit('close') };
}

test('a turn runs on its own: requests stream it, attach to it with its steps and open requests, and only Stop ends it', async (t) => {
  const { ChatRuns, streamTurn } = await import('../packages/server/chat-runs.ts');
  const chat = new ChatRuns();
  const responded = Promise.withResolvers<void>();
  const turn = chat.start('project.main', { name: 'Codex', text: 'Make it' }, async ({ ask, signal, update }) => {
    assert.ok(ask && signal && update);
    update({ type: 'activity', entry: { id: 'tool:1', kind: 'tool', title: 'execute', detail: 'npm test' } });
    const selected = await ask(
      {
        call: 'choice',
        title: 'Create a scratch file?',
        tool: 'Write',
        input: { path: 'index.html' },
        reason: 'It writes outside the sandbox.',
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
      signal,
    );
    assert.deepEqual(selected, { option: 'yes' });
    const form = await ask(
      {
        call: 'form',
        title: 'Choose the player count',
        tool: '',
        options: [],
        form: {
          message: 'Choose the player count',
          fields: [{ name: 'players', title: 'Players', type: 'integer', required: true }],
        },
      },
      signal,
    );
    assert.deepEqual(form, { accept: true, content: { players: 2 } });
    responded.resolve();
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(abortError(signal)), { once: true }),
    );
  });
  assert.throws(
    () => chat.start('project.main', { name: 'Codex', text: 'Again' }, async () => ({})),
    /already running/,
  );
  assert.equal(chat.count, 1);
  const first = streamed(t);
  const streaming = streamTurn(first.request, first.response, turn);
  const asked = await first.next((event) => event.type === 'action');
  assert.ok(asked.type === 'action' && asked.action.kind === 'permission');
  assert.deepEqual(first.frames[0], { type: 'run', id: turn.id });
  assert.deepEqual(asked.action.options, [
    { id: 'yes', title: 'Allow once' },
    { id: 'no', title: 'Reject' },
  ]);
  assert.equal(asked.action.summary, 'Edit index.html');
  assert.equal(asked.action.reason, 'It writes outside the sandbox.');
  // Each request is a step of the turn too: waiting while open, then with the answer it got.
  const step = first.frames.find((event) => event.type === 'activity' && event.entry.kind === 'request');
  assert.ok(step?.type === 'activity' && step.entry.state === 'waiting' && step.entry.title === 'Edit index.html');
  assert.match(step.entry.detail ?? '', /It writes outside the sandbox/);
  // The page goes away: the turn goes on, and a request that comes back sees it as it stands.
  first.close();
  await streaming;
  assert.equal(turn.running, true);
  const again = streamed(t);
  const attached = streamTurn(again.request, again.response, chat.get(turn.id));
  assert.deepEqual(
    again.frames.map(({ type }) => type),
    ['run', 'activity', 'activity', 'action'],
  );
  assert.throws(() => chat.answer(turn.id, asked.action.id, { choice: 'option', option: 'always' }), /offered/);
  chat.answer(turn.id, asked.action.id, { choice: 'option', option: 'yes' });
  assert.throws(() => chat.answer(turn.id, asked.action.id, { choice: 'option', option: 'yes' }), /no longer open/);
  const form = await again.next((event) => event.type === 'action' && event.action.kind === 'form');
  assert.ok(form.type === 'action');
  assert.throws(
    () => chat.answer(turn.id, form.action.id, { choice: 'submit', values: { players: 1.5 } }),
    /Check the value/,
  );
  chat.answer(turn.id, form.action.id, { choice: 'submit', values: { players: 2 } });
  await responded.promise;
  const answered = again.frames
    .filter((event) => event.type === 'activity' && event.entry.state === 'completed')
    .map((event) => (event.type === 'activity' ? event.entry.detail?.split('\n')[0] : ''));
  assert.deepEqual(answered, ['Answered: Allow once', 'Sent']);
  chat.stop(turn.id);
  await attached;
  assert.deepEqual(again.frames.at(-1), { type: 'error', error: 'Turn stopped.' });
  assert.throws(() => chat.stop(turn.id), /already ended/);
  assert.equal(chat.count, 0);
  // An ended turn still gives its outcome to a request that attaches a little later.
  const late = streamed(t);
  await streamTurn(late.request, late.response, chat.get(turn.id));
  assert.deepEqual(late.frames.at(-1), { type: 'error', error: 'Turn stopped.' });
});

test('a closed connection starts no stream, and the editor stopping interrupts its turns', async (t) => {
  const { ChatRuns, EditorStopping, streamTurn } = await import('../packages/server/chat-runs.ts');
  const chat = new ChatRuns();
  let reason: unknown;
  const turn = chat.start(
    'project.main',
    { name: 'Codex', text: 'Make it' },
    ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject((reason = abortError(signal))), { once: true }),
      ),
  );
  const closed = streamed(t);
  closed.response.destroy();
  await streamTurn(closed.request, closed.response, turn);
  assert.deepEqual(closed.frames, []);
  await chat.close();
  assert.ok(reason instanceof EditorStopping);
  assert.equal(turn.running, false);
});
