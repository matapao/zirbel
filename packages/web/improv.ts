// The Improv Wi-Fi protocol over Bluetooth LE (improv-wifi.com/ble, version 2.4), as a client speaks it: packets, their
// checksum and results. Pure, without Bluetooth, so the setup flow (box-setup.ts) and its tests share it.

export const IMPROV_SERVICE = '00467768-6228-2272-4663-277478268000';
export const CHARACTERISTIC = {
  state: '00467768-6228-2272-4663-277478268001',
  error: '00467768-6228-2272-4663-277478268002',
  command: '00467768-6228-2272-4663-277478268003',
  result: '00467768-6228-2272-4663-277478268004',
  capabilities: '00467768-6228-2272-4663-277478268005',
} as const;

export const STATE = { authorizationRequired: 1, authorized: 2, provisioning: 3, provisioned: 4 } as const;
export const COMMAND = { wifiSettings: 1, identify: 2, deviceInfo: 3, scan: 4 } as const;
export const CAPABILITY = { identify: 1, deviceInfo: 2, scan: 4 } as const;

/** What each error state means, in words for the person. */
export const ERROR_TEXT: Record<number, string> = {
  1: 'The box could not read what was sent. Try again.',
  2: 'The box does not know that request.',
  3: 'The box could not join that network. Check its name and password.',
  4: 'The box is not ready for Wi-Fi settings yet.',
  5: 'The box did not accept that name.',
  255: 'Something went wrong on the box.',
};

/** Bluetooth LE sends 20 bytes at a time unless both sides agree on more; the box gathers the parts. */
const WRITE_BYTES = 20;
const MAX_DATA = 255;

export function checksum(bytes: Uint8Array) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return sum;
}

/** An RPC command: its command, its data's length, the data, and the checksum of all before it. */
export function rpcPacket(command: number, data: Uint8Array = new Uint8Array()) {
  if (data.length > MAX_DATA) throw new Error('That is too long to send to the box.');
  const packet = new Uint8Array(data.length + 3);
  packet.set([command, data.length]);
  packet.set(data, 2);
  packet[packet.length - 1] = checksum(packet.subarray(0, -1));
  return packet;
}

/** "Send Wi-Fi settings": the network's name and password, each after its length. */
export function wifiSettings(ssid: string, password: string) {
  const name = new TextEncoder().encode(ssid);
  const secret = new TextEncoder().encode(password);
  if (name.length < 1 || name.length > 32) throw new Error('A Wi-Fi network’s name has 1 to 32 bytes.');
  if (secret.length > 64) throw new Error('A Wi-Fi password has at most 64 characters.');
  const data = new Uint8Array(name.length + secret.length + 2);
  data[0] = name.length;
  data.set(name, 1);
  data[name.length + 1] = secret.length;
  data.set(secret, name.length + 2);
  return rpcPacket(COMMAND.wifiSettings, data);
}

/** A packet in the pieces one write takes each. */
export function chunks(packet: Uint8Array, size = WRITE_BYTES) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 0; at < packet.length; at += size) parts.push(packet.slice(at, at + size));
  return parts;
}

/** An RPC result: its command and list of strings, its length and checksum checked. */
export function parseResult(value: Uint8Array) {
  if (value.length < 3 || value[1] !== value.length - 3) throw new Error('The box sent a result that does not add up.');
  if (checksum(value.subarray(0, -1)) !== value.at(-1)) throw new Error('The box sent a damaged result.');
  const strings: string[] = [];
  const decoder = new TextDecoder();
  for (let at = 2; at < value.length - 1;) {
    const end = at + 1 + value[at]!;
    if (end > value.length - 1) throw new Error('The box sent a result that does not add up.');
    strings.push(decoder.decode(value.subarray(at + 1, end)));
    at = end;
  }
  return { command: value[0]!, strings };
}

export type ScannedNetwork = { ssid: string; rssi: number; auth: string };

/** A scan's result: SSID, signal and security, three strings a network; the strongest of each name only. */
export function scannedNetworks(strings: string[]) {
  const found = new Map<string, ScannedNetwork>();
  for (let at = 0; at + 2 < strings.length; at += 3) {
    const ssid = strings[at]!;
    const rssi = Number(strings[at + 1]);
    const network = { ssid, rssi: Number.isFinite(rssi) ? rssi : -100, auth: strings[at + 2]! };
    if (ssid && (found.get(ssid)?.rssi ?? -Infinity) < network.rssi) found.set(ssid, network);
  }
  return [...found.values()].sort((a, b) => b.rssi - a.rssi);
}

/** The link a box returns once it is on the network, if it is one a browser may open. */
export function finishLink(strings: string[]) {
  const url = URL.parse(strings[0] ?? '');
  return url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    ? url.href
    : undefined;
}
