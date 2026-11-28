// A project's proposals, for the store's methods: each a commit on refs/zirbel/proposals/<id> with its file in
// proposals/, previewed, discarded, or applied by moving its branch to that commit, compare-and-swap.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { proposalInput, storedProposalInput } from '../sdk/contracts.ts';
import { ZirbelError } from './errors.ts';
import { FastImport, listTree, now as seconds, resolve, updateRefs, ZERO, type Ident } from './git.ts';
import { commitMessage, treeChanges, type Content } from './git-tree.ts';
import { applyOperations } from './operations.ts';
import { atomicWrite, newId, now, readData, safeId, savedProposal, type Proposal } from './project-files.ts';
import { assertCurrent, head, type Projects } from './projects.ts';

const proposalRef = (proposalId: string) => 'refs/zirbel/proposals/' + proposalId;

function proposalPath(projects: Projects, projectId: string, proposalId: string) {
  return join(projects.root, 'proposals', safeId(projectId) + '.' + safeId(proposalId) + '.json');
}

/** Writes content as a commit on a ref, its parent base, keeping what the host doesn't manage of base's tree. */
function write(projects: Projects, repo: string, ref: string, base: string | undefined, next: Content, label: string, author: Ident) {
  const stream = new FastImport();
  const entries = base ? listTree(repo, base) : [];
  const { changes, hashes } = treeChanges(entries, (oid) => projects.history.sha256(repo, oid), next, (hash) => projects.readAsset(hash), stream);
  const mark = stream.commit(ref, { author, time: seconds(), message: commitMessage(label), from: base }, changes);
  const commit = stream.run(repo).get(mark)!;
  projects.history.learn(repo, hashes);
  return commit;
}

/** Stages a proposal. Only the editor's own harness turns stage a game with its files (withFiles). */
export function submitProposal(projects: Projects, projectId: string, input: unknown, withFiles: boolean, author: Ident) {
  const request = (withFiles ? storedProposalInput : proposalInput).parse(input);
  const project = projects.read(projectId);
  const base = assertCurrent(project, request.branch, request.baseRevision);
  if (!project.template && request.operations.some(({ op }) => !['writeGame', 'addAsset', 'removeAsset'].includes(op)))
    throw new ZirbelError(422, 'Edit the game source to change its objects or behavior.');
  // Bounds what a proposal-only MCP grant can stage; it cannot move the head to reset this.
  if (projects.proposals(projectId, request.branch).length >= 50)
    throw new ZirbelError(429, 'Apply or discard pending proposals before staging more.');
  const applied = applyOperations(base, request.operations);
  const proposal = { ...request, id: newId(), projectId, date: now() };
  const repo = projects.repository(projectId);
  const commit = write(projects, repo, proposalRef(proposal.id), base.id, applied, request.label, author);
  atomicWrite(proposalPath(projects, projectId, proposal.id), JSON.stringify(proposal));
  return { proposal, preview: projects.history.content(repo, commit) };
}

/** Writes a proposal's file. */
export function writeProposal(projects: Projects, proposal: Proposal) {
  atomicWrite(proposalPath(projects, proposal.projectId, proposal.id), JSON.stringify(savedProposal.parse(proposal)));
}

/** A proposal's file, which must name its project and itself. */
export function readProposal(projects: Projects, projectId: string, proposalId: string) {
  const saved = savedProposal.parse(readData(proposalPath(projects, projectId, proposalId)));
  if (saved.projectId !== projectId || saved.id !== proposalId)
    throw new ZirbelError(422, 'The stored proposal does not match its project and filename.');
  return saved;
}

/** A branch's pending proposals against its head, oldest first. */
export function listProposals(projects: Projects, projectId: string, branch: string) {
  const base = head(projects.read(projectId), branch);
  return readdirSync(join(projects.root, 'proposals')).filter((file) => file.startsWith(projectId + '.') && file.endsWith('.json')).map((file) =>
    projects.getProposal(projectId, file.slice(projectId.length + 1, -5)),
  ).filter((proposal) => proposal.branch === branch && proposal.baseRevision === base.id).sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

function proposalCommit(projects: Projects, projectId: string, proposalId: string) {
  const commit = resolve(projects.repository(projectId), proposalRef(proposalId));
  if (!commit) throw new ZirbelError(404, 'The requested item does not exist.');
  return commit;
}

/** A proposal with its content, while its base is still its branch's head. */
export function previewProposal(projects: Projects, projectId: string, proposalId: string) {
  const proposal = projects.getProposal(projectId, proposalId);
  assertCurrent(projects.read(projectId), proposal.branch, proposal.baseRevision);
  return { proposal, preview: projects.history.content(projects.repository(projectId), proposalCommit(projects, projectId, proposalId)) };
}

/** Removes a proposal's file and its ref. */
export function discardProposal(projects: Projects, projectId: string, proposalId: string) {
  projects.getProposal(projectId, proposalId);
  rmSync(proposalPath(projects, projectId, proposalId));
  updateRefs(projects.repository(projectId), [{ ref: proposalRef(proposalId) }]);
}

/** Applies a proposal to its branch, or to a new branch, fork. */
export function applyProposal(projects: Projects, projectId: string, proposalId: string, fork?: string) {
  if (fork !== undefined) safeId(fork);
  const { proposal } = projects.preview(projectId, proposalId);
  const current = projects.read(projectId);
  if (fork && Object.hasOwn(current.branches, fork)) throw new ZirbelError(409, 'A branch with that name already exists.');
  const branch = fork ?? proposal.branch;
  const repo = projects.repository(projectId);
  const commit = proposalCommit(projects, projectId, proposalId);
  // The branch moves only from the proposal's base (or a fork from none), with the proposal's ref going in one step.
  if (!updateRefs(repo, [{ ref: 'refs/heads/' + branch, to: commit, from: fork ? ZERO : proposal.baseRevision },
    { ref: proposalRef(proposalId), from: commit }]))
    throw new ZirbelError(409, 'The branch has changed. Request a new proposal against its current revision.');
  rmSync(proposalPath(projects, projectId, proposalId), { force: true });
  return { revision: projects.revision(projectId, commit), branch };
}
