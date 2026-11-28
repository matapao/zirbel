// Runs inside the authored document. The host validates every message again. It stays within what the game frame
// already needs of a browser (import maps: Chromium 89, Safari 16.4), as on TV browsers that run games.
import { boundedJson, compactProperties, jsonCopy, MAX_REGISTERED_OBJECTS } from '../sdk/bounded.ts';
import type { RegisteredObject } from '../sdk/game.ts';
import type { SeatInfo } from '../sdk/contracts.ts';
import { checkedControls, checkedLabel, MAX_PLACES, type Controls, type PlaceLabel } from '../sdk/controls.ts';
import { pressKeys } from './game-keys.ts';
import { screenPads } from './game-pads.ts';
import { checkedFrame, checkedLocal, checkedPads } from './pad-state.ts';

type RoomState = { self: SeatInfo; seats: SeatInfo[]; states: Record<string, unknown> };
const objects = new Map<string, RegisteredObject>();
const listeners = new Set<(room: RoomState) => void>();
let room: RoomState | undefined;
let update: number | undefined;
const channel = parent === window ? undefined : new MessageChannel();
const notify = (type: string, value: unknown) => channel?.port1.postMessage({ type, value });

function publishObjects() {
  if (update !== undefined) return;
  update = window.setTimeout(() => {
    update = undefined;
    notify('zirbel.objects', [...objects.values()]);
  }, 80);
}

const gameData = document.getElementById('zirbel-assets')!;
/** What a place's player drives, for the screen and the place's phone to show: an adapter's to say, never a game's. */
const place = (index: number, label: PlaceLabel) => {
  const checked = checkedLabel(label);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PLACES || !checked)
    throw new Error('Give a place 0 to 7, a name of 1 to 24 characters and a #rrggbb colour.');
  notify('zirbel.place', { place: index, ...checked });
};
const sdk = {
  assets: Object.freeze(JSON.parse(gameData.textContent) as Record<string, string>),
  register(id: string, properties: Record<string, unknown> = {}) {
    if (gameData.dataset.registration === 'off') return;
    if (typeof id !== 'string' || id.length < 1 || id.length > 120)
      throw new Error('Register an ID of 1 to 120 characters.');
    if (!compactProperties(properties)) throw new Error('Provide compact JSON properties.');
    if (!objects.has(id) && objects.size >= MAX_REGISTERED_OBJECTS) throw new Error('The inspector is full.');
    objects.set(id, jsonCopy({ id, properties }));
    publishObjects();
  },
  unregister(id: string) {
    if (objects.delete(id)) publishObjects();
  },
  send(state: unknown) {
    if (boundedJson(state) && JSON.stringify(state).length <= 4096) notify('zirbel.state', state);
  },
  onRoom(listener: (room: RoomState) => void) {
    listeners.add(listener);
    if (room) listener(room);
    return () => listeners.delete(listener);
  },
  place,
};
Object.defineProperty(window, 'zirbel', { value: Object.freeze(sdk) });
// Every controller of the screen is a gamepad at its place (phones and the box's gamepads from the page, the device's
// own where the page placed them), before the game reads any; a game that reads only the keyboard gets each place's keys
// from its zirbel.json, and the screen the names and colours it gives its places.
const pads = screenPads((effect) => notify('zirbel.rumble', effect), !channel);
let controls: Controls | undefined;
try {
  controls = checkedControls(JSON.parse(document.getElementById('zirbel-controls')?.textContent ?? 'null'));
} catch {
  controls = undefined;
}
if (controls) {
  pressKeys(controls);
  controls.players?.forEach(({ name, color }, index) => {
    if (name || color) place(index, { name, color });
  });
}
if (channel) {
  channel.port1.onmessage = (event) => {
    const { type, value } = (event.data ?? {}) as { type?: unknown; value?: unknown };
    if (type === 'zirbel.pads') {
      const list = checkedPads(value);
      if (list) pads.list(list);
      return;
    }
    if (type === 'zirbel.pad') {
      const frame = checkedFrame(value);
      if (frame) pads.frame(frame.slot, frame);
      return;
    }
    if (type === 'zirbel.local') {
      const placed = checkedLocal(value);
      if (placed) pads.local(placed);
      return;
    }
    if (type !== 'zirbel.room') return;
    room = value as RoomState;
    for (const listener of listeners) listener(room);
  };
  // /game/<room>/<key>/…, or a net game's /game/@<room>/<key>/…: a built game's document and the pages beside it share the key.
  const documentKey = location.pathname.split('/')[3];
  parent.postMessage({ type: 'zirbel.ready', documentKey }, location.origin, [channel.port2]);
}
window.addEventListener('error', (event) => {
  if (event.message) notify('zirbel.error', String(event.message).slice(0, 500));
});
window.addEventListener('unhandledrejection', (event) => {
  notify('zirbel.error', String(event.reason?.message ?? event.reason).slice(0, 500));
});
