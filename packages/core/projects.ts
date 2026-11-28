// The project store. A project is its metadata (projects/<id>.json: title, notes, attachments, where it came from) and
// a bare git repository (git/<id>.git) whose commits are its revisions and whose branches are its branches. Every save
// is a commit: a proposal is one on refs/zirbel/proposals/<id> until it is applied, and applying moves the branch to it,
// compare-and-swap. The git store in AGENTS.md is the design; the Go host follows it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  asset, attachment, project, scene, sceneReference, type Asset, type Attachment, type FullRevision, type Note, type Project,
  type Reference, type Revision, type Template,
} from '../sdk/contracts.ts';
import { gameDocument, type GameDocument } from '../sdk/game.ts';
import { ZirbelError } from './errors.ts';
import { digest, mediaMatches } from './bytes.ts';
import {
  commitTree, FastImport, git, initRepository, now as seconds, OWNER, readBranches, readObjects, resolve, updateRefs, type Ident,
} from './git.ts';
import { ASSETS_JSON, commitMessage, treeChanges } from './git-tree.ts';
import { History } from './history.ts';
import { isLegacyPreview } from './legacy-previews.ts';
import { migrateProject } from './migrate.ts';
import { exportBundle, importBundle, withAssetFiles } from './bundles.ts';
import { referencesFor } from './operations.ts';
import {
  atomicWrite, newId, now, readData, safeId, savedNote, storedProject, titleSchema, type Proposal, type Stored,
} from './project-files.ts';
import {
  applyProposal, discardProposal, listProposals, previewProposal, readProposal, submitProposal, writeProposal,
} from './proposals.ts';

export { ZirbelError, digest, mediaMatches, atomicWrite, newId, readData, safeId, savedNote, storedProject, type Proposal };
export { deliveryAssets, gameFileBytes, gameFileHashes, verifyAssetBytes } from './bundles.ts';
export { projectBundle, savedProposal } from './project-files.ts';

/** A branch's head, which a project lists with its content. */
export function head(project: Pick<Project, 'branches' | 'revisions'>, branch: string): FullRevision {
  const revisionId = Object.hasOwn(project.branches, branch) ? project.branches[branch] : undefined;
  const revision = project.revisions.find((item) => item.id === revisionId);
  if (!revision) throw new ZirbelError(404, 'Branch does not exist.');
  if (!revision.assets) throw new Error('A branch head was listed without its content.');
  return revision as FullRevision;
}

export function assertCurrent(project: Pick<Project, 'branches' | 'revisions'>, branch: string, baseRevision: string) {
  const current = head(project, branch);
  if (current.id !== baseRevision) throw new ZirbelError(409, 'The branch has changed. Request a new proposal against its current revision.');
  return current;
}

type Meta = Pick<Stored, 'title' | 'template' | 'upstream' | 'imported' | 'source'>;
const content = z.strictObject({ scene: scene.optional(), game: gameDocument.optional(), assets: z.array(asset).max(80) });

export class Projects {
  readonly history: History;
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    for (const name of ['projects', 'proposals', 'assets', 'media', 'releases', 'grants', 'git']) {
      mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    }
    this.history = new History({ hasAsset: (hash) => existsSync(join(root, 'assets', hash)), storeAsset: (bytes) => this.storeAsset(bytes) });
  }

  private path(projectId: string) { return join(this.root, 'projects', safeId(projectId) + '.json'); }
  /** A project's bare repository. */
  repository(projectId: string) { return join(this.root, 'git', safeId(projectId) + '.git'); }

  private ids() { return readdirSync(join(this.root, 'projects')).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)); }

  list() { return this.ids().map((projectId) => this.read(projectId)); }

  summaries() {
    return this.ids().map((projectId) => {
      const { id, title, template } = this.stored(projectId);
      return { id, title, template, branches: readBranches(this.repository(projectId)) };
    });
  }

  /** Moves aside the built-in starters nobody changed, before or after their migration. */
  archiveLegacyPreviews() {
    const withProposals = new Set(readdirSync(join(this.root, 'proposals')).filter((file) => file.endsWith('.json'))
      .map((file) => file.split('.')[0]));
    for (const projectId of this.ids()) {
      if (withProposals.has(projectId)) continue;
      const raw = readData(this.path(projectId)) as { version?: unknown };
      const found = raw.version === 1 ? project.safeParse(raw).data : this.read(projectId);
      if (found && isLegacyPreview(found)) this.moveAside(projectId, join(this.root, 'archived-preview-projects'));
    }
  }

  /** Makes every project still kept as a version-1 file a repository (migrate.ts). Says how many it migrated. */
  migrate() {
    let migrated = 0;
    for (const projectId of this.ids()) {
      const raw = readData(this.path(projectId)) as { version?: unknown };
      if (raw.version !== 1) continue;
      migrateProject(this, project.parse(raw));
      migrated++;
    }
    return migrated;
  }

  private stored(projectId: string): Stored {
    const raw = readData(this.path(projectId)) as { version?: unknown };
    if (raw.version === 1) throw new ZirbelError(503, 'This project is still to be migrated. Start the editor again.');
    const saved = storedProject.parse(raw);
    if (saved.id !== projectId) throw new ZirbelError(422, 'The stored project ID does not match its filename.');
    return saved;
  }

  read(projectId: string): Project {
    const { version: _version, id, title, template, notes, attachments, upstream, imported, source } = this.stored(projectId);
    const repo = this.repository(projectId);
    const branches = readBranches(repo);
    if (!branches.main) throw new ZirbelError(422, 'The project’s repository has no main branch.');
    const heads = new Set(Object.values(branches));
    const revisions: Revision[] = this.history.revisions(repo, branches)
      .map((meta) => heads.has(meta.id) ? { ...meta, ...this.history.content(repo, meta.id) } : meta);
    return { version: 1, id, title, ...(template ? { template } : {}), branches, revisions, notes, attachments,
      ...(upstream ? { upstream } : {}), ...(imported ? { imported } : {}), ...(source ? { source } : {}) };
  }

  has(projectId: string) { return existsSync(this.path(projectId)); }

  remove(projectId: string) {
    this.stored(projectId);
    this.moveAside(projectId, join(this.root, 'removed-projects'));
  }

  private moveAside(projectId: string, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = existsSync(join(directory, projectId + '.json')) ? projectId + '.' + newId() : projectId;
    renameSync(this.path(projectId), join(directory, name + '.json'));
    const repo = this.repository(projectId);
    if (existsSync(repo)) renameSync(repo, join(directory, name + '.git'));
  }

  /** Writes a project's metadata. */
  save(value: Stored) {
    const saved = storedProject.parse(value);
    atomicWrite(this.path(saved.id), JSON.stringify(saved));
    return saved;
  }

  private update(projectId: string, change: (current: Stored) => Stored) {
    this.save(change(this.stored(projectId)));
  }

  createGame(title = 'Untitled project', game?: GameDocument, author: Ident = OWNER) {
    return this.createRevision(title, { game, assets: [], label: game ? 'Created with harness' : 'Created project' }, author);
  }

  createRevision(title: string, initial: { scene?: FullRevision['scene']; game?: GameDocument | undefined; assets: Asset[];
    template?: Template | undefined; upstream?: string; label: string }, author: Ident = OWNER) {
    const { template, upstream } = initial;
    const first = content.parse({ scene: initial.scene, game: initial.game, assets: initial.assets });
    const name = titleSchema.parse(title);
    return this.createRepository((repo) => {
      const stream = new FastImport();
      const { changes, hashes } = treeChanges([], () => undefined, first, (hash) => this.readAsset(hash), stream);
      stream.commit('refs/heads/main', { author, time: seconds(), message: commitMessage(initial.label) }, changes);
      stream.run(repo);
      return hashes;
    }, { title: name, ...(template ? { template } : {}), ...(upstream ? { upstream } : {}) });
  }

  /** A new project whose repository fill writes, made aside and moved in whole; its metadata last. */
  createRepository(fill: (repo: string) => [string, string][], meta: Meta, projectId = newId()) {
    const making = this.repository(projectId) + '.' + newId() + '.making';
    try {
      initRepository(making);
      return this.adopt(making, fill(making), meta, projectId);
    } finally { rmSync(making, { recursive: true, force: true }); }
  }

  /** Makes a repository written aside a new project's: hashes, the SHA-256s of blobs it was written with. */
  adopt(making: string, hashes: [string, string][], meta: Meta, projectId: string) {
    const repo = this.repository(projectId);
    rmSync(repo, { recursive: true, force: true });
    renameSync(making, repo);
    this.history.learn(repo, hashes);
    this.save({ version: 2, id: projectId, ...meta, notes: [], attachments: [] });
    return this.read(projectId);
  }

  rename(projectId: string, title: string) {
    this.update(projectId, (current) => ({ ...current, title: titleSchema.parse(title) }));
    return this.read(projectId);
  }

  /** Stages a proposal (proposals.ts). Only the editor's own harness turns stage a game with its files (withFiles). */
  submit(projectId: string, input: unknown, withFiles = false, author: Ident = OWNER) {
    return submitProposal(this, projectId, input, withFiles, author);
  }

  saveProposal(proposal: Proposal) { writeProposal(this, proposal); }

  getProposal(projectId: string, proposalId: string) { return readProposal(this, projectId, proposalId); }

  proposals(projectId: string, branch: string) { return listProposals(this, projectId, branch); }

  preview(projectId: string, proposalId: string) { return previewProposal(this, projectId, proposalId); }

  discard(projectId: string, proposalId: string) { discardProposal(this, projectId, proposalId); }

  commit(projectId: string, proposalId: string, fork?: string) { return applyProposal(this, projectId, proposalId, fork); }

  /** Moves a branch from base to a commit, or answers that it has moved on. */
  advance(projectId: string, branch: string, base: string, commit: string) {
    if (!updateRefs(this.repository(projectId), [{ ref: 'refs/heads/' + branch, to: commit, from: base }]))
      throw new ZirbelError(409, 'The branch has changed. Request a new proposal against its current revision.');
  }

  restore(projectId: string, branch: string, baseRevision: string, target: string, author: Ident = OWNER) {
    const project = this.read(projectId);
    assertCurrent(project, safeId(branch), safeId(baseRevision));
    const repo = this.repository(projectId);
    const earlier = this.revision(projectId, target);
    const { problems } = this.history.read(repo, earlier.id);
    if (problems.length) throw new ZirbelError(422, 'That revision can’t be restored: ' + problems[0]);
    const message = commitMessage(('Restore ' + earlier.label).slice(0, 120), [['Zirbel-Restored-From', earlier.id]]);
    const restored = commitTree(repo, earlier.id + '^{tree}', [baseRevision], author, seconds(), message);
    this.advance(projectId, branch, baseRevision, restored);
    return this.read(projectId);
  }

  /** A revision of the project's history, in full: a commit reachable from one of its branches. */
  revision(projectId: string, revisionId: string): FullRevision {
    this.stored(projectId);
    const repo = this.repository(projectId);
    const commit = /^[0-9a-f]{40}$/.test(revisionId) ? resolve(repo, revisionId) : undefined;
    const reachable = commit !== undefined && commit === revisionId &&
      git(repo, ['for-each-ref', '--count=1', '--contains', commit, 'refs/heads/']).stdout.length > 0;
    if (!reachable) throw new ZirbelError(404, 'Revision does not exist.');
    return { ...this.history.meta(repo, commit), ...this.history.content(repo, commit) };
  }

  /** Every asset the listed history holds: what an MCP grant may add again. */
  knownAssets(projectId: string) {
    const repo = this.repository(projectId);
    const listed = this.history.revisions(repo, readBranches(repo));
    const files = readObjects(repo, listed.map(({ id }) => id + ':' + ASSETS_JSON));
    return [...files.values()].flatMap((bytes) => {
      try { return z.array(asset).parse(JSON.parse(bytes.toString('utf8'))); } catch { return []; }
    });
  }

  addNote(projectId: string, raw: unknown) {
    const input = savedNote.parse(raw);
    const project = this.read(projectId);
    head(project, input.branch);
    const references = input.references.map((reference) => {
      let revision: FullRevision;
      try { revision = this.revision(projectId, reference.revision); }
      catch { throw new ZirbelError(404, 'Note refers to a missing revision.'); }
      return referencesFor(revision, [reference])[0]!;
    });
    if (input.attachments.some((id) => !project.attachments.some((item) => item.id === id)))
      throw new ZirbelError(404, 'Note refers to a missing attachment.');
    const next: Note = { ...input, id: newId(), date: now(), references };
    this.update(projectId, (current) => ({ ...current, notes: [...current.notes, next] }));
    return next;
  }

  select(projectId: string, branch: string, baseRevision: string, raw: unknown): Reference[] {
    const current = assertCurrent(this.read(projectId), branch, baseRevision);
    return referencesFor(current, z.array(sceneReference).max(32).parse(raw));
  }

  addMedia(projectId: string, metadata: Omit<Attachment, 'id'>, bytes: Buffer) {
    const project = this.stored(projectId);
    const item = attachment.parse({ ...metadata, id: newId() });
    if (item.original && !project.attachments.some((media) => media.id === item.original))
      throw new ZirbelError(404, 'The original attachment is missing.');
    atomicWrite(join(this.root, 'media', item.id), bytes);
    this.save({ ...project, attachments: [...project.attachments, item] });
    return item;
  }

  editTranscript(projectId: string, attachmentId: string, transcript: string, intent: Attachment['intent']) {
    const current = this.stored(projectId);
    const item = current.attachments.find((candidate) => candidate.id === attachmentId);
    if (!item) throw new ZirbelError(404, 'Attachment does not exist.');
    const next = attachment.parse({ ...item, transcript, intent });
    this.save({ ...current, attachments: current.attachments.map((candidate) => candidate.id === attachmentId ? next : candidate) });
    return next;
  }

  readMedia(projectId: string, attachmentId: string) {
    const item = this.stored(projectId).attachments.find((media) => media.id === attachmentId);
    if (!item) throw new ZirbelError(404, 'Attachment does not exist.');
    return { item, bytes: readFileSync(join(this.root, 'media', item.id)) };
  }

  storeAsset(bytes: Buffer) {
    const hash = digest(bytes);
    const path = join(this.root, 'assets', hash);
    if (!existsSync(path)) atomicWrite(path, bytes);
    return hash;
  }

  readAsset(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ZirbelError(400, 'Invalid asset hash.');
    try { return readFileSync(join(this.root, 'assets', hash)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ZirbelError(422, 'An asset file is missing.');
      throw error;
    }
  }

  /** A bundle of the project (bundles.ts). */
  export(projectId: string) { return exportBundle(this, projectId); }

  /** A package's metadata with the bytes of its assets and game files (bundles.ts). */
  withAssetFiles<T extends object>(metadata: T, assets: readonly Asset[], gameFiles: readonly string[] = []) {
    return withAssetFiles((hash) => this.readAsset(hash), metadata, assets, gameFiles);
  }

  /** A new project from a bundle (bundles.ts). */
  import(raw: unknown, author?: Ident) { return importBundle(this, raw, author); }
}
