// The host's pre-receive hook (`node dist/server.mjs git-hook pre-receive`), which git runs for every push before any
// ref moves: each update must be to a branch named as an id, no deletion, a fast-forward of a branch that exists (a
// project grant's push makes no new one), and end at a commit whose tree holds a game a host can keep (a scene
// project: a game or a scene), read under the rules every host applies (git-tree.ts). It reads the pushed objects in
// receive-pack's quarantine, so a refused push leaves nothing behind; the reason goes to stderr, which the client
// shows. The git store in AGENTS.md is the design.
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { id } from '../sdk/contracts.ts';
import { gitEnvironment, isAncestor, listTree, readObjects, ZERO } from '../core/git.ts';
import { readTree } from '../core/git-tree.ts';
import { checkAssets } from '../core/history.ts';

/** The environment receive-pack gives its hooks: the repository and its quarantine. */
function quarantine() {
  const kept: Record<string, string> = {};
  for (const key of ['GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) {
    const value = process.env[key];
    if (value) kept[key] = value;
  }
  return gitEnvironment(kept);
}

/** Why an update can't be taken, or nothing when it can. grant: a project grant pushes, which makes no branch. */
function refuseUpdate(repo: string, update: string, scene: boolean, env?: Record<string, string>, grant = false) {
  const [from, to, ref] = update.split(' ');
  const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  if (!from || !to || !branch || !id.safeParse(branch).success)
    return (ref ?? 'That ref') + ': Zirbel takes branches alone, named in lowercase letters, digits, - and _.';
  if (to === ZERO) return branch + ': a branch isn’t deleted by a push.';
  if (from === ZERO && grant) return branch + ': a project grant pushes to the game’s branches, and makes none.';
  if (from !== ZERO && !isAncestor(repo, from, to, env))
    return branch + ': it has moved on. Pull, then push again (history isn’t rewritten).';
  const bytes = (oids: string[]) => readObjects(repo, oids, env);
  const { content, problems } = readTree(listTree(repo, to, env), {
    bytes,
    sha256: (entries) => new Map(entries.map(({ oid }) => [oid, '0'.repeat(64)])),
    assets: (found) => checkAssets(found, bytes),
  });
  if (problems.length) return branch + ': this isn’t a game Zirbel can keep. ' + problems[0];
  if (!content.game && !(scene && content.scene))
    return branch + ': there is no index.html at its top: a game needs one.';
  return undefined;
}

async function run() {
  const env = quarantine();
  const repo = resolvePath(process.env.GIT_DIR ?? '.');
  const projectId = basename(repo).replace(/\.git$/, '');
  let scene = false;
  try {
    const stored = JSON.parse(readFileSync(join(dirname(dirname(repo)), 'projects', projectId + '.json'), 'utf8')) as {
      template?: unknown;
    };
    scene = typeof stored.template === 'string';
  } catch {
    /* a game */
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const updates = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
  for (const update of updates) {
    const refused = refuseUpdate(repo, update, scene, env, process.env.ZIRBEL_GIT_GRANT === '1');
    if (refused) {
      process.stderr.write(refused + '\n');
      process.exitCode = 1;
      return;
    }
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(
    'Zirbel could not check this push: ' + (error instanceof Error ? error.message : String(error)) + '\n',
  );
  process.exitCode = 1;
}
