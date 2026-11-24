import { Shell, mountShell, type ShellHandle } from '@matapao/vindu';
import { Preview, Proposal, activityKey, activityTurns, chatBusy, chatSettings, chatSettingsKey, lastProjectKey, markedObjects, modes, objectPreferenceKey, promptDrafts, threadKey, type Mode, ws } from './state.ts';
import { legacyScene, type Operation, type Project, type Revision } from '../sdk/contracts.ts';
import { $, action, api, attempt, dialog, el, inform, option } from './editor-ui.ts';
import { renderViewport, scheduleDraw, setupScene } from './viewport.ts';
import { renderObjects, renderRegisteredInspector, setupObjects } from './inspector.ts';
import { refreshProcessors, renderChips, renderMessages, renderProcessors, renderSuggestions, setupActivity } from './chat.ts';
import { createLibrary, type ProjectCard } from './library.ts';
import { objectRegistry } from '../sdk/game.ts';
import { forkDialog, historyDialog, sharingDialog } from './dialogs.ts';

// This module's own state. What the workspace modules share is in ws.
let projectCards: ProjectCard[] = [];
let proposals: Proposal[] = [];
let playRequest = 0;
let registryRevision = '';
let mount: ShellHandle | undefined;

try {
  ws.registerObjects = localStorage.getItem(objectPreferenceKey) !== 'off';
  const saved = JSON.parse(localStorage.getItem(chatSettingsKey) ?? '{}');
  if (typeof saved.suggestions === 'boolean') chatSettings.suggestions = saved.suggestions;
  if (Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 5) chatSettings.count = saved.count;
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

function stagedPreview() { return (ws.mode === 'review' || ws.mode === 'play') ? ws.candidate : undefined; }
export function authored() { return !openProject().template || Boolean(displayedRevision().game); }
export function displayedRevision() { return stagedPreview()?.preview ?? current(); }

export function displayedScene() {
  return legacyScene(ws.mode === 'review' && ws.candidate ? ws.candidate.preview : current());
}

const byMode = (value: Mode) => document.querySelector<HTMLButtonElement>('#workspace-modes button[data-mode="' + value + '"]')!;
export function uid() { return crypto.randomUUID(); }

export function bind(name: string, event: string, handler: (event: Event) => void) { $(name).addEventListener(event, handler); }
const layout = new Shell({ arrange: 'off', options: { line: 8, min: { w: 260, h: 180 } },
  onChange: (state) => mount?.state(state) });
function drawer(template: string, initialize: () => void) {
  return ({ body }: { body: HTMLElement }) => {
    body.replaceChildren($<HTMLTemplateElement>(template).content.cloneNode(true));
    initialize();
    return { place: () => scheduleDraw() };
  };
}
const css = getComputedStyle(document.documentElement);
const token = (name: string) => css.getPropertyValue('--' + name).trim();
mount = mountShell($('desk'), {
  theme: 'dark',
  tokens: { desk: token('app'), pane: token('pane'), head: token('pane'), line: token('line'), hair: token('line'),
    ink: token('ink'), ink2: token('ink'), muted: token('quiet'), accent: token('accent'), wash: token('hover') },
  labels: { mode: () => '' },
  onEvent: (event) => { layout.event(event); },
  panes: { objects: drawer('objects-pane', setupObjects), scene: drawer('scene-pane', setupScene),
    activity: drawer('activity-pane', setupActivity) },
});
layout.show('objects', { title: 'Scene hierarchy', panels: 'objects', kind: 'objects', fill: true });
layout.show('scene', { title: 'Viewport', panels: 'scene', kind: 'scene', fill: true });
layout.show('activity', { title: 'Activity', panels: 'activity', kind: 'activity', fill: true });
layout.setLayout([{ view: 'objects', size: .20 }, { view: 'scene', size: .54 }, { view: 'activity', size: .26 }]);

function showProjectPanes(open: boolean) {
  $('desk').toggleAttribute('data-empty', !open);
  $('branch').hidden = !open;
  $('workspace-modes').hidden = !open;
  for (const name of ['history', 'sharing']) document.querySelector<HTMLButtonElement>('[data-dialog="' + name + '"]')!.hidden = !open;
}

export async function listProjects() {
  projectCards = await api<ProjectCard[]>('projects');
  const select = $<HTMLSelectElement>('project');
  const placeholder = option('', 'Projects…');
  placeholder.disabled = true;
  select.replaceChildren(placeholder, ...projectCards.map((card) => option(card.id, card.title)), option('+', 'New game…'));
  select.value = ws.project?.id ?? '';
  return projectCards;
}

function rememberProject() {
  try { localStorage.setItem(lastProjectKey, activityKey()); } catch { /* Browser storage is optional. */ }
}

async function restoreProject() {
  let saved: string | null;
  try { saved = localStorage.getItem(lastProjectKey); } catch { return; }
  if (!saved || ws.navigation) return;
  const [id, name] = saved.split('/');
  if (id && projectCards.some((card) => card.id === id)) await loadProject(id, name);
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
  ws.project = next;
  ws.sourceVisible = false;
  ws.branch = Object.hasOwn(ws.project.branches, nextBranch) ? nextBranch : 'main';
  rememberProject();
  changePrompt(previousThread);
  ws.selected = new Set();
  ws.region = undefined;
  ws.candidate = undefined;
  proposals = [];
  ws.view = { x: 0, y: 0, zoom: 1, grid: ws.view.grid, tool: 'select' };
  showProjectPanes(true);
  setMode('edit');
  renderProcessors();
  await refreshProposals();
  if (visit === ws.navigation) renderReview();
}

function changePrompt(previousThread: string) {
  const next = activityKey();
  if (previousThread === next) return;
  const input = $<HTMLTextAreaElement>('prompt');
  if (input.value) promptDrafts.set(previousThread, input.value);
  input.value = promptDrafts.get(next) ?? '';
  promptDrafts.delete(next);
}

async function refreshProposals() {
  const visit = ws.navigation;
  const key = activityKey();
  const result = await api<Proposal[]>(route('proposals') + '?branch=' + encodeURIComponent(ws.branch));
  if (visit === ws.navigation && key === activityKey()) proposals = result;
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

function render() {
  if (!ws.project) return;
  $<HTMLSelectElement>('project').value = ws.project.id;
  const list = $<HTMLSelectElement>('branch');
  list.replaceChildren(...Object.keys(ws.project.branches).map((name) => option(name, name)));
  list.value = ws.branch;
  for (const name of modes) byMode(name).setAttribute('aria-pressed', String(ws.mode === name));
  $('revision').textContent = 'Revision ' + current().id.slice(0, 8);
  const source = authored();
  const preview = stagedPreview();
  const sourceKey = [ws.project.id, ws.branch, current().id, preview?.proposal.id].join('/');
  if (registryRevision !== sourceKey) {
    registryRevision = sourceKey;
    ws.registered = [];
    markedObjects.clear();
    $<HTMLTextAreaElement>('game-source').value = (preview?.preview ?? current()).game?.html ?? '';
    $('save-source').hidden = true;
  }
  const revision = displayedRevision();
  const canPlay = Boolean(revision.game || (ws.mode === 'play' && revision.scene));
  const embedded = ws.mode !== 'play';
  const gameKey = canPlay ? sourceKey + (embedded ? '/preview' : '/play') : undefined;
  syncPlaytest(gameKey, preview?.proposal.id, embedded);
  renderViewport();
  $('details').textContent = (source ? ws.registered.length : legacyScene(current()).objects.length) + ' objects';
  renderObjects();
  renderMessages();
  renderReview();
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
  $('details').textContent = ws.registered.length + ' objects';
  if (listChanged) { renderObjects(); renderChips(); }
  else renderRegisteredInspector();
});

export function setMode(value: Mode) {
  if (!ws.project) return;
  ws.mode = value;
  if (ws.mode === 'play') {
    ws.sourceVisible = false;
    if (ws.previewError) ws.playtestKey = undefined;
  }
  const tips = {
    edit: 'Select to inspect · drag to move',
    context: 'Select, Shift-click or drag to mark context',
    review: 'Compare candidates against the original revision',
    play: 'Playing locally on a separate game origin',
  };
  $('hint').textContent = authored() && ws.mode !== 'play' ? 'Chat to edit this revision' : tips[ws.mode];
  if (ws.mode === 'review') attempt(async () => { await refreshProposals(); renderReview(); });
  render();
}

export async function showProposal(id: string) {
  const visit = ws.navigation;
  const key = activityKey();
  const preview = await api<Preview>(route('proposals/' + id));
  if (visit !== ws.navigation || key !== activityKey()) return;
  ws.candidate = preview;
  setMode('review');
}

export async function edit(label: string, operations: Operation[]) {
  const visit = ws.navigation;
  const applyRoute = route('apply');
  const staged = await api<Preview>(route('proposals'), { ...scope(), label, operations });
  await api(applyRoute + '/' + staged.proposal.id, {});
  if (visit !== ws.navigation) return;
  ws.region = undefined;
  ws.candidate = undefined;
  await refreshProject();
}

function renderReview() {
  const node = $('review');
  if (!node) return;
  node.hidden = ws.mode !== 'review';
  node.replaceChildren();
  if (node.hidden) return;
  const options = el('div', undefined, 'row');
  const original = action('Original', () => { ws.candidate = undefined; render(); });
  original.setAttribute('aria-pressed', String(!ws.candidate)); options.append(original);
  for (const [index, proposal] of proposals.entries()) {
    const button = action('Option ' + (index + 1), () => showProposal(proposal.id));
    button.title = proposal.label;
    button.setAttribute('aria-pressed', String(ws.candidate?.proposal.id === proposal.id));
    options.append(button);
  }
  if (!proposals.length) options.append(el('small', 'There are no pending proposals.'));
  node.append(options);
  if (!ws.candidate) return;
  const id = ws.candidate.proposal.id;
  const controls = el('div', undefined, 'row');
  controls.append(action('Discard', async () => {
    await api(route('discard/' + id), {}); ws.candidate = undefined; await refreshProject();
  }), action('Branch…', () => forkDialog(id)), action('Apply', async () => {
    await api(route('apply/' + id), {}); ws.candidate = undefined; ws.region = undefined; await refreshProject(); setMode('edit');
  }, 'primary'));
  node.append(controls);
}

function syncPlaytest(key: string | undefined, proposalId: string | undefined, embedded: boolean) {
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
      if (embedded) url.searchParams.set('preview', '1');
      $<HTMLIFrameElement>('playframe').src = url.href;
      $<HTMLAnchorElement>('open-player').href = testing.link;
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
  if (frame) { frame.removeAttribute('src'); frame.hidden = true; $('open-player').hidden = true; }
  if (previous) await api('rooms/' + previous.id + '/close', {});
}

export const library = createLibrary({
  active: () => ws.project?.id, open: loadProject, refresh: listProjects, removed: projectRemoved,
});

async function projectRemoved(id: string) {
  for (const [key, turn] of activityTurns) {
    if (!key.startsWith(id + '/')) continue;
    turn.connection?.abort();
    activityTurns.delete(key);
  }
  if (ws.project?.id === id) {
    const previousThread = activityKey();
    ws.navigation++;
    ws.project = undefined;
    rememberProject();
    changePrompt(previousThread);
    ws.playtest = undefined;
    await closePlaytest();
    ws.candidate = undefined;
    proposals = [];
    ws.registered = [];
    markedObjects.clear();
    registryRevision = '';
    for (const element of ['marked', 'chat-suggestions', 'details', 'revision']) $(element).replaceChildren();
    showProjectPanes(false);
    renderMessages();
    renderProcessors();
  }
  for (const key of promptDrafts.keys()) {
    if (key.startsWith(id + '/')) promptDrafts.delete(key);
  }
}

for (const name of modes) byMode(name).addEventListener('click', () => setMode(name));
document.addEventListener('click', (event) => {
  if (!event.composedPath().includes($('model-picker'))) ws.modelControl?.close();
}, { capture: true });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dialog.open && ws.modelControl?.close(true)) event.preventDefault();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dialog]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.dialog;
    if (!ws.project && name !== 'library') return;
    const handlers = { library: library.open, history: historyDialog, sharing: sharingDialog };
    attempt(handlers[name as keyof typeof handlers],button);
  });
}

$<HTMLSelectElement>('project').addEventListener('change', (event) => {
  const picker = event.target as HTMLSelectElement;
  const id = picker.value;
  picker.value = ws.project?.id ?? '';
  if (id === '+') library.create();
  else if (id) attempt(() => loadProject(id));
});
$<HTMLSelectElement>('branch').addEventListener('change', (event) => {
  const id = ws.project?.id;
  const selectedBranch = (event.target as HTMLSelectElement).value;
  if (id) attempt(() => loadProject(id, selectedBranch));
});

try {
  [ws.health] = await Promise.all([api<typeof ws.health>('health'), listProjects()]);
  $('host-status').textContent = 'Local workspace';
  await restoreProject().catch((error: Error) => inform(error.message, true));
  await refreshProcessors();
  window.addEventListener('focus', () => { if (!chatBusy()) void refreshProcessors(); });

} catch (error) {
  $('host-status').textContent = 'Workspace unavailable';
  inform((error as Error).message, true);
}
