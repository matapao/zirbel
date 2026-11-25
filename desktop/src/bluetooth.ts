// Web Bluetooth in the desktop app, for "Set up a Zirbel box". Chromium leaves choosing a device to the app, so the
// editor's own window gets a small chooser of the boxes nearby that offer what its page asked for (the Improv Wi-Fi
// service); a request from any other page is refused. The chooser is the app's dialog, which main.ts passes in, so this
// file needs nothing of Electron's at runtime.
import type { BluetoothDevice, WebContents } from 'electron';

export type Ask = (contents: WebContents, buttons: string[], cancelId: number) => Promise<number>;

/** How long to gather boxes before showing them, and how long to wait for one before giving up. */
const TIMING = { gatherMs: 3000, giveUpMs: 20_000, recheckMs: 1000 };

/** The chooser's buttons: each box by its name, at most six, then Cancel. */
export function chooserButtons(devices: BluetoothDevice[]) {
  const named = devices.slice(0, 6).map((device) => device.deviceName || 'Unnamed box');
  return { buttons: [...named, 'Cancel'], cancelId: named.length };
}

/** Answers the page's device requests in `contents`: from the chooser in an allowed page, else refused at once. */
export function chooseBluetooth(
  contents: WebContents,
  allowed: (contents: WebContents) => boolean,
  ask: Ask,
  timing = TIMING,
) {
  let pending: { devices: BluetoothDevice[]; answer: (deviceId: string) => void } | undefined;
  contents.on('select-bluetooth-device', (event, devices, answer) => {
    event.preventDefault();
    if (!allowed(contents)) {
      answer('');
      return;
    }
    // Chromium says again as it finds more; the chooser shows what is found by then.
    if (pending) {
      pending.devices = devices;
      pending.answer = answer;
      return;
    }
    const choice = (pending = { devices, answer });
    const started = Date.now();
    const show = () => {
      if (pending !== choice) return;
      if (!choice.devices.length) {
        if (Date.now() - started < timing.giveUpMs) {
          setTimeout(show, timing.recheckMs);
          return;
        }
        pending = undefined;
        choice.answer('');
        return;
      }
      const shown = choice.devices;
      const { buttons, cancelId } = chooserButtons(shown);
      void ask(contents, buttons, cancelId).then(
        (response) => {
          pending = undefined;
          choice.answer(response < cancelId ? shown[response]!.deviceId : '');
        },
        () => {
          pending = undefined;
          choice.answer('');
        },
      );
    };
    setTimeout(show, timing.gatherMs);
  });
}
