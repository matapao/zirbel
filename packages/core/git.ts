// The git program, as the host runs it: with none of the system's or the person's settings (credential helpers,
// insteadOf, hooks), no prompts, and plain C messages. Everything is plumbing: ls-tree and cat-file to read, fast-import
// to write, update-ref --stdin to move refs, each move compare-and-swap. The git store in AGENTS.md is the design.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';

/** The oldest git the host runs on: merge-tree --write-tree came in 2.38. */
const GIT_MINIMUM = [2, 38] as const;
export const ZERO = '0'.repeat(40);
const commitId = /^[0-9a-f]{40}$/;
const isCommitId = (value: string) => commitId.test(value);

export type Ident = { name: string; email: string };
export const COMMITTER: Ident = { name: 'Zirbel', email: 'zirbel@zirbel.invalid' };
export const OWNER: Ident = { name: 'Owner', email: 'owner@zirbel.invalid' };

/** A name as an ident takes it: no angle brackets, control characters or surrounding space, at most 120 code points. */
export function identName(name: string, fallback = 'Unknown') {
  // oxlint-disable-next-line no-control-regex -- control characters are what a name in a commit loses
  const plain = Array.from(name.replace(/[<>\u0000-\u001f\u007f]/g, '').trim())
    .slice(0, 120)
    .join('')
    .trim();
  return plain || fallback;
}
export const ident = (name: string, email: string): Ident => ({ name: identName(name), email });

/** What every git the host runs starts from; extra adds to it (a hook's quarantine, CGI variables). */
export function gitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ELECTRON_RUN_AS_NODE']) {
    const value = process.env[key];
    if (value) kept[key] = value;
  }
  return {
    ...kept,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    LC_ALL: 'C',
    ...extra,
  };
}

/** Runs git on a repository and waits: its output, or a 500 with git's own words in the log. allow: exit codes that
 *  are answers (1 for "no"), not failures. */
export function git(
  repo: string,
  args: string[],
  options: { input?: Buffer | string; allow?: number[]; env?: Record<string, string> | undefined } = {},
) {
  const result = spawnSync('git', ['--git-dir=' + repo, ...args], {
    input: options.input,
    env: options.env ?? gitEnvironment(),
    maxBuffer: 1 << 30,
    windowsHide: true,
  });
  if (result.error) throw new Error('git could not run: ' + result.error.message);
  const status = result.status ?? -1;
  if (status !== 0 && !options.allow?.includes(status))
    throw new Error('git ' + args[0] + ' failed: ' + result.stderr.toString('utf8').trim().slice(0, 400));
  return { status, stdout: result.stdout, stderr: result.stderr.toString('utf8') };
}

/** The git program's version, or undefined when there is none. */
function gitVersion() {
  const result = spawnSync('git', ['--version'], { env: gitEnvironment(), encoding: 'utf8', windowsHide: true });
  const match = /git version (\d+)\.(\d+)/.exec(result.stdout ?? '');
  return match ? { text: result.stdout.trim(), major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

/** Refuses to go on without git, or with one older than GIT_MINIMUM. */
export function requireGit() {
  const version = gitVersion();
  const [major, minor] = GIT_MINIMUM;
  if (version && (version.major > major || (version.major === major && version.minor >= minor))) return;
  throw new Error(
    'Zirbel needs git ' +
      major +
      '.' +
      minor +
      " or later to keep its games' history (found " +
      (version?.text ?? 'no git') +
      '). Install git and start Zirbel again.',
  );
}

/** A blob's id, as git names it: SHA-1 of its header and bytes. */
export const blobId = (bytes: Buffer) =>
  createHash('sha1')
    .update('blob ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');

/** A new bare repository whose HEAD is main, its objects named by SHA-1 whatever git's default is. */
export function initRepository(repo: string) {
  rmSync(repo, { recursive: true, force: true });
  const result = spawnSync('git', ['init', '--bare', '--quiet', '--object-format=sha1', repo], {
    env: gitEnvironment(),
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('git init failed: ' + result.stderr.toString('utf8').trim());
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

/** A repository's branches by their names and commits, read from its ref files: a loose ref over a packed one. Names
 *  that aren't ids are left out. A repository with reftable is asked instead. */
export function readBranches(repo: string): Record<string, string> {
  const name = /^[a-z0-9][a-z0-9_-]{0,79}$/;
  const branches: Record<string, string> = {};
  if (existsSync(join(repo, 'reftable'))) {
    const listed = git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/']).stdout.toString(
      'utf8',
    );
    for (const line of listed.split('\n')) {
      const [oid, ref] = line.split(' ');
      const branch = ref?.slice('refs/heads/'.length);
      if (oid && branch && ref?.startsWith('refs/heads/') && name.test(branch) && isCommitId(oid))
        branches[branch] = oid;
    }
    return branches;
  }
  try {
    for (const line of readFileSync(join(repo, 'packed-refs'), 'utf8').split('\n')) {
      const match = /^([0-9a-f]{40}) refs\/heads\/([^\s]+)$/.exec(line);
      if (match && name.test(match[2]!)) branches[match[2]!] = match[1]!;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let loose: string[] = [];
  try {
    loose = readdirSync(join(repo, 'refs', 'heads'));
  } catch {
    /* none yet */
  }
  for (const branch of loose) {
    if (!name.test(branch)) continue;
    let text = '';
    try {
      text = readFileSync(join(repo, 'refs', 'heads', branch), 'utf8').trim();
    } catch {
      continue;
    }
    if (isCommitId(text)) branches[branch] = text;
  }
  return Object.fromEntries(Object.entries(branches).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** One entry of a commit's tree, recursively: mode, type, object id, size (blobs) and path. */
export type Entry = { mode: string; type: string; oid: string; size: number; path: string };

/** A commit's (or tree's) every entry, at any depth. env: a hook's quarantine. */
export function listTree(repo: string, treeish: string, env?: Record<string, string>): Entry[] {
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', '-l', treeish], { env }).stdout.toString('utf8');
  const entries: Entry[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid, size] = record.slice(0, tab).split(/ +/);
    entries.push({
      mode: mode!,
      type: type!,
      oid: oid!,
      size: size === '-' ? 0 : Number(size),
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

/** Objects' contents by id, in one cat-file run. A missing object is left out. */
export function readObjects(repo: string, oids: readonly string[], env?: Record<string, string>) {
  const found = new Map<string, Buffer>();
  const wanted = [...new Set(oids)];
  if (!wanted.length) return found;
  const out = git(repo, ['cat-file', '--batch'], { input: wanted.join('\n') + '\n', env }).stdout;
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(10, at);
    const header = out.toString('utf8', at, end).split(' ');
    at = end + 1;
    if (header[1] === 'missing' || header.length < 3) continue;
    const size = Number(header[2]);
    found.set(header[0]!, out.subarray(at, at + size));
    at += size + 1;
  }
  return found;
}

/** A commit as its metadata: tree, parents, author's name, committer time (seconds) and message. */
export type CommitInfo = { id: string; tree: string; parents: string[]; author: string; time: number; message: string };

export function parseCommit(id: string, raw: Buffer): CommitInfo {
  const text = raw.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const info: CommitInfo = {
    id,
    tree: '',
    parents: [],
    author: '',
    time: 0,
    message: split < 0 ? '' : text.slice(split + 2),
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) info.author = line.slice(7).replace(/ <[^>]*> -?\d+ [+-]\d{4}$/, '');
    else if (line.startsWith('committer ')) info.time = Number(/ (-?\d+) [+-]\d{4}$/.exec(line)?.[1] ?? 0);
  }
  return info;
}

/** A ref's commit, or undefined. */
export function resolve(repo: string, ref: string, env?: Record<string, string>) {
  const out = git(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allow: [1], env });
  const oid = out.stdout.toString('utf8').trim();
  return out.status === 0 && isCommitId(oid) ? oid : undefined;
}

export function isAncestor(repo: string, ancestor: string, descendant: string, env?: Record<string, string>) {
  return git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], { allow: [1], env }).status === 0;
}

/** Moves refs in one transaction: each update names the value it expects (ZERO: none yet), so nothing moves when one
 *  of them has moved on. Says whether it went through. */
export function updateRefs(repo: string, updates: { ref: string; to?: string; from?: string }[]) {
  const lines = updates.map(
    ({ ref, to, from }) => (to === undefined ? 'delete ' + ref : 'update ' + ref + ' ' + to) + (from ? ' ' + from : ''),
  );
  const out = git(repo, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n', allow: [128] });
  if (out.status === 0) return true;
  if (/cannot lock ref|is at .* but expected|reference already exists|unable to resolve reference/.test(out.stderr))
    return false;
  throw new Error('git update-ref failed: ' + out.stderr.trim().slice(0, 400));
}

/** A commit of an existing tree, its parents in order: its id. */
export function commitTree(
  repo: string,
  tree: string,
  parents: string[],
  author: Ident,
  time: number,
  message: string,
) {
  const stamp = time + ' +0000';
  const env = gitEnvironment({
    GIT_AUTHOR_NAME: identName(author.name),
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
    GIT_COMMITTER_DATE: stamp,
  });
  const out = git(repo, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'], {
    input: message,
    env,
  });
  return out.stdout.toString('utf8').trim();
}

/** Seconds since 1970, as a commit's date. */
export const now = () => Math.floor(Date.now() / 1000);

/** A git fast-import stream, built in memory: blobs by mark, commits with their changes. */
export class FastImport {
  private readonly chunks: Buffer[] = [Buffer.from('feature done\n')];
  private readonly blobs = new Map<string, string>();
  private marks = 0;

  /** A mark for a blob of these bytes, written once however often it is asked for. */
  blob(bytes: Buffer) {
    const oid = blobId(bytes);
    const known = this.blobs.get(oid);
    if (known) return known;
    const mark = ':' + ++this.marks;
    this.blobs.set(oid, mark);
    this.chunks.push(Buffer.from('blob\nmark ' + mark + '\ndata ' + bytes.length + '\n'), bytes, Buffer.from('\n'));
    return mark;
  }

  /** A commit on ref. changes: 'deleteall', ['M', mode, blob mark or id, path] or ['D', path]. Its mark. */
  commit(
    ref: string,
    info: { author: Ident; time: number; message: string; from?: string | undefined; merge?: string[] },
    changes: Array<'deleteall' | ['M', string, string, string] | ['D', string]>,
  ) {
    const mark = ':' + ++this.marks;
    const message = Buffer.from(info.message);
    const who = (person: Ident) => identName(person.name) + ' <' + person.email + '> ' + info.time + ' +0000';
    const lines = [
      'commit ' + ref,
      'mark ' + mark,
      'author ' + who(info.author),
      'committer ' + who(COMMITTER),
      'data ' + message.length,
    ];
    this.chunks.push(Buffer.from(lines.join('\n') + '\n'), message, Buffer.from('\n'));
    const tail: string[] = [];
    if (info.from) tail.push('from ' + info.from);
    for (const parent of info.merge ?? []) tail.push('merge ' + parent);
    for (const change of changes) {
      if (change === 'deleteall') tail.push('deleteall');
      else if (change[0] === 'M') tail.push('M ' + change[1] + ' ' + change[2] + ' ' + quotePath(change[3]));
      else tail.push('D ' + quotePath(change[1]));
    }
    this.chunks.push(Buffer.from(tail.join('\n') + (tail.length ? '\n' : '') + '\n'));
    return mark;
  }

  /** A ref set to a mark or commit, or with none, so that the next commit on it is a root. */
  reset(ref: string, to?: string) {
    this.chunks.push(Buffer.from('reset ' + ref + '\n' + (to ? 'from ' + to + '\n' : '') + '\n'));
  }

  /** Runs the stream: each mark's object id. */
  run(repo: string) {
    const marks = join(repo, 'zirbel-marks-' + process.pid + '-' + Date.now());
    try {
      // --force: a stretch of a migration may move the import ref to a commit that isn't a descendant (a branch forked
      // from an earlier revision), which is the point of the ref there.
      git(repo, ['fast-import', '--quiet', '--force', '--export-marks=' + marks], {
        input: Buffer.concat([...this.chunks, Buffer.from('done\n')]),
      });
      const ids = new Map<string, string>();
      for (const line of readFileSync(marks, 'utf8').split('\n')) {
        const [mark, oid] = line.split(' ');
        if (mark && oid) ids.set(mark, oid);
      }
      return ids;
    } finally {
      rmSync(marks, { force: true });
    }
  }
}

/** A path as fast-import takes it: quoted when it must be. */
function quotePath(path: string) {
  if (!/^["\s]|[\n"\\]/.test(path)) return path;
  return JSON.stringify(path);
}
