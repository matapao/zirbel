// The harness library's agents as the editor runs them (local-harnesses.ts): sign-in, here or from another device, the
// models and efforts a turn may take, what a harness needs first, why a turn ended, and where accounts are kept.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunSpec } from 'celler/harness';
import type { ChatUpdate } from '../packages/sdk/chat-stream.ts';
import { install } from './helpers.ts';

test('standalone harnesses use existing sign-in and enable chat after provider sign-in', async (t) => {
  const { LocalHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { runWorkspaceChat } = await import('../packages/server/harness-chat.ts');
  const { root, projects } = install(t);
  const usage = { input: 12, output: 5, cacheRead: 2, cacheWrite5m: 0, cacheWrite1h: 0 };
  let claudeReady = false;
  let loginStarts = 0;
  let workingFolder = '';
  const health = (ready: boolean) => ({ ok: ready, checkedAt: Date.now(), detail: '', ...(ready ? {} : { fix: 'login' as const }) });
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

test('account storage may not overlap the game directory', async (t) => {
  const { localHarnesses } = await import('../packages/server/local-harnesses.ts');
  const { root } = install(t);
  assert.throws(() => localHarnesses(root, root), /separate directories/);
  assert.throws(() => localHarnesses(root, join(root, 'accounts')), /separate directories/);
});
