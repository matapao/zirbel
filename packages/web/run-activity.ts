import type { ActionField, ActionValue, ActivityEntry, HarnessAction } from '../sdk/chat-stream.ts';
import { $, action, api, attempt, el, link, option } from './editor-ui.ts';

const states = { pending: 'Pending', running: 'Running', waiting: 'Needs a response', idle: 'Idle', completed: 'Completed', failed: 'Failed' };

export function renderRunEntries(entries?: ReadonlyMap<string, ActivityEntry>) {
  const list = $('chat-events');
  list.replaceChildren();
  if (!entries?.size) return;
  const groups = new Map<string | undefined, ActivityEntry[]>();
  for (const entry of entries.values()) {
    const parent = entry.parent && entries.has(entry.parent) ? entry.parent : undefined;
    const siblings = groups.get(parent) ?? [];
    siblings.push(entry);
    groups.set(parent, siblings);
  }
  const seen = new Set<string>();
  const render = (entry: ActivityEntry, parent: HTMLElement, depth: number) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const item = el('div', undefined, 'chat-event');
    const title = entry.kind === 'helper' ? 'Helper · ' + entry.title : entry.title;
    item.append(el('strong', title));
    if (entry.state) item.append(el('small', states[entry.state]));
    if (entry.detail) item.append(el('div', entry.detail, 'chat-event-detail'));
    parent.append(item);
    if (depth < 5) for (const child of groups.get(entry.id) ?? []) render(child, item, depth + 1);
  };
  for (const entry of groups.get(undefined) ?? []) render(entry, list, 0);
  for (const entry of entries.values()) render(entry, list, 0);
}

export function renderRunActions(run: string | undefined, actions?: ReadonlyMap<string, HarnessAction>) {
  const list = $('chat-actions');
  for (const child of list.querySelectorAll<HTMLElement>('[data-action-id]')) {
    if (!actions?.has(child.dataset.actionId ?? '')) child.remove();
  }
  if (!run || !actions) return;
  const visible = new Set([...list.children].map((child) => (child as HTMLElement).dataset.actionId));
  for (const request of actions.values()) {
    if (!visible.has(request.id)) list.append(actionCard(run, request));
  }
}

function actionCard(run: string, request: HarnessAction) {
  const card = el('section', undefined, 'chat-action');
  card.dataset.actionId = request.id;
  card.append(el('strong', request.title));
  const answer = async (payload: object) => {
    await api('chat/' + run + '/actions/' + request.id, payload);
  };
  const buttons = el('div', undefined, 'row');
  if (request.kind === 'permission') {
    if (request.detail) card.append(el('pre', request.detail));
    for (const option of request.options) buttons.append(action(option.title, () => answer({ choice: 'option', option: option.id })));
    buttons.append(action('Dismiss', () => answer({ choice: 'dismiss' })));
    card.append(buttons);
    return card;
  }
  const form = el('form');
  if (request.kind === 'link') card.append(link('Open requested page ↗', request.url, true));
  const fields = request.kind === 'form' ? request.fields : [];
  for (const field of fields) form.append(fieldControl(field));
  const submit = el('button', request.kind === 'link' ? 'Continue' : 'Send response');
  buttons.append(submit, action('Decline', () => answer({ choice: 'decline' })));
  form.append(buttons);
  card.append(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const values = Object.fromEntries(fields.flatMap((field) => {
      const value = fieldValue(field, data);
      return value === undefined ? [] : [[field.name, value]];
    }));
    attempt(() => answer({ choice: 'submit', values }), submit);
  });
  return card;
}

function fieldControl(field: ActionField) {
  const label = el('label', field.title);
  if (field.description) label.append(el('small', field.description));
  const choices = field.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.choices;
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (choices?.length) {
    input = el('select');
    input.multiple = field.type === 'array';
    if (!input.multiple) input.append(option('', 'Choose…'));
    input.append(...choices.map(({ value, label }) => option(value, label)));
  } else if (field.type === 'array') {
    input = el('textarea');
    input.placeholder = 'One value per line';
    input.maxLength = 4000;
  } else {
    input = el('input');
    input.type = field.type === 'string' ? 'text' : 'number';
    input.step = field.type === 'integer' ? '1' : 'any';
    input.maxLength = 4000;
  }
  input.name = field.name;
  input.required = field.required;
  label.append(input);
  return label;
}

function fieldValue(field: ActionField, data: FormData): ActionValue | undefined {
  if (field.type === 'array') {
    const values = data.getAll(field.name).map(String);
    const items = field.choices?.length ? values : values.flatMap((value) => value.split('\n').map((line) => line.trim()).filter(Boolean));
    return items.length ? items : undefined;
  }
  const value = data.get(field.name);
  if (typeof value !== 'string' || !value) return;
  if (field.type === 'boolean') return value === 'true';
  if (field.type === 'number' || field.type === 'integer') return Number(value);
  return value;
}
