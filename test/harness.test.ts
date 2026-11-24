import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunSpec, SessionConfigOption } from 'celler/harness';
import { chatStreamType, type ChatEvent, type ChatUpdate } from '../packages/sdk/chat-stream.ts';
import { head } from '../packages/core/projects.ts';
import { rights, legacyProject, install } from './helpers.ts';

test('a hosted harness connection offers processors and runs each harness through the same chat path', async (t) => {
  const { runHarnessChat } = await import('../packages/server/harness-chat.ts');
  const { HarnessConnection } = await import('../packages/server/harness-connection.ts');
  const { projects } = install(t);
  const project = legacyProject(projects, 'blank', 'Untitled project');
  const processors = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }];
  const requests: { processor: string; prompt: string; connectors: string[] }[] = [];
  const harnesses = new HarnessConnection('http://127.0.0.1:7300', 'app-token', async (url, init, body) => {
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer app-token');
    if (url.endsWith('/access')) return { status: 200, data: { app: 'zirbel', storage: '/storage', processors } };
    const run = JSON.parse(body!);
    requests.push(run);
    assert.deepEqual(run.connectors, []);
    const message = JSON.parse(run.prompt.slice(run.prompt.lastIndexOf('\n') + 1)).message;
    const text = message === 'simple 3D game using three.js'
      ? { action: 'reply', message: 'What should the player do in the game?' }
      : message === 'A small 3D JRPG'
      ? { action: 'create', message: 'Created the quest draft.', title: 'Sunstone Road',
          game: { html: '<canvas></canvas><script>zirbel.register("prism", { facets: 7 })</script>' } }
      : { action: 'reply', message: 'Starting.' };
    return { status: 200, data: { task: 'task-' + requests.length, stopReason: 'end_turn', text: JSON.stringify(text), usage: { totalTokens: 150 } } };
  });
  assert.deepEqual((await harnesses.describe()).processors, processors.map((processor) => ({ ...processor, activity: 'host' })));
  const send = (processor: string, text: string, projectId = project.id) => {
    const current = projects.read(projectId);
    return runHarnessChat(harnesses, processor, projects, current, head(current, 'main'), { text, branch: 'main', playing: false }, []);
  };
  const question = await send('codex', 'simple 3D game using three.js');
  assert.equal(question.mode, undefined);
  assert.equal(projects.list().length, 1);
  assert.equal(projects.read(project.id).notes.at(-1)?.text, 'What should the player do in the game?');
  assert.deepEqual(projects.read(project.id).notes.at(-1)?.usage, { source: 'Codex', total: 150 });
  const created = await send('claude', 'A small 3D JRPG');
  assert.equal(created.mode, 'edit');
  assert.match(requests[1]?.prompt ?? '', /What should the player do/);
  const game = projects.read(created.projectId);
  assert.equal(game.title, 'Sunstone Road');
  assert.equal(head(game, 'main').game?.html.includes('facets: 7'), true);
  assert.equal((await send('codex', 'play it', game.id)).mode, 'play');
  await assert.rejects(send('ungranted', 'Make a game'), /does not offer that harness/i);
  assert.deepEqual(requests.map(({ processor }) => processor), ['codex', 'claude']);
});

test('workspace chat stays projectless until the harness creates a draft', async (t) => {
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { HarnessConnection } = await import('../packages/server/harness-connection.ts');
  const { projects } = install(t);
  const grants = { app: 'zirbel', storage: '/storage', processors: [{ id: 'codex', name: 'Codex' }], connectors: [] };
  const calls: Array<{game: unknown; recentConversation: unknown[]}> = [];
  const harnesses = new HarnessConnection('http://127.0.0.1:7300', 'app-token', async (url, _init, body) => {
    if (url.endsWith('/access')) return { status: 200, data: grants };
    const { prompt } = JSON.parse(body!);
    calls.push(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)));
    const output = calls.length === 1 ? { action: 'reply', message: 'What should the player do?' } :
      { action: 'create', title: 'Sunstone Road', message: 'Here is a quest draft.',
        game: { html: '<button onclick="this.textContent=42">Play</button>' } };
    return { status: 200, data: { task: 'task-' + calls.length, stopReason: 'end_turn', text: JSON.stringify(output) } };
  });
  const clarification = await runWorkspaceChat(harnesses, 'codex', projects, 'A simple 3D game using Three.js', []);
  assert.ok('conversation' in clarification && clarification.conversation);
  assert.deepEqual(projects.list(), []);
  const draft = await runWorkspaceChat(harnesses, 'codex', projects, 'A short JRPG', clarification.conversation);
  assert.ok('projectId' in draft && draft.projectId);
  assert.equal(draft.mode, 'edit');
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
        assert.equal(spec.trusted, true);
        assert.equal(spec.timeoutMs, 3_600_000);
        assert.ok(spec.cwd.startsWith(join(root, 'turn-')));
        assert.equal(existsSync(spec.cwd), true);
        workingFolder = spec.cwd;
        assert.deepEqual(spec.mcpServers, []);
        onProgress({ type: 'session', sessionId: 'test-session' });
        onProgress({ type: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Design a sailing game', priority: 'high', status: 'in_progress' }] } });
        onProgress({ type: 'tool', tool: 'Agent', call: 'helper', summary: 'Delegate', helper: 'Design steering' });
        onProgress({ type: 'tool', tool: 'Write', call: 'write', parent: 'helper', summary: 'Write controls' });
        onProgress({ type: 'helper-done', call: 'helper', ok: true });
        onProgress({ type: 'update', update: { sessionUpdate: 'subagent_update', sessionId: 'native-helper', title: 'Test controls', state: { state: 'running' } } });
        onProgress({ type: 'update', update: { sessionUpdate: 'subagent_update', sessionId: 'native-helper', state: { state: 'idle' } } });
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
        return { url: Promise.resolve('https://example.com/sign-in'), done: done.promise, sendCode(code) {
          assert.equal(code, 'one-time-code');
          claudeReady = true;
          done.resolve({ ok: true });
        } };
      },
    } },
  ]);
  assert.deepEqual(await harnesses.list(), [
    { id: 'codex', name: 'Codex', ready: true, activity: 'zirbel', modelSettings: true }, { id: 'claude', name: 'Claude Code', ready: false, signIn: true },
  ]);
  const events: ChatUpdate[] = [];
  const reply = await runWorkspaceChat(harnesses, 'codex', projects, 'A game about a sailing ship', [], { update: (event) => events.push(event) });
  assert.ok('conversation' in reply);
  assert.equal(existsSync(workingFolder), false);
  assert.deepEqual(events.filter((event) => event.type === 'progress').map(({ phase }) => phase), ['running', 'responding', 'validating']);
  const entries = events.filter((event) => event.type === 'activity').map(({ entry }) => entry);
  assert.equal(entries.find(({ id }) => id === 'tool:write')?.parent, 'tool:helper');
  assert.equal(entries.findLast(({ id }) => id === 'tool:helper')?.state, 'completed');
  assert.equal(entries.findLast(({ id }) => id === 'helper:native-helper')?.state, 'idle');
  assert.equal(entries.findLast(({ id }) => id === 'helper:native-helper')?.title, 'Test controls');
  assert.match(entries.find(({ kind }) => kind === 'plan')?.detail ?? '', /Design a sailing game/);
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
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' }] }, signal);
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
  assert.deepEqual(first.action.options, [{ id: 'yes', title: 'Allow once' }]);
  assert.throws(() => chat.answer(run.id, first.action.id, { choice: 'option', option: 'always' }), /offered/);
  chat.answer(run.id, first.action.id, { choice: 'option', option: 'yes' });
  assert.throws(() => chat.answer(run.id, first.action.id, { choice: 'option', option: 'yes' }), /no longer open/);
  await hasForm.promise;
  const form = frames.findLast((event) => event.type === 'action');
  assert.ok(form?.action.kind === 'form');
  assert.throws(() => chat.answer(run.id, form.action.id, { choice: 'submit', values: { players: 1.5 } }), /Check the value/);
  chat.answer(run.id, form.action.id, { choice: 'submit', values: { players: 2 } });
  await responded.promise;
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

test('hosted harness runs use the caller cancellation signal without a Zirbel deadline', async () => {
  const { HarnessConnection } = await import('../packages/server/harness-connection.ts');
  const controller = new AbortController();
  const connected = Promise.withResolvers<void>();
  const harnesses = new HarnessConnection('http://127.0.0.1:7300', 'token', async (url, { signal }) => {
    if (url.endsWith('/access')) return { status: 200, data: { app: 'zirbel', processors: [{ id: 'claude', name: 'Claude Code' }] } };
    assert.equal(signal, controller.signal);
    connected.resolve();
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const run = harnesses.start('claude', 'Make a game', { signal: controller.signal });
  await connected.promise;
  controller.abort(new Error('Stopped by the creator'));
  await assert.rejects(run, /Stopped by the creator/);
  await assert.rejects(harnesses.start('claude', 'Make a game', { selection: { model: 'native-model' } }), /host does not expose model settings/);
});

test('the model picker reads native choices before the first prompt and applies only the selected variant options', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  const calls: RunSpec[] = [];
  let probesCancelled = 0;
  let ignoreEffort = false;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const modes = { currentModeId: 'work', availableModes: [{ id: 'work', name: 'Work' }] };
  const modelOptions = [{ group: 'current', name: 'Current models', options: [
    { value: 'model-one', name: 'Model One' }, { value: 'model-two', name: 'Model Two', description: 'Model from the harness' },
  ] }];
  const harnesses = new LocalHarnesses(root, [{ id: 'fixture', name: 'Fixture', runtime: {
    kind: 'fixture', async health() { return { ok: true, checkedAt: Date.now(), detail: '' }; },
    login() { throw new Error('Already signed in'); },
    run(spec, report) {
      calls.push(spec);
      const model = spec.model || 'model-one';
      const levels = model === 'model-one' ? ['light'] : ['regular', 'intensive'];
      const options: SessionConfigOption[] = [
        { id: 'mode', category: 'mode', type: 'select', name: 'Permission mode', currentValue: 'work', options: [] },
        { id: 'model', category: 'model', type: 'select', name: 'Harness model', currentValue: model, options: modelOptions },
        { id: 'reasoning', category: 'thought_level', type: 'select', name: 'Thinking effort',
          currentValue: (!ignoreEffort && spec.effort) || levels[0]!, options: levels.map((value) => ({ value, name: value })) },
      ];
      let cancelled = false;
      const done = Promise.resolve().then(() => {
        report({ type: 'options', modes: null, options: [] });
        report({ type: 'options', modes, options });
        if (!spec.prompt) assert.equal(cancelled, true, 'Discovery must end the initialized session before it sends a prompt');
        return { ok: !cancelled, cancelled, text: spec.prompt ? 'Reply' : '', usage, costUsd: null, permissionDenials: [] };
      });
      return { done, cancel() { cancelled = true; probesCancelled++; } };
    },
  } }]);

  const defaults = await harnesses.settings('fixture');
  assert.equal(defaults.model?.name, 'Harness model');
  assert.equal(defaults.model?.currentValue, 'model-one');
  assert.deepEqual(JSON.parse(JSON.stringify(defaults.model?.options)), modelOptions);
  assert.deepEqual(Object.keys(defaults).sort(), ['effort', 'model']);
  assert.equal(defaults.effort?.currentValue, 'light');
  const second = await harnesses.settings('fixture', 'model-two');
  assert.deepEqual(second.effort?.options.map(({ name }) => name), ['regular', 'intensive']);
  assert.equal(probesCancelled, 2);
  await assert.rejects(harnesses.start('fixture', 'Build it.', { selection: { model: 'unknown' } }), /offered by the harness/);
  await assert.rejects(harnesses.start('fixture', 'Build it.', { selection: { model: 'model-two', effort: 'light' } }), /offered for this model/);
  assert.equal(calls.length, 2);
  const selection = { model: 'model-two', effort: 'intensive' };
  assert.equal((await harnesses.start('fixture', 'Build it.', { selection })).text, 'Reply');
  assert.equal(calls[2]?.model, selection.model);
  assert.equal(calls[2]?.effort, selection.effort);
  ignoreEffort = true;
  await assert.rejects(harnesses.start('fixture', 'Build it.', { selection }), /did not apply the selected model settings/);
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
  assert.match(gamePage(release, 'http://127.0.0.1/runtime/room/', "'self'").html, /data-registration="off"/);
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
