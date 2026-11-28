// The editor contract's scripted session, which runs against each host, and the client it calls the editor API with:
// projects, proposals, scenes, imports, releases, rooms, MCP and refusals.
import { readFileSync } from 'node:fs';
import { rights } from './helpers.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export type Step = { status: number; body: unknown };

export function client(editor: string) {
  // raw sends JSON text that JSON.stringify cannot produce, such as duplicate keys or 2.0.
  const call = async (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Step> => {
    const sent = raw ?? (payload === undefined ? undefined : JSON.stringify(payload));
    // An empty origin means "send none" (MCP clients are not browsers).
    const merged: Record<string, string> = { origin: editor, ...(sent === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
    if (merged.origin === '') delete merged.origin;
    const response = await fetch(editor + path, { method, headers: merged, body: sent ?? null });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body };
  };
  return { get: (path: string) => call('GET', path), post: (path: string, payload: unknown = {}) => call('POST', path, payload),
    raw: (path: string, text: string) => call('POST', path, undefined, {}, text), call };
}

export async function session(editor: string) {
  const { get, post, raw, call } = client(editor);
  const steps: Step[] = [];
  const record = async (step: Promise<Step>) => { const result = await step; steps.push(result); return result; };
  const body = <T>(step: Step) => step.body as T;

  await record(get('/api/projects'));
  const created = body<{ id: string; branches: { main: string } }>(await record(post('/api/projects', { title: 'Parity' })));
  const id = created.id;
  const proposed = body<{ proposal: { id: string } }>(await record(post('/api/projects/' + id + '/proposals', {
    baseRevision: created.branches.main, branch: 'main', label: '  Write the game  ',
    operations: [{ op: 'writeGame', game: { html: '\ufeff  <!doctype html><canvas></canvas>  ', maxPlayers: 2 } }],
  })));
  await record(get('/api/projects/' + id + '/proposals?branch=main'));
  await record(get('/api/projects/' + id + '/proposals/' + proposed.proposal.id));
  const applied = body<{ revision: { id: string } }>(await record(post('/api/projects/' + id + '/apply/' + proposed.proposal.id)));
  const second = body<{ proposal: { id: string } }>(await record(post('/api/projects/' + id + '/proposals', {
    baseRevision: applied.revision.id, branch: 'main', label: 'Discard me',
    operations: [{ op: 'writeGame', game: { html: '<p>no</p>' } }],
  })));
  await record(post('/api/projects/' + id + '/discard/' + second.proposal.id));
  await record(post('/api/projects/' + id + '/title', { title: '  Renamed  ' }));
  await record(post('/api/projects/' + id + '/notes', { text: '  hello  ', branch: 'main', references: [], attachments: [] }));
  const restored = body<{ branches: { main: string } }>(await record(post('/api/projects/' + id + '/restore',
    { branch: 'main', baseRevision: applied.revision.id, target: created.branches.main })));
  const current = body<{ branches: { main: string } }>(await record(post('/api/projects/' + id + '/restore',
    { branch: 'main', baseRevision: restored.branches.main, target: applied.revision.id }))).branches.main;
  await record(get('/api/projects/' + id));

  // Bodies are read as Zod reads them: a missing key takes its default; null, "" or a wrong type is refused.
  for (const title of [null, '', '\ufeff', 5]) await record(post('/api/projects', { title }));
  // A new project's first commit is named by what it holds and the second it is made in (AGENTS.md: The git store), like
  // the first project's: the next ones start a second of their own, so on either host they are commits of their own.
  await new Promise((done) => setTimeout(done, 1005 - (Date.now() % 1000)));
  await record(post('/api/projects', {}));
  // Zod counts code points: 41 emoji are 82 UTF-16 units but fit 80.
  const emoji = body<{ id: string }>(await record(post('/api/projects', { title: '😀'.repeat(41) })));
  const list = await get('/api/projects');
  steps.push({ status: list.status, body: (list.body as unknown[]).length });
  await record(get('/api/projects/' + emoji.id));
  // Last duplicate key wins, 2.0 is an integer, and the label is trimmed before its 120-character limit.
  const duplicate = body<{ proposal: { id: string } }>(await record(raw('/api/projects/' + id + '/proposals',
    '{"baseRevision":"' + current + '","branch":"main","label":"' + 'L'.repeat(118) + '      ","operations":[{"op":"writeGame",' +
    '"game":{"html":"<p>a</p>","maxPlayers":99},"game":{"html":"<p>b</p>","maxPlayers":2.0}}]}')));
  for (const fork of ['', null, 'Bad']) await record(post('/api/projects/' + id + '/apply/' + duplicate.proposal.id, { fork }));
  await record(post('/api/projects/' + id + '/discard/' + duplicate.proposal.id));
  for (const input of [{ permissions: {} }, { permissions: { ...rights, play: 'yes' } }, { branch: '', permissions: rights },
    { baseRevision: null, permissions: rights }, { branch: 'main' }]) await record(post('/api/projects/' + id + '/release', input));
  for (const input of [{ proposalId: '' }, { branch: null }, null]) await record(post('/api/projects/' + id + '/playtest', input));
  await record(post('/api/projects/' + id + '/restore', { branch: null, baseRevision: current, target: current }));
  // Asset sources follow Zod's url check: trimmed, and parsed like new URL().
  const upload = (source: string) => post('/api/projects/' + id + '/asset', { branch: 'main', baseRevision: current, name: 'Dot',
    author: 'Me', source, license: 'CC0-1.0', credit: '', media: 'image/png', data: png });
  await record(upload('https://'));
  const asset = body<{ proposal: { id: string } }>(await record(upload(' https://example.com/50%off.png ')));
  await record(post('/api/projects/' + id + '/apply/' + asset.proposal.id));

  // A built-in scene project: every scene operation.
  const bundle = JSON.parse(readFileSync('test/fixtures/firefly-fen.zirbel-project.json', 'utf8')) as unknown;
  const legacy = body<{ id: string; branches: { main: string }; revisions: { scene?: { id: string } }[] }>(
    await record(post('/api/projects/import', bundle)));
  const sceneOps = body<{ proposal: { id: string } }>(await record(post('/api/projects/' + legacy.id + '/proposals', {
    baseRevision: legacy.branches.main, branch: 'main', label: 'Rearrange',
    operations: [
      { op: 'background', color: '#112233' },
      { op: 'add', object: { id: 'stone', kind: 'rock', name: '  Stone ', x: 10, y: 20, size: 30, color: '#808080' } },
      { op: 'update', id: 'campfire', changes: { x: 450.5, name: ' Fire ' } },
      { op: 'remove', id: 'footbridge' },
    ],
  })));
  await record(post('/api/projects/' + legacy.id + '/apply/' + sceneOps.proposal.id, { fork: 'variant' }));
  await record(get('/api/projects/' + legacy.id));
  await record(post('/api/projects/' + legacy.id + '/proposals', { baseRevision: legacy.branches.main, branch: 'main', label: 'Clash',
    operations: [{ op: 'remove', id: 'no-such-object' }] }));
  // An update needs a change; numbers read as JavaScript reads them (5.0 is an integer, -0 is 0).
  await record(post('/api/projects/' + legacy.id + '/proposals', { baseRevision: legacy.branches.main, branch: 'main', label: 'Nothing',
    operations: [{ op: 'update', id: 'campfire', changes: {} }] }));
  await record(get('/api/projects/' + legacy.id + '/proposals?branch=main'));
  await record(raw('/api/projects/' + legacy.id + '/proposals', '{"baseRevision":"' + legacy.branches.main + '","branch":"main",' +
    '"label":"Numbers","operations":[{"op":"update","id":"campfire","changes":{"health":5.0,"x":-0}}]}'));
  // Region references must stay inside the 960 by 600 world.
  const region = (bounds: object) => post('/api/projects/' + legacy.id + '/notes', { text: 'Here', branch: 'main', attachments: [],
    references: [{ type: 'region', sceneId: legacy.revisions[0]!.scene!.id, revision: legacy.branches.main, bounds, objects: [] }] });
  await record(region({ x: 900, y: 500, width: 900, height: 500 }));
  await record(region({ x: 0, y: 0, width: 960, height: 600 }));

  const exported = await record(get('/api/projects/' + id + '/export'));
  await record(post('/api/projects/import', exported.body));
  const manifest = body<{ releaseId: string }>(await record(post('/api/projects/' + id + '/release',
    { branch: 'main', permissions: { play: true, download: true, remix: true } })));
  await record(get('/api/releases'));
  const release = await record(get('/api/releases/' + manifest.releaseId + '/download'));
  await record(post('/api/releases/' + manifest.releaseId + '/remix'));
  const room = body<{ id: string }>(await record(post('/api/rooms', { releaseId: manifest.releaseId, lan: false })));
  await record(get('/api/rooms'));
  await record(get('/api/rooms/' + room.id + '/link'));
  await record(post('/api/rooms/' + room.id + '/close'));
  await record(post('/api/projects/' + id + '/playtest', { branch: 'main' }));
  await record(post('/api/releases/' + manifest.releaseId + '/play'));
  // After the release list, whose order each host takes from its directory listing.
  const template = body<{ releaseId: string }>(await record(post('/api/projects/' + legacy.id + '/release', { branch: 'main', permissions: rights })));
  const templateRelease = await record(get('/api/releases/' + template.releaseId + '/download'));

  // MCP with a proposal-only grant, then a revoked one.
  const grant = body<{ id: string; token: string }>(await record(post('/api/projects/' + id + '/grants', { write: false, hours: 1 })));
  await record(get('/api/projects/' + id + '/grants'));
  const mcp = (message: object, token = grant.token) => call('POST', '/mcp', message, { authorization: 'Bearer ' + token, origin: '' });
  await record(mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  await record(mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  await record(mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_scene', arguments: {} } }));
  await record(mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_revisions', arguments: {} } }));
  const head = body<{ branches: { main: string } }>(await get('/api/projects/' + id)).branches.main;
  const staged = await record(mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'propose',
    arguments: { proposal: { baseRevision: head, branch: 'main', label: 'From MCP', operations: [{ op: 'writeGame', game: { html: '<p>mcp</p>' } }] } } } }));
  const stagedText = (staged.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
  const stagedId = (JSON.parse(stagedText) as { proposal: { id: string } }).proposal.id;
  await record(mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'apply_proposal', arguments: { proposalId: stagedId } } }));
  await record(mcp({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'ui://zirbel/scene' } }));
  await record(mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await record(mcp({ jsonrpc: '2.0', id: 8, method: 'nope' }));
  await record(post('/api/projects/' + id + '/grants/' + grant.id));
  await record(mcp({ jsonrpc: '2.0', id: 9, method: 'ping' }));

  // A built folder imports as a game: its files ride along in the release, and proposals cannot rewrite it.
  const encode = (text: string) => Buffer.from(text).toString('base64');
  const folder = { 'index.html': encode('<!doctype html><script type="module" src="./assets/main.js"></script>'),
    'assets/main.js': encode('document.body.append("built")'), 'fonts/face.woff2': encode('wOF2') };
  await record(post('/api/projects/import-game', { files: { 'assets/main.js': folder['assets/main.js'] } }));
  await record(post('/api/projects/import-game', { files: { ...folder, '.hidden/x.js': encode('x') } }));
  const built = body<{ id: string; branches: { main: string } }>(await record(post('/api/projects/import-game', { title: 'Built', files: folder })));
  await record(post('/api/projects/' + built.id + '/proposals', { baseRevision: built.branches.main, branch: 'main', label: 'Edit',
    operations: [{ op: 'writeGame', game: { html: '<p>replaced</p>' } }] }));
  const builtManifest = body<{ releaseId: string }>(await record(post('/api/projects/' + built.id + '/release', { branch: 'main', permissions: rights })));
  const builtRelease = await record(get('/api/releases/' + builtManifest.releaseId + '/download'));
  // A net game's zirbel.json names its adapter, one of its scripts; anything else leaves it without one, and a proposal can't name one.
  const described = (multiplayer: unknown) => ({ ...folder, 'net/adapter.mjs': encode('export {}'),
    'zirbel.json': encode(JSON.stringify({ players: { max: 3 }, multiplayer })) });
  for (const multiplayer of [{ adapter: 'net/missing.js' }, { adapter: 'fonts/face.woff2' }, { adapter: 5 }, 'net/adapter.mjs'])
    await record(post('/api/projects/import-game', { files: described(multiplayer) }));
  const net = body<{ id: string; branches: { main: string } }>(await record(post('/api/projects/import-game',
    { title: 'Net', files: described({ adapter: 'net/adapter.mjs' }) })));
  await record(post('/api/projects/' + net.id + '/proposals', { baseRevision: net.branches.main, branch: 'main', label: 'Adapter',
    operations: [{ op: 'writeGame', game: { html: '<p>net</p>', maxPlayers: 3, net: true, adapter: 'net/adapter.mjs' } }] }));
  const netManifest = body<{ releaseId: string }>(await record(post('/api/projects/' + net.id + '/release', { branch: 'main', permissions: rights })));
  const netRelease = await record(get('/api/releases/' + netManifest.releaseId + '/download'));
  // Any game's zirbel.json may give gamepad inputs keyboard keys (controls.keys), and each place its own keys, name and
  // colour (controls.players), which its release keeps; anything but known inputs with codes leaves it without keys, any
  // place that isn't right without players, and a proposal can't set them.
  const keyed = (controls: unknown, players?: number) => ({ ...folder,
    'zirbel.json': encode(JSON.stringify({ ...(players ? { players: { max: players } } : {}), controls })) });
  for (const controls of [{ keys: { a: 'Space', jump: 'KeyW' } }, { keys: { a: 'Space bar' } }, { keys: { a: 32 } }, { keys: {} },
    { keys: ['Space'] }, { keys: 'Space' }, 'keys', { keys: { a: 'A'.repeat(25) } }])
    await record(post('/api/projects/import-game', { files: keyed(controls) }));
  await record(post('/api/projects/import-game', { files: keyed({ keys: { up: 'KeyW', a: 'Space' } }, 4) }));
  for (const players of [[], Array(9).fill({}), [{ name: '' }], [{ name: 'n'.repeat(25) }], [{ color: 'red' }], [{ keys: {} }], [null],
    [{ name: '\u{1F697}'.repeat(12), color: '#A0b0C0', wheels: 4 }, {}], [{ name: '\u{1F697}'.repeat(13) }]])
    await record(post('/api/projects/import-game', { files: keyed({ players }) }));
  const keys = body<{ id: string; branches: { main: string } }>(await record(post('/api/projects/import-game',
    { title: 'Keys', files: keyed({ keys: { start: 'Enter', a: 'Space', up: 'ArrowUp', left: 'KeyA', b: 'ShiftLeft' },
      players: [{ name: 'Red car', keys: { up: 'KeyW', a: 'KeyF' }, color: '#d03030' }, { color: '#3050d0' }] }) })));
  await record(post('/api/projects/' + keys.id + '/proposals', { baseRevision: keys.branches.main, branch: 'main', label: 'Keys',
    operations: [{ op: 'writeGame', game: { html: '<p>keys</p>', controls: { keys: { a: 'KeyX' } } } }] }));
  const keysManifest = body<{ releaseId: string }>(await record(post('/api/projects/' + keys.id + '/release', { branch: 'main', permissions: rights })));
  const keysRelease = await record(get('/api/releases/' + keysManifest.releaseId + '/download'));

  // Refusals.
  await record(call('POST', '/api/projects', {}, { origin: 'http://evil.example' }));
  await record(call('POST', '/api/projects', undefined, { 'content-type': 'text/plain' }));
  await record(get('/api/nothing-here'));
  await record(get('/api/projects/no-such-project'));
  await record(post('/api/projects/' + id + '/remove'));
  await record(get('/api/projects/' + id));
  return { steps, release: release.body, templateRelease: templateRelease.body, builtRelease: builtRelease.body, netRelease: netRelease.body,
    keysRelease: keysRelease.body };
}
