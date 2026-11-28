// The editor API on both hosts: `node dist/server.mjs` and the Go host
// (host/bin/zirbel-host). One scripted session runs against each, and their
// normalized responses must match. Releases published by one host must import
// into the other, which proves their content hashes agree.
// The session and its client are editor-session.ts.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { client, session, type Step } from './editor-session.ts';
import { hostsUnderTest, launch, statusForHost, stopHost, tempDir } from './helpers.ts';

const editors = hostsUnderTest();

async function startEditor(t: TestContext, command: string[], data: string) {
  const { child, ready } = launch(t, command, ['--data', data, '--port', '0', '--enable-mcp'], (line) =>
    typeof line.editor === 'string' ? line.editor : undefined,
  );
  return { editor: await ready, stop: () => stopHost(child) };
}

// Generated IDs, dates, secrets and ports differ per run; replace them by
// first appearance, walking object keys in sorted order.
function normalizer() {
  const ids = new Map<string, string>();
  const name = (value: string, kind: string) => {
    if (!ids.has(value)) ids.set(value, '<' + kind + ids.size + '>');
    return ids.get(value)!;
  };
  const text = (value: string) =>
    value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => name(id, 'id'))
      // Revisions are commits (AGENTS.md: The git store), each named by its hash.
      .replace(/\b[0-9a-f]{40}\b/g, (commit) => name(commit, 'commit'))
      .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<date>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/\/join\/[a-f0-9]{12}#[\w-]{32}/g, '/join/<room>#<invite>')
      .replace(/\.[\w-]{32}$/, '.<token>');
  const walk = (value: unknown, key = ''): unknown => {
    // The Scene app page embeds Function.toString() of its script, which each
    // TypeScript stripper formats differently; compare its markup only.
    if (typeof value === 'string' && value.startsWith('<!doctype html>') && value.includes('id="scene"'))
      return value.slice(0, value.indexOf('<script>'));
    if (typeof value === 'string') return /^[a-f0-9]{12}$/.test(value) && key === 'id' ? '<room>' : text(value);
    if (typeof value === 'number' && key === 'expires') return '<expires>';
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((field) => [field, walk((value as Record<string, unknown>)[field], field)]),
      );
    }
    return value;
  };
  return (step: Step) =>
    step.status >= 300 ? { status: step.status } : { status: step.status, body: walk(step.body) };
}

// Each editor's run is a step of one test, and the comparisons its last: steps keep their order, whatever order
// --test-randomize gives the file's tests.
test('every editor runs the scripted session, both answer it identically, and each imports the other’s releases', async (t) => {
  const results = new Map<string, Awaited<ReturnType<typeof session>>>();
  for (const host of editors) {
    await t.test(host.name + ' editor runs the scripted session', async (t) => {
      const { editor } = await startEditor(t, host.command, join(tempDir(t, 'zirbel-editor-'), 'data'));
      assert.equal(await statusForHost(editor + '/api/health', 'evil.example'), 403);
      const result = await session(editor);
      for (const [index, step] of result.steps.entries()) {
        assert.ok(
          step.status < 500,
          'step ' + index + ' failed with ' + step.status + ': ' + JSON.stringify(step.body),
        );
      }
      // The keys come in the release's game, in their inputs' order, and each place's fields in theirs.
      assert.equal(
        JSON.stringify((result.keysRelease as { game: { controls?: unknown } }).game.controls),
        '{"keys":{"a":"Space","b":"ShiftLeft","left":"KeyA","start":"Enter","up":"ArrowUp"},' +
          '"players":[{"keys":{"a":"KeyF","up":"KeyW"},"name":"Red car","color":"#d03030"},{"color":"#3050d0"}]}',
      );
      results.set(host.name, result);
    });
  }
  if (editors.length < 2) return;
  await t.test('both editors answer the session identically', () => {
    const node = results.get('node')!.steps.map(normalizer());
    const go = results.get('go')!.steps.map(normalizer());
    assert.equal(go.length, node.length);
    for (const [index, step] of node.entries()) assert.deepEqual(go[index], step, 'step ' + index);
  });

  await t.test('a release published by either editor imports into the other', async (t) => {
    const start = async (name: string) =>
      startEditor(t, editors.find((item) => item.name === name)!.command, join(tempDir(t, 'zirbel-cross-'), 'data'));
    for (const [from, to] of [
      ['node', 'go'],
      ['go', 'node'],
    ] as const) {
      const { release, templateRelease, builtRelease, netRelease, keysRelease } = results.get(from)!;
      const target = await start(to);
      const api = client(target.editor);
      for (const item of [release, templateRelease, builtRelease, netRelease, keysRelease]) {
        const imported = await api.post('/api/releases/import', item);
        assert.equal(imported.status, 201, from + ' -> ' + to + ': ' + JSON.stringify(imported.body));
      }
      // The other host may write the release's keys in another order; it is still the same package.
      const { releaseId } = (templateRelease as { manifest: { releaseId: string } }).manifest;
      const copy = (await api.get('/api/releases/' + releaseId + '/download')).body;
      await target.stop();
      const origin = await start(from);
      for (const item of [templateRelease, copy]) {
        const imported = await client(origin.editor).post('/api/releases/import', item);
        assert.equal(imported.status, 201, to + ' copy -> ' + from + ': ' + JSON.stringify(imported.body));
      }
      await origin.stop();
    }
  });
});

if (editors.length > 1) {
  test('both editors share one data directory', async (t) => {
    const data = join(tempDir(t, 'zirbel-shared-'), 'data');
    let previous: string | undefined;
    for (const host of [...editors, ...editors]) {
      const { editor, stop } = await startEditor(t, host.command, data);
      const api = client(editor);
      const list = (await api.get('/api/projects')).body as { id: string }[];
      if (previous) {
        const project = await api.get('/api/projects/' + previous);
        assert.equal(project.status, 200, host.name + " could not read the other editor's project");
        assert.ok(list.some((item) => item.id === previous));
      }
      previous = ((await api.post('/api/projects', { title: 'From ' + host.name })).body as { id: string }).id;
      await stop();
    }
  });
}
