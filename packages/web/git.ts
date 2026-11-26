// A game as a git repository (docs/git-store.md): Clone with git… shows the clone command, with this device's git token
// off a box; Import from a git URL… makes a game of a public repository; Update from source fetches the game's source
// again and brings its changes under the game's own.
import type { Project } from '../sdk/contracts.ts';
import { api, dialog, el, inform, openDialog } from './editor-ui.ts';
import { copyable } from './box.ts';
import { ws } from './state.ts';

type Clone = { url: string; command: string; token?: string };

/** Clone with git…: the command, and what pushing does. */
export async function cloneDialog(projectId: string, title: string) {
  const clone = await api<Clone>('projects/' + projectId + '/clone');
  const body = openDialog('Clone with git · ' + title);
  body.append(el('p', 'Every revision of this game is a commit. Clone it, change it with your own tools, and push to main: ' +
    'the game takes the push as its next revision when it is still a game Zirbel can keep.'),
  copyable(clone.command, 'Clone command'));
  if (clone.token) body.append(el('p', 'The command holds this device’s git token. Anyone with it can change your games, ' +
    'so keep it to yourself; it stops working when this device is removed.'));
  body.append(el('p', 'Pull before you push: a push that would rewrite the game’s history is refused.'));
}

/** Import from a git URL…: a public repository whose index.html is at its top; open is the new game's opener. */
export function importGitDialog(open: (project: Project) => Promise<void>) {
  const body = openDialog('Import from a git URL');
  const form = el('form');
  const url = el('input');
  url.type = 'url'; url.required = true; url.placeholder = 'https://example.org/you/game.git'; url.setAttribute('aria-label', 'Repository address');
  const ref = el('input');
  ref.placeholder = 'Branch or tag (its default without one)'; ref.setAttribute('aria-label', 'Branch or tag');
  const button = el('button', 'Import', 'primary');
  form.append(el('p', 'A public repository with the game’s index.html at its top. Zirbel keeps its history, and can update the game from it later.'),
    url, ref, button);
  body.append(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    button.disabled = true;
    void api<Project>('projects/import-git', { url: url.value.trim(), ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) })
      .then(async (imported) => { dialog.close(); await open(imported); })
      .catch((error: Error) => inform(error.message, true)).finally(() => { button.disabled = false; });
  });
}

/** Update from source: the game's source fetched again, and its changes brought under the game's own. */
export async function updateFromSource(projectId: string, baseRevision: string, reload: () => Promise<void>) {
  inform('Fetching the game’s source…');
  const { updated } = await api<{ updated: boolean }>('projects/' + projectId + '/update-from-source', { branch: ws.branch, baseRevision });
  await reload();
  inform(updated ? 'Updated the game from its source.' : 'The game already has everything its source has.');
}

/** Under a revision in History: its short id, who made it and when. */
export const revisionLine = (revision: { id: string; author?: string; date: string }) =>
  revision.id.slice(0, 8) + ' · ' + (revision.author ? revision.author + ' · ' : '') + new Date(revision.date).toLocaleString();
