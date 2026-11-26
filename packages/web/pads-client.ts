// A stand-in for track P's client until it lands, speaking the pads socket (/pads on the player listener) as the screens
// design gives it: a screen (openScreen), which shows a game and takes controllers at its places (P1 to P8, 0 to 7 on
// the wire), and a controller (openPad), which joins a screen by its code and sends its pad state. JSON control messages
// as text, pad state as binary frames.
import { decodePad, encodePad, type PadState } from '../sdk/pads.ts';
import type { PlaceLabel } from '../sdk/controls.ts';

export type ScreenInfo = { id: string; code: string; resume: string; box: boolean; tv: boolean };
/** A screen's controller at its place (slot), with what it drives there (label) where the game says. */
export type PadEntry = { slot: number; place: number; kind: 'phone' | 'box'; name: string; connected: boolean; label: PlaceLabel | null };
export type Rumble = { duration: number; strong: number; weak: number };
export type Screen = {
  /** For 30 s, the next controller whose A goes down takes this place (or the first free one). */
  claim(place?: number): void;
  release(slot: number): void; rumble(slot: number, effect: Rumble): void; show(link: string): void;
  /** Swaps two places, either of which may be empty. */
  move(from: number, to: number): void;
  /** What each place drives, which its pad hears. */
  labels(labels: (PlaceLabel & { place: number })[]): void;
  /** The places the device's own gamepads hold, which the host gives no one else. */
  local(places: number[]): void;
  close(): void;
};
export type PadInfo = { slot: number; place: number; screen: string; resume: string; label: PlaceLabel | null };
export type Pad = { send(state: PadState): void; place(place: number): void; close(): void };

function socketUrl(query: string) {
  const url = new URL('/pads?' + query, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}
function parsed(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string' || data.length > 4096) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function openScreen(handlers: { resume?: string; onScreen(screen: ScreenInfo): void; onPads(pads: PadEntry[]): void;
  onFrame(state: PadState): void; onOpen(link: string): void; onShown?(code: string): void }): Screen {
  let resume = handlers.resume ?? '';
  let socket: WebSocket | undefined;
  let stopped = false;
  let attempts = 0;
  const connect = () => {
    const opened = new WebSocket(socketUrl('role=screen' + (resume ? '&resume=' + encodeURIComponent(resume) : '')));
    opened.binaryType = 'arraybuffer';
    socket = opened;
    opened.addEventListener('message', ({ data }) => {
      if (data instanceof ArrayBuffer) {
        const state = decodePad(data);
        if (state) handlers.onFrame(state);
        return;
      }
      const message = parsed(data);
      if (message?.type === 'screen') {
        attempts = 0;
        resume = String(message.resume);
        handlers.onScreen(message as unknown as ScreenInfo);
      } else if (message?.type === 'pads' && Array.isArray(message.pads)) handlers.onPads(message.pads as PadEntry[]);
      else if (message?.type === 'open' && typeof message.link === 'string') handlers.onOpen(message.link);
      else if (message?.type === 'shown' && typeof message.code === 'string') handlers.onShown?.(message.code);
    });
    opened.addEventListener('close', () => {
      if (stopped || socket !== opened || ++attempts > 20) return;
      window.setTimeout(connect, Math.min(4000, attempts * 300));
    });
  };
  connect();
  const send = (message: object) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  return {
    claim: (place) => send(place === undefined ? { type: 'claim' } : { type: 'claim', place }),
    release: (slot) => send({ type: 'release', slot }),
    rumble: (slot, effect) => send({ type: 'rumble', slot, ...effect }),
    show: (link) => send({ type: 'show', link }),
    move: (from, to) => send({ type: 'move', from, to }),
    labels: (labels) => send({ type: 'labels', labels }),
    local: (places) => send({ type: 'local', places }),
    close() { stopped = true; socket?.close(); },
  };
}

/** Joins the screen whose code this is: at place, where it is free, or back at the place resume held. */
export function openPad(code: string, handlers: { place?: number; resume?: string; onPad(pad: PadInfo): void;
  onRumble(effect: Rumble): void; onClosed(code: number): void }): Pad {
  const query = 'role=pad&code=' + encodeURIComponent(code) + (handlers.place === undefined ? '' : '&place=' + handlers.place) +
    (handlers.resume ? '&resume=' + encodeURIComponent(handlers.resume) : '');
  const socket = new WebSocket(socketUrl(query));
  socket.binaryType = 'arraybuffer';
  let closed = false;
  socket.addEventListener('message', ({ data }) => {
    const message = parsed(data);
    if (message?.type === 'pad' && typeof message.slot === 'number') handlers.onPad(message as unknown as PadInfo);
    else if (message?.type === 'rumble') handlers.onRumble(message as unknown as Rumble);
    else if (message?.type === 'closed') { closed = true; handlers.onClosed(1000); }
  });
  socket.addEventListener('close', (event) => { if (!closed) handlers.onClosed(event.code); });
  const send = (message: string | Uint8Array<ArrayBuffer>) => { if (socket.readyState === WebSocket.OPEN) socket.send(message); };
  return {
    send: (state) => send(encodePad(state)),
    place: (place) => send(JSON.stringify({ type: 'place', place })),
    close() { closed = true; socket.close(); },
  };
}
