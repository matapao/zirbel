import { activityKey, activityTurns, chatBusy, chatSettings, chatSettingsKey, lastProjectKey, markedObjects, MAX_SUGGESTIONS,
  objectPreferenceKey, promptDrafts, recentProjectsKey, threadKey, ws, type Preview, type ProjectCard } from './state.ts';
import { legacyScene, type Operation, type Project, type Revision } from '../sdk/contracts.ts';
import { objectRegistry } from '../sdk/game.ts';
import { $, api, attempt, inform } from './editor-ui.ts';
import { arrangeDesk, mountDesk } from './desk.ts';
import { renderViewport, scheduleDraw, setupScene } from './viewport.ts';
import { renderObjects, renderRegisteredInspector, setupObjects } from './inspector.ts';
import { openHarnesses, refreshProcessors, renderChips, renderProcessors, setupActivity } from './chat.ts';
import { openOnboarding, setBoxHooks } from './box.ts';
import { renderSuggestions } from './chat-settings.ts';
import { renderMessages } from './thread.ts';
import { renderEditing, setupEditing } from './edit-mode.ts';
import { renderTopbar, setupTopbar } from './topbar.ts';
import { createLibrary } from './library.ts';
import { syncThread } from './turn-runner.ts';

// This module's own state. What the workspace modules share is in ws.
let playRequest = 0;
let registryRevision = '';

try {
  ws.registerObjects = localStorage.getItem(objectPreferenceKey) !== 'off';
  const saved = JSON.parse(localStorage.getItem(chatSettingsKey) ?? '{}');
  if (typeof saved.suggestions === 'boolean') chatSettings.suggestions = saved.suggestions;
  if (Number.isInteger(saved.count) && saved.count >= 1) chatSettings.count = Math.min(saved.count, MAX_SUGGESTIONS);
} catch { /* A bad preference does not block chat. */ }

export function openProject() {
  if (!ws.project) throw new Error('Open a project first.');
  return ws.project;
}

export const route = (name = '') => 'projects/' + openProject().id + (name ? '/' + name : '');
export const scope = () => ({ branch: ws.branch, baseRevision: current().id });
export function current(): Revision {
  const project = openProject();
  const active = project.revisions.find((revision) => revision.id === project.branches[ws.branch]);
  if (!active) throw new Error('This branch has no saved revision.');
  return active;
}

/** What the running game shows: the proposal its card has switched to After, or else the saved revision. */
export function displayedRevision() { return ws.candidate?.preview ?? current(); }
export function authored() { return !openProject().template || Boolean(displayedRevision().game); }
export function displayedScene() { return legacyScene(displayedRevision()); }
/** Whether there is a game to show: a revision with a game or a scene. */
export function hasContent() {
  if (!ws.project) return false;
  const revision = displayedRevision();
  return Boolean(revision.game || revision.scene);
}

export function uid() { return crypto.randomUUID(); }
export function bind(name: string, event: string, handler: (event: Event) => void) { $(name).addEventListener(event, handler); }

export async function listProjects() {
  ws.projectCards = await api<ProjectCard[]>('projects');
  renderTopbar();
  return ws.projectCards;
}

/** The games opened most recently first, then the others. */
export function recentCards(limit: number) {
  let order: string[] = [];
  try { order = JSON.parse(localStorage.getItem(recentProjectsKey) ?? '[]'); } catch { /* Browser storage is optional. */ }
  const rank = (id: string) => { const at = Array.isArray(order) ? order.indexOf(id) : -1; return at < 0 ? Infinity : at; };
  return ws.projectCards.toSorted((a, b) => rank(a.id) - rank(b.id)).slice(0, limit);
}

function rememberProject() {
  try {
    localStorage.setItem(lastProjectKey, activityKey());
    if (!ws.project) return;
    const order = JSON.parse(localStorage.getItem(recentProjectsKey) ?? '[]');
    const kept = Array.isArray(order) ? order.filter((id) => typeof id === 'string' && id !== ws.project?.id) : [];
    localStorage.setItem(recentProjectsKey, JSON.stringify([ws.project.id, ...kept].slice(0, 20)));
  } catch { /* Browser storage is optional. */ }
}

async function restoreProject() {
  let saved: string | null;
  try { saved = localStorage.getItem(lastProjectKey); } catch { return; }
  if (!saved || ws.navigation) return;
  const [id, name] = saved.split('/');
  if (id && ws.projectCards.some((card) => card.id === id)) await loadProject(id, name);
}

export async function loadProject(id: string, nextBranch = 'main') {
  const visit = ++ws.navigation;
  const path = 'projects/' + id;
  const turn = activityTurns.get(threadKey(id, nextBranch));
  const awaitingReply = turn?.pending && turn.showPrompt;
  let next = await api<Project>(path);
  if (visit !== ws.navigation) return;
  if (awaitingReply && !turn.showPrompt) {
    // The harness may have saved a revision after the first read.
    next = await api<Project>(path);
    if (visit !== ws.navigation) return;
  }
  const previousThread = activityKey();
  const sameProject = ws.project?.id === next.id;
  ws.project = next;
  ws.branch = Object.hasOwn(ws.project.branches, nextBranch) ? nextBranch : 'main';
  rememberProject();
  changePrompt(previousThread);
  resetView(sameProject);
  renderProcessors();
  await refreshProposals();
  if (visit !== ws.navigation) return;
  render();
  // A turn running in this thread, or one interrupted, shows in it.
  await syncThread();
}

function resetView(sameProject = false) {
  ws.selected = new Set();
  ws.region = undefined;
  ws.candidate = undefined;
  ws.proposals = [];
  ws.proposalChoice = undefined;
  if (!sameProject) { ws.editing = false; ws.sourceVisible = false; }
  ws.view = { x: 0, y: 0, zoom: 1, grid: ws.view.grid, tool: 'select' };
}

function changePrompt(previousThread: string) {
  const next = activityKey();
  if (previousThread === next) return;
  const input = $<HTMLTextAreaElement>('prompt');
  if (input.value) promptDrafts.set(previousThread, input.value);
  input.value = promptDrafts.get(next) ?? '';
  promptDrafts.delete(next);
}

export async function refreshProposals() {
  const visit = ws.navigation;
  const key = activityKey();
  const result = await api<Preview['proposal'][]>(route('proposals') + '?branch=' + encodeURIComponent(ws.branch));
  if (visit !== ws.navigation || key !== activityKey()) return;
  ws.proposals = result;
  if (ws.candidate && !result.some(({ id }) => id === ws.candidate?.proposal.id)) ws.candidate = undefined;
  if (!result.some(({ id }) => id === ws.proposalChoice)) ws.proposalChoice = result[0]?.id;
}

export async function refreshProject() {
  const visit = ws.navigation;
  const key = activityKey();
  const next = await api<Project>(route());
  if (visit !== ws.navigation || key !== activityKey()) return;
  ws.project = next;
  const available = new Set(current().scene?.objects.map((item) => item.id));
  ws.selected = new Set([...ws.selected].filter((id) => available.has(id)));
  await refreshProposals();
  if (visit === ws.navigation && key === activityKey()) render();
}

/** Switches the running game to a staged proposal (After), or back to the saved revision (Before). */
export async function showProposal(id: string | undefined) {
  if (!id) { ws.candidate = undefined; render(); return; }
  const visit = ws.navigation;
  const key = activityKey();
  const preview = await api<Preview>(route('proposals/' + id));
  if (visit !== ws.navigation || key !== activityKey()) return;
  ws.candidate = preview;
  ws.proposalChoice = id;
  render();
}

export function render() {
  const empty = !hasContent();
  $('desk').toggleAttribute('data-empty', empty);
  if (empty) ws.editing = false;
  arrangeDesk(empty);
  renderTopbar();
  if (!ws.project) { renderMessages(); return; }
  const preview = ws.candidate;
  const sourceKey = [ws.project.id, ws.branch, current().id, preview?.proposal.id].join('/');
  if (registryRevision !== sourceKey) {
    registryRevision = sourceKey;
    ws.registered = [];
    markedObjects.clear();
    $<HTMLTextAreaElement>('game-source').value = displayedRevision().game?.html ?? '';
  }
  syncPlaytest(empty ? undefined : sourceKey, preview?.proposal.id);
  renderEditing();
  renderMessages();
  renderChips();
  renderSuggestions();
  scheduleDraw();
}

// Checked below: the sender is the playtest frame, from the player's origin, for this room.
// nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation
window.addEventListener('message', (event) => {
  const frame = $<HTMLIFrameElement>('playframe');
  if (!ws.playtest || !frame || event.source !== frame.contentWindow || event.origin !== new URL(ws.playtest.link).origin ||
      event.data?.type !== 'zirbel.objects' || event.data.room !== ws.playtest.id) return;
  const objects = objectRegistry.safeParse(event.data.value);
  if (!objects.success) return;
  const listChanged = ws.registered.length !== objects.data.length || ws.registered.some((old, i) => {
    const next = objects.data[i]!;
    return old.id !== next.id || old.properties.name !== next.properties.name;
  });
  ws.registered = objects.data;
  const ids = new Set(ws.registered.map(({ id }) => id));
  for (const id of markedObjects) if (!ids.has(id)) markedObjects.delete(id);
  if (listChanged) { renderObjects(); renderChips(); }
  else renderRegisteredInspector();
});

export async function edit(label: string, operations: Operation[]) {
  const visit = ws.navigation;
  const applyRoute = route('apply');
  const staged = await api<Preview>(route('proposals'), { ...scope(), label, operations });
  await api(applyRoute + '/' + staged.proposal.id, {});
  if (visit !== ws.navigation) return;
  ws.region = undefined;
  await refreshProject();
}

// The game runs in the player, on its own origin, always embedded: the same room whether or not Edit is on, so the
// game keeps its state and reports its registered objects in both.
function syncPlaytest(key: string | undefined, proposalId: string | undefined) {
  if (ws.playtestKey === key) return;
  const closing = closePlaytest();
  if (!key) { attempt(() => closing); return; }
  ws.playtestKey = key;
  const request = playRequest;
  const path = route('playtest');
  const payload = { ...scope(), proposalId };
  void (async () => {
    try {
      await closing;
      if (request !== playRequest) return;
      const testing = await api<{ id: string; link: string }>(path, payload);
      if (request !== playRequest) { await api('rooms/' + testing.id + '/close', {}); return; }
      ws.playtest = testing;
      const url = new URL(testing.link);
      url.searchParams.set('preview', '1');
      $<HTMLIFrameElement>('playframe').src = url.href;
      renderViewport();
    } catch (error) {
      if (request !== playRequest) return;
      ws.previewError = (error as Error).message;
      renderViewport();
    }
  })();
}

async function closePlaytest() {
  playRequest++;
  ws.playtestKey = undefined;
  ws.previewError = '';
  const previous = ws.playtest;
  ws.playtest = undefined;
  const frame = $<HTMLIFrameElement>('playframe');
  if (frame) { frame.removeAttribute('src'); frame.hidden = true; }
  if (previous) await api('rooms/' + previous.id + '/close', {});
}

export const library = createLibrary({
  active: () => ws.project?.id, open: loadProject, refresh: listProjects, removed: projectRemoved,
});

/** Closes the open game and shows the empty desk, where a new game starts from one prompt. */
export async function leaveProject() {
  const previousThread = activityKey();
  ws.navigation++;
  ws.project = undefined;
  ws.branch = 'main';
  rememberProject();
  changePrompt(previousThread);
  await closePlaytest();
  resetView();
  ws.registered = [];
  markedObjects.clear();
  registryRevision = '';
  $('marked').replaceChildren();
  $('chat-suggestions').replaceChildren();
  render();
  renderProcessors();
  await syncThread();
}

async function projectRemoved(id: string) {
  if (ws.interrupted?.key.startsWith(id + '/')) ws.interrupted = undefined;
  for (const [key, turn] of activityTurns) {
    if (!key.startsWith(id + '/')) continue;
    turn.connection?.abort();
    activityTurns.delete(key);
  }
  if (ws.project?.id === id) await leaveProject();
  for (const key of promptDrafts.keys()) {
    if (key.startsWith(id + '/')) promptDrafts.delete(key);
  }
}

mountDesk(() => { setupScene(); setupObjects(); }, setupActivity, () => scheduleDraw());
setupTopbar();
setupEditing();
document.addEventListener('click', (event) => {
  if (!event.composedPath().includes($('model-picker'))) ws.modelControl?.close();
}, { capture: true });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$<HTMLDialogElement>('dialog').open && ws.modelControl?.close(true)) event.preventDefault();
});

try {
  [ws.health] = await Promise.all([api<typeof ws.health>('health'), listProjects()]);
  $('host-status-text').textContent = 'Local workspace';
  await restoreProject().catch((error: Error) => inform(error.message, true));
  render();
  if (!ws.project) await syncThread().catch((error: Error) => inform(error.message, true));
  await refreshProcessors();
  window.addEventListener('focus', () => { if (!chatBusy()) void refreshProcessors(); });
  setBoxHooks({ openHarnesses, refreshProcessors });
  // A box opened before its first-run choice was made asks how to use it.
  if (ws.health.box && !ws.health.box.onboarded) openOnboarding();
} catch (error) {
  $('host-status-text').textContent = 'Workspace unavailable';
  $('host-status').classList.add('failed');
  inform((error as Error).message, true);
}
