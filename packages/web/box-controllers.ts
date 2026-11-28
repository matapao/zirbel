// Box settings' Controllers (box mode, owners only): the gamepads on the box, USB and Bluetooth, each with the screen
// and place (P1 to P8) it has there, pairing a Bluetooth controller (the box looks for 30 s and lists the gamepads it
// finds, each with Pair) and forgetting one. The box's controllers service (pi/controllers) does the work; without it
// the section says so. While the box looks or pairs, the section follows it.
import { action, api, el, inform } from './editor-ui.ts';

type Screen = { code: string; tv: boolean; place: number } | null;
type Controller = {
  name: string;
  kind: 'usb' | 'bluetooth' | 'other';
  connected: boolean;
  address?: string;
  screen: Screen;
};
type Controllers = {
  devices: Controller[];
  found: { address: string; name: string }[];
  scanning: boolean;
  bluetooth: boolean;
  pairing: string | null;
  error: string | null;
};

const KINDS = { usb: 'USB', bluetooth: 'Bluetooth', other: 'On the box' };
/** How often the section looks again while the box looks for controllers or pairs one. */
const FOLLOW_MS = 1500;

/** Where a controller plays: its screen and place, or none yet. */
function where({ connected, screen }: Controller) {
  if (!connected) return 'Not connected: turn it on, or press a button on it';
  if (!screen) return 'On no screen yet: press a button on it to join the TV or a screen that asks for one';
  return (screen.tv ? 'On the TV' : 'On screen ' + screen.code) + ' as P' + (screen.place + 1);
}

/** The Controllers section, kept up to date while it is open. */
export async function controllersSection() {
  const part = el('div');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async (path: string, payload: object) => show(await api<Controllers>('box/controllers/' + path, payload));
  const refresh = async () => {
    try {
      show(await api<Controllers>('box/controllers'));
    } catch (error) {
      part.replaceChildren(el('p', (error as Error).message));
    }
  };
  function show(view: Controllers) {
    clearTimeout(timer);
    const list = view.devices.map((item) => {
      const row = el('section', undefined, 'item');
      row.append(el('strong', item.name), el('small', KINDS[item.kind] + ' · ' + where(item)));
      const address = item.address;
      if (item.kind === 'bluetooth' && address && view.bluetooth)
        row.append(
          action('Forget', async () => {
            if (!confirm('The box forgets ' + item.name + '. Pair it again to play with it.')) return;
            await ask('forget', { address });
            inform('The box forgot ' + item.name + '.');
          }),
        );
      return row;
    });
    if (!list.length) list.push(el('p', 'No controllers yet. Plug one into the box, or pair a Bluetooth one.'));
    part.replaceChildren(...list);
    if (view.error) part.append(el('p', view.error, 'error'));
    if (!view.bluetooth) {
      part.append(el('p', 'This box has no Bluetooth: USB controllers only.'));
      return;
    }
    if (view.pairing) {
      const name = view.found.find((item) => item.address === view.pairing)?.name ?? view.pairing;
      part.append(el('p', 'Pairing ' + name + '…'));
    } else if (view.scanning) {
      const found = el('div');
      found.append(
        el(
          'p',
          view.found.length ? 'Controllers the box found:' : 'Looking for controllers. Put yours in pairing mode.',
        ),
      );
      for (const item of view.found) {
        const row = el('div', undefined, 'row');
        row.append(
          el('span', item.name),
          action(
            'Pair',
            async () => {
              await ask('pair', { address: item.address });
            },
            'primary',
          ),
        );
        found.append(row);
      }
      part.append(
        found,
        action('Stop looking', async () => {
          await ask('scan', { on: false });
        }),
      );
    } else
      part.append(
        action('Pair a Bluetooth controller', async () => {
          await ask('scan', { on: true });
        }),
      );
    // The section follows the box while it looks or pairs, and stops once the dialog has closed.
    if (view.scanning || view.pairing)
      timer = setTimeout(() => {
        if (part.isConnected) void refresh();
      }, FOLLOW_MS);
  }
  await refresh();
  return part;
}
