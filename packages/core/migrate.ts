// Revisions kept in full, as a version-1 project file or a bundle holds them, written as commits: one per revision in
// order, its parent its parent's commit, its date as the commit's. A project still kept as a version-1 file becomes a
// repository at the editor's start, its pending proposals commits of their own; the version-2 file written last is
// the migration's commit point, so a start that finds a version-1 file again does it all again, to the same commits.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FullRevision, ProjectBundle } from '../sdk/contracts.ts';
import { COMMITTER, FastImport, ident, initRepository, updateRefs, type Ident } from './git.ts';
import { commitMessage, treeChanges } from './git-tree.ts';
import { applyOperations } from './operations.ts';
import type { Projects } from './projects.ts';

const IMPORTING = 'refs/zirbel/import';
const secondsOf = (date: string) => Math.floor(Date.parse(date) / 1000);

/** Writes revisions as commits: each old id's commit, and the SHA-256s of the blobs written. author: who made them
 *  all (a bundle's own author names otherwise, then Zirbel); trailer: whether each names its old id. A restore's
 *  target must be written before its trailer can name it, so the revisions go in runs that end before a restore. */
export function writeRevisions(
  repo: string,
  revisions: FullRevision[],
  read: (hash: string) => Buffer,
  author?: Ident,
  trailer = false,
) {
  const commits = new Map<string, string>();
  const hashes: [string, string][] = [];
  let index = 0;
  while (index < revisions.length) {
    const stream = new FastImport();
    const marks = new Map<string, string>();
    for (; index < revisions.length; index++) {
      const revision = revisions[index]!;
      // A restore of a revision written in this stretch waits for the next, which can name its commit; one of a
      // revision the project doesn't have (a damaged file) is written without the trailer instead of never.
      if (revision.restoredFrom && !commits.has(revision.restoredFrom) && marks.has(revision.restoredFrom)) break;
      const from = revision.parent ? (marks.get(revision.parent) ?? commits.get(revision.parent)) : undefined;
      if (!from) stream.reset(IMPORTING);
      const written = treeChanges([], () => undefined, revision, read, stream);
      hashes.push(...written.hashes);
      const trailers: [string, string][] = [
        ...(revision.restoredFrom && commits.has(revision.restoredFrom)
          ? [['Zirbel-Restored-From', commits.get(revision.restoredFrom)!] as [string, string]]
          : []),
        ...(trailer ? [['Zirbel-Revision', revision.id] as [string, string]] : []),
      ];
      const by = author ?? (revision.author ? ident(revision.author, COMMITTER.email) : COMMITTER);
      marks.set(
        revision.id,
        stream.commit(
          IMPORTING,
          { author: by, time: secondsOf(revision.date), message: commitMessage(revision.label, trailers), from },
          ['deleteall', ...written.changes],
        ),
      );
    }
    const ids = stream.run(repo);
    for (const [old, mark] of marks) commits.set(old, ids.get(mark)!);
  }
  updateRefs(repo, [{ ref: IMPORTING }]);
  return { commits, hashes };
}

/** Makes a version-1 project a repository and a version-2 file, keeping the old file in migrated-projects/. */
export function migrateProject(projects: Projects, old: ProjectBundle) {
  const { root } = projects;
  const aside = join(root, 'migrated-projects');
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  if (!existsSync(join(aside, old.id + '.json')))
    copyFileSync(join(root, 'projects', old.id + '.json'), join(aside, old.id + '.json'));
  const read = (hash: string) => projects.readAsset(hash);
  const repo = projects.repository(old.id);
  const making = repo + '.migrating';
  initRepository(making);
  const { commits, hashes } = writeRevisions(making, old.revisions, read, COMMITTER, true);
  updateRefs(
    making,
    Object.entries(old.branches).map(([branch, revision]) => ({
      ref: 'refs/heads/' + branch,
      to: commits.get(revision)!,
    })),
  );

  // Pending proposals: each a commit on its own ref, its base the new commit (also when a migration ran before).
  const mapped = new Map([...commits].map(([oldId, commit]) => [commit, oldId]));
  const pending = readdirSync(join(root, 'proposals'))
    .filter((file) => file.startsWith(old.id + '.') && file.endsWith('.json'))
    .flatMap((file) => {
      try {
        return [projects.getProposal(old.id, file.slice(old.id.length + 1, -5))];
      } catch {
        return [];
      }
    });
  const stream = new FastImport();
  const rebased = [];
  for (const proposal of pending) {
    const baseId = mapped.get(proposal.baseRevision) ?? proposal.baseRevision;
    const base = old.revisions.find(({ id }) => id === baseId);
    const commit = commits.get(baseId);
    if (!base || !commit) continue;
    let applied;
    try {
      applied = applyOperations(base, proposal.operations);
    } catch {
      continue;
    }
    const written = treeChanges([], () => undefined, applied, read, stream);
    hashes.push(...written.hashes);
    stream.commit(
      'refs/zirbel/proposals/' + proposal.id,
      { author: COMMITTER, time: secondsOf(proposal.date), message: commitMessage(proposal.label), from: commit },
      ['deleteall', ...written.changes],
    );
    rebased.push({ ...proposal, baseRevision: commit });
  }
  if (rebased.length) stream.run(making);
  rmSync(repo, { recursive: true, force: true });
  renameSync(making, repo);
  projects.history.learn(repo, hashes);
  for (const proposal of rebased) projects.saveProposal(proposal);

  const notes = old.notes.map((note) => ({
    ...note,
    references: note.references.map((reference) => ({
      ...reference,
      revision: commits.get(reference.revision) ?? reference.revision,
    })),
  }));
  const { id, title, template, attachments, upstream, imported } = old;
  projects.save({
    version: 2,
    id,
    title,
    ...(template ? { template } : {}),
    notes,
    attachments,
    ...(upstream ? { upstream } : {}),
    ...(imported ? { imported } : {}),
  });
}
