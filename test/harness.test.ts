// Harness chat (harness-chat.ts): what a turn is told, a reply taken into a game from the folder's game/ or refused,
// and workspace chat, which makes no game until the harness creates one.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
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

/** What the fake harness answers a message with: a question, a new game, or a start. */
function harnessReply(message: string) {
  if (message === 'simple 3D game using three.js')
    return { action: 'reply', message: 'What should the player do in the game?' };
  if (message === 'A small 3D JRPG')
    return { action: 'create', message: 'Created the quest draft.', title: 'Sunstone Road' };
  return { action: 'reply', message: 'Starting.' };
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
    const text = harnessReply(message);
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
