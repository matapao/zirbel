// Split from workspace.ts; shares state through ws in state.ts.
import { $, action, attempt, el, formValue, option } from './editor-ui.ts';
import { markedObjects, ws } from './state.ts';
import { authored, bind, current, displayedRevision, displayedScene, edit, uid } from './workspace.ts';
import { renderChips } from './chat.ts';
import { WORLD, legacyScene, type Reference, type SceneObject } from '../sdk/contracts.ts';
import { assetDialog } from './dialogs.ts';
import { newObject, palette } from '../games/templates.ts';
import { scheduleDraw } from './viewport.ts';

export function renderObjects() {
  const objects = $('objects');
  if (!objects || !ws.project) return;
  const search = $<HTMLInputElement>('search').value.toLowerCase().trim();
  $<HTMLSelectElement>('add-object').closest('label')!.hidden = authored();
  if (authored()) {
    objects.replaceChildren();
    for (const item of ws.registered.filter(({ id, properties }) => (id + ' ' + (typeof properties.name === 'string' ? properties.name : '')).toLowerCase().includes(search))) {
      const button = action(typeof item.properties.name === 'string' ? item.properties.name : item.id, () => {
        if (markedObjects.has(item.id)) markedObjects.delete(item.id);
        else if (markedObjects.size < 32) markedObjects.add(item.id);
        renderObjects(); renderChips();
      }, 'object');
      button.setAttribute('aria-pressed', String(markedObjects.has(item.id)));
      objects.append(button);
    }
    if (!ws.registered.length) objects.append(el('p', displayedRevision().game?.registerObjects === false
      ? 'Object registration is off for this revision.' : 'Objects registered by the running game appear here.'));
    renderRegisteredInspector();
    renderAssets();
    return;
  }
  const matches = legacyScene(current()).objects.filter((item) => item.name.toLowerCase().includes(search) || item.kind.includes(search));
  const groups = new Map<string, SceneObject[]>();
  const pinned = ['rangers-cabin', 'mirror-pond', 'footbridge', 'campfire', 'player-spawn'];
  const organize = (item: SceneObject) => pinned.includes(item.id) || search ? '' :
    ({ tree: 'Trees', rock: 'Stones', crystal: 'Valley lights' } as Record<string,string>)[item.kind] ?? '';
  for (const item of matches) {
    const group = organize(item);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  const openGroups = new Set([...objects.querySelectorAll<HTMLDetailsElement>('details[open]')].map((details) => details.dataset.group));
  objects.replaceChildren();
  const row = (item: SceneObject) => {
    const button = el('button', undefined, 'object');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(ws.selected.has(item.id)));
    const dot = el('i');
    dot.style.setProperty('--object', item.color);
    button.append(dot, el('span', item.name));
    button.addEventListener('click', (event) => choose(item, event.shiftKey || event.metaKey));
    return button;
  };
  for (const [group, items] of groups) {
    if (!group) { objects.append(...items.map(row)); continue; }
    const details = el('details');
    details.dataset.group = group;
    details.open = openGroups.has(group) || items.some((item) => ws.selected.has(item.id));
    details.append(el('summary', group + ' · ' + items.length), ...items.map(row));
    objects.append(details);
  }
  if (!matches.length) objects.append(el('p', search ? 'No matching objects.' : 'Add an object to start the scene.'));
  renderInspector();
  renderAssets();
}

export function renderRegisteredInspector() {
  $('inspector').replaceChildren(el('h3', 'Inspector'), ...ws.registered.filter(({ id }) => markedObjects.has(id))
      .map((item) => el('pre', JSON.stringify(item, null, 2))));
}

function renderInspector() {
  const node = $('inspector');
  node.replaceChildren(el('h3', 'Inspector'));
  const reviewing = ws.mode === 'review';
  const items = displayedScene().objects.filter((item) => ws.selected.has(item.id));
  const item = items[0];
  if (!item || items.length > 1) {
    node.append(el('p', items.length ? items.length + ' objects selected' : 'Select an object to edit its properties.'));
    return;
  }
  const form = el('form');
  for (const [name, label, type, value, max] of [
    ['name', 'Name', 'text', item.name, 80],
    ['x', 'X', 'number', item.x, WORLD.width], ['y', 'Y', 'number', item.y, WORLD.height],
    ['size', 'Size', 'number', item.size, 340], ['color', 'Color', 'color', item.color, undefined],
  ] as const) {
    const input = el('input');
    input.name = name; input.type = type; input.value = String(value); input.required = true;
    input.disabled = reviewing;
    if (type === 'text' && max) input.maxLength = max;
    if (type === 'number' && max) { input.max = String(max); input.min = name === 'size' ? '8' : '0'; input.step = 'any'; }
    const target = el('label', label); target.append(input); form.append(target);
  }
  const buttons = el('div', undefined, 'row');
  const submit = el('button', 'Save');
  if (!reviewing) {
    buttons.append(submit, action('Remove', async () => { await edit('Remove ' + item.name, [{ op: 'remove', id: item.id }]); }, 'danger'));
    form.append(buttons);
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(() => edit('Edit ' + item.name, [{
      op: 'update', id: item.id,
      changes: { name: formValue(form,'name'), x: Number(formValue(form,'x')), y: Number(formValue(form,'y')),
        size: Number(formValue(form,'size')), color: formValue(form,'color') },
    }]), submit);
  });
  node.append(form);
}

function renderAssets() {
  const node = $('assets');
  node.replaceChildren(action('Import image asset', () => assetDialog()));
  if (!current().assets.length) node.append(el('p', 'No imported assets.'));
  for (const asset of current().assets) {
    const item = el('div', undefined, 'item');
    item.append(el('strong',asset.name), el('small', asset.author + ' · ' + asset.license),
      action('Remove', () => edit('Remove asset ' + asset.name, [{ op: 'removeAsset', id: asset.id }])));
    node.append(item);
  }
}

export function setupObjects() {
  const add = $<HTMLSelectElement>('add-object');
  for (const value of Object.keys(palette)) add.append(option(value, value.charAt(0).toUpperCase() + value.slice(1)));
  bind('search', 'input', renderObjects);
  add.addEventListener('change', () => {
    const kind = add.value as SceneObject['kind'];
    if (!kind) return;
    add.value = '';
    const item = newObject(kind, uid(), 480, 300);
    attempt(async () => { await edit('Add ' + item.name, [{ op: 'add', object: item }]); choose(item, false); });
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-panel]')) button.addEventListener('click', () => {
    const objects = button.dataset.panel === 'objects';
    for (const element of document.querySelectorAll('[data-panel]')) element.setAttribute('aria-pressed', String(element === button));
    for (const id of ['objects', 'object-tools','inspector']) $(id).hidden = !objects;
    $('assets').hidden = objects;
  });
  if (ws.project) renderObjects();
}

export function choose(item: SceneObject, additive: boolean) {
  if (!additive) { ws.selected.clear(); ws.region = undefined; }
  if (additive && ws.selected.has(item.id)) ws.selected.delete(item.id);
  else if (ws.selected.size < 32) ws.selected.add(item.id);
  $('hits').hidden = true;
  renderObjects();
  renderChips();
  scheduleDraw();
}

export function references(): Reference[] {
  const revision = current();
  if (authored() || !revision.scene) return [];
  const base = { sceneId: revision.scene.id, revision: revision.id };
  const byId = new Map(revision.scene.objects.map((object) => [object.id, object]));
  const refs: Reference[] = [...ws.selected].flatMap((id) => {
    const object = byId.get(id);
    return object ? [{ ...base, type: 'instance', object }] : [];
  });
  if (ws.region) refs.unshift({ ...base, type: 'region', bounds: ws.region, objects: [] });
  return refs.slice(0,32);
}
