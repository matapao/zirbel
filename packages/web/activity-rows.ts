// A harness turn's steps in the thread, in order: its plan, tool calls and commands, file edits, messages and
// requests. Each step is one compact row; a row with more to show expands in place. Rows are kept by step id, so a
// running turn updates only the step that changed.
import type { ActivityEntry } from '../sdk/chat-stream.ts';
import { el } from './editor-ui.ts';

const kinds: Record<ActivityEntry['kind'], string> = {
  message: 'Message',
  plan: 'Plan',
  tool: 'Tool',
  helper: 'Helper',
  file: 'File',
  notice: 'Note',
  request: 'Request',
};
const states: Record<NonNullable<ActivityEntry['state']>, string> = {
  pending: 'Pending',
  running: 'Running',
  waiting: 'Needs a response',
  idle: 'Idle',
  completed: 'Done',
  failed: 'Failed',
};
type Row = { item: HTMLLIElement; entry: ActivityEntry; children?: HTMLOListElement };
const rowsOf = new WeakMap<HTMLElement, Map<string, Row>>();
let rows = 0;

export function createSteps() {
  const list = el('ol', undefined, 'steps');
  list.setAttribute('aria-label', 'Harness steps');
  rowsOf.set(list, new Map());
  return list;
}

const firstLine = (text = '') => text.trim().split('\n', 1)[0] ?? '';

function titleOf(entry: ActivityEntry) {
  if (entry.kind === 'message') return firstLine(entry.detail) || entry.title;
  if (entry.kind === 'plan' && entry.detail) {
    const items = entry.detail.split('\n');
    return items.filter((line) => line.startsWith('Completed')).length + ' of ' + items.length + ' done';
  }
  return entry.title;
}

function stateOf(entry: ActivityEntry) {
  if (entry.kind === 'request' && entry.state === 'completed') return firstLine(entry.detail);
  return entry.state ? states[entry.state] : '';
}

const expandable = (entry: ActivityEntry) =>
  Boolean(entry.diff || (entry.detail && entry.detail.trim() !== titleOf(entry)));

/** A diff as lines marked added or removed. */
export function diffView(diff: string) {
  const view = el('pre', undefined, 'diff');
  for (const line of diff.split('\n')) {
    const kind =
      line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')
        ? 'meta'
        : line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : '';
    view.append(el('span', line + '\n', kind || undefined));
  }
  return view;
}

function fillBody(body: HTMLElement, entry: ActivityEntry) {
  body.replaceChildren();
  if (entry.detail) body.append(el('pre', entry.detail, 'step-detail'));
  if (entry.diff) body.append(diffView(entry.diff));
}

function drawRow(row: Row) {
  const { item, entry } = row;
  item.dataset.kind = entry.kind;
  if (entry.state) item.dataset.state = entry.state;
  else delete item.dataset.state;
  const open = item.dataset.open === 'true';
  const canOpen = expandable(entry);
  const head = canOpen ? el('button', undefined, 'step-head') : el('div', undefined, 'step-head');
  head.append(el('span', kinds[entry.kind], 'step-kind'), el('span', titleOf(entry), 'step-title'));
  const state = stateOf(entry);
  if (state) head.append(el('span', state, 'step-state'));
  let body = item.querySelector<HTMLElement>(':scope > .step-body');
  if (canOpen) {
    if (!body) {
      body = el('div', undefined, 'step-body');
      body.id = 'step-' + ++rows;
      body.hidden = true;
    }
    const button = head as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-controls', body.id);
    button.addEventListener('click', () => {
      const opening = item.dataset.open !== 'true';
      item.dataset.open = String(opening);
      button.setAttribute('aria-expanded', String(opening));
      body!.hidden = !opening;
      if (opening) fillBody(body!, row.entry);
    });
    if (open) fillBody(body, entry);
  } else body?.remove();
  const previous = item.querySelector(':scope > .step-head');
  if (previous) previous.replaceWith(head);
  else item.prepend(head);
  if (body && !body.isConnected) head.after(body);
}

/** Adds a step or redraws it where it is. A step whose parent is shown sits under it. */
export function upsertStep(list: HTMLElement, entry: ActivityEntry) {
  const known = rowsOf.get(list);
  if (!known) return;
  let row = known.get(entry.id);
  if (!row) {
    row = { item: el('li', undefined, 'step'), entry };
    known.set(entry.id, row);
    const parent = entry.parent ? known.get(entry.parent) : undefined;
    if (parent) {
      parent.children ??= parent.item.appendChild(el('ol', undefined, 'steps'));
      parent.children.append(row.item);
    } else list.append(row.item);
  }
  row.entry = entry;
  drawRow(row);
  return row.item;
}

export function removeSteps(list: HTMLElement, ids: string[], dropped: number) {
  const known = rowsOf.get(list);
  for (const id of ids) {
    known?.get(id)?.item.remove();
    known?.delete(id);
  }
  let note = list.querySelector<HTMLElement>(':scope > .steps-dropped');
  if (!dropped) {
    note?.remove();
    return;
  }
  note ??= list.insertBefore(el('li', undefined, 'steps-dropped'), list.firstChild);
  note.textContent =
    dropped +
    (dropped === 1 ? ' earlier step was' : ' earlier steps were') +
    ' not kept: this turn passed its size limit.';
}

export function fillSteps(list: HTMLElement, entries: Iterable<ActivityEntry>, dropped: number) {
  for (const entry of entries) upsertStep(list, entry);
  removeSteps(list, [], dropped);
}

/** The row of a request, where its card goes while the request is open. */
export const requestRow = (list: HTMLElement, actionId: string) => rowsOf.get(list)?.get('request:' + actionId)?.item;
