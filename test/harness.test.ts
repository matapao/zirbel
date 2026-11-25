import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunSpec } from '@matapao/celler/harness';
import { chatStreamType, type ChatEvent, type ChatUpdate } from '../packages/sdk/chat-stream.ts';
import { head } from '../packages/core/projects.ts';
import { rights, legacyProject, install } from './helpers.ts';
import { fakeHarnesses } from './fake-harnesses.ts';

test('a harness provider runs each harness through the same chat path', async (t) => {
  const { runHarnessChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const project = legacyProject(projects, 'blank', 'Untitled project');
  const requests: { processor: string; prompt: string }[] = [];
  const harnesses = fakeHarnesses([{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }], async (processor, prompt) => {
    requests.push({ processor, prompt });
    const message = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).message;
    const text = message === 'simple 3D game using three.js'
      ? { action: 'reply', message: 'What should the player do in the game?' }
      : message === 'A small 3D JRPG'
      ? { action: 'create', message: 'Created the quest draft.', title: 'Sunstone Road',
          game: { html: '<canvas></canvas><script>zirbel.register("prism", { facets: 7 })</script>' } }
      : { action: 'reply', message: 'Starting.' };
    return { task: 'task-' + requests.length, stopReason: 'end_turn', text: JSON.stringify(text), usage: { totalTokens: 150 } };
  });
  const send = (processor: string, text: string, projectId = project.id) => {
    const current = projects.read(projectId);
    return runHarnessChat(harnesses, processor, projects, current, head(current, 'main'), { text, branch: 'main' }, []);
  };
  const question = await send('codex', 'simple 3D game using three.js');
  assert.equal(question.proposalId, undefined);
  assert.equal(projects.list().length, 1);
  assert.equal(projects.read(project.id).notes.at(-1)?.text, 'What should the player do in the game?');
  assert.deepEqual(projects.read(project.id).notes.at(-1)?.usage, { source: 'Codex', total: 150 });
  const created = await send('claude', 'A small 3D JRPG');
  assert.notEqual(created.projectId, project.id);
  assert.match(requests[1]?.prompt ?? '', /What should the player do/);
  const game = projects.read(created.projectId);
  assert.equal(game.title, 'Sunstone Road');
  assert.equal(head(game, 'main').game?.html.includes('facets: 7'), true);
  // The game always runs: "play it" is a message for the harness, not a command that switches modes.
  const played = await send('codex', 'play it', game.id);
  assert.deepEqual(Object.keys(played).sort(), ['branch', 'projectId', 'task']);
  assert.equal(projects.read(game.id).notes.at(-1)?.text, 'Starting.');
  await assert.rejects(send('ungranted', 'Make a game'), /does not offer that harness/i);
  assert.deepEqual(requests.map(({ processor }) => processor), ['codex', 'claude', 'codex']);
});

test('the instructions say how to reply and what the sandbox offers, and nothing about the game itself', async () => {
  const { instructions } = await import('../packages/server/harness-chat.ts');
  for (const contract of ['{"action":"reply","message":"..."}',
    '{"action":"create","title":"...","message":"...","game":{"html":"...","maxPlayers":1}}',
    '{"action":"edit","message":"...","game":{"html":"...","maxPlayers":1}}']) assert.ok(instructions.includes(contract), contract);
  for (const steer of ['original', 'You choose', 'even a short one', 'Three.js use', 'viewport'])
    assert.equal(instructions.includes(steer), false, steer);
});

test('workspace chat stays projectless until the harness creates a draft', async (t) => {
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const calls: Array<{game: unknown; recentConversation: unknown[]}> = [];
  const harnesses = fakeHarnesses([{ id: 'codex', name: 'Codex' }], async (_processor, prompt) => {
    calls.push(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)));
    const output = calls.length === 1 ? { action: 'reply', message: 'What should the player do?' } :
      { action: 'create', title: 'Sunstone Road', message: 'Here is a quest draft.',
        game: { html: '<button onclick="this.textContent=42">Play</button>' } };
    return { task: 'task-' + calls.length, stopReason: 'end_turn', text: JSON.stringify(output) };
  });
  const clarification = await runWorkspaceChat(harnesses, 'codex', projects, 'A simple 3D game using Three.js', []);
  assert.ok('conversation' in clarification && clarification.conversation);
  assert.deepEqual(projects.list(), []);
  const draft = await runWorkspaceChat(harnesses, 'codex', projects, 'A short JRPG', clarification.conversation);
  assert.ok('projectId' in draft && draft.projectId);
  assert.equal('mode' in draft, false);
  assert.deepEqual(calls.map(({game}) => game), [null, null]);
  assert.equal(calls[1]?.recentConversation.length, 2);
  assert.equal(projects.read(draft.projectId).notes.length, 4);
});

test('standalone harnesses use existing sign-in and enable chat after provider sign-in', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { root, projects } = install(t);
  const usage = { input: 12, output: 5, cacheRead: 2, cacheWrite5m: 0, cacheWrite1h: 0 };
  let claudeReady = false;
  let loginStarts = 0;
  let workingFolder = '';
  const health = (ready: boolean) => ({ ok: ready, checkedAt: Date.now(), detail: '', fix: ready ? undefined : 'login' as const });
  const harnesses = new LocalHarnesses(root, [
    { id: 'codex', name: 'Codex', runtime: {
      kind: 'codex', async health() { return health(true); }, login() { throw new Error('Already signed in'); },
      run(spec, onProgress) {
        assert.equal(spec.purpose, 'work');
        assert.equal(spec.resume, false);
        assert.equal(spec.timeoutMs, 3_600_000);
        assert.ok(spec.cwd.startsWith(join(root, 'turn-')));
        assert.equal(existsSync(spec.cwd), true);
        workingFolder = spec.cwd;
        assert.deepEqual(spec.mcpServers, []);
        onProgress({ type: 'session', sessionId: 'test-session' });
        onProgress({ type: 'tool', tool: 'Agent', call: 'helper', summary: 'Delegate', helper: 'Design steering' });
        onProgress({ type: 'tool', tool: 'Write', call: 'write', parent: 'helper', summary: 'Write controls' });
        onProgress({ type: 'helper-done', call: 'helper', ok: true });
        onProgress({ type: 'file', file: 'index.html' });
        onProgress({ type: 'text', text: 'What should' });
        onProgress({ type: 'text', text: 'What should the player do?' });
        return { done: Promise.resolve({ ok: true, text: 'What should the player do?', usage, costUsd: null, permissionDenials: [] }), cancel() {} };
      },
    } },
    { id: 'claude', name: 'Claude Code', runtime: {
      kind: 'claude-code', async health() { return health(claudeReady); }, run() { throw new Error('Unexpected run'); },
      login() {
        loginStarts++;
        const done = Promise.withResolvers<{ ok: boolean }>();
        return { url: Promise.resolve('https://example.com/sign-in'), done: done.promise, cancel() {}, sendCode(code) {
          assert.equal(code, 'one-time-code');
          claudeReady = true;
          done.resolve({ ok: true });
        } };
      },
    } },
  ]);
  assert.deepEqual(await harnesses.list(), [
    { id: 'codex', name: 'Codex', ready: true, modelSettings: true }, { id: 'claude', name: 'Claude Code', ready: false, signIn: true },
  ]);
  const events: ChatUpdate[] = [];
  const reply = await runWorkspaceChat(harnesses, 'codex', projects, 'A game about a sailing ship', [], { update: (event) => events.push(event) });
  assert.ok('conversation' in reply);
  assert.equal(existsSync(workingFolder), false);
  assert.deepEqual(events.filter((event) => event.type === 'progress').map(({ phase }) => phase), ['running', 'responding', 'validating']);
  const entries = events.filter((event) => event.type === 'activity').map(({ entry }) => entry);
  assert.equal(entries.find(({ id }) => id === 'tool:write')?.parent, 'tool:helper');
  assert.equal(entries.findLast(({ id }) => id === 'tool:helper')?.state, 'completed');
  assert.equal(entries.find(({ kind }) => kind === 'file')?.title, 'Updated index.html');
  assert.equal(entries.findLast(({ kind }) => kind === 'message')?.detail, 'What should the player do?');
  assert.deepEqual(reply.conversation?.at(-1)?.usage, { source: 'Codex', total: 19 });
  await assert.rejects(harnesses.start('claude', 'Hello'), /sign in to Claude Code/i);
  await Promise.all([harnesses.beginSignIn('claude'), harnesses.beginSignIn('claude')]);
  assert.equal(loginStarts, 1);
  assert.deepEqual(harnesses.signInStatus('claude'), { status: 'pending', url: 'https://example.com/sign-in' });
  harnesses.submitSignInCode('claude', 'one-time-code');
  await Promise.resolve();
  assert.deepEqual(harnesses.signInStatus('claude'), { status: 'complete' });
  assert.equal((await harnesses.list()).find(({ id }) => id === 'claude')?.ready, true);
});

test('streamed harness requests accept a single reviewed answer and stopping ends the turn', async (t) => {
  const { ChatRuns } = await import('../packages/server/chat-runs.ts');
  const chat = new ChatRuns();
  const request = new IncomingMessage(new Socket());
  request.headers.accept = chatStreamType;
  const response = new ServerResponse(request);
  const frames: ChatEvent<unknown>[] = [];
  const hasForm = Promise.withResolvers<void>();
  const responded = Promise.withResolvers<void>();
  t.mock.method(response, 'flushHeaders', () => {});
  t.mock.method(response, 'write', (line: string) => {
    const event = JSON.parse(line) as ChatEvent<unknown>;
    frames.push(event);
    if (event.type === 'action' && event.action.kind === 'form') hasForm.resolve();
    return true;
  });
  t.mock.method(response, 'end', () => response);

  const completed = chat.reply(request, response, async ({ ask, signal }) => {
    assert.ok(ask && signal);
    const selected = await ask({ call: 'choice', title: 'Create a scratch file?', tool: 'Write', input: { path: 'index.html' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' }] }, signal);
    assert.deepEqual(selected, { option: 'yes' });
    const form = await ask({ call: 'form', title: 'Choose the player count', tool: '', options: [],
      form: { message: 'Choose the player count', fields: [{ name: 'players', title: 'Players', type: 'integer', required: true }] } }, signal);
    assert.deepEqual(form, { accept: true, content: { players: 2 } });
    responded.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const run = frames.find((event) => event.type === 'run');
  const first = frames.find((event) => event.type === 'action');
  assert.ok(run && first?.action.kind === 'permission');
  assert.deepEqual(first.action.options, [{ id: 'yes', title: 'Allow once' }, { id: 'no', title: 'Reject' }]);
  assert.equal(first.action.summary, 'Edit index.html');
  assert.equal(first.action.scope, 'sandboxed');
  // Each request is a step of the turn too: waiting while open, then with the answer it got.
  const asked = frames.find((event) => event.type === 'activity' && event.entry.kind === 'request');
  assert.ok(asked?.type === 'activity' && asked.entry.state === 'waiting' && asked.entry.title === 'Edit index.html');
  assert.throws(() => chat.answer(run.id, first.action.id, { choice: 'option', option: 'always' }), /offered/);
  assert.equal(first.action.reason, undefined);
  chat.answer(run.id, first.action.id, { choice: 'option', option: 'yes' });
  assert.throws(() => chat.answer(run.id, first.action.id, { choice: 'option', option: 'yes' }), /no longer open/);
  await hasForm.promise;
  const form = frames.findLast((event) => event.type === 'action');
  assert.ok(form?.action.kind === 'form');
  assert.throws(() => chat.answer(run.id, form.action.id, { choice: 'submit', values: { players: 1.5 } }), /Check the value/);
  chat.answer(run.id, form.action.id, { choice: 'submit', values: { players: 2 } });
  await responded.promise;
  const answered = frames.filter((event) => event.type === 'activity' && event.entry.state === 'completed')
    .map((event) => event.type === 'activity' ? event.entry.detail?.split('\n')[0] : '');
  assert.deepEqual(answered, ['Answered: Allow once', 'Sent']);
  chat.stop(run.id);
  await completed;
  assert.deepEqual(frames.at(-1), { type: 'error', error: 'Turn stopped.' });
  assert.throws(() => chat.stop(run.id), /already ended/);
});

test('a chat connection closed before streaming does not start a harness turn', async () => {
  const { chatReply } = await import('../packages/server/http.ts');
  const request = new IncomingMessage(new Socket());
  request.headers.accept = chatStreamType;
  const response = new ServerResponse(request);
  response.destroy();
  await chatReply(request, response, async () => assert.fail('The harness must not start for a closed connection.'));
});

test('the model picker offers the tiers and each agent’s efforts, and a turn takes only those', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  const calls: RunSpec[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const harnesses = new LocalHarnesses(root, [{ id: 'claude', name: 'Claude Code', runtime: {
    kind: 'claude-code', async health() { return { ok: true, checkedAt: Date.now(), detail: '' }; },
    login() { throw new Error('Already signed in'); },
    run(spec) {
      calls.push(spec);
      return { done: Promise.resolve({ ok: true, text: 'Reply', usage, costUsd: null, permissionDenials: [] }), cancel() {} };
    },
  } }]);
  const settings = await harnesses.settings('claude');
  assert.deepEqual(settings.model?.options.map((option) => 'value' in option && option.value), ['fast', 'balanced', 'strong']);
  assert.deepEqual(settings.effort?.options.map((option) => 'value' in option && option.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(settings.model?.currentValue, '', 'no choice: the harness’s own default');
  await assert.rejects(harnesses.settings('claude', 'gpt-unknown'), /offered by the harness/);
  await assert.rejects(harnesses.start('claude', 'Build it.', { selection: { model: 'unknown' } }), /offered by the harness/);
  await assert.rejects(harnesses.start('claude', 'Build it.', { selection: { model: 'strong', effort: 'minimal' } }), /offered for this model/);
  assert.equal(calls.length, 0);
  assert.equal((await harnesses.start('claude', 'Build it.', { selection: { model: 'strong', effort: 'max' } })).text, 'Reply');
  assert.equal(calls[0]?.model, 'strong');
  assert.equal(calls[0]?.effort, 'max');
});

test('a turn that ends for a known reason says so in plain words', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { TurnEndedError } = await import('../packages/server/processors.ts');
  const { root } = install(t);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  let ended: 'usage-limit' | 'max-turns' | 'timed-out' | 'session-not-found' = 'usage-limit';
  const harnesses = new LocalHarnesses(root, [{ id: 'codex', name: 'Codex', runtime: {
    kind: 'codex', async health() { return { ok: true, checkedAt: Date.now(), detail: '' }; },
    login() { throw new Error('Already signed in'); },
    run() { return { done: Promise.resolve({ ok: false, text: '', usage, costUsd: null, permissionDenials: [], ended, error: 'raw' }), cancel() {} }; },
  } }]);
  const words = { 'usage-limit': /usage limit/, 'max-turns': /most steps/, 'timed-out': /out of time/, 'session-not-found': /no longer has this thread’s session/ };
  for (const [reason, pattern] of Object.entries(words) as [typeof ended, RegExp][]) {
    ended = reason;
    const error = await harnesses.start('codex', 'Go on.').then(() => undefined, (error: unknown) => error);
    assert.ok(error instanceof TurnEndedError, reason);
    assert.equal(error.ended, reason);
    assert.match(error.message, pattern);
  }
});

test('a reply that arrives after cancellation does not create a draft', async (t) => {
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const controller = new AbortController();
  const pending = Promise.withResolvers<{ name: string; task: string; stopReason: string; text: string }>();
  const provider = { async list() { return []; }, start() { return pending.promise; } };
  const started = runWorkspaceChat(provider, 'codex', projects, 'Create a game', [], { signal: controller.signal });
  controller.abort(new Error('Turn stopped.'));
  pending.resolve({ name: 'Codex', task: 'late', stopReason: 'end_turn',
    text: JSON.stringify({ action: 'create', title: 'Late draft', message: 'Created it.', game: { html: '<p>Game</p>' } }) });
  await assert.rejects(started, /Turn stopped/);
  assert.deepEqual(projects.list(), []);
});

test('generation records an explicit opt-out of editor object registration', async (t) => {
  const { projects, releases } = install(t);
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { gamePage } = await import('../packages/server/game-page.ts');
  const provider = { async list() { return []; }, async start(_id: string, prompt: string) {
    assert.equal(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).registerObjects, false);
    return { name: 'Fixture', task: 'one', stopReason: 'end_turn', text: JSON.stringify({ action: 'create', title: 'A game',
      message: 'Built it.', game: { html: '<script>zirbel.register("test", {})</script>' } }) };
  } };
  const draft = await runWorkspaceChat(provider, 'test', projects, 'Build a game', [], undefined, false);
  assert.ok('projectId' in draft);
  const release = releases.package(draft.projectId, 'main', rights, false, true);
  assert.equal(release.game?.registerObjects, false);
  assert.match(gamePage(release, 'http://127.0.0.1/runtime/room/', "'self'", 'http://127.0.0.1/game/room/key/').html, /data-registration="off"/);
});

test('chat refuses an incomplete code response without inventing a game', async (t) => {
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const harness = { async list() { return []; }, async start() {
    return { name: 'Contract fixture', task: 'one', stopReason: 'end_turn', text: '{"action":"create","title":"Missing code"}' };
  } };
  await assert.rejects(runWorkspaceChat(harness, 'test', projects, 'Build it', []), /incomplete game/);
  assert.deepEqual(projects.list(), []);
});

test('account storage may not overlap the game directory', async (t) => {
  const { localHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  assert.throws(() => localHarnesses(root, root), /separate directories/);
  assert.throws(() => localHarnesses(root, join(root, 'accounts')), /separate directories/);
});
