// Git over HTTP on a box (--box), on both hosts (AGENTS.md: The git store): the box itself clones and pushes every game; from
// its network a git client needs a paired device's git token (every game), an editor's (its game alone), or a project
// grant while external MCP access is on (its game; pushing with a write grant alone), and a token ends with its device
// or editor. The editor shows each device its own token in the clone command.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { client, writeFiles } from './git-fixtures.ts';
import { hostsUnderTest, launch, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();
const lan = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4' &&
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
if (!lan) console.log('# No private network address: git on a box is checked from loopback only.');
const base64 = (text: string) => Buffer.from(text).toString('base64');

async function startBox(t: TestContext, command: string[], root: string) {
  const account = join(root, 'account');
  mkdirSync(account, { mode: 0o700 });
  mkdirSync(join(root, 'run'));
  const { ready } = launch(t, command, ['--data', join(root, 'data'), '--port', '0', '--player-port', '0', '--box'],
    (line) => typeof line.editor === 'string' ? line.editor : undefined,
    { ZIRBEL_ACCOUNT_DIR: account, ZIRBEL_SETUP_REQUEST: join(root, 'run', 'request'), ZIRBEL_OWN_NETWORK: join(root, 'own-network.json') });
  return ready;
}

/** A call's request body: its JSON, else its form, else none. */
function requestBody(json: unknown, form: Record<string, string> | undefined) {
  if (json !== undefined) return JSON.stringify(json);
  return form ? new URLSearchParams(form) : null;
}

/** The editor's API as a device calls it: its session (an owner's) or editor's cookie, and its Origin. */
function api(base: string) {
  return async <T>(method: string, path: string, options: { json?: unknown; form?: Record<string, string>; session?: string; editor?: string } = {}) => {
    const cookies = [...(options.session ? ['zirbel_session=' + options.session] : []), ...(options.editor ? ['zirbel_editor=' + options.editor] : [])];
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { origin: base,
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}), ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: requestBody(options.json, options.form) });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* a page */ }
    return { status: response.status, body: body as T, cookie: response.headers.getSetCookie().join('\n'), headers: response.headers };
  };
}

for (const host of hosts) {
  test(host.name + ' box serves git by role and token', async (t) => {
    const root = tempDir(t, 'zirbel-git-box-');
    const base = await startBox(t, host.command, root);
    const box = api(base);
    const folder = { 'index.html': '<p>box</p>', 'game.js': 'x' };
    const game = (await box<{ id: string }>('POST', '/api/projects/import-game', { json: { title: 'Box game',
      files: Object.fromEntries(Object.entries(folder).map(([path, text]) => [path, base64(text)])) } })).body;
    const other = (await box<{ id: string }>('POST', '/api/projects', { json: { title: 'Other' } })).body;
    const work = join(root, 'work');
    mkdirSync(work);
    const git = client(work);
    // The box itself: every game, no credentials; and the clone command it shows has none.
    const local = (await box<{ url: string; command: string; token?: string }>('GET', '/api/projects/' + game.id + '/clone')).body;
    assert.deepEqual(local, { url: base + '/git/' + game.id + '.git', command: 'git clone ' + base + '/git/' + game.id + '.git' });
    git.run('ls-remote', local.url);
    if (!lan) return;

    const at = base.replace('127.0.0.1', lan);
    const device = api(at);
    const repo = (id: string, token?: string) => at.replace('http://', 'http://' + (token ? 'zirbel:' + token + '@' : '')) + '/git/' + id + '.git';
    // From the network, nothing without credentials: a Basic challenge.
    const challenge = await fetch(repo(game.id) + '/info/refs?service=git-upload-pack');
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get('www-authenticate'), 'Basic realm="Zirbel", charset="UTF-8"');
    assert.match(git.refused('ls-remote', repo(game.id)), /could not read Username|Authentication failed/);
    assert.match(git.refused('ls-remote', repo(game.id, 'o.00000000-0000-4000-8000-000000000000.' + 'A'.repeat(43))), /Authentication failed/);

    // A paired device: its token in the clone command, for every game, cloning and pushing.
    const claimed = await device('POST', '/pair', { form: { claim: '1' } });
    const session = /zirbel_session=([\w-]{43})/.exec(claimed.cookie)![1]!;
    const owned = (await device<{ url: string; command: string; token: string }>('GET', '/api/projects/' + game.id + '/clone', { session })).body;
    assert.match(owned.token, /^o\.[0-9a-f-]{36}\.[\w-]{43}$/);
    assert.deepEqual(owned, { url: repo(game.id), command: 'git clone ' + repo(game.id, owned.token), token: owned.token });
    git.run('clone', '--quiet', repo(game.id, owned.token), 'owned');
    const push = (name: string, files: Record<string, string>, ...args: string[]) => {
      const copy = client(join(work, name));
      writeFiles(join(work, name), files);
      copy.run('commit', '--quiet', '-am', 'Change ' + Object.keys(files).join(' '));
      return copy.run(...args, 'push', '--quiet', 'origin', 'main');
    };
    push('owned', { 'game.js': 'owner' });
    git.run('ls-remote', repo(other.id, owned.token));

    // An editor of one game: its token reaches that game alone.
    const { code } = (await device<{ code: string }>('POST', '/api/projects/' + game.id + '/edit-code', { session })).body;
    const redeemed = await device('POST', '/edit', { form: { code, name: 'Ada' } });
    const editor = /zirbel_editor=([\w-]{43})/.exec(redeemed.cookie)![1]!;
    const edits = (await device<{ token: string }>('GET', '/api/projects/' + game.id + '/clone', { editor })).body;
    assert.match(edits.token, /^e\.[0-9a-f-]{36}\.[\w-]{43}$/);
    assert.equal((await device('GET', '/api/projects/' + other.id + '/clone', { editor })).status, 403);
    git.run('clone', '--quiet', repo(game.id, edits.token), 'edits');
    push('edits', { 'game.js': 'editor' });
    assert.match(git.refused('ls-remote', repo(other.id, edits.token)), /403/);

    // A project grant: off while external MCP access is; then its game, fetching, and pushing with a write grant.
    const grant = async (write: boolean) => (await box<{ token: string }>('POST', '/api/projects/' + game.id + '/grants', { json: { write, hours: 1 } })).body.token;
    await box('PUT', '/api/box/settings', { json: { externalMcp: true } });
    const reading = await grant(false), writing = await grant(true);
    const bearer = (token: string) => ['-c', 'http.extraHeader=Authorization: Bearer ' + token];
    git.run(...bearer(reading), 'clone', '--quiet', repo(game.id), 'granted');
    let readOnly = 'pushed';
    try { push('granted', { 'game.js': 'read grant' }, ...bearer(reading)); } catch (error) { readOnly = String((error as { stderr?: string }).stderr); }
    assert.match(readOnly, /403/);
    client(join(work, 'granted')).run('reset', '--quiet', '--hard', 'origin/main');
    push('granted', { 'game.js': 'write grant' }, ...bearer(writing));
    assert.match(client(join(work, 'granted')).refused(...bearer(writing), 'push', 'origin', 'HEAD:grant-branch'), /makes none/);
    git.run('ls-remote', repo(game.id, writing));
    assert.match(git.refused(...bearer(reading), 'ls-remote', repo(other.id)), /403/);
    await box('PUT', '/api/box/settings', { json: { externalMcp: false } });
    assert.match(git.refused(...bearer(reading), 'ls-remote', repo(game.id)), /403/);

    // Every push went in, by its own author, and the game is what was pushed last.
    const project = (await box<{ branches: { main: string }; revisions: { label: string; author: string; game?: { files?: Record<string, string> } }[] }>(
      'GET', '/api/projects/' + game.id)).body;
    assert.deepEqual(project.revisions.map(({ label, author }) => [label, author]), [['Imported game folder', 'Owner'],
      ['Change game.js', 'Tester'], ['Change game.js', 'Tester'], ['Change game.js', 'Tester']]);

    // A token ends with its device, or its editor.
    const devices = (await device<{ devices: { id: string; current: boolean }[] }>('GET', '/api/pairing/devices', { session })).body.devices;
    const { editors } = (await device<{ editors: { id: string }[] }>('GET', '/api/projects/' + game.id + '/editors', { session })).body;
    await device('DELETE', '/api/projects/' + game.id + '/editors/' + editors[0]!.id, { session });
    assert.match(git.refused('ls-remote', repo(game.id, edits.token)), /Authentication failed/);
    await box('DELETE', '/api/pairing/devices/' + devices.find((item) => item.current)!.id);
    assert.match(git.refused('ls-remote', repo(game.id, owned.token)), /Authentication failed/);
  });
}
