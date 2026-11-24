// Runs inside the authored document. The host validates every message again.
import { boundedJson, compactProperties, MAX_REGISTERED_OBJECTS } from '../sdk/bounded.ts';
import type { RegisteredObject } from '../sdk/game.ts';
import type { SeatInfo } from '../sdk/contracts.ts';

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
const sdk = {
  assets: Object.freeze(JSON.parse(gameData.textContent) as Record<string, string>),
  register(id: string, properties: Record<string, unknown> = {}) {
    if (gameData.dataset.registration === 'off') return;
    if (typeof id !== 'string' || id.length < 1 || id.length > 120) throw new Error('Register an ID of 1 to 120 characters.');
    if (!compactProperties(properties)) throw new Error('Provide compact JSON properties.');
    if (!objects.has(id) && objects.size >= MAX_REGISTERED_OBJECTS) throw new Error('The inspector is full.');
    objects.set(id, structuredClone({ id, properties }));
    publishObjects();
  },
  unregister(id: string) { if (objects.delete(id)) publishObjects(); },
  send(state: unknown) {
    if (boundedJson(state) && JSON.stringify(state).length <= 4096) notify('zirbel.state', state);
  },
  onRoom(listener: (room: RoomState) => void) {
    listeners.add(listener);
    if (room) listener(room);
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, 'zirbel', { value: Object.freeze(sdk) });
if (channel) {
  channel.port1.onmessage = (event) => {
    if (event.data?.type !== 'zirbel.room') return;
    room = event.data.value as RoomState;
    for (const listener of listeners) listener(room);
  };
  // /game/<room>/<key>/…: a built game's document and the pages beside it share the key.
  const documentKey = location.pathname.split('/')[3];
  parent.postMessage({ type: 'zirbel.ready', documentKey }, location.origin, [channel.port2]);
}
window.addEventListener('error', (event) => {
  if (event.message) notify('zirbel.error', String(event.message).slice(0, 500));
});
window.addEventListener('unhandledrejection', (event) => {
  notify('zirbel.error', String(event.reason?.message ?? event.reason).slice(0, 500));
});
