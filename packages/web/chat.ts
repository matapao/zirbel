// Split from workspace.ts; shares state through ws in state.ts.
// The composer and the status line of a turn: sending, the live status line with the current step and elapsed time,
// and Stop while a turn runs. The turns themselves are turn-runner.ts's.
import { $, action, api, attempt, option } from './editor-ui.ts';
import { ActivityTurn, chatBusy, markedObjects, visibleTurn, ws } from './state.ts';
import { authored, hasContent, library, loadProject, recentCards, render } from './workspace.ts';
import { references, renderObjects } from './inspector.ts';
import { scheduleDraw } from './viewport.ts';
import { type Processor } from '../server/processors.ts';
import { modelPicker } from './model-picker.ts';
import { showHarnessAccounts } from './harness-accounts.ts';
import { onTheBox, openBoxSettings, REMOTE_SIGN_IN } from './box.ts';
import { renderSuggestions } from './chat-settings.ts';
import { renderMessages, setupThread } from './thread.ts';
import { setThreadOpen } from './desk.ts';
import { runTurn, stopTurn } from './turn-runner.ts';

// Chat's own state. What the workspace modules share is in ws.
let providers: Processor[] = [];
let processorNotice = 'Checking harnesses…';
let preferredProcessor = '';
let refreshingProcessors: Promise<void> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

export const harnessReady = () => providers.some(({ ready }) => ready !== false);
export const providerName = (id: string) => providers.find((choice) => choice.id === id)?.name ?? 'the harness';

function elapsed(since: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

/** The step a running turn is on: its newest unfinished step, else the phase the harness reported. */
function currentStep(turn: ActivityTurn) {
  if (turn.stopping) return 'Stopping the turn…';
  if (turn.actions.size) return 'Waiting for your response…';
  if (!turn.pending) return turn.status;
  const steps = [...turn.log.entries.values()];
  const active = steps.findLast(({ state }) => state === 'running' || state === 'pending') ?? steps.at(-1);
  const title = active?.kind === 'message' ? 'Writing a reply' : active?.title;
  return title ? turn.name + ' · ' + title.split('\n', 1)[0] : turn.status;
}

export function renderChatStatus() {
  const turn = visibleTurn();
  const status = $('chat-run');
  if (!status) return;
  const step = turn ? currentStep(turn) : '';
  if ($('chat-step').textContent !== step) $('chat-step').textContent = step;
  $('chat-elapsed').textContent = turn?.pending ? elapsed(turn.startedAt) : '';
  status.classList.toggle('waiting', turn?.pending === true && !turn.actions.size);
  status.classList.toggle('failed', turn?.failed === true);
  status.hidden = !step;
  clearInterval(clock);
  clock = turn?.pending ? setInterval(() => { $('chat-elapsed').textContent = elapsed(turn.startedAt); }, 1000) : undefined;
  const stop = $<HTMLButtonElement>('stop-run');
  const send = $<HTMLButtonElement>('send');
  const focusStop = Boolean(turn?.connection) && document.activeElement === send;
  stop.hidden = !turn?.connection;
  send.hidden = !stop.hidden;
  stop.disabled = turn?.stopping === true;
  if (focusStop) stop.focus();
  $('show-thread').classList.toggle('working', turn?.pending === true);
}

export function renderChips() {
  const marked = $('marked');
  if (!marked || !ws.project) return;
  if (authored()) {
    marked.replaceChildren(...[...markedObjects].map((id) => action(id + ' ×', () => {
      markedObjects.delete(id); renderChips(); renderObjects();
    }, 'chip')));
    return;
  }
  marked.replaceChildren(...references().map((reference) => action(
    reference.type === 'instance' ? reference.object.name + ' ×' : 'Marked region ×',
    () => {
      if (reference.type === 'instance') ws.selected.delete(reference.object.id); else ws.region = undefined;
      renderObjects(); renderChips(); scheduleDraw();
    }, 'chip',
  )));
}

/** The empty desk: one prompt, the folder import, and the games opened recently. */
function renderStart() {
  const empty = !hasContent();
  const label = empty ? 'Describe a game' : 'Describe a change';
  $('prompt-label').textContent = label;
  $<HTMLTextAreaElement>('prompt').placeholder = label + '…';
  const recent = $('recent-games');
  recent.replaceChildren();
  const cards = recentCards(6).filter(({ id }) => id !== ws.project?.id);
  if (!empty || !cards.length) return;
  const list = document.createElement('ul');
  for (const card of cards) {
    const item = document.createElement('li');
    item.append(action(card.title, () => loadProject(card.id), 'recent'));
    list.append(item);
  }
  const heading = document.createElement('h2');
  heading.textContent = 'Recent games';
  recent.append(heading, list);
}

/** Why chat cannot start: no harness signed in, or an editor without harness chat. */
function renderNotice(ready: boolean) {
  const notice = $('chat-notice');
  notice.hidden = ready || processorNotice === 'Checking harnesses…';
  notice.replaceChildren(ws.health.chat ? processorNotice : 'This editor has no harness chat. Import a game folder, or open a game from the Library.');
  if (notice.hidden || !ws.health.chat) return;
  if (ws.health.box && !ws.health.box.harnesses) {
    notice.replaceChildren('Harnesses are off on this box.', ' ', action('Box settings', () => openBoxSettings(), 'link'));
    return;
  }
  notice.append(' ', action('Harnesses', () => openHarnesses(), 'link'));
}

export function renderProcessors() {
  const select = $<HTMLSelectElement>('provider');
  const send = $<HTMLButtonElement>('send');
  if (!select || !send) return;
  const available = providers.filter(({ ready }) => ready !== false);
  const empty = processorNotice === 'Checking harnesses…' ? processorNotice :
    providers.some(({ signIn }) => signIn) ? 'Sign-in required' : 'No harness available';
  select.replaceChildren(...(available.length ? available.map(({ id, name }) => option(id, name)) : [option('', empty)]));
  select.value = available.some(({ id }) => id === preferredProcessor) ? preferredProcessor : available[0]?.id ?? '';
  select.disabled = chatBusy() || !available.length;
  renderNotice(available.length > 0);
  updateModelControls();
  renderChatStatus();
  renderStart();
  renderSuggestions();
}

function updateSendButton() {
  const provider = $<HTMLSelectElement>('provider');
  $<HTMLButtonElement>('send').disabled = chatBusy() || !provider.value || Boolean(ws.modelControl?.loading);
}

function updateModelControls() {
  const provider = $<HTMLSelectElement>('provider');
  ws.modelControl?.setProcessor(providers.find(({ id }) => id === provider.value), chatBusy());
  updateSendButton();
}

export async function refreshProcessors() {
  if (refreshingProcessors) return refreshingProcessors;
  refreshingProcessors = (async () => {
    try {
      const access = await api<{ processors: Processor[] }>('processors');
      providers = access.processors;
      processorNotice = providers.some(({ signIn }) => signIn) ? 'Open Harnesses to sign in.' : 'No harness is available.';
    } catch {
      providers = [];
      processorNotice = 'Could not check harnesses. Open Harnesses to refresh.';
    }
    renderProcessors();
  })();
  try { await refreshingProcessors; } finally { refreshingProcessors = undefined; }
}

export const openHarnesses = () => showHarnessAccounts(async () => {
  await refreshProcessors();
  return { providers, notice: processorNotice, notes: ws.health.box && !onTheBox() ? REMOTE_SIGN_IN : {} };
});

export function setupActivity() {
  setupThread();
  const provider = $<HTMLSelectElement>('provider');
  ws.modelControl = modelPicker(updateSendButton);
  $('stop-run').addEventListener('click', () => attempt(stopTurn));
  $('hide-thread').addEventListener('click', () => {
    setThreadOpen(false);
    render();
    $('show-thread').focus();
  });
  $('import-folder').addEventListener('click', () => library.importFolder());
  provider.addEventListener('change', () => {
    preferredProcessor = provider.value;
    updateModelControls();
  });
  renderProcessors();
  const form = $<HTMLFormElement>('prompt-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $<HTMLTextAreaElement>('prompt');
    const text = input.value.trim();
    if (!text || !provider.value || chatBusy() || ws.modelControl?.loading) return;
    attempt(() => runTurn(text, provider.value));
  });
  $('prompt').addEventListener('keydown', (key) => {
    if (key.key !== 'Enter' || key.shiftKey || key.isComposing || $<HTMLButtonElement>('send').disabled) return;
    key.preventDefault();
    form.requestSubmit();
  });
  renderMessages();
  if (ws.project) { renderChips(); renderSuggestions(); }
}
