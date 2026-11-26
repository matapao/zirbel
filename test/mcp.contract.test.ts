// The project MCP server on both hosts: `node dist/server.mjs` and the Go host (host/bin/zirbel-host). One scripted
// session over /mcp runs against each, with a grant that proposes and one that also applies: the orientation at
// initialize, the guides, which both serve as the build's bytes, and reading and writing a built game's files. Their
// normalized answers must match.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { guideResources } from '../packages/server/mcp-guides.ts';
import { hostsUnderTest, launch, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();
const base64 = (data: string | Uint8Array) => Buffer.from(data).toString('base64');
type Step = { status: number; body: unknown };
type Reply = { result?: { isError?: boolean; content?: { text: string }[]; contents?: { uri: string; mimeType: string; text: string }[] } };

async function session(editor: string) {
  const post = async (path: string, payload: unknown, headers: Record<string, string>): Promise<Step> => {
    const response = await fetch(editor + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload) });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body };
  };
  const api = async <T>(path: string, payload: unknown) => (await post(path, payload, { origin: editor })).body as T;
  const steps: Step[] = [];
  const guides = new Map<string, string>();
  let next = 1;
  const mcp = async (token: string, method: string, params?: object) => {
    const step = await post('/mcp', { jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) }, { authorization: 'Bearer ' + token });
    steps.push(step);
    return step.body as Reply;
  };
  /** A tool's answer: its JSON, or its refusal's text. */
  const tool = async <T>(token: string, name: string, args: object) => {
    const result = (await mcp(token, 'tools/call', { name, arguments: args })).result!;
    const text = result.content![0]!.text;
    return result.isError ? { refused: text } : { value: JSON.parse(text) as T };
  };

  const built = await api<{ id: string; branches: { main: string } }>('/api/projects/import-game', { title: 'Files', files: {
    'index.html': base64('<!doctype html><script type="module" src="./src/main.js"></script>'),
    'src/main.js': base64('\ufeffdocument.body.append("built")'), 'models/hero.glb': base64(new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0xff])),
  } });
  const grant = async (projectId: string, write: boolean) => (await api<{ token: string }>('/api/projects/' + projectId + '/grants', { write, hours: 1 })).token;
  const proposing = await grant(built.id, false);
  const writing = await grant(built.id, true);

  await mcp(proposing, 'initialize', { protocolVersion: '2025-06-18' });
  await mcp(writing, 'initialize', { protocolVersion: '2025-11-25' });
  await mcp(proposing, 'resources/list');
  for (const { uri } of guideResources) {
    const contents = (await mcp(proposing, 'resources/read', { uri })).result?.contents;
    guides.set(uri, contents?.[0]?.text ?? '');
  }
  for (const uri of ['zirbel://guide/nope', 'zirbel://guide/overview.md', 'ui://zirbel/nope']) await mcp(proposing, 'resources/read', { uri });
  await mcp(proposing, 'tools/list');
  await mcp(writing, 'tools/list');

  // Download: the head's revision lists the files, and read_file reads each from that revision.
  const base = built.branches.main;
  await tool(proposing, 'read_scene', {});
  for (const path of ['index.html', 'src/main.js', 'models/hero.glb']) await tool(proposing, 'read_file', { path, revision: base });
  await tool(proposing, 'read_file', { path: 'missing.js' });
  await tool(proposing, 'read_file', { path: 'index.html', revision: 'nope' });
  await tool(proposing, 'read_file', { path: 'index.html', branch: 'nope' });

  // Changes that are refused, and stage nothing.
  const write = (token: string, baseRevision: string, files: object[], label = 'Edit') =>
    tool<{ proposal: { id: string } }>(token, 'write_files', { baseRevision, label, files });
  await write(proposing, 'nope', [{ path: 'a.js', text: '1' }]);
  await write(proposing, base, [{ path: 'a.js', text: '1' }, { path: 'a.js', remove: true }]);
  await write(proposing, base, [{ path: 'index.html', remove: true }]);
  await write(proposing, base, [{ path: 'gone.js', remove: true }]);
  await write(proposing, base, [{ path: 'index.html', base64: base64(new Uint8Array([0xff, 0xfe])) }]);
  await write(proposing, base, [{ path: 'index.html', text: ' \n\ufeff ' }]);
  await write(proposing, base, [{ path: 'src/main.js', remove: true }, { path: 'models/hero.glb', remove: true }]);
  // A change that is staged: page, code and model written, a file removed, and zirbel.json making it a net game.
  const staged = await write(proposing, base, [
    { path: 'index.html', text: '\ufeff  <!doctype html><script type="module" src="./src/game.js"></script>\n' },
    { path: 'src/game.js', text: 'import * as THREE from "three"; document.title = THREE.REVISION;' },
    { path: 'src/main.js', remove: true },
    { path: 'models/hero.glb', base64: base64(new Uint8Array([1, 2, 3])) },
    { path: 'zirbel.json', text: '{ "players": { "min": 1, "max": 8 } }' },
  ], '  Move the code  ');
  const proposalId = staged.value!.proposal.id;
  await tool(proposing, 'preview_proposal', { proposalId });
  await tool(proposing, 'apply_proposal', { proposalId });
  const applied = await tool<{ revision: { id: string } }>(writing, 'apply_proposal', { proposalId });
  for (const path of ['index.html', 'src/game.js', 'zirbel.json', 'models/hero.glb']) await tool(proposing, 'read_file', { path });
  await tool(proposing, 'read_file', { path: 'src/main.js' });
  await tool(proposing, 'read_file', { path: 'src/main.js', revision: base });
  await write(proposing, base, [{ path: 'late.js', text: '1' }]);
  await tool(proposing, 'propose', { proposal: { baseRevision: applied.value!.revision.id, branch: 'main', label: 'One page',
    operations: [{ op: 'writeGame', game: { html: '<p>one</p>' } }] } });

  // A project with no game yet: write_files starts one with its index.html.
  const empty = await api<{ id: string; branches: { main: string } }>('/api/projects', { title: 'Empty' });
  const fresh = await grant(empty.id, false);
  await write(fresh, empty.branches.main, [{ path: 'a.js', text: '1' }]);
  await write(fresh, empty.branches.main, [{ path: 'index.html', text: '<p>new</p>' }, { path: 'style.css', text: 'p{}' }]);
  await tool(fresh, 'read_file', { path: 'index.html' });

  // A folder of 1000 files besides index.html takes no more.
  const full = await api<{ id: string; branches: { main: string } }>('/api/projects/import-game', { files: {
    'index.html': base64('<p>full</p>'), ...Object.fromEntries(Array.from({ length: 1000 }, (_, index) => ['f' + index + '.txt', base64('x')])),
  } });
  const crowded = await grant(full.id, false);
  await write(crowded, full.branches.main, [{ path: 'extra.txt', text: 'x' }]);
  await write(crowded, full.branches.main, [{ path: 'f1.txt', text: 'y' }]);
  return { steps, guides };
}

// Generated IDs, dates and secrets differ per run; replace them by first appearance, walking object keys in sorted
// order, also inside a tool's JSON answer.
function normalizer() {
  const ids = new Map<string, string>();
  const text = (value: string) => value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{40}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, '<id' + ids.size + '>');
      return ids.get(id)!;
    })
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<date>');
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, walk((value as Record<string, unknown>)[key])]));
    return value;
  };
  return (step: Step) => ({ status: step.status, body: walk(step.body) });
}

const results = new Map<string, Awaited<ReturnType<typeof session>>>();

for (const host of hosts) {
  test(host.name + ' MCP server runs the scripted session', async (t) => {
    const { ready } = launch(t, host.command, ['--data', join(tempDir(t, 'zirbel-mcp-'), 'data'), '--port', '0', '--enable-mcp'],
      (line) => typeof line.editor === 'string' ? line.editor : undefined);
    const result = await session(await ready);
    for (const [index, step] of result.steps.entries()) assert.equal(step.status, 200, 'step ' + index + ': ' + JSON.stringify(step.body));
    // Every guide is the build's file, byte for byte.
    for (const { uri, name } of guideResources) assert.equal(result.guides.get(uri), readFileSync('dist/web/mcp-guides/' + name + '.md', 'utf8'), uri);
    results.set(host.name, result);
  });
}

if (hosts.length > 1) {
  test('both MCP servers answer the session identically', () => {
    const node = results.get('node')!.steps.map(normalizer());
    const go = results.get('go')!.steps.map(normalizer());
    assert.equal(go.length, node.length);
    for (const [index, step] of node.entries()) assert.deepEqual(go[index], step, 'step ' + index);
  });
}
