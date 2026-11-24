// Split from workspace.ts; shares state through ws in state.ts.
// The stage: the running game, and in Edit its tools, the object list and the source. A template scene without a game
// shows its scene editor in Edit and plays in the player otherwise.
import { authored, bind, current, displayedRevision, displayedScene, edit, render } from './workspace.ts';
import { type Box, ws } from './state.ts';
import { $, attempt } from './editor-ui.ts';
import { drawScene, hitObjects } from './scene.ts';
import { WORLD, type SceneObject } from '../sdk/contracts.ts';
import { choose, renderObjects } from './inspector.ts';
import { renderChips } from './chat.ts';
import { renderEditing } from './edit-mode.ts';
import { renderMessages } from './thread.ts';
import { setThreadOpen } from './desk.ts';

// The viewport's own state. What the workspace modules share is in ws.
let drawFrame = 0;
let drag: { start: { x: number; y: number }; clientX: number; clientY: number; panX: number; panY: number;
  object?: SceneObject; moved?: SceneObject; region?: Box; movedPointer: boolean } | undefined;

export function renderViewport() {
  if (!ws.project) return;
  const revision = displayedRevision();
  const sceneEditor = ws.editing && !authored();
  const sourceShown = ws.editing && ws.sourceVisible && Boolean(revision.game);
  $('edit-bar').hidden = !ws.editing;
  $('view-tools').hidden = !sceneEditor;
  const objectsToggle = $('toggle-objects');
  objectsToggle.setAttribute('aria-pressed', String(ws.objectsOpen));
  $('objects-drawer').hidden = !ws.editing || !ws.objectsOpen;
  const sourceToggle = $('toggle-source');
  sourceToggle.hidden = !revision.game;
  sourceToggle.setAttribute('aria-pressed', String(sourceShown));
  $('source-drawer').hidden = !sourceShown;
  const source = $<HTMLTextAreaElement>('game-source');
  // The source is editable in Edit, on the saved revision; a proposal's source is shown as it is.
  source.readOnly = !ws.editing || Boolean(ws.candidate);
  $('save-source').hidden = source.readOnly || source.value === (current().game?.html ?? '');
  $('playframe').hidden = sceneEditor || !ws.playtest;
  $('scene-wrap').hidden = !sceneEditor;
  const tag = $('preview-tag');
  tag.hidden = !ws.candidate;
  tag.textContent = ws.candidate ? 'After · ' + ws.candidate.proposal.label : '';
  const message = $('preview-message');
  message.hidden = sceneEditor || Boolean(ws.playtest);
  message.textContent = ws.previewError || 'Opening game…';
  $('show-thread').hidden = ws.threadOpen;
}

export function scheduleDraw() {
  if (!ws.project || authored() || !$('scene') || drawFrame) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0;
    if (!ws.project || authored()) return;
    const canvas = $<HTMLCanvasElement>('scene');
    const ctx = canvas.getContext('2d')!;
    ctx.resetTransform();
    ctx.fillStyle = '#15251c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ws.view.zoom, 0, 0, ws.view.zoom, ws.view.x, ws.view.y);
    const active = displayedScene();
    const scene = drag?.moved ? { ...active, objects: active.objects.map((item) => item.id === drag?.moved?.id ? drag.moved : item) } : active;
    drawScene(ctx, scene, { selected: ws.selected, blank: ws.project.template === 'blank' || ws.project.template === 'tessellate',
      grid: ws.view.grid, region: drag?.region ?? ws.region, time: 1000 });
    $('zoom').textContent = Math.round(ws.view.zoom * 100) + '%';
  });
}

function point(event: PointerEvent) {
  const bounds = $('scene').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(WORLD.width, ((event.clientX - bounds.left) / bounds.width * WORLD.width - ws.view.x) / ws.view.zoom)),
    y: Math.max(0, Math.min(WORLD.height, ((event.clientY - bounds.top) / bounds.height * WORLD.height - ws.view.y) / ws.view.zoom)),
  };
}

function setupStageControls() {
  const source = $<HTMLTextAreaElement>('game-source');
  bind('toggle-objects', 'click', () => { ws.objectsOpen = !ws.objectsOpen; renderEditing(); });
  bind('toggle-source', 'click', () => { ws.sourceVisible = !ws.sourceVisible; renderViewport(); if (ws.sourceVisible) source.focus(); });
  bind('game-source', 'input', () => { $('save-source').hidden = source.value === (current().game?.html ?? ''); });
  bind('save-source', 'click', () => attempt(() => edit('Edit game source', [{ op: 'writeGame',
    game: { ...current().game, html: source.value, maxPlayers: current().game?.maxPlayers ?? 1 } }]), $<HTMLButtonElement>('save-source')));
  bind('show-thread', 'click', () => {
    setThreadOpen(true);
    render();
    $('hide-thread').focus();
    renderMessages();
  });
}

export function setupScene() {
  setupStageControls();
  const canvas = $<HTMLCanvasElement>('scene');
  const tool = (name: 'select' | 'pan') => {
    ws.view.tool = name; canvas.classList.toggle('pan', name === 'pan');
    $('select-tool').setAttribute('aria-pressed', String(name === 'select'));
    $('pan-tool').setAttribute('aria-pressed', String(name === 'pan'));
  };
  bind('select-tool','click',() => tool('select'));
  bind('pan-tool','click',() => tool('pan'));
  bind('fit','click',() => { Object.assign(ws.view, { x: 0, y: 0, zoom: 1 }); scheduleDraw(); });
  bind('grid-tool','click',() => { ws.view.grid = !ws.view.grid; $('grid-tool').setAttribute('aria-pressed', String(ws.view.grid)); scheduleDraw(); });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * WORLD.width;
    const y = (event.clientY - bounds.top) / bounds.height * WORLD.height;
    const before = ws.view.zoom;
    ws.view.zoom = Math.min(3, Math.max(.65, before * Math.exp(-event.deltaY / 600)));
    ws.view.x = x - (x - ws.view.x) * ws.view.zoom / before;
    ws.view.y = y - (y - ws.view.y) * ws.view.zoom / before;
    scheduleDraw();
  }, { passive: false });
  canvas.addEventListener('pointerdown', (event) => {
    // A proposal shown After is for comparing; edits go to the saved revision.
    if (!ws.project || !ws.editing || ws.candidate || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const start = point(event);
    drag = { start, clientX: event.clientX, clientY: event.clientY, panX: ws.view.x, panY: ws.view.y, movedPointer: false,
      object: ws.view.tool === 'select' ? hitObjects(displayedScene(), start.x, start.y)[0] : undefined };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
    if (Math.hypot(dx, dy) <= 5 && !drag.movedPointer) return;
    drag.movedPointer = true;
    const end = point(event);
    if (ws.view.tool === 'pan') {
      const bounds = canvas.getBoundingClientRect();
      ws.view.x = drag.panX + dx * WORLD.width / bounds.width;
      ws.view.y = drag.panY + dy * WORLD.height / bounds.height;
    } else if (drag.object) {
      drag.moved = { ...drag.object, x: Math.round(Math.max(0, Math.min(WORLD.width, drag.object.x + end.x - drag.start.x))),
        y: Math.round(Math.max(0, Math.min(WORLD.height, drag.object.y + end.y - drag.start.y))) };
    } else {
      // A drag across empty space marks a region for the next message.
      drag.region = { x: Math.min(end.x, drag.start.x), y: Math.min(end.y, drag.start.y),
        width: Math.abs(end.x - drag.start.x), height: Math.abs(end.y - drag.start.y) };
    }
    scheduleDraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    const ended = drag;
    drag = undefined;
    if (!ended || ws.view.tool === 'pan') return;
    if (ended.moved) {
      const { id, name, x, y } = ended.moved;
      attempt(async () => { await edit('Move ' + name, [{ op: 'update', id, changes: { x, y } }]); choose(ended.moved!, false); });
    } else if (ended.region && ended.region.width > 0 && ended.region.height > 0) {
      if (!event.shiftKey) ws.selected.clear();
      ws.region = ended.region; renderChips(); renderObjects(); scheduleDraw();
    } else if (!ended.movedPointer) {
      const match = hitObjects(displayedScene(), ended.start.x, ended.start.y)[0];
      if (match) choose(match, event.shiftKey || event.metaKey);
      else { ws.selected.clear(); ws.region = undefined; renderChips(); renderObjects(); scheduleDraw(); }
    }
  });
  canvas.addEventListener('pointercancel', () => { drag = undefined; scheduleDraw(); });
  scheduleDraw();
}
