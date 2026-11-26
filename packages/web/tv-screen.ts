// The TV page's screen (tv.ts): the pads socket's screen side (docs/screens.md), behind the names the TV page uses.
// Until the pads client (pads-client.ts, the frame codec in sdk/pads.ts) is in this build, a small client of the same
// wire stands in for it here; the page sees only openScreen and these types. The screen's resume token is kept in
// sessionStorage, so the player page it goes to in this tab keeps the same screen, its code and its places.

/** A controller on the screen at a place (0..7, P1..P8): a phone or a gamepad on the box, with what it drives there. */
export type Pad = { slot: number; place: number; kind: 'phone' | 'box'; name: string; connected: boolean;
  label: { name: string; color: string } | null };
/** The screen as the host names it: its code for phones, whether it is the box's own, whether a box screen is open. */
export type ScreenInfo = { id: string; code: string; resume: string; box: boolean; tv: boolean };
/** A controller's state as a frame carries it: buttons pressed as a bitmask, their values and the axes from -1 to 1. */
type PadState = { slot: number; standard: boolean; pressed: number; values: number[]; axes: number[] };
type ScreenEvents = {
  resume?: string; onScreen: (info: ScreenInfo) => void; onPads: (pads: Pad[]) => void; onFrame: (state: PadState) => void;
  onOpen: (link: string) => void;
};
/** What the page asks of the host: a place taken by the next controller whose A goes down, a controller let go, two
 *  places swapped, and the places the device's own gamepads hold. */
export type Screen = {
  claim: (place?: number) => void; release: (slot: number) => void; move: (from: number, to: number) => void;
  local: (places: number[]) => void; close: () => void;
};
export type OpenScreen = (events: ScreenEvents) => Screen;

/** Where this tab keeps its screen's resume token, for the next page it opens. */
const RESUME_KEY = 'zirbel-screen';
export function savedResume() { try { return sessionStorage.getItem(RESUME_KEY) ?? undefined; } catch { return undefined; } }
export function saveResume(token: string) { try { sessionStorage.setItem(RESUME_KEY, token); } catch { /* this page alone */ } }

/** A pad frame: slot, flags (bit 0: standard), n buttons, m axes, the pressed bitmask (u32 LE), n values (0..255) and m
 *  axes (i16 LE, ±32767). Nothing for one that isn't. */
function readFrame(data: ArrayBuffer): PadState | undefined {
  const view = new DataView(data);
  if (view.byteLength < 8) return undefined;
  const buttons = view.getUint8(2), axes = view.getUint8(3);
  if (buttons > 32 || axes > 8 || view.byteLength !== 8 + buttons + axes * 2) return undefined;
  const values: number[] = [], sticks: number[] = [];
  for (let i = 0; i < buttons; i++) values.push(view.getUint8(8 + i) / 255);
  for (let i = 0; i < axes; i++) sticks.push(Math.max(-1, view.getInt16(8 + buttons + i * 2, true) / 32767));
  return { slot: view.getUint8(0), standard: (view.getUint8(1) & 1) === 1, pressed: view.getUint32(4, true), values, axes: sticks };
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** The stand-in client: the screen's socket, opened again (resumed) when it drops. */
export const openScreen: OpenScreen = (events) => {
  let resume = events.resume;
  let socket: WebSocket | undefined;
  let closed = false;
  const send = (message: object) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const connect = () => {
    const url = new URL('/pads', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('role', 'screen');
    if (resume) url.searchParams.set('resume', resume);
    const opened = new WebSocket(url.href);
    opened.binaryType = 'arraybuffer';
    socket = opened;
    opened.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) { const state = readFrame(data); if (state) events.onFrame(state); return; }
      let message: Record<string, unknown>;
      try { message = object(JSON.parse(String(data))); } catch { return; }
      if (message.type === 'screen' && typeof message.code === 'string' && typeof message.resume === 'string') {
        resume = message.resume;
        events.onScreen({ id: String(message.id), code: message.code, resume: message.resume, box: message.box === true, tv: message.tv === true });
      } else if (message.type === 'pads' && Array.isArray(message.pads)) {
        events.onPads(message.pads.map(object).map((pad) => ({ slot: Number(pad.slot), place: Number(pad.place ?? pad.slot),
          kind: pad.kind === 'box' ? 'box' as const : 'phone' as const, name: text(pad.name), connected: pad.connected !== false,
          label: typeof object(pad.label).name === 'string' ? { name: text(object(pad.label).name), color: text(object(pad.label).color) } : null })));
      } else if (message.type === 'open' && typeof message.link === 'string') events.onOpen(message.link);
    };
    opened.onclose = () => { if (!closed && socket === opened) setTimeout(connect, 1500); };
  };
  connect();
  return {
    claim: (place) => send(place === undefined ? { type: 'claim' } : { type: 'claim', place }),
    release: (slot) => send({ type: 'release', slot }),
    move: (from, to) => send({ type: 'move', from, to }),
    local: (places) => send({ type: 'local', places }),
    close: () => { closed = true; socket?.close(); },
  };
};
