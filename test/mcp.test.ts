import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { legacyScene } from '../packages/sdk/contracts.ts';
import { head } from '../packages/core/projects.ts';
import { Mcp } from '../packages/server/mcp.ts';
import { guideResources, instructions, readGuides } from '../packages/server/mcp-guides.ts';
import { legacyProject, install, tempDir } from './helpers.ts';

test('the project MCP grant can stage and preview a proposal, and revocation acts immediately', (t) => {
  const { projects } = install(t);
  const a = legacyProject(projects, 'blank', 'Private');
  const b = legacyProject(projects, 'blank', 'Other');
  const mcp = new Mcp(projects, readGuides('dist/web'));
  const issued = mcp.create({ projectId: a.id, hours: 1, write: false });
  const credential = 'Bearer ' + issued.token;
  const payload = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
  const call = (name: string, args: object) => mcp.handle({ ...payload, params: { name, arguments: args } }, credential) as {
    result: { isError?: boolean; content: [{ text: string }] };
  };
  assert.equal(JSON.parse(call('read_project', {}).result.content[0].text).id, a.id);
  const uri = 'ui://zirbel/scene';
  const catalogue = mcp.handle({ ...payload, method: 'tools/list' }, credential) as {
    result: { tools: { name: string; _meta: { ui: { resourceUri?: string; visibility: string[] } } }[] };
  };
  assert.deepEqual(catalogue.result.tools.filter(tool => tool._meta.ui.visibility.includes('app')).map(tool => [tool.name, tool._meta.ui.resourceUri]), [['read_scene', uri]]);
  assert.deepEqual(mcp.handle({ ...payload, method: 'resources/list' }, credential), {
    jsonrpc: '2.0', id: 1, result: { resources: [...guideResources, { uri, name: 'Scene', mimeType: 'text/html;profile=mcp-app' }] },
  });
  const resource = { ...payload, method: 'resources/read', params: { uri } };
  const html = mcp.handle(resource, credential) as { result: { contents: { uri: string; text: string }[] } };
  const [content] = html.result.contents;
  assert.ok(content);
  assert.equal(content.uri, uri);
  assert.match(content.text, /ui\/notifications\/tool-result/);
  assert.equal(JSON.parse(call('read_scene', { branch: 'main' }).result.content[0].text).id, head(a, 'main').id);
  assert.equal(legacyScene(head(b, 'main')).background, '#20342c');
  const created = call('propose', { proposal: { branch: 'main', baseRevision: head(a, 'main').id,
    label: 'Background', operations: [{ op: 'background', color: '#445566' }] } });
  const { proposal } = JSON.parse(created.result.content[0].text);
  assert.equal(JSON.parse(call('preview_proposal', { proposalId: proposal.id }).result.content[0].text).preview.scene.background, '#445566');
  assert.equal(call('apply_proposal', { proposalId: proposal.id }).result.isError, true);
  assert.equal(call('read_scene', { branch: 'main', unexpected: true }).result.isError, true);
  mcp.revoke(a.id, issued.id);
  assert.throws(() => call('read_project', {}), /current project grant/);
  assert.throws(() => mcp.handle(resource, credential), /current project grant/);
});

test('project MCP grants can write source and reuse only project-approved asset metadata', (t) => {
  const { projects } = install(t);
  const project = projects.createGame('Custom');
  const mcp = new Mcp(projects, readGuides('dist/web'));
  const grant = mcp.create({ projectId: project.id, hours: 1, write: true });
  const propose = (operations: unknown[]) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'propose', arguments: { proposal: { branch: 'main', baseRevision: head(project, 'main').id, label: 'Edit', operations } } },
  }, 'Bearer ' + grant.token) as { result: { isError?: boolean } };
  assert.ok(!propose([{ op: 'writeGame', game: { html: '<p>Independent</p>' } }]).result.isError);
  const asset = { id: 'new', hash: 'a'.repeat(64), media: 'image/png', name: 'Art', license: 'CC0-1.0',
    author: 'Artist', credit: '', source: 'https://example.org/art' };
  assert.equal(propose([{ op: 'addAsset', asset }]).result.isError, true);
});

test('an agent learns at initialize what its grant allows, and reads every guide as the build has it', (t) => {
  const { projects } = install(t);
  const project = projects.createGame('Guided');
  const mcp = new Mcp(projects, readGuides('dist/web'));
  const proposing = 'Bearer ' + mcp.create({ projectId: project.id, hours: 1, write: false }).token;
  const writing = 'Bearer ' + mcp.create({ projectId: project.id, hours: 1, write: true }).token;
  type Reply = { result?: { instructions?: string; contents?: { uri: string; mimeType: string; text: string }[] }; error?: object };
  const send = (method: string, credential: string, params?: object) =>
    mcp.handle({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, credential) as Reply;
  assert.equal(send('initialize', proposing).result?.instructions, instructions.propose);
  assert.equal(send('initialize', writing).result?.instructions, instructions.write);
  assert.match(instructions.propose, /waits in the editor/);
  assert.match(instructions.write, /apply_proposal/);
  for (const text of Object.values(instructions)) {
    for (const { uri } of guideResources.slice(0, 4)) assert.ok(text.includes(uri), uri);
  }

  assert.deepEqual(guideResources.map(({ uri }) => uri), ['overview', 'game-format', 'files', 'revisions', 'multiplayer', 'net-api']
    .map((name) => 'zirbel://guide/' + name));
  for (const guide of guideResources) {
    const [content] = send('resources/read', proposing, { uri: guide.uri }).result?.contents ?? [];
    assert.deepEqual(content, { uri: guide.uri, mimeType: 'text/markdown',
      text: readFileSync('dist/web/mcp-guides/' + guide.name + '.md', 'utf8') });
  }
  // The multiplayer guide is the skill as it is, then how to follow it here; the API guide is the net module's.
  const guide = readGuides('dist/web');
  const skill = readFileSync('skills/zirbel-multiplayer/SKILL.md', 'utf8');
  assert.equal(guide.get('zirbel://guide/multiplayer'), skill + '\n' + readFileSync('packages/server/guides/multiplayer.md', 'utf8'));
  assert.match(guide.get('zirbel://guide/multiplayer')!.slice(skill.length), /zirbel:\/\/guide\/net-api/);
  for (const name of ['overview', 'game-format', 'files', 'revisions', 'net-api'])
    assert.equal(guide.get('zirbel://guide/' + name), readFileSync('packages/server/guides/' + name + '.md', 'utf8'));
  for (const uri of ['zirbel://guide/nope', 'zirbel://guide/', 'zirbel://guide/overview.md', 5, undefined])
    assert.deepEqual(send('resources/read', proposing, { uri }), { jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Resource not found.' } });
  assert.throws(() => readGuides(tempDir(t, 'zirbel-no-guides-')), /mcp-guides\/overview\.md; run `pnpm build`/);
});
