// Editors of one game on a box. The owner's Invite editors… dialog: the game's edit code, big, with its QR code and
// link, when it expires, Stop the code and New code, and the people editing the game with a Remove each. An editor's
// own Claude Code or Codex: a grant for its game over the box's MCP, whose changes go straight into the game.
import { action, api, apiWith, el, link, openDialog } from './editor-ui.ts';
import { grantSetup, type Grant } from './box.ts';
import { qrPicture } from './qr.ts';

type EditCode = { code: string; link: string; expiresAt: string };
type Editor = { id: string; name: string; since: string; lastSeen: string };

/** Invite editors: who may work on this game, and only this one, from their own device on the box's network. */
export async function inviteEditorsDialog(projectId: string, title: string) {
  const path = 'projects/' + projectId;
  const { code, editors } = await api<{ code: EditCode | null; editors: Editor[] }>(path + '/editors');
  const body = openDialog('Invite editors · ' + title);
  const again = () => inviteEditorsDialog(projectId, title);
  const fresh = action(
    'New code',
    async () => {
      await api(path + '/edit-code', {});
      await again();
    },
    'primary',
  );
  body.append(
    el(
      'p',
      'Someone with this game’s edit code works on it, and only on it, from their own device on the box’s network. ' +
        'They don’t see your other games or Box settings, and don’t use the box’s AI.',
    ),
  );
  if (code) {
    const item = el('section', undefined, 'item');
    item.append(
      el('small', 'Edit code'),
      el('strong', code.code, 'sign-in-code edit-code'),
      el('p', 'On their device, they open this link or scan the code with a camera, and give their name:'),
      link(code.link, code.link, true),
      await qrPicture(code.link, 'QR code that opens ' + code.link),
      el('small', 'Anyone with it can start editing until ' + new Date(code.expiresAt).toLocaleString() + '.'),
      action('Stop the code', async () => {
        await api(path + '/edit-code/stop', {});
        await again();
      }),
      fresh,
    );
    body.append(item);
  } else body.append(el('p', 'No edit code is open. A new one lets people start editing for a week.'), fresh);
  body.append(el('h3', 'Editing now'));
  if (!editors.length) body.append(el('p', 'Nobody is editing this game with a code.'));
  for (const editor of editors) {
    const item = el('section', undefined, 'item');
    item.append(
      el('strong', editor.name),
      el(
        'small',
        'Since ' +
          new Date(editor.since).toLocaleDateString() +
          ' · last seen ' +
          new Date(editor.lastSeen).toLocaleString(),
      ),
      action('Remove', async () => {
        await apiWith('DELETE', path + '/editors/' + editor.id);
        await again();
      }),
    );
    body.append(item);
  }
}

/** For an editor: its own Claude Code or Codex on its game, through the box's MCP server while its owner allows it. */
export function ownAgentDialog(projectId: string, title: string) {
  const body = openDialog('Your own Claude Code or Codex');
  const endpoint = location.origin + '/mcp';
  const result = el('div');
  body.append(
    el(
      'p',
      'Claude Code or Codex on your own computer can work on ' +
        title +
        ' through this box’s MCP server, ' +
        'for up to a week. Its changes go straight into the game.',
    ),
    action(
      'Give my agent access',
      async () => {
        const grant = await api<Grant>('projects/' + projectId + '/grants', { write: true, hours: 168 });
        result.replaceChildren(...grantSetup(endpoint, grant));
      },
      'primary',
    ),
    result,
  );
}
