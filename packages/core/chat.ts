import { chatControl } from '../sdk/chat-control.ts';
import type { GameDocument } from '../sdk/game.ts';
import type { ChatUsage, Project, Revision } from '../sdk/contracts.ts';
import type { Projects, Proposal } from './projects.ts';
import type { Ident } from './git.ts';

/** Where a turn's reply lands. proposalId: a change staged for review, which the thread shows as a card. */
export type ChatReply = {
  projectId: string;
  branch: string;
  proposalId?: string;
};

/** author: who sent the message, whose undo is theirs. */
type Request = { text: string; branch: string; proposalId?: string | undefined; author?: Ident | undefined };
type Draft = { title?: string | undefined; game: GameDocument };

function wantsReview(text: string) {
  return /^(?:please\s+)?(?:propose|preview|suggest)\b|\b(?:show|give|offer|compare|prepare)\b[^.!?]{0,70}\b(?:options|alternatives)\b|\bbefore applying\b/i.test(text);
}

export function finishChatEdit(projects: Projects, proposal: Proposal, text: string, message: string, usage?: ChatUsage): ChatReply {
  const context = { projectId: proposal.projectId, branch: proposal.branch };
  const review = wantsReview(text);
  if (!review) projects.commit(proposal.projectId, proposal.id);
  projects.addNote(proposal.projectId, { text: message + (review ? ' Compare it before and after, then apply or discard it.' : ' Saved as a new revision.'),
    branch: proposal.branch, role: 'assistant', references: [], attachments: [], usage });
  return review ? { ...context, proposalId: proposal.id } : context;
}

export function applyChatControl(projects: Projects, project: Project, base: Revision, request: Request, usage?: ChatUsage): ChatReply | undefined {
  const { text, branch } = request;
  const context = { projectId: project.id, branch };
  const say = (message: string) => projects.addNote(project.id,
    { text: message, branch, role: 'assistant', references: [], attachments: [], usage });
  const control = chatControl(text);
  if (!control) return undefined;
  if (control.action === 'undo') {
    if (!base.parent) { say('This is the first revision. There’s nothing to undo yet.'); return context; }
    projects.restore(project.id, branch, base.id, base.parent, request.author);
    say('Restored the previous revision.');
    return context;
  }
  const options = projects.proposals(project.id, branch);
  const proposal = control.index !== undefined ? options[control.index] :
    options.find((item) => item.id === request.proposalId) ?? (options.length === 1 ? options[0] : undefined);
  if (!proposal) {
    say(options.length ? 'Tell me which option to use, for example “apply option 2”.' : 'There are no pending changes to apply or discard.');
    return context;
  }
  if (control.action === 'discard') { projects.discard(project.id, proposal.id); say('Discarded that proposal.'); return context; }
  projects.commit(project.id, proposal.id);
  say('Saved a new revision.');
  return context;
}

export function startFromChat(projects: Projects, draft: Draft, text: string, message: string, usage?: ChatUsage,
  history: ReadonlyArray<{ role: 'creator' | 'assistant'; text: string; usage?: ChatUsage | undefined }> = [], author?: Ident,
): ChatReply {
  const newProject = projects.createGame(draft.title, draft.game, author);
  for (const note of history) projects.addNote(newProject.id, { ...note, branch: 'main', references: [], attachments: [] });
  projects.addNote(newProject.id, { text, branch: 'main', role: 'creator', references: [], attachments: [] });
  projects.addNote(newProject.id, { text: message, branch: 'main', role: 'assistant', references: [], attachments: [], usage });
  return { projectId: newProject.id, branch: 'main' };
}
