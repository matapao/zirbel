// A game's source elsewhere: a public git repository the host imports a game from, and fetches again to update it.
// The host holds no outside credentials and never pushes outside; it fetches over https alone, with none of the
// person's git settings, within a time and size limit. An update merges the source's commits under the host's own
// (a fast-forward when it has none), and a conflict is reported, never forced. The git store in AGENTS.md is the design.
import { spawn } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { gitRef, id, PORTABLE_FILE_LIMIT } from '../sdk/contracts.ts';
import { ZirbelError } from './errors.ts';
import { commitTree, git, gitEnvironment, initRepository, isAncestor, now, resolve, updateRefs, type Ident } from './git.ts';
import { commitMessage } from './git-tree.ts';
import { assertCurrent, newId, type Projects } from './projects.ts';

/** How long a fetch may take, and how large a repository it may bring. */
const FETCH_MS = 120_000;
const FETCH_BYTES = 4 * PORTABLE_FILE_LIMIT;
const SOURCE = 'refs/zirbel/source';

export const importInput = z.strictObject({ url: z.string().min(1).max(2048), ref: gitRef.optional() });
export const updateInput = z.strictObject({ branch: id.default('main'), baseRevision: id });

/** Tests alone fetch from this computer: file: URLs and http on loopback, while ZIRBEL_GIT_ALLOW_LOCAL=1. */
const local = () => process.env.ZIRBEL_GIT_ALLOW_LOCAL === '1';

/** A source's URL as the host fetches it: https, public (no user name or password), no query or fragment. */
function sourceUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new ZirbelError(400, 'Give the repository’s https:// address.'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const allowed = url.protocol === 'https:' || (local() && (url.protocol === 'file:' || loopback));
  if (!allowed || (url.protocol !== 'file:' && !url.hostname)) throw new ZirbelError(400, 'Give the repository’s https:// address.');
  if (url.username || url.password) throw new ZirbelError(400, 'The host imports public repositories only: give the address without a user name or password.');
  if (url.search || url.hash) throw new ZirbelError(400, 'Give the repository’s address without a query or fragment.');
  return url.href;
}

/** A project's title from its source's address: the last part of its path, without .git. */
function sourceTitle(url: string) {
  const last = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let name = last.replace(/\.git$/, '');
  try { name = decodeURIComponent(name); } catch { /* as it is */ }
  return Array.from(name.trim()).slice(0, 80).join('').trim() || 'Imported game';
}

/** The size of what a repository keeps, in bytes. */
function sizeOf(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const at = join(path, entry.name);
    if (entry.isDirectory()) total += sizeOf(at);
    else if (entry.isFile()) { try { total += statSync(at).size; } catch { /* gone meanwhile */ } }
  }
  return total;
}

/** Fetches a source's branch or tag (its default branch without one) into the repository's refs/zirbel/source: the
 *  commit it fetched. */
async function fetchSource(repo: string, url: string, ref?: string) {
  const protocols = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    ...(local() ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.http.allow=always'] : [])];
  const args = [...protocols, '-c', 'credential.helper=', '-c', 'core.askPass=', '--git-dir=' + repo, 'fetch', '--no-tags',
    '--no-recurse-submodules', '--quiet', '--', url, '+' + (ref ?? 'HEAD') + ':' + SOURCE];
  // No askpass, no terminal: a repository that asks for credentials is refused, as it isn't public.
  const child = spawn('git', args, { env: gitEnvironment(), stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString('utf8')).slice(-2000); });
  let stopped: ZirbelError | undefined;
  const stop = (error: ZirbelError) => { stopped ??= error; child.kill('SIGKILL'); };
  const timer = setTimeout(() => stop(new ZirbelError(504, 'The source took too long to fetch.')), FETCH_MS);
  const watch = setInterval(() => {
    try { if (sizeOf(join(repo, 'objects')) > FETCH_BYTES) stop(new ZirbelError(413, 'The source is larger than a game’s repository can be.')); }
    catch { /* not there yet */ }
  }, 250);
  const code = await new Promise<number | null>((done) => { child.once('close', done); child.once('error', () => done(-1)); });
  clearTimeout(timer);
  clearInterval(watch);
  if (stopped) throw stopped;
  if (code === 0 && sizeOf(join(repo, 'objects')) > FETCH_BYTES) throw new ZirbelError(413, 'The source is larger than a game’s repository can be.');
  if (code !== 0) {
    const reason = errors.split('\n').map((line) => line.replace(/^fatal: /, '').trim()).find(Boolean) ?? 'git could not fetch it';
    throw new ZirbelError(502, 'The source could not be fetched: ' + reason.slice(0, 200));
  }
  const commit = resolve(repo, SOURCE);
  if (!commit) throw new ZirbelError(502, 'The source could not be fetched: it has no commit there.');
  return commit;
}

/** Problems a commit's tree has as a game's head, as a push's check reads them: the first, or none. */
function checkHead(projects: Projects, repo: string, commit: string, scene = false) {
  const { content, problems } = projects.history.read(repo, commit);
  if (problems.length) return problems[0]!;
  if (!content.game && !(scene && content.scene)) return 'There is no index.html at its top: a game needs one.';
  return undefined;
}

/** POST /api/projects/import-git: a new project from a public repository, its history the source's. */
export async function importGit(projects: Projects, raw: unknown) {
  const { url, ref } = importInput.parse(raw);
  const address = sourceUrl(url);
  const projectId = newId();
  const making = projects.repository(projectId) + '.' + newId() + '.importing';
  initRepository(making);
  try {
    const commit = await fetchSource(making, address, ref);
    const problem = checkHead(projects, making, commit);
    if (problem) throw new ZirbelError(422, 'This repository isn’t a game Zirbel can keep. ' + problem);
    updateRefs(making, [{ ref: 'refs/heads/main', to: commit }]);
    return projects.adopt(making, [], { title: sourceTitle(address), source: { url: address, ...(ref ? { ref } : {}) } }, projectId);
  } finally { rmSync(making, { recursive: true, force: true }); }
}

/** POST /api/projects/<id>/update-from-source: the source fetched again and its commits brought under the branch's. */
export async function updateFromSource(projects: Projects, projectId: string, raw: unknown, author: Ident) {
  const { branch, baseRevision } = updateInput.parse(raw);
  const before = projects.read(projectId);
  const { source } = before;
  if (!source) throw new ZirbelError(404, 'This game has no source to update from.');
  assertCurrent(before, branch, baseRevision);
  const repo = projects.repository(projectId);
  const fetched = await fetchSource(repo, sourceUrl(source.url), source.ref);
  const project = projects.read(projectId);
  const current = assertCurrent(project, branch, baseRevision);
  if (isAncestor(repo, fetched, current.id)) return { updated: false, project };
  let next = fetched;
  if (!isAncestor(repo, current.id, fetched)) {
    const merged = git(repo, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', current.id, fetched], { allow: [1, 128] });
    if (merged.status === 128) {
      if (/unrelated histories/.test(merged.stderr))
        throw new ZirbelError(409, 'The source’s history no longer shares a revision with this game’s. Merge it in a clone and push.');
      throw new Error('git merge-tree failed: ' + merged.stderr.trim().slice(0, 400));
    }
    const [tree, ...rest] = merged.stdout.toString('utf8').split('\0');
    if (merged.status === 1) {
      const paths = [...new Set(rest.slice(0, rest.indexOf('') < 0 ? undefined : rest.indexOf('')))];
      throw new ZirbelError(409, 'The source’s changes conflict with this game’s in: ' + paths.slice(0, 8).join(', ') +
        (paths.length > 8 ? ', …' : '') + '. Merge them in a clone and push.');
    }
    next = commitTree(repo, tree!, [current.id, fetched], author, now(), commitMessage('Update from source'));
  }
  const problem = checkHead(projects, repo, next, Boolean(project.template));
  if (problem) throw new ZirbelError(422, 'The updated game isn’t one Zirbel can keep. ' + problem);
  projects.advance(projectId, branch, current.id, next);
  return { updated: true, project: projects.read(projectId) };
}
