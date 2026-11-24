// Split from workspace.ts; shares state through ws in state.ts.
import { $, action, api, attempt, chatApi, dialog, el, openDialog, option } from './editor-ui.ts';
import { type Note, type Reference } from '../sdk/contracts.ts';
import { ActivityTurn, ChatReply, WorkspaceMessage, activityKey, activityTurns, chatBusy, chatSettings, chatSettingsKey, markedObjects, objectPreferenceKey, promptDrafts, threadKey, type Preview, visibleTurn, ws } from './state.ts';
import { renderRunActions, renderRunEntries } from './run-activity.ts';
import { authored, listProjects, loadProject, refreshProject, route, scope, setMode, showProposal } from './workspace.ts';
import { references, renderObjects } from './inspector.ts';
import { scheduleDraw } from './viewport.ts';
import { type Processor } from '../server/processors.ts';
import { modelPicker } from './model-picker.ts';
import { showHarnessAccounts } from './harness-accounts.ts';

// Chat's own state. What the workspace modules share is in ws.
let workspaceConversation: WorkspaceMessage[] = [];
let providers: Processor[] = [];
let processorNotice = 'Checking harnesses…';
let preferredProcessor = '';
let refreshingProcessors: Promise<void> | undefined;
let renderedTurn: ActivityTurn | undefined;

export function renderMessages() {
  const node = $('messages');
  if (!node) return;
  const notes: ReadonlyArray<Note | WorkspaceMessage> = ws.project ? ws.project.notes.filter((note) => note.branch === ws.branch) : workspaceConversation;
  const turn = visibleTurn();
  const messages = notes.map((note) => chatMessage(note.text, note.role === 'assistant', 'references' in note ? note.references : []));
  if (turn?.showPrompt && !notes.some((note) => 'id' in note && note.id === turn.note?.id))
    messages.push(chatMessage(turn.text, false, turn.note?.references ?? turn.references));
  node.replaceChildren(...messages);
  renderChatStatus();
}

function chatMessage(text: string, assistant: boolean, refs: Reference[]) {
  const article = el('article', undefined, assistant ? 'note assistant-note' : 'note');
  if (assistant) article.append(el('strong', 'Zirbel'));
  article.append(el('div', text));
  const labels = refs.map((reference) => reference.type === 'instance' ? reference.object.name : 'Marked region');
  if (labels.length) article.append(el('small', labels.join(' · ') + ' · ' + refs[0]?.revision.slice(0, 8)));
  return article;
}

function renderChatStatus(refreshEntries = false) {
  const turn = visibleTurn();
  const status = $('chat-run');
  const text = turn?.stopping ? 'Stopping the turn…' : turn?.actions.size ? 'Waiting for your response…' : turn?.status ?? '';
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle('waiting', turn?.pending === true && !turn.actions.size);
  status.classList.toggle('failed', turn?.failed === true);
  const stop = $<HTMLButtonElement>('stop-run');
  const send = $<HTMLButtonElement>('send');
  const focusStop = Boolean(turn?.connection) && document.activeElement === send;
  stop.hidden = !turn?.connection;
  send.hidden = !stop.hidden;
  stop.disabled = turn?.stopping === true;
  if (focusStop) stop.focus();
  const log = $<HTMLDetailsElement>('chat-log');
  if (renderedTurn !== turn) {
    renderedTurn = turn;
    log.open = turn?.pending === true;
    $('chat-log-title').textContent = (turn?.name ?? 'Harness') + ' activity';
    refreshEntries = true;
  }
  log.hidden = !turn?.entries.size;
  if (refreshEntries) renderRunEntries(turn?.entries);
  renderRunActions(turn?.id, turn?.actions);
  const feed = $('activity-feed');
  feed.scrollTop = feed.scrollHeight;
}

function updateChatDetails() {
  const context = $('chat-context');
  const usage = $('chat-usage');
  if (!context || !usage) return;
  const selected = providers.find(({ id }) => id === $<HTMLSelectElement>('provider').value);
  const thread = ws.project ? ws.project.notes.filter((note) => note.branch === ws.branch) : workspaceConversation;
  const refCount = ws.project ? authored() ? markedObjects.size : references().length : 0;
  const marks = refCount ? ' · ' + refCount + ' marked' : '';
  context.textContent = selected ? 'Context · ' + (ws.project ? 'game + ' : '') + Math.min(thread.length, 12) + ' recent messages' + marks : processorNotice;
  const amounts = thread.findLast((note) => note.role === 'assistant')?.usage;
  const number = (value?: number) => value?.toLocaleString() ?? '—';
  usage.textContent = amounts ? 'Last turn · ' + amounts.source + ' · ' + (amounts.input !== undefined || amounts.output !== undefined ?
    number(amounts.input) + ' in / ' + number(amounts.output) + ' out' : number(amounts.total) + ' tokens') :
    selected ? 'Usage · shown when reported by the harness' : '';

  usage.title = amounts?.total === undefined ? '' : String(amounts.total) + ' total tokens';
}

export function renderSuggestions() {
  const host = $('chat-suggestions');
  if (!host || !ws.project) return;
  host.replaceChildren();
  if (!chatSettings.suggestions || !providers.some(({ ready }) => ready !== false)) return;
  const status = ws.mode === 'play' ? 'Stop playing' : ws.mode === 'review' && ws.candidate ? 'Apply and play' : 'Play it';
  const available = [status, 'Help me design a game', 'Describe this game', 'Add a clear goal for the player', 'Suggest two changes'];
  for (const text of available.slice(0, chatSettings.count)) {
    host.append(action(text, () => { $<HTMLTextAreaElement>('prompt').value = text; $('prompt').focus(); }, 'suggest'));
  }
}

function openChatSettings() {
  const body = openDialog('Chat settings');
  const show = el('input');
  show.type = 'checkbox';
  show.checked = chatSettings.suggestions;
  const showLabel = el('label', 'Show suggested messages');
  showLabel.append(show);
  const count = el('select');
  count.append(...Array.from({ length: 5 }, (_, index) => option(String(index + 1), String(index + 1))));
  count.value = String(chatSettings.count);
  count.disabled = !show.checked;
  const countLabel = el('label', 'Number of suggestions');
  countLabel.append(count);
  body.append(showLabel, countLabel);
  const save = () => {
    chatSettings.suggestions = show.checked;
    chatSettings.count = Number(count.value);
    count.disabled = !show.checked;
    try { localStorage.setItem(chatSettingsKey, JSON.stringify(chatSettings)); } catch { /* Use memory for this session. */ }
    renderSuggestions();
  };
  show.addEventListener('change', save);
  count.addEventListener('change', save);
}

export function renderChips() {
  const marked = $('marked');
  if (!marked || !ws.project) return;
  if (authored()) {
    marked.replaceChildren(...[...markedObjects].map((id) => action(id + ' ×', () => {
      markedObjects.delete(id); renderChips(); renderObjects();
    }, 'chip')));
    updateChatDetails();
    return;
  }
  marked.replaceChildren(...references().map((reference) => action(
    reference.type === 'instance' ? reference.object.name + ' ×' : 'Marked region ×',
    () => {
      if (reference.type === 'instance') ws.selected.delete(reference.object.id); else ws.region = undefined;
      renderObjects(); renderChips(); scheduleDraw();
    }, 'chip',
  )));
  updateChatDetails();

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
  updateModelControls();
  updateChatDetails();
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

// Send marked objects first; keep automatic context small enough for a chat turn.
function chatObjects() {
  const sorted = ws.registered.toSorted((a, b) => Number(markedObjects.has(b.id)) - Number(markedObjects.has(a.id)));
  let size = 0;
  return sorted.filter((item) => {
    const length = JSON.stringify(item).length;
    if (size + length > 24000) return false;
    size += length;
    return true;
  });
}

export function setupActivity() {
  renderedTurn = undefined;
  const provider = $<HTMLSelectElement>('provider');
  ws.modelControl = modelPicker(updateSendButton);
  const objects = $<HTMLInputElement>('register-objects');
  objects.checked = ws.registerObjects;
  objects.addEventListener('change', () => {
    ws.registerObjects = objects.checked;
    try { localStorage.setItem(objectPreferenceKey, ws.registerObjects ? 'on' : 'off'); } catch { /* Use memory for this session. */ }
  });
  $('stop-run').addEventListener('click', () => attempt(async () => {
    const turn = visibleTurn();
    if (!turn?.connection || turn.stopping) return;
    turn.stopping = true;
    renderChatStatus();
    if (!turn.id) {
      turn.connection.abort();
      return;
    }
    try { await api('chat/' + turn.id + '/stop', {}); }
    catch (error) {
      turn.stopping = false;
      if (!turn.pending || visibleTurn() !== turn) return;
      renderChatStatus();
      throw error;
    }
  }));
  provider.addEventListener('change', () => {
    preferredProcessor = provider.value;
    updateModelControls();
    updateChatDetails();
  });
  $('chat-settings').addEventListener('click', openChatSettings);
  $('harness-accounts').addEventListener('click', () => attempt(() => showHarnessAccounts(async () => {
    await refreshProcessors();
    return { providers, notice: processorNotice };
  })));
  renderProcessors();
  const form = $<HTMLFormElement>('prompt-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $<HTMLTextAreaElement>('prompt');
    const text = input.value.trim();
    if (!text) return;
    const selectedProvider = provider.value;
    if (!selectedProvider || chatBusy() || ws.modelControl?.loading) return;
    const run = async () => {
      const key = activityKey();
      const startedAt = ws.navigation;
      const projectId = ws.project?.id;
      const processor = providers.find((choice) => choice.id === selectedProvider);
      const name = processor?.name ?? 'the harness';
      const refs = ws.project ? references() : [];
      const path = ws.project ? route('prompt') : 'chat';
      const modelSettings = ws.modelControl?.selection();
      const payload = ws.project ? {
        ...scope(), text, references: refs, provider: selectedProvider, registerObjects: ws.registerObjects, modelSettings,
        ...(authored() ? { objects: chatObjects(), markedIds: [...markedObjects] } : {}),
        proposalId: ws.candidate?.proposal.id, playing: ws.mode === 'play',
      } : { text, provider: selectedProvider, conversation: workspaceConversation, registerObjects: ws.registerObjects, modelSettings };
      const connection = new AbortController();
      const turn: ActivityTurn = { name, text, references: refs, status: 'Waiting for ' + name + '…', pending: true,
        showPrompt: true, connection, entries: new Map(), actions: new Map() };
      const messages = {
        running: name + ' is working…',
        responding: name + ' is preparing a response…',
        validating: 'Checking the harness response…',
      };
      input.value = '';
      activityTurns.set(key, turn);
      renderMessages();
      renderProcessors();
      try {
        const response = await chatApi<ChatReply>(path, payload, (event) => {
          if (activityTurns.get(key) !== turn) return;
          if (event.type === 'heartbeat') return;
          if (event.type === 'note') {
            turn.note = event.note;
            if (ws.project && ws.project.id === projectId && !ws.project.notes.some(({ id }) => id === event.note.id)) ws.project.notes.push(event.note);
            if (key === activityKey()) renderMessages();
            return;
          }
          if (event.type === 'run') turn.id = event.id;
          if (event.type === 'progress') turn.status = messages[event.phase];
          if (event.type === 'activity') {
            turn.entries.set(event.entry.id, event.entry);
            if (turn.entries.size > 150) turn.entries.delete(turn.entries.keys().next().value!);
          }
          if (event.type === 'action') turn.actions.set(event.action.id, event.action);
          if (event.type === 'action-closed') turn.actions.delete(event.id);
          if (visibleTurn() === turn) renderChatStatus(event.type === 'activity');
        }, connection.signal);
        if (activityTurns.get(key) !== turn) return;
        turn.connection = undefined;
        turn.stopping = false;
        turn.showPrompt = false;
        turn.status = '';
        turn.id = undefined;
        turn.actions.clear();
        if (visibleTurn() === turn) renderChatStatus();
        if (response.conversation) workspaceConversation = response.conversation;
        let visit = ws.navigation;
        if (response.projectId && response.projectId !== projectId) {
          const openResult = key === activityKey() && visit === startedAt && !dialog.open;
          if (!projectId) {
            activityTurns.delete(key);
            activityTurns.set(threadKey(response.projectId, response.branch ?? 'main'), turn);
            workspaceConversation = [];
          }
          await listProjects();
          if (!openResult || visit !== ws.navigation || dialog.open) return;
          const loading = loadProject(response.projectId, response.branch);
          visit = ws.navigation;
          await loading;
        } else if (response.projectId && response.projectId === ws.project?.id) {
          await refreshProject();
        }
        const replyThread = threadKey(response.projectId, response.branch ?? 'main');
        if (visit !== ws.navigation || replyThread !== activityKey()) return;
        if (response.mode) ws.sourceVisible = false;
        if (response.mode === 'review' && response.proposalId) await showProposal(response.proposalId);
        else if (response.mode === 'play') {
          const preview = response.proposalId ? await api<Preview>(route('proposals/' + response.proposalId)) : undefined;
          if (visit !== ws.navigation || replyThread !== activityKey()) return;
          ws.candidate = preview;
          setMode('play');
        } else if (response.mode) {
          ws.candidate = undefined;
          setMode(response.mode);
        }
      } catch (error) {
        if (activityTurns.get(key) !== turn) return;
        turn.status = connection.signal.aborted ? 'Turn stopped.' : (error as Error).message;
        turn.failed = turn.status !== 'Turn stopped.';
        if (key === activityKey()) {
          if (!input.value.trim()) input.value = text;
          if (turn.failed) void refreshProcessors();
        } else if (!promptDrafts.get(key)?.trim()) {
          promptDrafts.set(key, text);
        }
      } finally {
        turn.connection = undefined;
        turn.stopping = false;
        turn.pending = false;
        turn.actions.clear();
        if (key === activityKey() || visibleTurn() === turn) {
          renderMessages();
          renderProcessors();
        }
      }
    };
    attempt(run);
  });
  $('prompt').addEventListener('keydown', (key) => {
    if (key.key !== 'Enter' || key.shiftKey || key.isComposing || $<HTMLButtonElement>('send').disabled) return;
    key.preventDefault();
    form.requestSubmit();
  });
  renderMessages();
  if (ws.project) { renderChips(); renderSuggestions(); }
}
