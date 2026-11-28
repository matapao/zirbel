// The pads socket from a page (packages/core/pads.ts has the host's side): a screen, which shows a game and takes its
// controllers' pad frames, and a pad, a phone's controller of a screen whose code it has. Each controller holds a place
// on its screen, P1 to P8 (0 to 7; the frames' slot). Both reconnect by themselves: a screen resumes with its code and
// controllers from this tab's sessionStorage, across pages (15 s), and a pad takes its place back (60 s).
import { decodePad, encodePad, type PadState } from '../sdk/pads.ts';

export { decodePad, encodePad } from '../sdk/pads.ts';

/** A screen as the host gave it: box, it is the box's own; tv, the box's own screen is open (Show on TV). */
export type ScreenInfo = { id: string; code: string; resume: string; box: boolean; tv: boolean };
/** What a place drives, as the game names it: at most 24 characters, and a #rrggbb colour. */
export type PlaceLabel = { name: string; color: string };
/** A controller on a screen: slot and place are the same, its place. */
export type PadInfo = {
  slot: number;
  place: number;
  kind: 'phone' | 'box';
  name: string;
  connected: boolean;
  label: PlaceLabel | null;
};
/** A rumble: ms at most 5000, and the strong and weak motors' magnitudes, 0 to 1. */
export type Rumble = { duration: number; strong: number; weak: number };

/** The sessionStorage keys a tab's screen keeps its resume token under, and its pad its code's. */
const SCREEN_KEY = 'zirbel.screen';
const PAD_KEY = 'zirbel.pad';
/** Close codes after which a socket is not opened again: a screen's own close, taken over by another page, released by
 *  its screen, no screen with that code, a full screen, too many wrong codes. */
const FINAL = new Set([1000, 4000, 4001, 4404, 4409, 4429]);
/** A pad repeats its state this often while it is still; the host drops a pad that sends nothing for 10 s. */
const STILL = 250;
const PER_SECOND = 120;

const stored = (key: string) => {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const store = (key: string, value: string) => {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    /* not kept */
  }
};
const record = (value: unknown) =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
/** A number in low..high, and low for one that is none. */
const within = (value: number, low: number, high: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const labelOf = (value: unknown): PlaceLabel | null => {
  const label = record(value);
  return typeof label.name === 'string' && typeof label.color === 'string'
    ? { name: label.name, color: label.color }
    : null;
};
/** A name cut at 24 characters (UTF-16 units, as the host counts them), between whole characters. */
const cut = (text: string) => {
  let out = '';
  for (const character of text) {
    if (out.length + character.length > 24) break;
    out += character;
  }
  return out;
};
/** A place, 0 to 7: the host closes a screen that names another, so none is sent. */
const isPlace = (place: unknown): place is number =>
  Number.isInteger(place) && (place as number) >= 0 && (place as number) < 8;

/** One socket to /pads that opens again a second after it drops, until a final close or close(). */
function connection(
  origin: string,
  query: () => string,
  handlers: {
    text(message: Record<string, unknown>): void;
    binary?(frame: Uint8Array): void;
    open?(): void;
    final(code: number): void;
  },
) {
  let socket: WebSocket | undefined;
  let ended = false;
  const open = () => {
    const opened = new WebSocket(origin.replace(/^http/, 'ws') + '/pads?' + query());
    socket = opened;
    opened.binaryType = 'arraybuffer';
    opened.onopen = () => handlers.open?.();
    opened.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data instanceof ArrayBuffer) {
        handlers.binary?.(new Uint8Array(data));
        return;
      }
      if (typeof data !== 'string') return;
      try {
        handlers.text(record(JSON.parse(data)));
      } catch {
        /* not a message */
      }
    };
    opened.onclose = ({ code }) => {
      if (socket !== opened || ended) return;
      if (FINAL.has(code)) {
        ended = true;
        handlers.final(code);
        return;
      }
      setTimeout(() => {
        if (!ended) open();
      }, 1000);
    };
  };
  open();
  return {
    send(data: string | Uint8Array<ArrayBuffer>) {
      if (socket?.readyState === 1) socket.send(data);
    },
    close() {
      if (ended) return;
      ended = true;
      socket?.close(1000);
    },
  };
}

export type ScreenOptions = {
  /** The resume token of the screen to keep; by default (or undefined) this tab's last screen's, kept in sessionStorage. */
  resume?: string | undefined;
  onScreen?(screen: ScreenInfo): void;
  onPads?(pads: PadInfo[]): void;
  /** A controller's state; its slot is its place. */
  onFrame?(pad: PadState, frame: Uint8Array): void;
  /** On the box's own screen: Show on TV asks it to open this player page. */
  onOpen?(link: string): void;
  /** The screen ended: closed, or taken over by another page with its resume token. */
  onClosed?(code: number): void;
  /** The listener's address, by default this page's. */
  origin?: string;
};

/** Opens this page as a screen. close() ends it at once, its phones let go; a page that navigates away keeps it for 15 s,
 *  for the next page to resume. The labels and local places it was given are said again after each reconnection. */
export function openScreen(options: ScreenOptions = {}) {
  let info: ScreenInfo | undefined;
  let resume = options.resume ?? stored(SCREEN_KEY);
  let labels: { place: number; name: string; color: string }[] = [],
    local: number[] = [];
  let showing: { resolve(code: string): void; reject(error: Error): void } | undefined;
  const settle = (code?: string) => {
    const waiting = showing;
    showing = undefined;
    if (code !== undefined) waiting?.resolve(code);
    else waiting?.reject(new Error('No TV is showing the lobby.'));
  };
  const send = (message: object) => socket.send(JSON.stringify(message));
  const socket = connection(
    options.origin ?? location.origin,
    () => 'role=screen' + (resume ? '&resume=' + encodeURIComponent(resume) : ''),
    {
      open() {
        if (labels.length) send({ type: 'labels', labels });
        if (local.length) send({ type: 'local', places: local });
      },
      text(message) {
        if (message.type === 'screen' && typeof message.code === 'string' && typeof message.resume === 'string') {
          info = {
            id: String(message.id),
            code: message.code,
            resume: message.resume,
            box: message.box === true,
            tv: message.tv === true,
          };
          resume = info.resume;
          store(SCREEN_KEY, resume);
          if (!info.tv) settle();
          options.onScreen?.(info);
        } else if (message.type === 'pads' && Array.isArray(message.pads)) {
          options.onPads?.(
            message.pads.map(record).map((pad) => ({
              slot: Number(pad.slot),
              place: Number(pad.place),
              kind: pad.kind === 'box' ? 'box' : 'phone',
              name: String(pad.name),
              connected: pad.connected === true,
              label: labelOf(pad.label),
            })),
          );
        } else if (message.type === 'open' && typeof message.link === 'string') options.onOpen?.(message.link);
        else if (message.type === 'shown' && typeof message.code === 'string') settle(message.code);
      },
      binary(frame) {
        const pad = decodePad(frame);
        if (pad) options.onFrame?.(pad, frame);
      },
      final(code) {
        settle();
        options.onClosed?.(code);
      },
    },
  );
  return {
    /** The screen, once the host has said. */
    get info() {
      return info;
    },
    /** For 30 s: with a place, the next controller whose A goes down takes that place (when it is free; the page's own
     *  gamepads are the page's to place, and say so with local); without one, the next gamepad on the box whose button
     *  goes down, of those on no screen, joins this screen. */
    claim(place?: number) {
      if (place === undefined) send({ type: 'claim' });
      else if (isPlace(place)) send({ type: 'claim', place });
    },
    /** Lets the controller in a place go. */
    release(slot: number) {
      if (isPlace(slot)) send({ type: 'release', slot });
    },
    rumble(slot: number, rumble: Rumble) {
      if (isPlace(slot))
        send({
          type: 'rumble',
          slot,
          duration: within(rumble.duration, 0, 5000),
          strong: within(rumble.strong, 0, 1),
          weak: within(rumble.weak, 0, 1),
        });
    },
    /** Swaps the controllers of two places; either may be empty. */
    move(from: number, to: number) {
      if (isPlace(from) && isPlace(to)) send({ type: 'move', from, to });
    },
    /** What each place drives (the places left out drive nothing named): each phone hears its own. A label without a name
     *  or a #rrggbb colour is left out, and a name is cut at 24 characters. */
    labels(list: readonly ({ place: number } & PlaceLabel)[]) {
      labels = list
        .filter(
          ({ place, name, color }) =>
            isPlace(place) && typeof name === 'string' && name.length > 0 && /^#[0-9a-fA-F]{6}$/.test(color),
        )
        .slice(0, 8)
        .map(({ place, name, color }) => ({ place, name: cut(name), color }));
      send({ type: 'labels', labels });
    },
    /** The places this device's own gamepads hold, which the host gives no phone or box gamepad. */
    local(places: readonly number[]) {
      local = [...new Set(places.filter(isPlace))];
      send({ type: 'local', places: local });
    },
    /** Show on TV: the box's own screen opens link, a /join/ path of this listener. Resolves with that screen's code, for
     *  this page to become one of its controllers; rejects when there is no TV. */
    show(link: string) {
      settle();
      if (!info?.tv) return Promise.reject(new Error('No TV is showing the lobby.'));
      return new Promise<string>((resolve, reject) => {
        showing = { resolve, reject };
        send({ type: 'show', link });
        setTimeout(() => settle(), 5000);
      });
    },
    close() {
      socket.close();
      settle();
    },
  };
}

/** A pad's place on its screen, as the host gave it: slot is the place; resume takes it back within 60 s. */
type PadPlace = { slot: number; screen: string; resume: string; label: PlaceLabel | null };

export type PadOptions = {
  /** The place to ask for (one taken, or none, gives the first free one). */
  place?: number | undefined;
  /** The resume token of an earlier pad of this screen, by default (or undefined) the one this tab's last pad of the
   *  code kept. */
  resume?: string | undefined;
  /** Joined, or its place or label changed; again after each reconnection. */
  onPad?(pad: PadPlace): void;
  onRumble?(rumble: Rumble & { slot: number }): void;
  /** The pad won't connect again: 4404 no screen has the code, 4409 it is full, 4429 too many wrong codes, 4000 the
   *  screen let it go, 4001 another page took its place over, 1000 the screen ended (or close()). */
  onClosed?(code: number): void;
  /** The listener's address, by default this page's. */
  origin?: string;
};

/** Opens a pad of the screen with code. send() it the pad's state on every change; it repeats the last at 4 Hz while
 *  the state stays the same, at most 120 a second. */
export function openPad(code: string, options: PadOptions = {}) {
  let held: PadPlace | undefined;
  let asked = options.place;
  let resume =
    options.resume ??
    (() => {
      const kept = record(
        (() => {
          try {
            return JSON.parse(stored(PAD_KEY)) as unknown;
          } catch {
            return undefined;
          }
        })(),
      );
      return kept.code === code && typeof kept.resume === 'string' ? kept.resume : '';
    })();
  let last: Uint8Array<ArrayBuffer> | undefined;
  let sentAt = 0,
    window = 0,
    count = 0;
  const counts = () => {
    const now = Date.now();
    if (now - window >= 1000) {
      window = now;
      count = 0;
    }
    return ++count <= PER_SECOND;
  };
  const push = (frame: Uint8Array<ArrayBuffer>) => {
    if (!counts()) return;
    sentAt = Date.now();
    socket.send(frame);
  };
  let closedWith: number | undefined;
  const query = () =>
    'role=pad&code=' +
    encodeURIComponent(code) +
    (asked === undefined ? '' : '&place=' + asked) +
    (resume ? '&resume=' + encodeURIComponent(resume) : '');
  const socket = connection(options.origin ?? location.origin, query, {
    text(message) {
      if (message.type === 'pad' && typeof message.slot === 'number' && typeof message.resume === 'string') {
        const first = held === undefined;
        held = {
          slot: message.slot,
          screen: String(message.screen),
          resume: message.resume,
          label: labelOf(message.label),
        };
        [asked, resume] = [held.slot, held.resume];
        store(PAD_KEY, JSON.stringify({ code, resume }));
        options.onPad?.(held);
        if (first && last) push(last);
      } else if (message.type === 'rumble') {
        options.onRumble?.({
          slot: Number(message.slot),
          duration: Number(message.duration),
          strong: Number(message.strong),
          weak: Number(message.weak),
        });
      } else if (message.type === 'closed') closedWith = 1000;
    },
    open() {
      held = undefined;
    },
    final(code) {
      clearInterval(still);
      options.onClosed?.(closedWith ?? code);
    },
  });
  const still = setInterval(() => {
    if (last && Date.now() - sentAt >= STILL) push(last);
  }, STILL);
  return {
    /** The place the host gave it, while it holds one. */
    get slot() {
      return held?.slot;
    },
    get label() {
      return held?.label ?? null;
    },
    /** Sends a state (its slot is the host's to write) or an encoded frame. */
    send(state: Parameters<typeof encodePad>[0] | Uint8Array<ArrayBuffer>) {
      last = state instanceof Uint8Array ? state : encodePad(state);
      push(last);
    },
    /** Moves to another place, when it is free. */
    place(place: number) {
      if (isPlace(place) && counts()) socket.send(JSON.stringify({ type: 'place', place }));
    },
    close() {
      clearInterval(still);
      socket.close();
      options.onClosed?.(1000);
    },
  };
}
