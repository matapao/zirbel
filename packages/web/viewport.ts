// Split from workspace.ts; shares state through ws in state.ts.
import { authored, bind, current, displayedRevision, displayedScene, edit, route } from './workspace.ts';
import { type Box, ws } from './state.ts';
import { $, action, attempt } from './editor-ui.ts';
import { drawScene, hitObjects } from './scene.ts';
import { WORLD, legacyScene, type SceneObject } from '../sdk/contracts.ts';
import { choose, renderObjects } from './inspector.ts';
import { renderChips } from './chat.ts';
import { openGame } from './library.ts';

// The viewport's own state. What the workspace modules share is in ws.
let drawFrame = 0;
let drag: { start: { x: number; y: number }; clientX: number; clientY: number; panX: number; panY: number;
  object?: SceneObject; moved?: SceneObject; region?: Box; movedPointer: boolean } | undefined;

export function renderViewport() {
  const revision = displayedRevision();
  const legacyEdit = !authored() && ws.mode !== 'play';
  const canToggle = Boolean(revision.game);
  const showSource = canToggle && ws.sourceVisible;
  const toggle = $('toggle-source');
  toggle.hidden = !canToggle;
  toggle.setAttribute('aria-pressed', String(showSource));
  $('source-pane').hidden = !showSource;
  const source = $<HTMLTextAreaElement>('game-source');
  source.readOnly = ws.mode !== 'edit';
  $('save-source').hidden = source.readOnly || source.value === (revision.game?.html ?? '');
  $('playframe').hidden = showSource || !ws.playtest;
  $('open-player').hidden = showSource || !ws.playtest;
  $('scene-wrap').hidden = !legacyEdit;
  $('view-tools').hidden = !legacyEdit;
  $('zoom').hidden = !legacyEdit;
  document.querySelector<HTMLElement>('.viewport-meta')!.hidden = !legacyEdit;
  document.querySelector<HTMLElement>('.scene-bottom span:last-child')!.hidden = !legacyEdit;
  const message = $('preview-message');
  message.hidden = showSource || legacyEdit || Boolean(ws.playtest);
  message.textContent = ws.previewError || (ws.playtestKey ? 'Opening game…' : 'Describe a game in Activity to build this project.');
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
    $('preview-tag').textContent = ws.mode === 'review' && ws.candidate ? ws.candidate.proposal.label : 'Saved revision · ' + current().id.slice(0, 8);
  });
}

function point(event: PointerEvent) {
  const bounds = $('scene').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(WORLD.width, ((event.clientX - bounds.left) / bounds.width * WORLD.width - ws.view.x) / ws.view.zoom)),
    y: Math.max(0, Math.min(WORLD.height, ((event.clientY - bounds.top) / bounds.height * WORLD.height - ws.view.y) / ws.view.zoom)),
  };
}

export function setupScene() {
  const source = $<HTMLTextAreaElement>('game-source');
  bind('toggle-source', 'click', () => { ws.sourceVisible = !ws.sourceVisible; renderViewport(); });
  bind('game-source', 'input', () => { $('save-source').hidden = source.value === (current().game?.html ?? ''); });
  bind('save-source', 'click', () => attempt(() => edit('Edit game source', [{ op: 'writeGame',
    game: { ...current().game, html: source.value, maxPlayers: current().game?.maxPlayers ?? 1 } }]), $<HTMLButtonElement>('save-source')));
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
    if (!ws.project || !['edit', 'context'].includes(ws.mode) || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const start = point(event);
    drag = { start, clientX: event.clientX, clientY: event.clientY, panX: ws.view.x, panY: ws.view.y, movedPointer: false,
      object: ws.view.tool === 'select' && ws.mode === 'edit' ? hitObjects(legacyScene(current()), start.x, start.y)[0] : undefined };
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
    } else if (ws.mode === 'context') {
      drag.region = { x: Math.min(end.x, drag.start.x), y: Math.min(end.y, drag.start.y),
        width: Math.abs(end.x - drag.start.x), height: Math.abs(end.y - drag.start.y) };
    } else if (drag.object) {
      drag.moved = { ...drag.object, x: Math.round(Math.max(0, Math.min(WORLD.width, drag.object.x + end.x - drag.start.x))),
        y: Math.round(Math.max(0, Math.min(WORLD.height, drag.object.y + end.y - drag.start.y))) };
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
      const matches = hitObjects(legacyScene(current()), ended.start.x, ended.start.y);
      if (matches.length > 1 && ws.mode === 'context') {
        const menu = $('hits');
        menu.hidden = false;
        menu.replaceChildren(...matches.map((item) => action(item.name, () => choose(item, event.shiftKey || event.metaKey))));
      } else if (matches[0]) choose(matches[0], event.shiftKey || event.metaKey);
      else { ws.selected.clear(); ws.region = undefined; $('hits').hidden = true; renderChips(); renderObjects(); scheduleDraw(); }
    }
  });
  canvas.addEventListener('pointercancel', () => { drag = undefined; scheduleDraw(); });
  $('open-player').addEventListener('click', (event) => {
    event.preventDefault();
    if (ws.project) openGame(route('playtest'), { branch: ws.branch, proposalId: ws.candidate?.proposal.id });
  });
  scheduleDraw();
}
