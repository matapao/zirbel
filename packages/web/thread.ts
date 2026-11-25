// Split from chat.ts; shares state through ws in state.ts.
// The thread: the conversation, each turn's steps right after the message that started it, any request the harness
// waits on in its row, and the card for staged proposals. A turn's steps are kept by the Node editor; a thread loads
// each kept turn when it comes into view.
import type { Note, Reference } from '../sdk/contracts.ts';
import { TurnLog, type TurnRecord } from '../sdk/activity.ts';
import { $, action, api, dialog, el } from './editor-ui.ts';
import { type ActivityTurn, type WorkspaceMessage, activityKey, visibleTurn, ws } from './state.ts';
import { createSteps, fillSteps, removeSteps, requestRow, upsertStep } from './activity-rows.ts';
import { actionCard, announce, headlineOf } from './ask-card.ts';
import { renderProposalCard } from './proposals.ts';
import { continueTurn } from './turn-runner.ts';
import type { ActivityEntry } from '../sdk/chat-stream.ts';

type Kept = { element: HTMLElement; state: 'waiting' | 'loading' | 'ready' } | 'none';
/** Kept turns by project and message, as loaded or as they ended in this session. */
const kept = new Map<string, Kept>();
/** Steps of turns before a project existed, by the message that started them. */
const conversationSteps = new Map<string, HTMLElement>();
let observer: IntersectionObserver | undefined;
let shownThread = '';

/** A turn the editor was running when it ended: it waits to be continued in the same session. */
function interruptedRow() {
  const row = el('div', undefined, 'interrupted');
  row.setAttribute('role', 'status');
  row.append(el('strong', 'Interrupted'), el('span', 'The editor stopped while this turn was running.'),
    action('Continue', () => continueTurn(), 'primary'));
  return row;
}

function bubble(text: string, assistant: boolean, refs: Reference[], usage?: Note['usage'], id?: string) {
  const article = el('article', undefined, assistant ? 'note assistant-note' : 'note');
  if (id) article.dataset.note = id;
  if (assistant) article.append(el('strong', 'Zirbel'));
  article.append(el('div', text));
  const labels = refs.map((reference) => (reference.type === 'instance' ? reference.object.name : 'Marked region'));
  if (labels.length) article.append(el('small', labels.join(' · ') + ' · ' + refs[0]?.revision.slice(0, 8)));
  if (assistant && usage) {
    const number = (value?: number) => value?.toLocaleString() ?? '—';
    const amount =
      usage.input !== undefined || usage.output !== undefined
        ? number(usage.input) + ' in / ' + number(usage.output) + ' out'
        : number(usage.total) + ' tokens';
    article.append(el('small', usage.source + ' · ' + amount, 'usage'));
  }
  return article;
}

function liveSteps(turn: ActivityTurn) {
  if (!turn.steps) {
    turn.steps = createSteps();
    fillSteps(turn.steps, turn.log.entries.values(), turn.log.dropped);
  }
  return turn.steps;
}

function keptSteps(projectId: string, noteId: string) {
  const key = projectId + '/' + noteId;
  const known = kept.get(key);
  if (known === 'none') return undefined;
  if (known) return known.element;
  if (!ws.health.chat) return undefined;
  const element = createSteps();
  element.dataset.turn = key;
  kept.set(key, { element, state: 'waiting' });
  observer?.observe(element);
  return element;
}

async function loadSteps(key: string) {
  const known = kept.get(key);
  if (!known || known === 'none' || known.state !== 'waiting') return;
  known.state = 'loading';
  const [projectId, noteId] = key.split('/');
  try {
    const record = await api<TurnRecord>('projects/' + projectId + '/activity/' + noteId);
    fillSteps(known.element, TurnLog.from(record).entries.values(), record.dropped);
    known.state = 'ready';
  } catch {
    kept.set(key, 'none');
    known.element.remove();
  }
}

/** A finished turn's steps stay in the thread after another turn starts. */
export function keepTurn(turn: ActivityTurn, projectId?: string) {
  if (!turn.steps || !turn.log.entries.size) return;
  if (projectId && turn.note) kept.set(projectId + '/' + turn.note.id, { element: turn.steps, state: 'ready' });
  else if (!projectId) conversationSteps.set(turn.text, turn.steps);
}

export function renderMessages() {
  const node = $('messages');
  if (!node) return;
  const feed = $('activity-feed');
  const thread = (ws.project?.id ?? '') + '/' + ws.branch;
  const following = shownThread !== thread || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  shownThread = thread;
  const project = ws.project;
  const notes: ReadonlyArray<Note | WorkspaceMessage> = project
    ? project.notes.filter((note) => note.branch === ws.branch)
    : ws.conversation;
  const turn = visibleTurn();
  const children: HTMLElement[] = [];
  for (const note of notes) {
    children.push(
      bubble(note.text, note.role === 'assistant', 'references' in note ? note.references : [], note.usage,
        'id' in note ? note.id : undefined),
    );
    if (note.role === 'assistant') continue;
    const steps = !project
      ? (conversationSteps.get(note.text) ??
        (turn && !turn.showPrompt && turn.text === note.text ? liveSteps(turn) : undefined))
      : 'id' in note && turn?.note?.id === note.id
        ? liveSteps(turn)
        : 'id' in note
          ? keptSteps(project.id, note.id)
          : undefined;
    if (steps) children.push(steps);
  }
  if (turn?.showPrompt && !notes.some((note) => 'id' in note && note.id === turn.note?.id)) {
    children.push(bubble(turn.text, false, turn.note?.references ?? turn.references), liveSteps(turn));
  }
  const interrupted = ws.interrupted?.key === activityKey() && !turn?.pending ? ws.interrupted : undefined;
  if (interrupted) {
    const after = interrupted.noteId ? children.findIndex((child) => child.dataset.note === interrupted.noteId) : -1;
    const started = after >= 0 ? [] : [bubble(interrupted.text, false, [])];
    const at = after >= 0 && children[after + 1]?.classList.contains('steps') ? after + 2 : after >= 0 ? after + 1 : children.length;
    children.splice(at, 0, ...started, interruptedRow());
  }
  node.replaceChildren(...children);
  if (turn) renderTurnActions(turn, false);
  renderProposalCard();
  $('thread-title').textContent = project && ws.branch !== 'main' ? 'Branch · ' + ws.branch : '';
  if (following) feed.scrollTop = feed.scrollHeight;
}

/** A step of the turn that is running, drawn in place. */
export function showStep(turn: ActivityTurn, entry: ActivityEntry, removed: string[]) {
  const steps = liveSteps(turn);
  const feed = $('activity-feed');
  const following = visibleTurn() === turn && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  upsertStep(steps, entry);
  if (removed.length) removeSteps(steps, removed, turn.log.dropped);
  if (following) feed.scrollTop = feed.scrollHeight;
}

/** The cards for what the harness waits on, each under its request's row. A new card takes focus and is announced. */
export function renderTurnActions(turn: ActivityTurn, announceNew = true) {
  const steps = liveSteps(turn);
  for (const card of steps.querySelectorAll<HTMLElement>('.ask-card')) {
    if (!turn.actions.has(card.dataset.actionId ?? '')) card.remove();
  }
  if (!turn.id) return;
  for (const request of turn.actions.values()) {
    if (steps.querySelector('.ask-card[data-action-id="' + CSS.escape(request.id) + '"]')) continue;
    const card = actionCard(turn.id, request, turn.name);
    (requestRow(steps, request.id) ?? steps).append(card);
    if (!announceNew || visibleTurn() !== turn) continue;
    announce(turn.name + ' asks: ' + headlineOf(request));
    if (!dialog.open && ws.threadOpen) card.focus();
  }
}

export function setupThread() {
  observer = new IntersectionObserver(
    (seen) => {
      for (const { isIntersecting, target } of seen) {
        if (!isIntersecting) continue;
        observer?.unobserve(target);
        const key = (target as HTMLElement).dataset.turn;
        if (key) void loadSteps(key);
      }
    },
    { root: $('activity-feed'), rootMargin: '400px 0px' },
  );
}
