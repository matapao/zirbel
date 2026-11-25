// Split from chat.ts; shares state through ws in state.ts.
// A turn as the thread follows it: sending a message starts one, and the editor streams it here. The turn belongs to
// the editor, so a page that closes leaves it running; a page that opens a thread asks what it has, follows a running
// turn from where it is (its steps so far, any request waiting) and offers to continue one that was interrupted. Stop
// is the only way to end a turn.
import { TurnLog } from '../sdk/activity.ts';
import { CONTINUE_TEXT, type ChatUpdate, type ThreadView } from '../sdk/chat-stream.ts';
import { $, api, chatApi, dialog } from './editor-ui.ts';
import { activityKey, activityTurns, markedObjects, promptDrafts, threadKey, visibleTurn, workspaceThreadKey, ws,
  type ActivityTurn, type ChatReply } from './state.ts';
import { authored, listProjects, loadProject, refreshProject, route, scope, showProposal } from './workspace.ts';
import { references } from './inspector.ts';
import { keepTurn, renderMessages, renderTurnActions, showStep } from './thread.ts';
import { providerName, refreshProcessors, renderChatStatus, renderProcessors } from './chat.ts';

function rememberWorkspaceThread(id: string) {
  ws.workspaceThread = id;
  try { localStorage.setItem(workspaceThreadKey, id); } catch { /* Browser storage is optional. */ }
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

export async function stopTurn() {
  const turn = visibleTurn();
  if (!turn?.connection || turn.stopping) return;
  turn.stopping = true;
  renderChatStatus();
  // Before its stream has begun, the request itself is called off; a turn it started meanwhile is stopped too.
  if (!turn.id) { turn.stopRequested = true; turn.connection.abort(); return; }
  try { await api('chat/' + turn.id + '/stop', {}); }
  catch (error) {
    turn.stopping = false;
    if (!turn.pending || visibleTurn() !== turn) return;
    renderChatStatus();
    throw error;
  }
}

/** Follows a turn's stream to its end in the thread `key`, then shows what it made. */
async function follow(turn: ActivityTurn, key: string, projectId: string | undefined,
  stream: (update: (event: ChatUpdate) => void, signal: AbortSignal) => Promise<ChatReply>, restoreDraft: boolean) {
  const startedAt = ws.navigation;
  const connection = turn.connection!;
  const input = $<HTMLTextAreaElement>('prompt');
  const phases = { running: turn.name + ' is working…', responding: turn.name + ' is preparing a response…', validating: 'Checking the harness response…' };
  try {
    const response = await stream((event) => {
      if (activityTurns.get(key) !== turn || event.type === 'heartbeat') return;
      if (event.type === 'note') {
        turn.note = event.note;
        if (ws.project && ws.project.id === projectId && !ws.project.notes.some(({ id }) => id === event.note.id)) ws.project.notes.push(event.note);
        if (key === activityKey()) renderMessages();
        return;
      }
      if (event.type === 'run') {
        turn.id = event.id;
        if (turn.stopRequested) void api('chat/' + event.id + '/stop', {}).catch(() => {});
      }
      if (event.type === 'progress') turn.status = phases[event.phase];
      if (event.type === 'activity') showStep(turn, event.entry, turn.log.add(event.entry));
      if (event.type === 'action') turn.actions.set(event.action.id, event.action);
      if (event.type === 'action-closed') turn.actions.delete(event.id);
      if (event.type === 'action' || event.type === 'action-closed') renderTurnActions(turn);
      if (visibleTurn() === turn) renderChatStatus();
    }, connection.signal);
    if (activityTurns.get(key) !== turn) return;
    Object.assign(turn, { connection: undefined, stopping: false, showPrompt: false, status: '', id: undefined });
    turn.actions.clear();
    renderTurnActions(turn, false);
    if (visibleTurn() === turn) renderChatStatus();
    if (response.conversation) ws.conversation = response.conversation;
    let visit = ws.navigation;
    if (response.projectId && response.projectId !== projectId) {
      const openResult = key === activityKey() && visit === startedAt && !dialog.open;
      if (!projectId) {
        activityTurns.delete(key);
        activityTurns.set(threadKey(response.projectId, response.branch ?? 'main'), turn);
        ws.conversation = [];
        // The chat became the game's thread: the next chat before a project is a new one.
        rememberWorkspaceThread(crypto.randomUUID());
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
    if (response.proposalId) await showProposal(response.proposalId);
  } catch (error) {
    if (activityTurns.get(key) !== turn) return;
    // The page let go of the stream: the turn goes on in the editor, and the thread follows it again when it opens.
    if (connection.signal.aborted && !turn.stopRequested) { activityTurns.delete(key); return; }
    if (turn.stopRequested && !turn.id) void stopStarted(turn, projectId);
    turn.status = connection.signal.aborted ? 'Turn stopped.' : (error as Error).message;
    turn.failed = turn.status !== 'Turn stopped.';
    if (!restoreDraft) {
      if (turn.failed) void refreshProcessors();
    } else if (key === activityKey()) {
      if (!input.value.trim()) input.value = turn.text;
      if (turn.failed) void refreshProcessors();
    } else if (!promptDrafts.get(key)?.trim()) {
      promptDrafts.set(key, turn.text);
    }
  } finally {
    Object.assign(turn, { connection: undefined, stopping: false, pending: false });
    turn.actions.clear();
    if (key === activityKey() || visibleTurn() === turn) {
      renderMessages();
      renderProcessors();
    }
  }
}

/** A turn whose request was called off before its stream began: if the editor started it all the same, it stops. */
async function stopStarted(turn: ActivityTurn, projectId: string | undefined) {
  const path = projectId ? 'projects/' + projectId + '/thread?branch=' + encodeURIComponent(ws.branch) : 'chat/workspace/' + ws.workspaceThread;
  const view = await api<ThreadView>(path).catch(() => undefined);
  if (view?.turn?.text === turn.text) await api('chat/' + view.turn.id + '/stop', {}).catch(() => {});
}

function newTurn(name: string, text: string, startedAt = Date.now()): ActivityTurn {
  return { name, text, references: [], status: 'Waiting for ' + name + '…', pending: true, showPrompt: true,
    connection: new AbortController(), startedAt, log: new TurnLog(), actions: new Map() };
}

export async function runTurn(text: string, selectedProvider: string) {
  const input = $<HTMLTextAreaElement>('prompt');
  const key = activityKey();
  const projectId = ws.project?.id;
  const refs = ws.project ? references() : [];
  const path = ws.project ? route('prompt') : 'chat';
  const modelSettings = ws.modelControl?.selection();
  const payload = ws.project ? {
    ...scope(), text, references: refs, provider: selectedProvider, registerObjects: ws.registerObjects, modelSettings,
    ...(authored() ? { objects: chatObjects(), markedIds: [...markedObjects] } : {}),
    proposalId: ws.proposalChoice,
  } : { text, provider: selectedProvider, conversation: ws.conversation, registerObjects: ws.registerObjects, modelSettings,
    thread: ws.workspaceThread };
  const turn = { ...newTurn(providerName(selectedProvider), text), references: refs };
  input.value = '';
  if (ws.interrupted?.key === key) ws.interrupted = undefined;
  const previous = activityTurns.get(key);
  if (previous) keepTurn(previous, projectId);
  activityTurns.set(key, turn);
  renderMessages();
  renderProcessors();
  await follow(turn, key, projectId, (update, signal) => chatApi<ChatReply>(path, payload, update, signal), true);
}

/** Continues the thread's interrupted turn: the same session, in the same folder, with the same harness. */
export function continueTurn() {
  const interrupted = ws.interrupted;
  if (!interrupted || interrupted.key !== activityKey()) return;
  return runTurn(CONTINUE_TEXT, interrupted.harness);
}

/** Asks what the open thread has: follows a turn running in it, or offers to continue an interrupted one. */
export async function syncThread() {
  const key = activityKey();
  const projectId = ws.project?.id;
  const branch = ws.branch;
  if (activityTurns.get(key)?.pending || !ws.health.chat) return;
  let view: ThreadView;
  try {
    view = await api<ThreadView>(projectId ? route('thread') + '?branch=' + encodeURIComponent(branch)
      : 'chat/workspace/' + ws.workspaceThread);
  } catch { return; } // The thread still shows what it has; its turn is looked for again when it opens.
  if (key !== activityKey() || activityTurns.get(key)?.pending) return;
  if (!projectId && view.project) {
    // The chat became a game while this page was away: open it, and start the next chat afresh.
    rememberWorkspaceThread(crypto.randomUUID());
    await listProjects();
    if (!ws.project && ws.projectCards.some(({ id }) => id === view.project)) await loadProject(view.project);
    return;
  }
  if (!projectId && view.conversation && !ws.conversation.length) ws.conversation = view.conversation;
  ws.interrupted = view.interrupted ? { key, ...view.interrupted } : undefined;
  if (!view.turn) { renderMessages(); return; }
  const running = view.turn;
  const turn = newTurn(running.name, running.text, Date.parse(running.startedAt) || Date.now());
  turn.id = running.id;
  const note = ws.project?.notes.find(({ id }) => id === running.noteId);
  if (note) Object.assign(turn, { note, showPrompt: false });
  activityTurns.set(key, turn);
  renderMessages();
  renderProcessors();
  // Followed in the background: whoever opened the thread goes on meanwhile.
  void follow(turn, key, projectId, (update, signal) => chatApi<ChatReply>('chat/' + running.id + '/attach', {}, update, signal), false);
}

if (!ws.workspaceThread) {
  let saved: string | null = null;
  try { saved = localStorage.getItem(workspaceThreadKey); } catch { /* Browser storage is optional. */ }
  if (saved && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(saved)) ws.workspaceThread = saved;
  else rememberWorkspaceThread(crypto.randomUUID());
}
