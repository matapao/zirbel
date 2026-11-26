import { PORTABLE_FILE_LIMIT, type Manifest, type Project } from '../sdk/contracts.ts';
import { templates } from '../games/templates.ts';
import { gameFilePath } from '../sdk/game.ts';
import { action, api, attempt, dialog, el, inform, link, openDialog } from './editor-ui.ts';
import type { ProjectCard } from './state.ts';
import { importGitDialog } from './git.ts';

export type Room = {
  id: string; manifest: Manifest; development: boolean; link: string; localLink: string;
  qr: string | null; lan: boolean; status: string;
  /** A session's code, which players join it by in the lobby. */
  code?: string;
};

/** The releases the lobby offers, by id. */
export const lobbyOffers = async () => (await api<{ offered: string[] }>('lobby')).offered;

type LibraryProjects = {
  active(): string | undefined;
  open(id: string): Promise<void>;
  refresh(): Promise<readonly ProjectCard[]>;
  removed(id: string): Promise<void>;
};

export function createLibrary(projects: LibraryProjects) {
  async function libraryDialog() {
    const body = openDialog('Game library');
    const header = el('div', undefined, 'row');
    header.append(action('New project', newDialog, 'primary'), action('Import file…', importDialog), action('Import game folder…', folderDialog),
      action('Import from a git URL…', gitDialog));
    const projectId = projects.active();
    if (projectId) header.append(link('Export editable project', new URL('api/projects/' + projectId + '/export', document.baseURI).href));
    body.append(header);
    const projectCards = await projects.refresh();
    if (projectCards.length) body.append(el('h3', 'Projects'));
    else body.append(el('p', 'No saved projects in this workspace.'));
    for (const card of projectCards) {
      const item = el('div', undefined, 'item library-project');
      const details = el('div', undefined, 'library-project-title');
      details.append(el('strong', card.title));
      if (card.template) details.append(el('small', templates[card.template].description));
      const controls = el('div', undefined, 'row');
      controls.append(action('Open project', async () => { dialog.close(); await projects.open(card.id); }),
        action('Remove…', () => removeDialog(card), 'danger'));
      item.append(details, controls);
      body.append(item);
    }
    const [releases, offered] = await Promise.all([api<Manifest[]>('releases'), lobbyOffers()]);
    if (releases.length) body.append(el('h3', 'Releases'));
    // Offering a release in the lobby takes its game's other release out, so every switch follows the answer.
    const switches = new Map<string, HTMLInputElement>();
    const follow = (list: string[]) => { for (const [id, input] of switches) input.checked = list.includes(id); };
    for (const release of releases) {
      const item = el('div', undefined, 'item');
      const controls = el('div', undefined, 'row');
      if (release.permissions.play) {
        const label = el('label', undefined, 'lobby-switch');
        const input = el('input');
        input.type = 'checkbox'; input.checked = offered.includes(release.releaseId);
        switches.set(release.releaseId, input);
        input.addEventListener('change', () => {
          input.disabled = true;
          void api<{ offered: string[] }>('lobby/offer', { release: release.releaseId, offered: input.checked })
            .then(({ offered: list }) => follow(list), (error: Error) => { input.checked = !input.checked; inform(error.message, true); })
            .finally(() => { input.disabled = false; });
        });
        label.append(input, 'In the lobby');
        controls.append(label);
      }
      if (release.permissions.play) controls.append(action('Play', () => openGame('releases/' + release.releaseId + '/play', {})));
      if (release.permissions.play && release.simulation) controls.append(action('Host on LAN', async () => {
        const room = await api<Room>('rooms', { releaseId: release.releaseId, lan: true });
        openDialog(release.title).append(roomCard(room, libraryDialog));
      }));
      if (release.permissions.download) controls.append(link('Download playable build',
        new URL('api/releases/' + release.releaseId + '/download', document.baseURI).href));
      if (release.permissions.remix) controls.append(action('Remix', async () => {
        const remixed = await api<Project>('releases/' + release.releaseId + '/remix', {});
        dialog.close(); await projects.refresh(); await projects.open(remixed.id);
      }));
      item.append(el('strong', release.title), el('small', 'Revision ' + release.sourceRevision.slice(0, 8)), controls);
      const credits = el('details');
      credits.append(el('summary', 'Credits'), ...release.credits.map((credit) => el('p', credit.credit + ' · ' + credit.license)));
      item.append(credits); body.append(item);
    }
  }

  function removeDialog(card: ProjectCard) {
    const body = openDialog('Remove ' + card.title + '?');
    const controls = el('div', undefined, 'row');
    controls.append(action('Cancel', libraryDialog), action('Remove project', async () => {
      await api('projects/' + card.id + '/remove', {});
      await projects.removed(card.id);
      await libraryDialog();
    }, 'danger'));
    body.append(el('p', 'This takes the project out of your Library and closes its active rooms. Published releases stay available.'), controls);
  }

  function newDialog() {
    const body = openDialog('Create a game');
    const form = el('form');
    const label = el('label','Game name');
    const name = el('input');
    name.maxLength = 80; name.name = 'title'; name.placeholder = 'Untitled project'; label.append(name);
    const button = el('button', 'Create project', 'primary');
    form.append(label, button); body.append(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      attempt(async () => {
        const created = await api<Project>('projects', { title: name.value.trim() || undefined });
        await projects.refresh();
        dialog.close();
        await projects.open(created.id);
      }, button);
    });
  }

  function importDialog() {
    const body = openDialog('Import a Zirbel file');
    const input = el('input');
    input.type = 'file'; input.accept = 'application/json,.json'; input.setAttribute('aria-label','Zirbel project or release file');
    body.append(input, action('Import', async () => {
      const file = input.files?.[0];
      if (!file || file.size > PORTABLE_FILE_LIMIT) throw new Error('Choose a Zirbel JSON file under 48 MB.');
      const data = JSON.parse(await file.text()) as { project?: unknown; manifest?: unknown };
      if (data.project) {
        const imported = await api<Project>('projects/import', data);
        dialog.close(); await projects.refresh(); await projects.open(imported.id);
      } else if (data.manifest) {
        await api('releases/import', data);
        await libraryDialog();
      } else throw new Error('This file is neither a Zirbel project nor a Zirbel release.');
    }, 'primary'));
  }

  // A built web game: the folder a build writes, with index.html at its top. Files the import does
  // not take (hidden files, other types) are named afterwards instead of sent.
  function folderDialog() {
    const body = openDialog('Import a built game folder');
    const input = el('input');
    input.type = 'file'; input.webkitdirectory = true; input.multiple = true; input.setAttribute('aria-label', 'Built game folder');
    body.append(el('p', 'Choose the folder your build writes, such as dist/. Build it with relative paths (for Vite: --base ./).'),
      input, action('Import', async () => {
        const chosen = [...(input.files ?? [])];
        const entries = chosen.map((file) => [file.webkitRelativePath.split('/').slice(1).join('/'), file] as const);
        const kept = entries.filter(([path]) => gameFilePath.safeParse(path).success);
        const skipped = entries.filter(([path]) => !gameFilePath.safeParse(path).success).map(([path]) => path);
        if (!kept.some(([path]) => path === 'index.html')) throw new Error('Choose a folder with an index.html at its top.');
        if (kept.reduce((total, [, file]) => total + file.size, 0) * 4 / 3 > PORTABLE_FILE_LIMIT)
          throw new Error('Choose a built folder under 36 MB.');
        const files = Object.fromEntries(await Promise.all(kept.map(async ([path, file]) => [path, await base64(file)] as const)));
        const title = (chosen[0]?.webkitRelativePath.split('/')[0] ?? '').slice(0, 80).trim() || undefined;
        const imported = await api<Project>('projects/import-game', { title, files });
        dialog.close(); await projects.refresh(); await projects.open(imported.id);
        if (skipped.length) inform('Imported ' + kept.length + ' files. Skipped: ' + skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? '…' : '') + '.');
      }, 'primary'));
  }

  /** A public repository, its history kept, which the game can update from later. */
  function gitDialog() {
    importGitDialog(async (imported) => { await projects.refresh(); await projects.open(imported.id); });
  }

  return { open: libraryDialog, importFolder: folderDialog, importFile: importDialog, importGit: gitDialog };
}

function base64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const url = typeof reader.result === 'string' ? reader.result : ''; resolve(url.slice(url.indexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

export function openGame(path: string, payload: object) {
  const popup = window.open('about:blank', '_blank');
  if (!popup) { inform('Allow popups to open the standalone player.', true); return; }
  popup.opener = null;
  void api<{ link: string }>(path, payload).then(({ link }) => { popup.location.replace(link); })
    .catch((error: Error) => { popup.close(); inform(error.message, true); });
}

export function roomCard(room: Room, refresh: () => Promise<void>) {
  const card = el('article', undefined, 'item');
  const invite = el('input', undefined, 'invite'); invite.value = room.link; invite.readOnly = true;
  invite.setAttribute('aria-label','Guest invitation');
  card.append(el('strong', (room.development ? 'Development room' : 'Release room') + ' · ' + room.status),
    el('small','Revision ' + room.manifest.sourceRevision.slice(0, 8)));
  if (room.code) {
    const code = el('p', undefined, 'room-code');
    code.append(el('span', 'Code in the lobby'), el('strong', room.code));
    card.append(code);
  }
  card.append(invite);
  const controls = el('div', undefined, 'row');
  controls.append(action('Copy link', async () => {
    try { await navigator.clipboard.writeText(room.link); inform('Invitation copied.'); }
    catch { invite.select(); inform('Select and copy the invitation link.'); }
  }), link('Join game', room.localLink, true), action('Stop hosting', async () => {
    await api('rooms/' + room.id + '/close', {}); await refresh();
  }, 'danger'));
  card.append(controls);
  if (room.qr) { const qr = el('img', undefined, 'qr'); qr.src = room.qr; qr.alt = 'Scan to open the game invitation'; card.append(qr); }
  return card;
}
