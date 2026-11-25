// A Zirbel box in the workspace (box mode): the first-run choice of how to use it, and Box settings with its two
// switches, agent access over MCP, its paired devices, pairing another device and its Wi-Fi setup.
import { action, api, apiWith, attempt, dialog, el, inform, link, openDialog, option } from './editor-ui.ts';
import { ws, type BoxHealth } from './state.ts';

/** What the box's dialogs call in the rest of the workspace, set as it starts (chat.ts imports this module). */
const hooks = { openHarnesses: () => Promise.resolve(), refreshProcessors: () => Promise.resolve() };
export function setBoxHooks(given: typeof hooks) { Object.assign(hooks, given); }

/** Under this much memory a harness turn may run the box out of it (a 2 GB board reports a little less). */
const ROOMY_MB = 1536;

type Settings = Pick<BoxHealth, 'harnesses' | 'externalMcp' | 'onboarded' | 'setupRequested'>;
type Device = { id: string; label: string; createdAt: string; lastSeen: string; current: boolean };
type Grant = { token: string; expires: number };

async function change(update: Partial<Settings>) {
  const settings = await apiWith<Settings>('PUT', 'box/settings', update);
  if (ws.health.box) Object.assign(ws.health.box, settings);
  ws.health.mcp = ws.health.mcp || settings.externalMcp;
  return settings;
}

const lowMemory = (box: BoxHealth) => box.memoryMB < ROOMY_MB;
const memoryNote = (box: BoxHealth) => 'This box has ' + box.memoryMB + ' MB of memory: turns of Claude Code or Codex on it ' +
  'may run out of memory. Your own agent over MCP leaves the work to your computer.';

/** The first-run choice, shown on a box until it is made or set aside. Both can be on. */
export function openOnboarding() {
  const box = ws.health.box;
  if (!box) return;
  const body = openDialog('How do you want to use Zirbel here?');
  const harnesses = el('section', undefined, 'item');
  harnesses.append(el('strong', 'Run harnesses on this box'),
    el('p', 'Claude Code or Codex runs on the box, signed in to your own account, and makes the games here.'));
  if (!box.canRunHarnesses) harnesses.append(el('p', box.harnessesUnavailable ?? 'Harnesses can’t run on this box.'));
  else {
    if (lowMemory(box)) harnesses.append(el('p', memoryNote(box)));
    harnesses.append(action('Use harnesses here', async () => {
      await change({ harnesses: true, onboarded: true });
      await hooks.refreshProcessors();
      await hooks.openHarnesses();
    }, lowMemory(box) ? undefined : 'primary'));
  }
  const agent = el('section', undefined, 'item');
  agent.append(el('strong', 'Use your own agent over MCP'),
    el('p', 'Claude Code or Codex on your own computer works on the games on this box through Zirbel’s MCP server.'),
    action('Turn on agent access', async () => {
      await change({ externalMcp: true, onboarded: true });
      agentAccess(openDialog('Agent access'));
    }, lowMemory(box) || !box.canRunHarnesses ? 'primary' : undefined));
  // Where turns on the box may run out of memory, or can't run, your own agent comes first.
  body.append(...(lowMemory(box) || !box.canRunHarnesses ? [agent, harnesses] : [harnesses, agent]),
    el('p', 'You can turn either on or off later in Box settings.'),
    action('Not now', async () => { await change({ onboarded: true }); dialog.close(); }));
}

/** Agent access over MCP: the endpoint, and for a game, its grant with the lines that add it to an agent. */
function agentAccess(body: HTMLElement) {
  const endpoint = location.origin + '/mcp';
  body.append(el('p', 'Agents on your network reach this box at:'), copyable(endpoint, 'MCP endpoint'),
    el('p', 'Each game gives an agent its own access, for up to a week, which you can revoke from the game’s More menu.'));
  if (!ws.projectCards.length) {
    body.append(el('p', 'Make or import a game first, then come back here or open the game and choose More → Agent access.'));
    return;
  }
  const form = el('form');
  const game = el('select');
  game.setAttribute('aria-label', 'Game');
  for (const card of ws.projectCards) game.append(option(card.id, card.title));
  const write = el('input');
  write.type = 'checkbox';
  const allow = el('label', 'Let the agent apply its changes, not only propose them');
  allow.prepend(write);
  const create = el('button', 'Give this game’s access', 'primary');
  form.append(game, allow, create);
  const result = el('div');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    attempt(async () => {
      const grant = await api<Grant>('projects/' + game.value + '/grants', { write: write.checked, hours: 168 });
      result.replaceChildren(el('h3', 'Claude Code'),
        copyable('claude mcp add --transport http zirbel ' + endpoint + ' --header "Authorization: Bearer ' + grant.token + '"', 'Claude Code setup'),
        el('h3', 'Codex'), copyable('export ZIRBEL_MCP_TOKEN=' + grant.token, 'Codex token'),
        copyable('codex mcp add zirbel --url ' + endpoint + ' --bearer-token-env-var ZIRBEL_MCP_TOKEN', 'Codex setup'),
        el('p', 'This access ends ' + new Date(grant.expires).toLocaleString() + '.'));
    }, create);
  });
  body.append(form, result);
}

function copyable(text: string, label: string) {
  const row = el('div', undefined, 'row');
  const field = el('input', undefined, 'invite');
  field.value = text;
  field.readOnly = true;
  field.setAttribute('aria-label', label);
  row.append(field, action('Copy', async () => { await navigator.clipboard.writeText(text); inform('Copied.'); }));
  return row;
}

function toggle(label: string, checked: boolean, disabled: boolean, onChange: (on: boolean) => Promise<void>) {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  const row = el('label', label);
  row.prepend(input);
  input.addEventListener('change', () => attempt(async () => {
    try { await onChange(input.checked); } catch (error) { input.checked = !input.checked; throw error; }
  }));
  return row;
}

/** Box settings: the two switches, agent access, paired devices, pairing another device and the Wi-Fi setup. */
export async function openBoxSettings() {
  const box = ws.health.box;
  if (!box) return;
  const body = openDialog('Box settings');
  const settings = await api<Settings>('box/settings');
  Object.assign(box, settings);
  body.append(el('h3', 'On this box'),
    toggle('Run harnesses on this box', settings.harnesses, !box.canRunHarnesses, async (on) => {
      await change({ harnesses: on });
      await hooks.refreshProcessors();
    }));
  if (!box.canRunHarnesses) body.append(el('p', box.harnessesUnavailable ?? ''));
  else if (lowMemory(box)) body.append(el('p', memoryNote(box)));
  body.append(toggle('Let agents on your network use this box over MCP', settings.externalMcp, false, async (on) => {
    await change({ externalMcp: on });
    await openBoxSettings();
  }));
  if (settings.externalMcp) {
    const access = el('section', undefined, 'item');
    agentAccess(access);
    body.append(access);
  }
  body.append(el('h3', 'Paired devices'));
  const { devices } = await api<{ devices: Device[] }>('pairing/devices');
  for (const device of devices) {
    const item = el('section', undefined, 'item');
    item.append(el('strong', device.label + (device.current ? ' · this device' : '')),
      el('small', 'Paired ' + new Date(device.createdAt).toLocaleDateString() + ' · last seen ' + new Date(device.lastSeen).toLocaleString()),
      action('Remove', async () => {
        const last = devices.length === 1;
        if (last && !confirm('This is the last paired device. After it, only the box itself can pair one: through its Wi-Fi setup, or a terminal on it.')) return;
        await apiWith('DELETE', 'pairing/devices/' + device.id);
        if (device.current) location.assign('/pair');
        else await openBoxSettings();
      }));
    body.append(item);
  }
  const pairing = el('div');
  body.append(action('Pair another device', async () => {
    // The native host draws no QR code: its link and code are enough.
    const code = await api<{ code: string; url: string; expiresAt: string; qr: string | null }>('pairing', {});
    const picture = el('img');
    if (code.qr) {
      picture.src = code.qr;
      picture.alt = 'QR code for ' + code.url;
      picture.width = 180;
    }
    pairing.replaceChildren(el('p', 'On the other device, open the link' + (code.qr ? ' or scan the code' : '') + ', then enter this code if asked:'),
      el('strong', code.code, 'sign-in-code'), link(code.url, code.url, true), ...(code.qr ? [picture] : []),
      el('small', 'Valid until ' + new Date(code.expiresAt).toLocaleTimeString() + ', for one device.'));
  }), pairing, el('h3', 'Network'), action('Change Wi-Fi', async () => {
    await api('box/setup', { requested: true });
    inform('The box opens its Wi-Fi setup: over Bluetooth, and as the “Zirbel setup” hotspot.');
  }));
}
