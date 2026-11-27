// A controller's link to its screen, for the pad page and a player page whose game went to the TV: it joins the screen
// by its code (pads-client's openPad), at the place it asks for or the first free one, and sends its pad whenever it
// changes; pads-client repeats it while it is still, keeps to 120 a second, and joins again when the connection drops,
// back at its place. It vibrates where the device can when the screen rumbles it. The pad comes from the device's own
// gamepad while one is connected, else from the page's own controls (the touch pad, the keyboard).
import type { PlaceLabel } from '../sdk/controls.ts';
import { openPad, type Rumble } from './pads-client.ts';
import { padOf, restingPad, samePad, type Pad } from './pad-state.ts';

export type LinkState =
  | { state: 'joining' } | { state: 'joined'; place: number; label: PlaceLabel | null }
  /** For good: retry says whether the same code may work later. */
  | { state: 'ended'; message: string; retry: boolean };

/** Why a controller's connection ended, by its close code. */
function ending(code: number, screen: string): Extract<LinkState, { state: 'ended' }> {
  switch (code) {
    case 4404: return { state: 'ended', message: 'No screen has the code ' + screen + '. Check the code on the screen.', retry: false };
    case 4409: return { state: 'ended', message: 'That screen has eight controllers already.', retry: true };
    case 4429: return { state: 'ended', message: 'Too many wrong codes from this device. Try again in a minute.', retry: true };
    case 4000: return { state: 'ended', message: 'The screen let this controller go.', retry: true };
    case 4001: return { state: 'ended', message: 'Another page took this controller’s place.', retry: true };
    default: return { state: 'ended', message: 'The screen closed.', retry: false };
  }
}

/** A device's own gamepad: the first connected one, if any. Some browsers have none, or none outside a secure page. */
function ownGamepad(): Gamepad | undefined {
  try { return [...navigator.getGamepads?.() ?? []].find((pad): pad is Gamepad => Boolean(pad?.connected)); }
  catch { return undefined; }
}

function vibrate({ duration, strong, weak }: Rumble) {
  if (typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(duration > 0 && Math.max(strong, weak) > 0 ? Math.min(5000, duration) : 0); } catch { /* not allowed yet */ }
}

export function padLink(code: string, onState: (state: LinkState) => void, options: { place?: number | undefined } = {}, open = openPad) {
  let current = restingPad();
  let stopped = false;
  onState({ state: 'joining' });
  const socket = open(code, {
    place: options.place,
    onPad: ({ slot, label }) => onState({ state: 'joined', place: slot, label }),
    onRumble: vibrate,
    onClosed(reason) { if (!stopped) { stopped = true; onState(ending(reason, code)); } },
  });
  socket.send(current);
  return {
    /** The pad as it reads now: sent when it differs from the last. */
    update(pad: Pad) {
      if (stopped || samePad(pad, current)) return;
      current = pad;
      socket.send(pad);
    },
    /** Moves to this place, where it is free: the host says where the link is now. */
    move(place: number) { socket.place(place); },
    close() {
      if (stopped) return;
      stopped = true;
      socket.close();
    },
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
