import { chatControl, requestsPlay } from '../sdk/chat-control.ts';
import type { GameDocument } from '../sdk/game.ts';
import type { ChatUsage, Project, Revision } from '../sdk/contracts.ts';
import type { Projects, Proposal } from './projects.ts';

const replyModes = ['edit', 'review', 'play'] as const;
export type ChatReply = {
  projectId: string;
  branch: string;
  mode?: typeof replyModes[number];
  proposalId?: string;
};

type Request = { text: string; branch: string; proposalId?: string; playing?: boolean };
type Draft = { title?: string; game: GameDocument };

function wantsReview(text: string) {
  return /^(?:please\s+)?(?:propose|preview|suggest)\b|\b(?:show|give|offer|compare|prepare)\b[^.!?]{0,70}\b(?:options|alternatives)\b|\bbefore applying\b/i.test(text);
}

export function finishChatEdit(projects: Projects, proposal: Proposal, text: string, playing: boolean, message: string, usage?: ChatUsage): ChatReply {
  const context = { projectId: proposal.projectId, branch: proposal.branch };
  const review = wantsReview(text);
  if (!review) projects.commit(proposal.projectId, proposal.id);
  const play = playing || requestsPlay(text);
  projects.addNote(proposal.projectId, { text: message + (review ? ' Say “apply and play” when you’re ready.' : play ? ' Saved. Starting the updated game.' : ' Saved as a new revision.'),
    branch: proposal.branch, role: 'assistant', references: [], attachments: [], usage });
  if (review) return { ...context, mode: 'review', proposalId: proposal.id };
  return { ...context, mode: play ? 'play' : 'edit' };
}

export function applyChatControl(projects: Projects, project: Project, base: Revision, request: Request, usage?: ChatUsage): ChatReply | undefined {
  const { text, branch } = request;
  const context = { projectId: project.id, branch };
  const say = (message: string) => projects.addNote(project.id,
    { text: message, branch, role: 'assistant', references: [], attachments: [], usage });
  const control = chatControl(text);
  if (control?.action === 'undo') {
    if (!base.parent) { say('This is the first revision. There’s nothing to undo yet.'); return context; }
    projects.restore(project.id, branch, base.id, base.parent);
    say('Restored the previous revision.');
    return { ...context, mode: request.playing ? 'play' : 'edit' };
  }
  if (control?.action === 'play' || control?.action === 'stop') {
    if (control.action === 'play' && !base.game && !base.scene && !request.proposalId) {
      say('Describe the game you want to build before starting a playtest.');
      return context;
    }
    say(control.action === 'play' ? 'Starting ' + project.title + '.' : 'Back in the editor.');
    return { ...context, mode: control.action === 'play' ? 'play' : 'edit', proposalId: control.action === 'play' ? request.proposalId : undefined };
  }
  if (control) {
    const options = projects.proposals(project.id, branch);
    const proposal = control.index !== undefined ? options[control.index] :
      options.find((item) => item.id === request.proposalId) ?? (options.length === 1 ? options[0] : undefined);
    if (!proposal) {
      say(options.length ? 'Tell me which option to use, for example “apply option 2”.' : 'There are no pending changes to review or apply.');
      return context;
    }
    if (control.action === 'preview') { say('Showing ' + proposal.label + '.'); return { ...context, mode: 'review', proposalId: proposal.id }; }
    if (control.action === 'discard') { projects.discard(project.id, proposal.id); say('Discarded that proposal.'); return { ...context, mode: 'review' }; }
    projects.commit(project.id, proposal.id);
    say(control.play ? 'Saved a new revision. Starting the game.' : 'Saved a new revision.');
    return { ...context, mode: control.play ? 'play' : 'edit' };
  }

  return undefined;
}

export function startFromChat(projects: Projects, draft: Draft, text: string, message: string, usage?: ChatUsage,
  history: ReadonlyArray<{ role: 'creator' | 'assistant'; text: string; usage?: ChatUsage }> = []): ChatReply {
  const newProject = projects.createGame(draft.title, draft.game);
  for (const note of history) projects.addNote(newProject.id, { ...note, branch: 'main', references: [], attachments: [] });
  projects.addNote(newProject.id, { text, branch: 'main', role: 'creator', references: [], attachments: [] });
  const play = requestsPlay(text);
  projects.addNote(newProject.id, { text: message +
    (play ? ' Starting a local playtest.' : ''),
    branch: 'main', role: 'assistant', references: [], attachments: [], usage });
  return { projectId: newProject.id, branch: 'main', mode: play ? 'play' : 'edit' };
}
