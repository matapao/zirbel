import { chatStreamType, type ChatEvent, type ChatUpdate } from '../sdk/chat-stream.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let statusTimer: number;

function request(path: string, payload?: unknown, accept = 'application/json', signal?: AbortSignal) {
  const headers = new Headers({ accept });
  if (payload !== undefined) headers.set('content-type', 'application/json');
  return fetch(new URL('api/' + path, document.baseURI), {
    redirect: 'error',
    method: payload === undefined ? 'GET' : 'POST',
    headers,
    signal,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

async function json<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Zirbel could not complete the request.');
  return value as T;
}

export async function api<T = unknown>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  return json(await request(path, payload, undefined, signal));
}

export async function chatApi<T>(path: string, payload: unknown, update: (event: ChatUpdate) => void, signal: AbortSignal): Promise<T> {
  const response = await request(path, payload, chatStreamType, signal);
  if (response.headers.get('content-type')?.split(';')[0] !== chatStreamType || !response.ok) return json(response);
  if (!response.body) throw new Error('The chat connection closed before the reply arrived.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('The chat connection closed before the reply arrived.');
      const lines = (buffered + value).split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const event = JSON.parse(line) as ChatEvent<T>;
        if (event.type === 'result') return event.result;
        if (event.type === 'error') throw new Error(event.error);
        update(event);
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function el<K extends keyof HTMLElementTagNameMap>(name: K, text?: string, className?: string) {
  const node = document.createElement(name);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function action(label: string, fn: () => void | Promise<void>, className?: string) {
  const button = el('button', label, className);
  button.type = 'button';
  button.addEventListener('click', () => attempt(fn, button));
  return button;
}

export function link(label: string, url: string, external = false) {
  const a = el('a', label);
  a.href = url;
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}

export function inform(message: string, fault = false) {
  const node = $('status');
  node.hidden = false;
  node.textContent = message;
  node.classList.toggle('failed', fault);
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { node.hidden = true; }, fault ? 8000 : 3500);
}

export function attempt(fn: () => void | Promise<void>, button?: HTMLButtonElement) {
  if (button) button.disabled = true;
  void Promise.resolve().then(fn).catch((error: Error) => inform(error.message, true)).finally(() => {
    if (button) button.disabled = false;
  });
}

export const dialog = $<HTMLDialogElement>('dialog');

export function openDialog(title: string) {
  $('dialog-title').textContent = title;
  // Give each invocation its own body. Late responses can only update their original dialog.
  const body = document.createElement('div');
  body.id = 'dialog-body';
  $('dialog-body').replaceWith(body);
  if (!dialog.open) dialog.showModal();
  return body;
}

export function formValue(form: HTMLFormElement, name: string) {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}
export function option(value: string, label: string) { const node = el('option', label); node.value = value; return node; }
