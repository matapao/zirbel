// What a harness asks during a turn, as a card under its row: a permission in plain language, a form, or a page to
// open. The headline says what it wants to do, the harness's own reason follows as plain text, a badge says whether
// that stays in the turn's sandbox, and the exact command, file or change waits in the closed details. The buttons are
// the harness's own options.
import type { ActionField, ActionValue, HarnessAction } from '../sdk/chat-stream.ts';
import { $, action, api, attempt, el, link, option } from './editor-ui.ts';
import { diffView } from './activity-rows.ts';

const SHIELD =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5 13.5 3.5v4c0 3.2-2.3 5.8-5.5 7-3.2-1.2-5.5-3.8-5.5-7v-4z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ALERT =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 6v4M8 11.6v.2" stroke="currentColor" stroke-width="1.6"/></svg>';
let cards = 0;

/** The headline a request shows: never the raw command. */
export const headlineOf = (request: HarnessAction) => {
  if (request.kind === 'permission') return request.summary;
  return request.kind === 'link' ? 'Open a web page' : request.title || 'Fill in a form';
};

function scopeBadge(request: HarnessAction) {
  const badge = el('p', undefined, 'scope');
  badge.dataset.scope = request.scope;
  const icon = el('span', undefined, 'scope-icon');
  icon.innerHTML = request.scope === 'sandboxed' ? SHIELD : ALERT;
  badge.append(
    icon,
    el('strong', request.scope === 'sandboxed' ? 'Sandboxed' : 'Outside the sandbox'),
    el('span', request.reach, 'scope-reach'),
  );
  return badge;
}

/** The harness's reason, in its own words: set as text, never read as HTML or Markdown. */
function reasonLine(reason: string) {
  const line = el('p', undefined, 'ask-reason');
  line.append(el('span', 'Why it’s asking', 'ask-label'), el('span', reason, 'ask-reason-text'));
  return line;
}

function details(request: Extract<HarnessAction, { kind: 'permission' }>) {
  const box = el('details', undefined, 'ask-details');
  box.append(el('summary', 'Details'));
  if (request.command) box.append(el('span', 'Command', 'ask-label'), el('pre', request.command, 'command'));
  if (request.folder) box.append(el('p', 'Folder: ' + (request.folder === '.' ? 'the turn’s folder' : request.folder)));
  if (request.file) box.append(el('p', 'File: ' + request.file));
  if (request.diff) box.append(diffView(request.diff));
  if (request.tool) box.append(el('p', 'Tool: ' + request.tool));
  if (request.detail) {
    const raw = el('details', undefined, 'ask-raw');
    raw.append(el('summary', 'Raw input'), el('pre', request.detail));
    box.append(raw);
  }
  return box;
}

export function actionCard(run: string, request: HarnessAction, harness: string) {
  const card = el('section', undefined, 'ask-card');
  card.dataset.actionId = request.id;
  card.tabIndex = -1;
  const title = el('strong', headlineOf(request), 'ask-title');
  title.id = 'ask-' + ++cards;
  card.setAttribute('aria-labelledby', title.id);
  card.append(el('span', harness + ' asks', 'ask-from'), title);
  if (request.kind === 'permission' && request.reason) card.append(reasonLine(request.reason));
  card.append(scopeBadge(request));
  const answer = async (payload: object) => {
    await api('chat/' + run + '/actions/' + request.id, payload);
  };
  const buttons = el('div', undefined, 'row ask-options');
  if (request.kind === 'permission') {
    card.append(details(request));
    for (const choice of request.options)
      buttons.append(action(choice.title, () => answer({ choice: 'option', option: choice.id })));
    if (!request.options.length) buttons.append(action('Dismiss', () => answer({ choice: 'dismiss' })));
    card.append(buttons);
    return card;
  }
  const form = el('form');
  if (request.kind === 'link') card.append(el('p', request.title), link('Open requested page ↗', request.url, true));
  const fields = request.kind === 'form' ? request.fields : [];
  for (const field of fields) form.append(fieldControl(field));
  const submit = el('button', request.kind === 'link' ? 'Continue' : 'Send response', 'primary');
  buttons.append(
    submit,
    action('Decline', () => answer({ choice: 'decline' })),
  );
  form.append(buttons);
  card.append(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const values = Object.fromEntries(
      fields.flatMap((field) => {
        const value = fieldValue(field, data);
        return value === undefined ? [] : [[field.name, value]];
      }),
    );
    attempt(() => answer({ choice: 'submit', values }), submit);
  });
  return card;
}

/** Says a new request aloud for screen readers, as the card takes focus. */
export function announce(text: string) {
  const node = $('announcer');
  node.textContent = '';
  setTimeout(() => {
    node.textContent = text;
  }, 50);
}

function fieldControl(field: ActionField) {
  const label = el('label', field.title);
  if (field.description) label.append(el('small', field.description));
  const choices =
    field.type === 'boolean'
      ? [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]
      : field.choices;
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
    const items = field.choices?.length
      ? values
      : values.flatMap((value) =>
          value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        );
    return items.length ? items : undefined;
  }
  const value = data.get(field.name);
  if (typeof value !== 'string' || !value) return;
  if (field.type === 'boolean') return value === 'true';
  if (field.type === 'number' || field.type === 'integer') return Number(value);
  return value;
}
