import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  attachment, id, note, PORTABLE_FILE_LIMIT, project, proposalInput, scene, sceneReference, type Asset, type Attachment,
  type Note, type Operation, type Project, type Reference, type Revision, type Template,
} from '../sdk/contracts.ts';
import type { GameDocument } from '../sdk/game.ts';
import { starterScene, templates } from '../games/templates.ts';

export class ZirbelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const now = () => new Date().toISOString();
export const newId = () => randomUUID();
export const safeId = (input: unknown) => id.parse(input);

export const savedProposal = proposalInput.extend({ id, projectId: id, date: z.iso.datetime() });
export type Proposal = z.infer<typeof savedProposal>;

export function atomicWrite(path: string, contents: string | Buffer) {
  const temporary = path + '.' + newId() + '.tmp';
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readData(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ZirbelError(404, 'The requested item does not exist.');
    throw error;
  }
}

export function head(project: Project, branch: string) {
  const revisionId = Object.hasOwn(project.branches, branch) ? project.branches[branch] : undefined;
  const revision = project.revisions.find((item) => item.id === revisionId);
  if (!revision) throw new ZirbelError(404, 'Branch does not exist.');
  return revision;
}

export function assertCurrent(project: Project, branch: string, baseRevision: string) {
  const current = head(project, branch);
  if (current.id !== baseRevision) throw new ZirbelError(409, 'The branch has changed. Request a new proposal against its current revision.');
  return current;
}

function applyOperations(base: Pick<Revision, 'scene' | 'assets' | 'game'>, operations: Operation[]) {
  let game = base.game;
  let background = base.scene?.background;
  const objects = new Map((base.scene?.objects ?? []).map((item) => [item.id, { ...item }]));
  const assets = new Map(base.assets.map((asset) => [asset.id, asset]));
  for (const operation of operations) {
    switch (operation.op) {
      case 'writeGame':
        if (game?.files) throw new ZirbelError(422, 'This game was imported as a built folder. Import a new build to change it.');
        game = operation.game;
        break;
      case 'background':
        background = operation.color;
        break;
      case 'add':
        if (objects.has(operation.object.id)) throw new ZirbelError(409, 'An object already uses that ID.');
        objects.set(operation.object.id, operation.object);
        break;
      case 'update': {
        const object = objects.get(operation.id);
        if (!object) throw new ZirbelError(409, 'The target object is missing.');
        objects.set(operation.id, { ...object, ...operation.changes });
        break;
      }
      case 'remove':
        if (!objects.delete(operation.id)) throw new ZirbelError(409, 'The target object is missing.');
        break;
      case 'addAsset':
        if (assets.has(operation.asset.id)) throw new ZirbelError(409, 'An asset already uses that ID.');
        assets.set(operation.asset.id, operation.asset);
        break;
      case 'removeAsset':
        if (!assets.delete(operation.id)) throw new ZirbelError(409, 'The target asset is missing.');
        break;
    }
  }
  if (assets.size > 80) throw new ZirbelError(400, 'A project can reference up to 80 assets.');
  return { game, scene: base.scene && scene.parse({ ...base.scene, background, objects: [...objects.values()] }), assets: [...assets.values()] };
}

function referencesFor(base: Revision, references: Reference[]): Reference[] {
  return references.map((reference) => {
    if (!base.scene || reference.sceneId !== base.scene.id || reference.revision !== base.id)
      throw new ZirbelError(409, 'A selected reference belongs to another revision.');
    if (reference.type === 'instance') {
      const object = base.scene.objects.find((item) => item.id === reference.object.id);
      if (!object) throw new ZirbelError(409, 'A selected object no longer exists.');
      return { ...reference, object };
    }
    const { x, y, width, height } = reference.bounds;
    return { ...reference, objects: base.scene.objects.filter((item) => item.x >= x && item.x <= x + width &&
      item.y >= y && item.y <= y + height) };
  });
}

function isLegacyPreview(project: Project) {
  if (!project.template || project.upstream || project.imported || project.attachments.length || project.revisions.length !== 1) return false;
  const first = project.revisions[0];
  if (!first || first.label !== 'Initial scene' || first.parent !== null || first.assets.length || first.game ||
      !isDeepStrictEqual(first.scene, starterScene(project.template))) return false;
  const builtInTitle = templates[project.template].title;
  const title = project.title;
  if (!project.notes.length) return title === (project.template === 'blank' ? 'Untitled project' : builtInTitle);

  const introduction = project.notes.find(({ role }) => role === 'assistant');
  if (!introduction || introduction.usage || project.notes.length > 2 || project.notes.at(-1) !== introduction) return false;
  return introduction?.text === 'Created a draft of ' + title + '. Say “play it” when you want to try it.' ||
    introduction?.text === 'Created a draft of ' + title + '. Starting a local playtest.' ||
    introduction?.text.startsWith('Created ' + title + '. ' + templates[project.template].description + ' Starting a local playtest.') === true;
}

export const savedNote = note.omit({ id: true, date: true });
export const projectBundle = z.strictObject({ project, assets: z.record(z.string(), z.string()) });
const titleSchema = project.shape.title;

export class Projects {
  constructor(public readonly root: string) {
    for (const name of ['projects', 'proposals', 'assets', 'media', 'releases', 'grants']) {
      mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    }
  }

  private path(projectId: string) { return join(this.root, 'projects', safeId(projectId) + '.json'); }
  private proposalPath(projectId: string, proposalId: string) {
    return join(this.root, 'proposals', safeId(projectId) + '.' + safeId(proposalId) + '.json');
  }

  private *storedProjects() {
    for (const file of readdirSync(join(this.root, 'projects'))) {
      if (file.endsWith('.json')) yield this.read(file.slice(0, -5));
    }
  }

  list() { return [...this.storedProjects()]; }

  summaries() {
    return Array.from(this.storedProjects(), ({ id, title, template, branches }) => ({ id, title, template, branches }));
  }

  archiveLegacyPreviews() {
    const withProposals = new Set(readdirSync(join(this.root, 'proposals')).filter((file) => file.endsWith('.json'))
      .map((file) => file.split('.')[0]));
    const directory = join(this.root, 'archived-preview-projects');
    for (const project of this.storedProjects()) {
      const { id } = project;
      if (withProposals.has(id) || !isLegacyPreview(project)) continue;
      this.moveAside(id, directory);
    }
  }

  read(projectId: string) {
    const saved = project.parse(readData(this.path(projectId)));
    if (saved.id !== projectId) throw new ZirbelError(422, 'The stored project ID does not match its filename.');
    return saved;
  }

  has(projectId: string) { return existsSync(this.path(projectId)); }

  remove(projectId: string) {
    this.read(projectId);
    this.moveAside(projectId, join(this.root, 'removed-projects'));
  }

  private moveAside(projectId: string, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, projectId + '.json');
    renameSync(this.path(projectId), existsSync(path) ? join(directory, projectId + '.' + newId() + '.json') : path);
  }

  private save(value: Project) {
    const saved = project.parse(value);
    atomicWrite(this.path(saved.id), JSON.stringify(saved));
    return saved;
  }

  createGame(title = 'Untitled project', game?: GameDocument) {
    return this.createRevision(title, { game, assets: [], label: game ? 'Created with harness' : 'Created project' });
  }

  createRevision(title: string, initial: { scene?: Revision['scene']; game?: GameDocument; assets: Asset[];
    template?: Template; upstream?: string; label: string }) {
    const { template, upstream } = initial;
    const first: Revision = {
      id: newId(), parent: null, label: initial.label, date: now(),
      game: initial.game, scene: initial.scene, assets: initial.assets,
    };
    return this.save({
      version: 1, id: newId(), title, template, branches: { main: first.id }, revisions: [first],
      notes: [], attachments: [], upstream,
    });
  }

  rename(projectId: string, title: string) {
    const current = this.read(projectId);
    return this.save({ ...current, title: titleSchema.parse(title) });
  }

  submit(projectId: string, input: unknown) {
    const request = proposalInput.parse(input);
    const project = this.read(projectId);
    const base = assertCurrent(project, request.branch, request.baseRevision);
    if (!project.template && request.operations.some(({ op }) => !['writeGame', 'addAsset', 'removeAsset'].includes(op)))
      throw new ZirbelError(422, 'Edit the game source to change its objects or behavior.');
    // Bounds what a proposal-only MCP grant can stage; it cannot move the head to reset this.
    if (this.proposals(projectId, request.branch).length >= 50)
      throw new ZirbelError(429, 'Apply or discard pending proposals before staging more.');
    const preview = applyOperations(base, request.operations);
    const proposal = { ...request, id: newId(), projectId, date: now() };
    atomicWrite(this.proposalPath(projectId, proposal.id), JSON.stringify(proposal));
    return { proposal, preview };
  }

  getProposal(projectId: string, proposalId: string) {
    const saved = savedProposal.parse(readData(this.proposalPath(projectId, proposalId)));
    if (saved.projectId !== projectId || saved.id !== proposalId)
      throw new ZirbelError(422, 'The stored proposal does not match its project and filename.');
    return saved;
  }

  proposals(projectId: string, branch: string) {
    const base = head(this.read(projectId), branch);
    return readdirSync(join(this.root, 'proposals')).filter((file) => file.startsWith(projectId + '.') && file.endsWith('.json')).map((file) =>
      this.getProposal(projectId, file.slice(projectId.length + 1, -5)),
    ).filter((proposal) => proposal.branch === branch && proposal.baseRevision === base.id).sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  }

  preview(projectId: string, proposalId: string) {
    const proposal = this.getProposal(projectId, proposalId);
    const base = assertCurrent(this.read(projectId), proposal.branch, proposal.baseRevision);
    return { proposal, preview: applyOperations(base, proposal.operations) };
  }

  discard(projectId: string, proposalId: string) {
    this.getProposal(projectId, proposalId);
    rmSync(this.proposalPath(projectId, proposalId));
  }

  commit(projectId: string, proposalId: string, fork?: string) {
    if (fork !== undefined) safeId(fork);
    const { proposal, preview } = this.preview(projectId, proposalId);
    const current = this.read(projectId);
    if (fork && Object.hasOwn(current.branches, fork)) throw new ZirbelError(409, 'A branch with that name already exists.');
    const branch = fork ?? proposal.branch;
    const next: Revision = { ...preview, id: newId(), date: now(), label: proposal.label, parent: proposal.baseRevision };
    this.save({ ...current, branches: { ...current.branches, [branch]: next.id }, revisions: [...current.revisions, next] });
    // Once the transaction commits the proposal is stale on that branch.
    rmSync(this.proposalPath(projectId, proposalId), { force: true });
    return { revision: next, branch };
  }

  restore(projectId: string, branch: string, baseRevision: string, target: string) {
    const project = this.read(projectId);
    assertCurrent(project, safeId(branch), safeId(baseRevision));
    const earlier = project.revisions.find((item) => item.id === target);
    if (!earlier) throw new ZirbelError(404, 'Revision does not exist.');
    const revision: Revision = {
      ...earlier, id: newId(), date: now(), parent: baseRevision, restoredFrom: earlier.id,
      label: ('Restore ' + earlier.label).slice(0, 120),
    };
    return this.save({ ...project, branches: { ...project.branches, [branch]: revision.id }, revisions: [...project.revisions, revision] });
  }

  addNote(projectId: string, raw: unknown) {
    const input = savedNote.parse(raw);
    const project = this.read(projectId);
    head(project, input.branch);
    const references = input.references.map((reference) => {
      const revision = project.revisions.find((item) => item.id === reference.revision);
      if (!revision) throw new ZirbelError(404, 'Note refers to a missing revision.');
      return referencesFor(revision, [reference])[0]!;
    });
    if (input.attachments.some((id) => !project.attachments.some((item) => item.id === id)))
      throw new ZirbelError(404, 'Note refers to a missing attachment.');
    const next: Note = { ...input, id: newId(), date: now(), references };
    this.save({ ...project, notes: [...project.notes, next] });
    return next;
  }

  select(projectId: string, branch: string, baseRevision: string, raw: unknown) {
    const current = assertCurrent(this.read(projectId), branch, baseRevision);
    return referencesFor(current, z.array(sceneReference).max(32).parse(raw));
  }

  addMedia(projectId: string, metadata: Omit<Attachment, 'id'>, bytes: Buffer) {
    const project = this.read(projectId);
    const item = attachment.parse({ ...metadata, id: newId() });
    if (item.original && !project.attachments.some((media) => media.id === item.original))
      throw new ZirbelError(404, 'The original attachment is missing.');
    atomicWrite(join(this.root, 'media', item.id), bytes);
    this.save({ ...project, attachments: [...project.attachments, item] });
    return item;
  }

  editTranscript(projectId: string, attachmentId: string, transcript: string, intent: Attachment['intent']) {
    const current = this.read(projectId);
    const item = current.attachments.find((candidate) => candidate.id === attachmentId);
    if (!item) throw new ZirbelError(404, 'Attachment does not exist.');
    const next = attachment.parse({ ...item, transcript, intent });
    this.save({ ...current, attachments: current.attachments.map((candidate) => candidate.id === attachmentId ? next : candidate) });
    return next;
  }

  readMedia(projectId: string, attachmentId: string) {
    const item = this.read(projectId).attachments.find((media) => media.id === attachmentId);
    if (!item) throw new ZirbelError(404, 'Attachment does not exist.');
    return { item, bytes: readFileSync(join(this.root, 'media', item.id)) };
  }

  storeAsset(bytes: Buffer) {
    const hash = digest(bytes);
    atomicWrite(join(this.root, 'assets', hash), bytes);
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

  export(projectId: string) {
    const { notes: _notes, attachments: _attachments, ...accepted } = this.read(projectId);
    return this.withAssetFiles({ project: { ...accepted, notes: [], attachments: [] } }, deliveryAssets(accepted.revisions),
      gameFileHashes(accepted.revisions));
  }

  // The package's assets map carries image assets and a built game's files, each once, by hash.
  withAssetFiles<T extends object>(metadata: T, assets: readonly Asset[], gameFiles: readonly string[] = []) {
    let remaining = PORTABLE_FILE_LIMIT - Buffer.byteLength(JSON.stringify({ ...metadata, assets: {} }));
    const files = new Map<string, string>();
    const checkSize = () => {
      if (remaining < 0) throw new ZirbelError(413, 'This package exceeds the 48 MB file limit.');
    };
    checkSize();
    for (const asset of assets) {
      const bytes = this.readAsset(asset.hash);
      verifyAssetBytes(asset, bytes);
      if (files.has(asset.hash)) continue;
      // Base64 length plus the quoted key, quoted value, colon and optional comma.
      remaining -= 4 * Math.ceil(bytes.length / 3) + asset.hash.length + 5 + Number(files.size > 0);
      checkSize();
      files.set(asset.hash, bytes.toString('base64'));
    }
    for (const hash of gameFiles) {
      if (files.has(hash)) continue;
      const bytes = this.readAsset(hash);
      if (digest(bytes) !== hash) throw new ZirbelError(422, 'A game file does not match its hash.');
      remaining -= 4 * Math.ceil(bytes.length / 3) + hash.length + 5 + Number(files.size > 0);
      checkSize();
      files.set(hash, bytes.toString('base64'));
    }
    return { ...metadata, assets: Object.fromEntries(files) };
  }

  import(raw: unknown) {
    const bundle = projectBundle.parse(raw);
    const source = bundle.project;
    const ids = new Set<string>();
    for (const revision of source.revisions) {
      if (source.template && !revision.scene && !revision.game)
        throw new ZirbelError(422, 'The imported legacy revision is missing its scene.');
      const validParent = ids.size === 0 ? revision.parent === null : revision.parent !== null && ids.has(revision.parent);
      if (ids.has(revision.id) || !validParent ||
        (revision.restoredFrom && !ids.has(revision.restoredFrom))) throw new ZirbelError(400, 'Revision history is invalid.');
      ids.add(revision.id);
    }
    if (!source.branches.main || Object.values(source.branches).some((id) => !ids.has(id)))
      throw new ZirbelError(400, 'The imported branches have invalid revisions.');
    const assets = new Map<string, Buffer>();
    for (const item of deliveryAssets(source.revisions)) {
      const data = bundle.assets[item.hash];
      if (typeof data !== 'string') throw new ZirbelError(422, 'An asset file is missing.');
      const bytes = Buffer.from(data, 'base64');
      verifyAssetBytes(item, bytes);
      assets.set(item.hash, bytes);
    }
    for (const hash of gameFileHashes(source.revisions)) assets.set(hash, gameFileBytes(hash, bundle.assets[hash]));
    if (Object.keys(bundle.assets).length !== assets.size) throw new ZirbelError(422, 'The package contains undeclared assets.');
    for (const bytes of assets.values()) this.storeAsset(bytes);
    return this.save({ ...source, id: newId(), notes: [], attachments: [], imported: true });
  }
}

export function mediaMatches(media: string, bytes: Buffer) {
  switch (media) {
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg': return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case 'image/webp': return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    case 'video/mp4': return bytes.toString('ascii', 4, 8) === 'ftyp';
    case 'video/webm': return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    case 'text/plain': return !bytes.includes(0) && !bytes.toString('utf8').includes('\ufffd');
    default: return false;
  }
}

function checkDeliveryRights(asset: Asset) {
  if (asset.license === 'unknown' || asset.license === 'local-only')
    throw new ZirbelError(422, 'Resolve the delivery rights for ' + asset.name + '.');
  if (asset.license !== 'CC0-1.0' && !asset.credit.trim())
    throw new ZirbelError(422, 'Add the required credit for ' + asset.name + '.');
  const source = new URL(asset.source);
  if (source.username || source.password)
    throw new ZirbelError(422, 'Remove account credentials from the source URL for ' + asset.name + '.');
}

// Check every revision's metadata, but process each distinct file only once.
export function deliveryAssets(revisions: ReadonlyArray<Pick<Revision, 'assets'>>) {
  const unique = new Map<string, Asset>();
  for (const { assets } of revisions) {
    for (const asset of assets) {
      checkDeliveryRights(asset);
      const previous = unique.get(asset.hash);
      if (previous && previous.media !== asset.media) throw new ZirbelError(422, 'Conflicting media types for ' + asset.name + '.');
      unique.set(asset.hash, asset);
    }
  }
  return [...unique.values()];
}

// Every file a built game lists, once each.
export function gameFileHashes(revisions: ReadonlyArray<Pick<Revision, 'game'>>) {
  return [...new Set(revisions.flatMap(({ game }) => Object.values(game?.files ?? {})))];
}

// A built game's file carried as base64, which must match its hash.
export function gameFileBytes(hash: string, data: unknown) {
  if (typeof data !== 'string') throw new ZirbelError(422, 'A game file is missing.');
  const bytes = Buffer.from(data, 'base64');
  if (digest(bytes) !== hash) throw new ZirbelError(422, 'A game file does not match its hash.');
  return bytes;
}

export function verifyAssetBytes(asset: Asset, bytes: Buffer) {
  if (digest(bytes) !== asset.hash || !mediaMatches(asset.media, bytes))
    throw new ZirbelError(422, 'The asset bytes do not match ' + asset.name + '.');
}
