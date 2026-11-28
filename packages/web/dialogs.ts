// Split from workspace.ts; shares state through ws in state.ts.
import { action, api, attempt, dialog, el, formValue, inform, openDialog, option } from './editor-ui.ts';
import { current, library, loadProject, openProject, refreshProject, route, scope } from './workspace.ts';
import { editorOf, type Preview, ws } from './state.ts';
import type { Manifest, Project } from '../sdk/contracts.ts';
import { templates } from '../games/templates.ts';
import { lobbyOffers, roomCard, type Room } from './library.ts';
import { revisionLine } from './git.ts';

function forkDialog(id: string) {
  const body = openDialog('Apply to a new branch');
  const label = el('label', 'Branch name');
  const field = el('input');
  field.placeholder = 'experiment';
  field.pattern = '[a-z0-9][a-z0-9_-]{0,79}';
  label.append(field);
  body.append(
    label,
    action(
      'Create branch',
      async () => {
        if (!field.value.trim() || !field.reportValidity())
          throw new Error('Choose a branch name using lowercase letters, digits, dashes or underscores.');
        const result = await api<{ branch: string }>(route('apply/' + id), { fork: field.value.trim() });
        dialog.close();
        await loadProject(openProject().id, result.branch);
      },
      'primary',
    ),
  );
}

/** History: the branches to switch between, staged proposals to apply to a new branch, and revisions to restore. */
export function historyDialog() {
  const body = openDialog('History');
  const visit = ws.navigation;
  const project = openProject();
  const restore = route('restore');
  const base = scope();
  const branches = Object.keys(project.branches);
  body.append(el('h3', 'Branches'));
  for (const name of branches) {
    const item = el('div', undefined, 'item history-branch');
    item.append(el('strong', name));
    if (name === ws.branch) item.append(el('span', 'Current branch'));
    else
      item.append(
        action('Switch to ' + name, async () => {
          dialog.close();
          await loadProject(project.id, name);
        }),
      );
    body.append(item);
  }
  if (ws.proposals.length) {
    body.append(el('h3', 'Proposals'), el('p', 'Apply a staged proposal to a new branch, and keep this one as it is.'));
    for (const proposal of ws.proposals) {
      const item = el('div', undefined, 'item');
      item.append(
        el('strong', proposal.label),
        action('Apply to a new branch…', () => forkDialog(proposal.id)),
      );
      body.append(item);
    }
  }
  body.append(el('h3', 'Revisions'));
  for (const revision of [...project.revisions].reverse()) {
    const item = el('article', undefined, 'item');
    item.append(el('strong', revision.label), el('small', revisionLine(revision)));
    if (revision.id === base.baseRevision) item.append(el('span', 'Current revision'));
    else
      item.append(
        action('Restore as new revision', async () => {
          const restored = await api<Project>(restore, { ...base, target: revision.id });
          if (visit !== ws.navigation) return;
          ws.project = restored;
          ws.candidate = undefined;
          ws.region = undefined;
          await refreshProject();
          if (visit !== ws.navigation) return;
          historyDialog();
        }),
      );
    body.append(item);
  }
}

export async function sharingDialog() {
  const { id, title, template } = openProject();
  const { branch, baseRevision } = scope();
  const body = openDialog('Share ' + title);
  const dev = el('section', undefined, 'item');
  const game = current().game;
  const multiplayer = game ? game.maxPlayers > 1 : Boolean(template && templates[template].simulation);
  const listed = await api<Room[]>('rooms');
  const active = await Promise.all(
    listed.filter((room) => room.manifest.gameId === id).map((room) => api<Room>('rooms/' + room.id + '/link')),
  );
  const sharing = active.find((room) => room.development && room.manifest.sourceRevision === baseRevision);
  dev.append(el('strong', 'Development multiplayer'));
  const label = el('label');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = Boolean(sharing);
  toggle.disabled = !multiplayer;
  label.append(toggle, 'Share this revision over LAN');
  dev.append(
    label,
    el(
      'p',
      multiplayer
        ? 'Guests open a standalone game. The room stays on revision ' +
            baseRevision.slice(0, 8) +
            ' while you keep editing.'
        : 'Ask the harness to add multiplayer to this game.',
    ),
  );
  /** Opens a development room on this revision, or closes the one that shares it. */
  const share = (enabled: boolean) => {
    if (enabled) return api('projects/' + id + '/development-room', { branch, baseRevision });
    return sharing ? api('rooms/' + sharing.id + '/close', {}) : Promise.resolve();
  };
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    void share(enabled)
      .then(sharingDialog)
      .catch((error: Error) => {
        toggle.checked = !enabled;
        toggle.disabled = false;
        inform(error.message, true);
      });
  });
  body.append(dev);
  for (const room of active) body.append(roomCard(room, sharingDialog));
  // An editor of one game on a box shares its development rooms; its releases are the box's owners' to publish.
  if (editorOf()) return;

  const form = el('form');
  const options = el('fieldset');
  options.append(el('legend', 'Publish a release'));
  const boxes: Record<string, HTMLInputElement> = {};
  for (const [name, title] of [
    ['play', 'Allow play'],
    ['download', 'Allow downloads'],
    ['remix', 'Allow remixing'],
    ['lobby', 'Offer in the lobby'],
  ]) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.name = name!;
    input.checked = true;
    boxes[name!] = input;
    label.append(input, title!);
    options.append(label);
  }
  // The lobby offers only what may be played.
  boxes.play!.addEventListener('change', () => {
    boxes.lobby!.disabled = !boxes.play!.checked;
  });
  options.append(await lobbyStatus(id));
  const publish = el('button', 'Publish to this host’s library', 'primary');
  form.append(options, publish);
  body.append(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      const formData = new FormData(form);
      const play = formData.has('play');
      const manifest = await api<Manifest>('projects/' + id + '/release', {
        branch,
        baseRevision,
        permissions: {
          play,
          download: formData.has('download'),
          remix: formData.has('remix'),
        },
      });
      const offer = play && formData.has('lobby');
      if (offer) await api('lobby/offer', { release: manifest.releaseId, offered: true });
      inform(
        offer ? 'Published to this host’s library and offered in the lobby.' : 'Published to this host’s library.',
      );
      await library.open();
    }, publish);
  });
}

/** Whether the lobby offers a release of this game, and which. */
async function lobbyStatus(gameId: string) {
  const [releases, offered] = await Promise.all([api<Manifest[]>('releases'), lobbyOffers()]);
  const release = releases.find((item) => item.gameId === gameId && offered.includes(item.releaseId));
  return el(
    'small',
    release
      ? 'In the lobby now: revision ' + release.sourceRevision.slice(0, 8) + '. A new release offered takes its place.'
      : 'No release of this game is in the lobby.',
    'lobby-status',
  );
}

export async function agentAccessDialog(projectId: string, title: string) {
  const body = openDialog('Agent access · ' + title);
  const grants = 'projects/' + projectId + '/grants';
  body.append(
    el('p', 'Give an MCP client permission to propose changes to this project.'),
    action(
      'Create a proposal grant',
      async () => {
        const grant = await api<{ token: string; expires: number }>(grants, { write: false, hours: 24 });
        const connection = el('input', undefined, 'invite');
        connection.value = grant.token;
        connection.readOnly = true;
        connection.setAttribute('aria-label', 'Project grant');
        const endpoint = el('input', undefined, 'invite');
        endpoint.value = location.origin + '/mcp';
        endpoint.readOnly = true;
        endpoint.setAttribute('aria-label', 'MCP endpoint');
        body.append(
          el('strong', 'MCP endpoint'),
          endpoint,
          el('strong', 'Project grant · expires in 24 hours'),
          connection,
          el('p', 'Use the project grant as the bearer token in your MCP client.'),
        );
      },
      'primary',
    ),
  );
  const records = await api<Array<{ id: string; expires: number; write: boolean }>>(grants);
  for (const record of records) {
    body.append(
      el('p', 'Grant ' + record.id.slice(0, 8) + ' · ' + new Date(record.expires).toLocaleString()),
      action('Revoke ' + record.id.slice(0, 8), async () => {
        await api(grants + '/' + record.id, {});
        await agentAccessDialog(projectId, title);
      }),
    );
  }
}

function fileBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? (reader.result.split(',')[1] ?? '') : '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function assetDialog() {
  const body = openDialog('Import an image asset');
  const form = el('form');
  const file = el('input');
  file.type = 'file';
  file.required = true;
  file.accept = 'image/png,image/jpeg,image/webp';
  file.setAttribute('aria-label', 'Asset file');
  form.append(file);
  for (const [name, label] of [
    ['name', 'Name'],
    ['author', 'Author'],
    ['source', 'Source URL'],
    ['credit', 'Required credit'],
  ]) {
    const field = el('label', label);
    const value = el('input');
    value.name = name!;
    value.type = name === 'source' ? 'url' : 'text';
    value.required = name !== 'credit';
    value.maxLength = name === 'credit' ? 600 : 140;
    field.append(value);
    form.append(field);
  }
  const license = el('select');
  license.name = 'license';
  license.setAttribute('aria-label', 'License');
  for (const id of ['unknown', 'local-only', 'CC0-1.0', 'CC-BY-4.0', 'MIT']) license.append(option(id, id));
  const button = el('button', 'Import asset', 'primary');
  form.append(license, button);
  body.append(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      const source = file.files?.[0];
      if (!source || source.size > 5_000_000) throw new Error('Choose an image under 5 MB.');
      const stage = await api<Preview>(route('asset'), {
        ...scope(),
        name: formValue(form, 'name'),
        author: formValue(form, 'author'),
        source: formValue(form, 'source'),
        license: license.value,
        credit: formValue(form, 'credit'),
        media: source.type,
        data: await fileBase64(source),
      });
      await api(route('apply/' + stage.proposal.id), {});
      await refreshProject();
      dialog.close();
    }, button);
  });
}
