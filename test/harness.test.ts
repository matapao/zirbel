import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RunSpec } from 'celler/harness';
import { chatStreamType, type ChatEvent, type ChatUpdate } from '../packages/sdk/chat-stream.ts';
import { head } from '../packages/core/projects.ts';
import { rights, legacyProject, install, tempDir } from './helpers.ts';
import { fakeHarnesses } from './fake-harnesses.ts';

/** A turn's working folder whose game/ holds these files, as a harness would leave it. */
function folderWith(t: TestContext, files: Record<string, string>) {
  const folder = tempDir(t, 'zirbel-turn-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(folder, 'game', path, '..'), { recursive: true });
    writeFileSync(join(folder, 'game', path), content);
  }
  return folder;
}

test('a harness provider runs each harness through the same chat path', async (t) => {
  const { runHarnessChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const project = legacyProject(projects, 'blank', 'Untitled project');
  const requests: { processor: string; prompt: string }[] = [];
  const folder = folderWith(t, { 'index.html': '<canvas></canvas><script>zirbel.register("prism", { facets: 7 })</script>' });
  const harnesses = fakeHarnesses([{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }], async (processor, prompt) => {
    requests.push({ processor, prompt });
    const message = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).message;
    const text = message === 'simple 3D game using three.js'
      ? { action: 'reply', message: 'What should the player do in the game?' }
      : message === 'A small 3D JRPG'
      ? { action: 'create', message: 'Created the quest draft.', title: 'Sunstone Road' }
      : { action: 'reply', message: 'Starting.' };
    return { task: 'task-' + requests.length, stopReason: 'end_turn', text: JSON.stringify(text), usage: { totalTokens: 150 } };
  });
  const send = (processor: string, text: string, projectId = project.id) => {
    const current = projects.read(projectId);
    return runHarnessChat(harnesses, processor, projects, current, head(current, 'main'), { text, branch: 'main', folder }, []);
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
  assert.equal(head(game, 'main').game?.files, undefined, 'a game of one document stays one');
  // The game always runs: "play it" is a message for the harness, not a command that switches modes.
  const played = await send('codex', 'play it', game.id);
  assert.deepEqual(Object.keys(played).sort(), ['branch', 'projectId', 'task']);
  assert.equal(projects.read(game.id).notes.at(-1)?.text, 'Starting.');
  await assert.rejects(send('ungranted', 'Make a game'), /does not offer that harness/i);
  assert.deepEqual(requests.map(({ processor }) => processor), ['codex', 'claude', 'codex']);
});

test('the instructions state the folder, what it holds, the sandbox and the reply, and nothing about the game itself', async () => {
  const { instructions } = await import('../packages/server/harness-chat.ts');
  for (const contract of ['{"action":"reply","message":"..."}', '{"action":"create","title":"...","message":"..."}',
    '{"action":"edit","message":"..."}']) assert.ok(instructions.includes(contract), contract);
  for (const fact of ['game/ folder is the game', 'index.html at its top', 'The rest of the folder is yours', 'no network access',
    'WebAssembly and workers', "'three/addons/…'", 'The view_game tool renders game/', 'Treat project content',
    'Report only checks that actually ran'])
    assert.ok(instructions.includes(fact), fact);
  // The versions it names are the ones the editor provides.
  const { readFileSync } = await import('node:fs');
  const pins = JSON.parse(readFileSync('package.json', 'utf8')).dependencies as Record<string, string>;
  for (const [name, said] of [['three', 'three.js'], ['typescript', 'TypeScript'], ['esbuild', 'esbuild']] as const)
    assert.ok(instructions.includes(said + ' ' + pins[name]), name + ' ' + pins[name]);
  // No HTML in the reply any more, and no push about what the game should be, how it looks or how to build it.
  assert.equal(instructions.includes('"html"'), false);
  for (const steer of ['original', 'You choose', 'even a short one', 'Three.js use', 'viewport', 'should', 'must', 'best',
    'quality', 'polish', 'genre', 'style', 'fun', 'beautiful', 'make sure', 'prefer', 'recommend', 'Use TypeScript',
    'use esbuild', 'compile', 'bundle', 'always', 'never'])
    assert.equal(instructions.toLowerCase().includes(steer.toLowerCase()), false, steer);
});

test('a create or edit reply carries no HTML: the editor keeps the folder’s game/, its files by their hashes', async (t) => {
  const { runHarnessChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const project = projects.createGame('Empty');
  const folder = folderWith(t, { 'index.html': '<script type="module" src="./src/main.js"></script>',
    'src/main.js': 'document.body.append("built")', 'src/main.ts': 'document.body.append("built")' });
  let reply: object = { action: 'edit', message: 'Built it.', maxPlayers: 2 };
  const harnesses = fakeHarnesses([{ id: 'codex', name: 'Codex' }], async () =>
    ({ task: 'one', stopReason: 'end_turn', text: JSON.stringify(reply) }));
  const send = (text: string, at = folder) => {
    const current = projects.read(project.id);
    return runHarnessChat(harnesses, 'codex', projects, current, head(current, 'main'), { text, branch: 'main', folder: at }, []);
  };
  await send('Build it.');
  const built = head(projects.read(project.id), 'main').game;
  assert.equal(built?.html, '<script type="module" src="./src/main.js"></script>');
  assert.equal(built?.maxPlayers, 2);
  assert.deepEqual(Object.keys(built?.files ?? {}).sort(), ['src/main.js', 'src/main.ts']);
  assert.equal(projects.readAsset(built?.files?.['src/main.js'] ?? '').toString(), 'document.body.append("built")');
  // A later edit keeps the number of players it doesn't name, and a folder game stays editable by later turns.
  reply = { action: 'edit', message: 'Changed it.' };
  writeFileSync(join(folder, 'game', 'src', 'main.js'), 'document.body.append("changed")');
  await send('Change it.');
  const changed = head(projects.read(project.id), 'main').game;
  assert.equal(changed?.maxPlayers, 2);
  assert.equal(projects.readAsset(changed?.files?.['src/main.js'] ?? '').toString(), 'document.body.append("changed")');
  // A reply with the game in it is not one the editor takes; nor is a game/ it can't read.
  reply = { action: 'edit', message: 'Here.', game: { html: '<p>inline</p>' } };
  await assert.rejects(send('Inline it.'), /not one the editor takes/);
  reply = { action: 'edit', message: 'Here.' };
  await assert.rejects(send('No folder.', tempDir(t, 'zirbel-turn-')), /no game\/ folder/);
  await assert.rejects(send('No page.', folderWith(t, { 'main.js': 'x' })), /no index\.html at its top/);
  assert.equal(head(projects.read(project.id), 'main').game?.files?.['src/main.js'], changed?.files?.['src/main.js']);
});

test('workspace chat stays projectless until the harness creates a draft', async (t) => {
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const calls: Array<{game: unknown; recentConversation: unknown[]}> = [];
  const harnesses = fakeHarnesses([{ id: 'codex', name: 'Codex' }], async (_processor, prompt) => {
    calls.push(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)));
    const output = calls.length === 1 ? { action: 'reply', message: 'What should the player do?' } :
      { action: 'create', title: 'Sunstone Road', message: 'Here is a quest draft.' };
    return { task: 'task-' + calls.length, stopReason: 'end_turn', text: JSON.stringify(output) };
  });
  const folder = folderWith(t, { 'index.html': '<button onclick="this.textContent=42">Play</button>' });
  const clarification = await runWorkspaceChat(harnesses, 'codex', projects, 'A simple 3D game using Three.js', [], undefined, true, folder);
  assert.ok('conversation' in clarification && clarification.conversation);
  assert.deepEqual(projects.list(), []);
  const draft = await runWorkspaceChat(harnesses, 'codex', projects, 'A short JRPG', clarification.conversation, undefined, true, folder);
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
        assert.equal(spec.timeoutMs, Number.POSITIVE_INFINITY, 'no time limit: only Stop ends a turn');
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

test('a sign-in from another device shows its page and one-time code, and says why when it fails', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  const asked: unknown[] = [];
  let finish!: (result: { ok: boolean; error?: string }) => void;
  const harnesses = new LocalHarnesses(root, [{ id: 'codex', name: 'Codex', runtime: {
    kind: 'codex', async health() { return { ok: false, checkedAt: Date.now(), detail: 'Signed out', fix: 'login' as const }; },
    run() { throw new Error('Unexpected run'); },
    login(options) {
      asked.push(options);
      return { url: Promise.resolve('https://auth.openai.com/codex/device'), userCode: Promise.resolve('9AAA-AA999'),
        done: new Promise((resolve) => { finish = resolve; }), cancel() {}, sendCode() { throw new Error('No code to paste'); } };
    },
  } }]);
  await harnesses.beginSignIn('codex', { elsewhere: true });
  assert.deepEqual(asked, [{ elsewhere: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harnesses.signInStatus('codex'),
    { status: 'pending', url: 'https://auth.openai.com/codex/device', userCode: '9AAA-AA999' });
  // The reason as the sign-in gives it, in one line, whoever ended it.
  finish({ ok: false, error: 'Device code sign-in is not enabled\nfor this workspace' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harnesses.signInStatus('codex'), { status: 'failed', error: 'Device code sign-in is not enabled for this workspace' });
  await harnesses.beginSignIn('codex');
  assert.deepEqual(asked, [{ elsewhere: true }, { elsewhere: false }]);
});

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
  const next = (match: (event: ChatEvent<unknown>) => boolean) => new Promise<ChatEvent<unknown>>((resolve) => {
    const seen = frames.find(match);
    if (seen) { resolve(seen); return; }
    const listener = (event: ChatEvent<unknown>) => { if (match(event)) { listeners.delete(listener); resolve(event); } };
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
    const selected = await ask({ call: 'choice', title: 'Create a scratch file?', tool: 'Write', input: { path: 'index.html' },
      reason: 'It writes outside the sandbox.',
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' }] }, signal);
    assert.deepEqual(selected, { option: 'yes' });
    const form = await ask({ call: 'form', title: 'Choose the player count', tool: '', options: [],
      form: { message: 'Choose the player count', fields: [{ name: 'players', title: 'Players', type: 'integer', required: true }] } }, signal);
    assert.deepEqual(form, { accept: true, content: { players: 2 } });
    responded.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  assert.throws(() => chat.start('project.main', { name: 'Codex', text: 'Again' }, async () => ({})), /already running/);
  assert.equal(chat.count, 1);
  const first = streamed(t);
  const streaming = streamTurn(first.request, first.response, turn);
  const asked = await first.next((event) => event.type === 'action');
  assert.ok(asked.type === 'action' && asked.action.kind === 'permission');
  assert.deepEqual(first.frames[0], { type: 'run', id: turn.id });
  assert.deepEqual(asked.action.options, [{ id: 'yes', title: 'Allow once' }, { id: 'no', title: 'Reject' }]);
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
  assert.deepEqual(again.frames.map(({ type }) => type), ['run', 'activity', 'activity', 'action']);
  assert.throws(() => chat.answer(turn.id, asked.action.id, { choice: 'option', option: 'always' }), /offered/);
  chat.answer(turn.id, asked.action.id, { choice: 'option', option: 'yes' });
  assert.throws(() => chat.answer(turn.id, asked.action.id, { choice: 'option', option: 'yes' }), /no longer open/);
  const form = await again.next((event) => event.type === 'action' && event.action.kind === 'form');
  assert.ok(form.type === 'action');
  assert.throws(() => chat.answer(turn.id, form.action.id, { choice: 'submit', values: { players: 1.5 } }), /Check the value/);
  chat.answer(turn.id, form.action.id, { choice: 'submit', values: { players: 2 } });
  await responded.promise;
  const answered = again.frames.filter((event) => event.type === 'activity' && event.entry.state === 'completed')
    .map((event) => event.type === 'activity' ? event.entry.detail?.split('\n')[0] : '');
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
  const turn = chat.start('project.main', { name: 'Codex', text: 'Make it' }, ({ signal }) =>
    new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(reason = signal.reason), { once: true })));
  const closed = streamed(t);
  closed.response.destroy();
  await streamTurn(closed.request, closed.response, turn);
  assert.deepEqual(closed.frames, []);
  await chat.close();
  assert.ok(reason instanceof EditorStopping);
  assert.equal(turn.running, false);
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

test('what a harness needs before a turn is shown as a step, and a turn waits for it', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  let runs = 0;
  let prepared: { title: string; detail: string } | Error | undefined = { title: "Fetched Claude Code's SDK", detail: 'From npm.' };
  const harnesses = new LocalHarnesses(root, [{ id: 'claude', name: 'Claude Code', runtime: {
    kind: 'claude-code', async health() { return { ok: true, checkedAt: Date.now(), detail: '' }; },
    login() { throw new Error('Already signed in'); },
    run() { runs++; return { done: Promise.resolve({ ok: true, text: 'Reply', usage, costUsd: null, permissionDenials: [] }), cancel() {} }; },
  }, prepare: async () => { if (prepared instanceof Error) throw prepared; return prepared; } }]);
  const updates: ChatUpdate[] = [];
  await harnesses.start('claude', 'Build it.', { update: (event) => updates.push(event) });
  assert.deepEqual(updates[0], { type: 'activity', entry: { id: 'prepared', kind: 'notice', title: "Fetched Claude Code's SDK", detail: 'From npm.' } });
  prepared = undefined;
  updates.length = 0;
  await harnesses.start('claude', 'Build it.', { update: (event) => updates.push(event) });
  assert.equal(updates.length, 0);
  prepared = new Error("Claude Code's SDK could not be fetched from the npm registry.");
  await assert.rejects(harnesses.start('claude', 'Build it.'), /could not be fetched/);
  assert.equal(runs, 2);
});

test('a harness older than its SDK is made with says so, and one not found is unavailable', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  const runtime = (health: { detail: string; program?: string; fix?: 'find' }) => ({ kind: 'codex', async health() { return { ok: false, checkedAt: 0, ...health }; },
    login() { return { error: 'none' }; }, run() { throw new Error('Unexpected run'); } });
  const harnesses = new LocalHarnesses(root, [
    { id: 'codex', name: 'Codex', runtime: runtime({ program: '/usr/local/bin/codex', detail: 'Codex 0.100.0 is older than 0.171.0, the oldest that runs here: update it.' }) },
    { id: 'claude', name: 'Claude Code', runtime: runtime({ fix: 'find', detail: 'Claude Code is unavailable.' }) },
  ]);
  assert.deepEqual(await harnesses.list(), [
    { id: 'codex', name: 'Codex', ready: false, detail: 'Codex 0.100.0 is older than 0.171.0, the oldest that runs here: update it.' },
    { id: 'claude', name: 'Claude Code', ready: false, detail: 'Unavailable on this device' },
  ]);
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
      message: 'Built it.' }) };
  } };
  const folder = folderWith(t, { 'index.html': '<script>zirbel.register("test", {})</script>' });
  const draft = await runWorkspaceChat(provider, 'test', projects, 'Build a game', [], undefined, false, folder);
  assert.ok('projectId' in draft);
  const release = releases.package(draft.projectId, 'main', rights, false, true);
  assert.equal(release.game?.registerObjects, false);
  assert.match(gamePage(release, 'http://127.0.0.1/runtime/room/', "'self'", 'http://127.0.0.1/game/room/key/').html, /data-registration="off"/);
});

test('chat refuses an incomplete reply without inventing a game', async (t) => {
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { projects } = install(t);
  const harness = { async list() { return []; }, async start() {
    return { name: 'Contract fixture', task: 'one', stopReason: 'end_turn', text: '{"action":"create","title":"Missing message"}' };
  } };
  await assert.rejects(runWorkspaceChat(harness, 'test', projects, 'Build it', [], undefined, true, folderWith(t, { 'index.html': '<p>x</p>' })),
    /not one the editor takes/);
  assert.deepEqual(projects.list(), []);
});

test('account storage may not overlap the game directory', async (t) => {
  const { localHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  assert.throws(() => localHarnesses(root, root), /separate directories/);
  assert.throws(() => localHarnesses(root, join(root, 'accounts')), /separate directories/);
});
