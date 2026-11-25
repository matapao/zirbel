// Split from workspace.ts; shares state through ws in state.ts.
// The top bar: the game switcher on the left; Edit, Assets and Share on the right, and the ⋯ menu for the rest.
import { $, action, attempt, el } from './editor-ui.ts';
import { ws } from './state.ts';
import { current, edit, hasContent, leaveProject, library, loadProject, recentCards, route } from './workspace.ts';
import { menuButton, panelButton, type MenuItem } from './menu.ts';
import { agentAccessDialog, assetDialog, historyDialog, sharingDialog } from './dialogs.ts';
import { openGame } from './library.ts';
import { openChatSettings } from './chat-settings.ts';
import { openHarnesses } from './chat.ts';
import { openBoxSettings } from './box.ts';
import { boxSetupDialog } from './box-setup.ts';

let assets: { readonly open: boolean } | undefined;

function gameMenu(): MenuItem[] {
  const recent: MenuItem[] = recentCards(8).map((card) => ({
    label: card.title,
    checked: card.id === ws.project?.id,
    run: () => attempt(() => loadProject(card.id)),
  }));
  return [
    ...recent,
    ...(recent.length ? ['separator' as const] : []),
    {
      label: 'New game',
      run: () =>
        attempt(async () => {
          await leaveProject();
          $('prompt').focus();
        }),
    },
    { label: 'Library…', run: () => attempt(library.open) },
    { label: 'Import a game folder…', run: library.importFolder },
    { label: 'Import a file…', run: library.importFile },
    'separator',
    { label: 'All threads', disabled: true, note: 'Soon' },
  ];
}

function moreMenu(): MenuItem[] {
  const project = ws.project;
  const items: MenuItem[] = [];
  if (project) {
    items.push(
      { label: 'History', run: () => attempt(historyDialog) },
      { label: 'Export project', href: new URL('api/projects/' + project.id + '/export', document.baseURI).href },
    );
    if (hasContent())
      items.push({
        label: 'Open game in a new window',
        run: () => openGame(route('playtest'), { branch: ws.branch, proposalId: ws.candidate?.proposal.id }),
      });
    if (ws.health.mcp)
      items.push({ label: 'Agent access…', run: () => attempt(() => agentAccessDialog(project.id, project.title)) });
  }
  if (ws.health.chat) items.push({ label: 'Harnesses', run: () => attempt(openHarnesses) });
  if (ws.health.box) items.push({ label: 'Box settings…', run: () => attempt(openBoxSettings) });
  items.push({ label: 'Set up a Zirbel box…', run: boxSetupDialog }, { label: 'Settings', run: openChatSettings });
  return items;
}

/** The Assets panel: today's asset list and image import. */
function renderAssets() {
  const node = $('assets');
  node.replaceChildren();
  if (!ws.project) return;
  const list = current().assets;
  if (!list.length) node.append(el('p', 'No imported assets yet.'));
  for (const asset of list) {
    const item = el('div', undefined, 'asset');
    item.append(
      el('strong', asset.name),
      el('small', asset.author + ' · ' + asset.license),
      action('Remove', () => edit('Remove asset ' + asset.name, [{ op: 'removeAsset', id: asset.id }])),
    );
    node.append(item);
  }
}

export function renderTopbar() {
  const content = hasContent();
  $('game-title').textContent = ws.project?.title ?? 'New game';
  $('edit-toggle').hidden = !content;
  $('assets-toggle').hidden = !content;
  $('share').hidden = !content;
  if (assets?.open) renderAssets();
}

export function setupTopbar() {
  menuButton('game-switcher', 'game-menu', gameMenu);
  menuButton('more-button', 'more-menu', moreMenu);
  assets = panelButton('assets-toggle', 'assets-panel', renderAssets);
  $('import-asset').addEventListener('click', () => assetDialog());
  const share = $<HTMLButtonElement>('share');
  share.addEventListener('click', () => {
    if (ws.project) attempt(sharingDialog, share);
  });
}
