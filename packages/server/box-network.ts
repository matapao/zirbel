// The box's own Wi-Fi (box mode, pi/setup/own_network.py): instead of joining a network, the box makes one with a
// password, which phones, tablets and computers join to play, with no router and no internet. The box's setup service
// makes its name and password once and keeps them outside the data folder, readable by the editor's group and no one
// else (/var/lib/zirbel-setup/own-network.json, or ZIRBEL_OWN_NETWORK); the editor shows them to its paired devices,
// with a QR code that joins the network. The ownNetwork switch says whether the box makes it. Switching it wakes the
// setup service, the only thing that changes the Wi-Fi; a box with no name and password (no Wi-Fi setup) can't switch
// it on.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ZirbelError } from '../core/projects.ts';

/** As a network takes them: a name of 1 to 32 bytes, and a WPA2 passphrase of 8 to 63 printable ASCII characters. */
const stored = z.strictObject({
  version: z.literal(1), name: z.string().min(1).refine((name) => Buffer.byteLength(name) <= 32),
  password: z.string().regex(/^[\x20-\x7e]{8,63}$/),
});
type OwnNetwork = { name: string; password: string };
const FILE_BYTES = 4096;
export const NO_OWN_NETWORK = 'This box can’t make its own Wi-Fi: it has no Wi-Fi setup.';
const UNREADABLE = 'The box’s own Wi-Fi could not be read.';

/** The network's name and password, or nothing where the setup service made none. */
export function readOwnNetwork(file: string): OwnNetwork | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ZirbelError(500, UNREADABLE);
  }
  try {
    if (Buffer.byteLength(text) > FILE_BYTES) throw new Error('too long');
    const { name, password } = stored.parse(JSON.parse(text));
    return { name, password };
  } catch { throw new ZirbelError(500, UNREADABLE); }
}

/** The text of a QR code that joins the network, as phones' cameras read it: WIFI:T:WPA;S:name;P:password;; with a
 *  backslash before each \ ; , : and " in the name and password. */
export function wifiJoinText({ name, password }: OwnNetwork) {
  const escape = (text: string) => text.replace(/[\\;,:"]/g, (character) => '\\' + character);
  return 'WIFI:T:WPA;S:' + escape(name) + ';P:' + escape(password) + ';;';
}

/** GET /api/box/network, for paired devices and the box itself: whether the box makes its own Wi-Fi, and the network
 *  with its password and the QR code that joins it, or null on a box that can't make one. */
export async function ownNetworkView(file: string, on: boolean, qr: (text: string) => Promise<string>) {
  const network = readOwnNetwork(file);
  return { ownNetwork: on, network: network ? { ...network, qr: await qr(wifiJoinText(network)) } : null };
}

/** Wakes the setup service through a file it removes: a systemd path unit starts the service when one appears. A box
 *  without the service has no folder for it, and the change stays in the settings only. */
export function wake(file: string) {
  try { writeFileSync(file, '', { mode: 0o660 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** The file that wakes the setup service for the box's own Wi-Fi, beside its setup request. */
export const networkWake = (setupRequest: string) => join(dirname(setupRequest), 'network');
