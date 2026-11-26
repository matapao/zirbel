// A controller's link to its screen, for the pad page and a player page whose game went to the TV: it joins the screen
// by its code (pads-client's openPad), at the place it asks for or the first free one, sends its pad whenever it changes
// (at most 120 times a second) and four times a second while it is still, vibrates where the device can when the screen
// rumbles it, and joins again with the same code when the connection drops, back at its place (resume, for 60 s). The pad
// comes from the device's own gamepad while one is connected, else from the page's own controls (the touch pad, the
// keyboard).
import type { PlaceLabel } from '../sdk/controls.ts';
import { openPad, type Pad as PadSocket, type Rumble } from './pads-client.ts';
import { padOf, restingPad, samePad, type Pad } from './pad-state.ts';

export type LinkState =
  | { state: 'joining' } | { state: 'joined'; place: number; label: PlaceLabel | null } | { state: 'lost' }
  /** For good: retry says whether the same code may work later. */
  | { state: 'ended'; message: string; retry: boolean };

const SOONEST = 1000 / 120;
const STILL = 250;

/** Why a controller's connection ended, by its close code, or nothing when it only dropped. */
export function ending(code: number, screen: string): Extract<LinkState, { state: 'ended' }> | undefined {
  switch (code) {
    case 4404: return { state: 'ended', message: 'No screen has the code ' + screen + '. Check the code on the screen.', retry: false };
    case 4409: return { state: 'ended', message: 'That screen has eight controllers already.', retry: true };
    case 4429: return { state: 'ended', message: 'Too many wrong codes from this device. Try again in a minute.', retry: true };
    case 4000: return { state: 'ended', message: 'The screen let this controller go.', retry: true };
    case 1000: return { state: 'ended', message: 'The screen closed.', retry: false };
    default: return undefined;
  }
}

/** A device's own gamepad: the first connected one, if any. Some browsers have none, or none outside a secure page. */
export function ownGamepad(): Gamepad | undefined {
  try { return [...navigator.getGamepads?.() ?? []].find((pad): pad is Gamepad => Boolean(pad?.connected)); }
  catch { return undefined; }
}

/** resume keeps the place a link held, as the host gave it (kept: where it is kept, so a page loaded again has it). */
export function padLink(code: string, onState: (state: LinkState) => void,
  options: { place?: number; resume?: string; kept?(resume: string): void } = {}, open = openPad) {
  let socket: PadSocket | undefined;
  let resume = options.resume;
  let current = restingPad();
  let slot: number | undefined;
  let sentAt = 0;
  let timer: number | undefined;
  let attempts = 0;
  let stopped = false;
  const send = () => {
    timer = undefined;
    if (slot === undefined || !socket) return;
    socket.send({ slot, ...current });
    sentAt = performance.now();
  };
  const soon = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(send, Math.max(0, sentAt + SOONEST - performance.now()));
  };
  const still = window.setInterval(() => { if (performance.now() - sentAt >= STILL - 5) soon(); }, STILL);
  const vibrate = ({ duration, strong, weak }: Rumble) => {
    if (typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(duration > 0 && Math.max(strong, weak) > 0 ? Math.min(5000, duration) : 0); } catch { /* not allowed yet */ }
  };
  const connect = () => {
    onState({ state: 'joining' });
    const opened = open(code, {
      place: options.place, resume,
      onPad(pad) {
        attempts = 0;
        const first = slot === undefined;
        slot = pad.slot;
        if (pad.resume && pad.resume !== resume) { resume = pad.resume; options.kept?.(pad.resume); }
        onState({ state: 'joined', place: pad.place ?? pad.slot, label: pad.label ?? null });
        if (first) send();
      },
      onRumble: vibrate,
      onClosed(reason) {
        if (socket !== opened || stopped) return;
        slot = undefined;
        socket = undefined;
        const ended = ending(reason, code);
        if (ended || ++attempts > 30) { stop(); onState(ended ?? { state: 'ended', message: 'The screen can’t be reached.', retry: true }); return; }
        onState({ state: 'lost' });
        window.setTimeout(() => { if (!stopped) connect(); }, Math.min(5000, attempts * 500));
      },
    });
    socket = opened;
  };
  function stop() {
    stopped = true;
    window.clearInterval(still);
    if (timer !== undefined) window.clearTimeout(timer);
    const closing = socket;
    socket = undefined;
    closing?.close();
  }
  connect();
  return {
    /** The pad as it reads now: sent when it differs from the last. */
    update(pad: Pad) {
      if (samePad(pad, current)) return;
      current = pad;
      soon();
    },
    /** Moves to this place, where it is free: the host says where the link is now. */
    move(place: number) { socket?.place(place); },
    close: stop,
  };
}

/** Reads the pad each animation frame: the device's own gamepad while one is connected, else the page's (own); says
 *  which gamepad it reads, or none. */
export function readPad(own: () => Pad, update: (pad: Pad) => void, onGamepad: (gamepad: string | undefined) => void) {
  let frame = 0;
  let shown: string | undefined;
  const read = () => {
    const gamepad = ownGamepad();
    if (gamepad?.id !== shown) { shown = gamepad?.id; onGamepad(shown); }
    update(gamepad ? padOf(gamepad) : own());
    frame = requestAnimationFrame(read);
  };
  frame = requestAnimationFrame(read);
  return () => cancelAnimationFrame(frame);
}
