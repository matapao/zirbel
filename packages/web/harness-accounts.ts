import type { Processor, SignInStatus } from '../server/processors.ts';
import { action, api, attempt, dialog, el, link, openDialog } from './editor-ui.ts';

/** notes: a plain word for a harness's card, by its id. */
type AccountChoices = { providers: Processor[]; notice: string; notes?: Record<string, string> };

export function showHarnessAccounts(refresh: () => Promise<AccountChoices>) {
  const body = openDialog('Harnesses');
  const reload = async () => {
    const { providers, notice, notes = {} } = await refresh();
    if (dialog.open && body.isConnected) render(providers, notice, notes);
  };
  function render(providers: Processor[], notice: string, notes: Record<string, string>) {
    body.replaceChildren();
    for (const processor of providers) {
      const item = el('section', undefined, 'item');
      const detail = processor.ready !== false ? 'Ready' : processor.signIn ? 'Signed out' : processor.detail ?? 'Unavailable';
      item.append(el('strong', processor.name), el('small', detail));
      const note = Object.hasOwn(notes, processor.id) ? notes[processor.id] : undefined;
      if (note && processor.signIn) item.append(el('p', note));
      if (processor.signIn) item.append(action('Sign in to ' + processor.name, () => signInHarness(item, processor, reload), 'primary'));
      body.append(item);
    }
    if (!providers.length) body.append(el('p', notice));
    body.append(action('Refresh harnesses', reload));
  }
  return reload();
}

async function signInHarness(item: HTMLElement, processor: Processor, reload: () => Promise<void>) {
  const path = 'processors/' + processor.id + '/sign-in';
  let state = await api<SignInStatus>(path, {});
  const controls = el('div');
  const status = el('p', 'Complete sign-in in your browser.');
  status.setAttribute('role', 'status');
  controls.append(status);
  item.replaceChildren(el('strong', processor.name), controls);
  const form = el('form');
  const label = el('label', 'Sign-in code, if requested');
  const code = el('input');
  code.maxLength = 2048;
  code.autocomplete = 'off';
  label.append(code);
  const submit = el('button', 'Submit code');
  form.append(label, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!code.value.trim()) return;
    attempt(async () => { await api(path, { code: code.value.trim() }); code.value = ''; }, submit);
  });
  controls.append(form);
  let signInLink: HTMLAnchorElement | undefined;
  let userCode: HTMLElement | undefined;
  while (state.status === 'pending' && dialog.open && item.isConnected) {
    if (state.url && !signInLink) {
      signInLink = link('Open ' + processor.name + ' sign-in', state.url, true);
      controls.insertBefore(signInLink, form);
    }
    // A sign-in finished on another device: its page, and the one-time code to enter there.
    if (state.userCode && !userCode) {
      status.textContent = 'Open this page and enter this code:';
      userCode = el('strong', state.userCode, 'sign-in-code');
      controls.insertBefore(userCode, form);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!dialog.open || !item.isConnected) return;
    state = await api<SignInStatus>(path);
  }
  if (!dialog.open || !item.isConnected) return;
  if (state.status === 'complete') await reload();
  else controls.replaceChildren(el('p', 'Sign-in did not complete.'), action('Try again', () => signInHarness(item, processor, reload)));
}
