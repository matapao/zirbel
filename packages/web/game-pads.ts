// In every game frame: every controller of the screen is a gamepad at its place (P1 to P8: index 0 to 7), so a game's
// usual "gamepad i is player i + 1" puts P(i + 1) on its player i + 1. The screen's phones and box gamepads come from the
// page around the frame with their state; the device's own gamepads are the browser's, at the places the page gave them
// when they were first pressed (or at their own index in a frame on its own). navigator.getGamepads() gives them with
// null at empty places, as browsers do; the browser's own gamepadconnected and gamepaddisconnected are swallowed and
// fired again for the placed gamepad; and a phone's or box gamepad's vibrationActuator sends its rumble back to the host.
import { MAX_PLACES } from '../sdk/controls.ts';
import { STANDARD_AXES, STANDARD_BUTTONS, type Pad, type PadEntry } from './pad-state.ts';

type Button = { readonly pressed: boolean; readonly touched: boolean; readonly value: number };
type Effect = { duration?: number; startDelay?: number; strongMagnitude?: number; weakMagnitude?: number };
type Actuator = {
  readonly type: 'dual-rumble';
  readonly effects: readonly string[];
  playEffect(type: string, effect?: Effect): Promise<'complete' | 'preempted'>;
  reset(): Promise<'complete'>;
};
export type PadLike = {
  readonly id: string;
  readonly index: number;
  readonly mapping: GamepadMappingType;
  readonly connected: boolean;
  readonly timestamp: number;
  readonly axes: readonly number[];
  readonly buttons: readonly Button[];
  readonly vibrationActuator: Actuator | GamepadHapticActuator | null;
  readonly hapticActuators: readonly unknown[];
};
/** A device gamepad the page gave a place: the browser's index and id for it. */
export type LocalPad = { place: number; index: number; id: string };
type Controller = PadEntry & {
  pad?: Pad;
  timestamp: number;
  shown: boolean;
  layout: number;
  snapshot?: PadLike | undefined;
  actuator: Actuator;
};
export type Rumble = { slot: number; duration: number; strong: number; weak: number };

/** The places browsers keep for a device's own gamepads: getGamepads() is at least this long. */
const PLACES_SHOWN = 4;
const within = (value: unknown, most: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(most, Math.max(0, value)) : 0;
const unit = (value: unknown) => within(value, 1);
const milliseconds = (value: unknown, most: number) => Math.round(within(value, most));

/** Wraps navigator.getGamepads in this frame. rumble sends a phone's or box gamepad's rumble to its host; alone (a frame
 *  without a page around it), the device's gamepads keep their own index. */
export function screenPads(rumble: (effect: Rumble) => void, alone = false) {
  const remote = new Map<number, Controller>();
  let local: LocalPad[] = [];
  const own = typeof navigator.getGamepads === 'function' ? navigator.getGamepads.bind(navigator) : undefined;
  // A frame without the gamepad permission throws: it still has the screen's.
  const ownPads = (): (Gamepad | null)[] => {
    try {
      return own ? [...own()] : [];
    } catch {
      return [];
    }
  };

  function actuator(slot: number): Actuator {
    let playing: { done: (result: 'complete' | 'preempted') => void; timer: number } | undefined;
    const stop = () => {
      if (playing) {
        clearTimeout(playing.timer);
        playing.done('preempted');
        playing = undefined;
      }
    };
    return Object.freeze({
      type: 'dual-rumble' as const,
      effects: Object.freeze(['dual-rumble']),
      playEffect(type: string, effect: Effect = {}) {
        if (type !== 'dual-rumble') return Promise.reject(new TypeError('This gamepad plays dual-rumble effects.'));
        stop();
        const duration = milliseconds(effect.duration, 5000),
          delay = milliseconds(effect.startDelay, 4000);
        return new Promise<'complete' | 'preempted'>((done) => {
          const timer = window.setTimeout(() => {
            rumble({ slot, duration, strong: unit(effect.strongMagnitude), weak: unit(effect.weakMagnitude) });
            playing = {
              done,
              timer: window.setTimeout(() => {
                playing = undefined;
                done('complete');
              }, duration),
            };
          }, delay);
          playing = { done, timer };
        });
      },
      reset() {
        stop();
        rumble({ slot, duration: 0, strong: 0, weak: 0 });
        return Promise.resolve('complete' as const);
      },
    });
  }

  function snapshot(controller: Controller): PadLike {
    const pad = controller.pad!;
    return Object.freeze({
      id:
        'Zirbel ' +
        controller.kind +
        ' ' +
        (controller.slot + 1) +
        ' (' +
        (pad.standard ? 'STANDARD GAMEPAD' : controller.name || 'gamepad') +
        ')',
      index: controller.slot,
      mapping: pad.standard ? ('standard' as const) : ('' as const),
      connected: true,
      timestamp: controller.timestamp,
      axes: Object.freeze([...pad.axes]),
      buttons: Object.freeze(
        pad.buttons.map(({ pressed, value }) =>
          Object.freeze({ pressed, touched: pressed || value > 0, value: pressed && !value ? 1 : value }),
        ),
      ),
      vibrationActuator: controller.actuator,
      hapticActuators: Object.freeze([]),
    });
  }
  /** A device's own gamepad at a place: the browser's state, under the place's index. */
  const placedOwn = (pad: Gamepad, index: number): PadLike => ({
    id: pad.id,
    index,
    mapping: pad.mapping,
    connected: pad.connected,
    timestamp: pad.timestamp,
    axes: pad.axes,
    buttons: pad.buttons,
    vibrationActuator: pad.vibrationActuator ?? null,
    hapticActuators: (pad as Gamepad & { hapticActuators?: readonly unknown[] }).hapticActuators ?? [],
  });

  /** Who is at each place now, with a key that changes when another gamepad takes it. */
  function places() {
    const at: ({ key: string; pad: () => PadLike } | undefined)[] = Array.from({ length: MAX_PLACES }, () => undefined);
    const natives = ownPads().filter((pad): pad is Gamepad => Boolean(pad?.connected));
    if (alone)
      for (const pad of natives) {
        if (pad.index < MAX_PLACES)
          at[pad.index] = { key: 'own ' + pad.index + ' ' + pad.id, pad: () => placedOwn(pad, pad.index) };
      }
    for (const { place, index, id } of local) {
      const pad =
        natives.find((item) => item.index === index && item.id === id) ?? natives.find((item) => item.id === id);
      if (pad) at[place] = { key: 'own ' + index + ' ' + id, pad: () => placedOwn(pad, place) };
    }
    for (const controller of remote.values()) {
      if (!controller.shown) continue;
      at[controller.slot] = {
        key: controller.kind + ' ' + controller.layout,
        pad: () => (controller.snapshot ??= snapshot(controller)),
      };
    }
    return at;
  }

  let told: ({ key: string; pad: PadLike } | undefined)[] = [];
  function announce(type: 'gamepadconnected' | 'gamepaddisconnected', gamepad: PadLike) {
    // GamepadEvent takes only a real Gamepad: a plain event that carries one, as games read it.
    const event = new Event(type);
    Object.defineProperty(event, 'gamepad', { value: gamepad, enumerable: true });
    window.dispatchEvent(event);
  }
  /** Tells the game of every place whose gamepad came or went. */
  function sync() {
    const now = places().map((item) => item && { key: item.key, pad: item.pad() });
    const changed = now.map((item, place) => item?.key !== told[place]?.key);
    told.forEach((item, place) => {
      if (item && changed[place]) announce('gamepaddisconnected', Object.freeze({ ...item.pad, connected: false }));
    });
    now.forEach((item, place) => {
      if (item && changed[place]) announce('gamepadconnected', item.pad);
    });
    told = now;
  }
  // The browser's own events name its own index: the game hears of a device's gamepad at its place, from sync.
  for (const type of ['gamepadconnected', 'gamepaddisconnected'])
    window.addEventListener(
      type,
      (event) => {
        if (!event.isTrusted) return;
        event.stopImmediatePropagation();
        sync();
      },
      true,
    );

  function getGamepads(): (Gamepad | null)[] {
    const pads = places().map((item) => item?.pad() ?? null);
    let length = pads.length;
    while (length > PLACES_SHOWN && !pads[length - 1]) length--;
    return pads.slice(0, length) as unknown as (Gamepad | null)[];
  }
  Object.defineProperty(navigator, 'getGamepads', { value: getGamepads, configurable: true, writable: true });

  return {
    /** The screen's phones and box gamepads now, at their places, as its host lists them. */
    list(entries: PadEntry[]) {
      for (const [slot, controller] of remote) {
        const entry = entries.find((item) => item.slot === slot);
        if (entry?.connected && entry.kind === controller.kind) {
          controller.name = entry.name;
          continue;
        }
        remote.delete(slot);
      }
      for (const entry of entries) {
        if (!entry.connected || remote.has(entry.slot)) continue;
        remote.set(entry.slot, {
          ...entry,
          timestamp: performance.now(),
          shown: false,
          layout: 0,
          actuator: actuator(entry.slot),
        });
      }
      sync();
    },
    /** A phone's or box gamepad's state as it last sent it: it is a gamepad from its first. */
    frame(slot: number, pad: Pad) {
      const controller = remote.get(slot);
      if (!controller) return;
      const next = pad.standard
        ? {
            ...pad,
            buttons: fit(pad.buttons, STANDARD_BUTTONS, { pressed: false, value: 0 }),
            axes: fit(pad.axes, STANDARD_AXES, 0),
          }
        : pad;
      // A controller keeps the layout it came with: one that changes it comes back as a new gamepad.
      const before = controller.pad;
      const relaid =
        before !== undefined &&
        (before.standard !== next.standard ||
          before.buttons.length !== next.buttons.length ||
          before.axes.length !== next.axes.length);
      if (relaid) controller.layout++;
      controller.pad = next;
      controller.timestamp = performance.now();
      controller.snapshot = undefined;
      const first = !controller.shown;
      controller.shown = true;
      if (first || relaid) sync();
    },
    /** The places the page gave the device's own gamepads. */
    local(placed: LocalPad[]) {
      local = placed;
      sync();
    },
  };
}

/** A standard pad's buttons or axes, exactly as many as the layout has. */
const fit = <T>(values: T[], length: number, none: T) => Array.from({ length }, (_, index) => values[index] ?? none);
