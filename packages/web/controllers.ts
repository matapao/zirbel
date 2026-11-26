// The player page as a screen (pads-client's openScreen): its controllers at their places, P1 to P8. The host's phones
// and box gamepads come with their state, which goes on to the game's frame (zirbel.pads, zirbel.pad); the device's own
// gamepads, which this page reads too, take a place when first pressed (the first free one, or the one on offer), which
// the frame hears (zirbel.local) and the host too, so it gives those places no one else. The game's frame says what
// each place drives (zirbel.place), which the host passes to the place's phone, and rumbles a controller through here.
import { checkedLabel, MAX_PLACES, type PlaceLabel } from '../sdk/controls.ts';
import type { PadState } from '../sdk/pads.ts';
import type { LocalPad } from './game-pads.ts';
import { openScreen, type PadInfo, type ScreenInfo } from './pads-client.ts';
import { slotColour } from './pad-state.ts';

/** How long "Press A to take Pk" waits, as the host's claim does. */
const CLAIM_MS = 30_000;

export type Occupant = { kind: 'phone' | 'box' | 'own'; name: string };
export type Controllers = ReturnType<typeof screenControllers>;

/** The device's own gamepads, as the page reads them; none where the browser has none. */
function ownGamepads(): Gamepad[] {
  try { return [...navigator.getGamepads?.() ?? []].filter((pad): pad is Gamepad => Boolean(pad?.connected)); }
  catch { return []; }
}

/** open: whether this page is a screen on its host (a page in the editor's preview isn't, and reads only its device's
 *  gamepads). onChange hears whenever what the panel shows changes; onShown, that the game went to the TV, whose code
 *  this page now controls it by. */
export function screenControllers(options: { open: boolean; onChange(): void; onShown(code: string): void }) {
  let info: ScreenInfo | undefined;
  let pads: PadInfo[] = [];
  let local: LocalPad[] = [];
  const frames = new Map<number, PadState>();
  const labels = new Map<number, PlaceLabel>();
  let claim: { place?: number; until: number; timer: number } | undefined;
  let port: MessagePort | undefined;
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no target origin
  const post = (type: string, value: unknown) => port?.postMessage({ type, value });
  const forFrame = () => pads.map(({ slot, kind, name, connected }) => ({ slot, kind, name, connected }));

  // The screen resumes this tab's last one (the TV page's, a game's before it), kept by pads-client.
  const screen = options.open ? openScreen({
    onScreen(next) { info = next; options.onChange(); },
    onPads(next) {
      pads = next;
      for (const slot of frames.keys()) if (!pads.some((pad) => pad.slot === slot)) frames.delete(slot);
      if (claim?.place !== undefined && occupant(claim.place)) endClaim();
      post('zirbel.pads', forFrame());
      options.onChange();
    },
    onFrame(state) { frames.set(state.slot, state); post('zirbel.pad', state); },
    // This page is the box's own screen (the TV), and someone showed their game on it: it goes there, as that seat.
    onOpen(link) {
      const target = new URL(link, location.href);
      try { sessionStorage.removeItem('zirbel-room:' + target.pathname.split('/').at(-1)); } catch { /* nothing kept */ }
      if (target.pathname === location.pathname && target.search === location.search) { location.hash = target.hash; location.reload(); }
      else location.assign(target);
    },
    // Taken over by another page of this screen, or ended.
    onClosed() { info = undefined; options.onChange(); },
  }) : undefined;

  /** Who holds a place: a phone or box gamepad on the host, or one of the device's own. */
  function occupant(place: number): Occupant | undefined {
    const pad = pads.find((item) => item.slot === place && item.connected);
    if (pad) return { kind: pad.kind, name: pad.name };
    const own = local.find((item) => item.place === place);
    return own && { kind: 'own', name: own.id };
  }
  const free = () => Array.from({ length: MAX_PLACES }, (_, place) => place).filter((place) => !occupant(place));
  function placed(next: LocalPad[]) {
    local = next;
    post('zirbel.local', local);
    screen?.local(local.map(({ place }) => place));
    if (claim?.place !== undefined && occupant(claim.place)) endClaim();
    options.onChange();
  }
  function endClaim() {
    if (claim) clearTimeout(claim.timer);
    claim = undefined;
    options.onChange();
  }

  // The device's own gamepads: a place on the first press, or the place on offer when A goes down while it is.
  const held = new Map<string, boolean[]>();
  let reading = 0;
  function read() {
    reading = 0;
    const gamepads = ownGamepads();
    let next = local.filter(({ index, id }) => gamepads.some((pad) => pad.index === index && pad.id === id));
    for (const pad of gamepads) {
      const key = pad.index + ' ' + pad.id;
      const before = held.get(key) ?? [];
      const now = pad.buttons.map(({ pressed }) => pressed);
      held.set(key, now);
      const pressed = now.some((down, button) => down && !before[button]);
      const a = now[0] && !before[0];
      const at = next.find(({ index, id }) => index === pad.index && id === pad.id);
      const offer = claim?.place;
      if (!pressed) continue;
      if (a && offer !== undefined && !occupant(offer) && at?.place !== offer) {
        next = [...next.filter((item) => item !== at), { place: offer, index: pad.index, id: pad.id }];
        endClaim();
      } else if (!at) {
        const place = offer !== undefined && a && !occupant(offer) ? offer : free().find((spot) => !next.some((item) => item.place === spot));
        if (place !== undefined) next = [...next, { place, index: pad.index, id: pad.id }];
      }
    }
    for (const key of held.keys()) if (!gamepads.some((pad) => pad.index + ' ' + pad.id === key)) held.delete(key);
    if (JSON.stringify(next) !== JSON.stringify(local)) placed(next);
    if (gamepads.length) reading = requestAnimationFrame(read);
  }
  const startReading = () => { reading ||= requestAnimationFrame(read); };
  window.addEventListener('gamepadconnected', startReading);
  window.addEventListener('gamepaddisconnected', startReading);
  startReading();

  let sending: number | undefined;
  return {
    get info() { return info; },
    get pads() { return pads; },
    get labels() { return labels; },
    get claiming() { return claim && { place: claim.place, until: claim.until }; },
    occupant,
    /** The game's frame, whose port hears the controllers from now on. */
    attach(next: MessagePort) {
      port = next;
      post('zirbel.pads', forFrame());
      for (const state of frames.values()) post('zirbel.pad', state);
      post('zirbel.local', local);
    },
    /** What the game's frame asks of its controllers: a rumble, or what a place drives. */
    fromGame(type: string, value: unknown) {
      const message = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
      const place = message.place ?? message.slot;
      if (!Number.isInteger(place) || (place as number) < 0 || (place as number) >= MAX_PLACES) return;
      if (type === 'zirbel.rumble') {
        const unit = (input: unknown) => (typeof input === 'number' && Number.isFinite(input) ? Math.min(1, Math.max(0, input)) : 0);
        const duration = typeof message.duration === 'number' && Number.isFinite(message.duration) ? Math.min(5000, Math.max(0, message.duration)) : 0;
        if (pads.some((pad) => pad.slot === place)) screen?.rumble(place as number, { duration, strong: unit(message.strong), weak: unit(message.weak) });
      } else if (type === 'zirbel.place') {
        const label = checkedLabel(message);
        if (!label) return;
        labels.set(place as number, label);
        // A phone shows a name in a colour: a place's own colour where the game names none.
        sending ??= window.setTimeout(() => {
          sending = undefined;
          screen?.labels([...labels].flatMap(([at, { name, color }]) => (name ? [{ place: at, name, color: color ?? slotColour(at) }] : [])));
        }, 100);
        options.onChange();
      }
    },
    /** "Press A to take Pk": for 30 s the next controller whose A goes down takes it (or, without a place, the first free). */
    claim(place?: number) {
      endClaim();
      screen?.claim(place);
      claim = { place, until: Date.now() + CLAIM_MS, timer: window.setTimeout(endClaim, CLAIM_MS) };
      options.onChange();
    },
    /** Swaps the controllers at two places, either of which may be empty. */
    swap(from: number, to: number) {
      if (from === to) return;
      const moved = local.map((item) => item.place === from ? { ...item, place: to } : item.place === to ? { ...item, place: from } : item);
      placed(moved);
      if (pads.some((pad) => pad.slot === from || pad.slot === to)) screen?.move(from, to);
    },
    /** Lets the controller at a place go: a phone or box gamepad from the host, the device's own until its next press. */
    release(place: number) {
      if (local.some((item) => item.place === place)) placed(local.filter((item) => item.place !== place));
      else screen?.release(place);
    },
    /** Show on TV: the box's screen opens this seat's link, and this page controls it there by its code. */
    show(link: string) { void screen?.show(link).then((code) => options.onShown(code), () => options.onChange()); },
    close() {
      endClaim();
      window.removeEventListener('gamepadconnected', startReading);
      window.removeEventListener('gamepaddisconnected', startReading);
      cancelAnimationFrame(reading);
      screen?.close();
    },
  };
}
