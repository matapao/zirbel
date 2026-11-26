// In every game frame: the screen's controllers (phones and the box's gamepads, from the page around the frame) join the
// device's own gamepads in the standard Gamepad API, so a game that reads gamepads plays with them unchanged.
// navigator.getGamepads() gives the device's own and then the screen's, each Gamepad-like, at index 4 + its slot (after
// the four places browsers keep for their own); gamepadconnected and gamepaddisconnected fire on window as for any
// gamepad; and a pad's vibrationActuator sends its rumble back to the host through the page.
import { STANDARD_AXES, STANDARD_BUTTONS, type Pad, type PadEntry } from './pad-state.ts';

type Button = { readonly pressed: boolean; readonly touched: boolean; readonly value: number };
export type PadLike = {
  readonly id: string; readonly index: number; readonly mapping: GamepadMappingType; readonly connected: boolean;
  readonly timestamp: number; readonly axes: readonly number[]; readonly buttons: readonly Button[];
  readonly vibrationActuator: Actuator; readonly hapticActuators: readonly never[];
};
type Effect = { duration?: number; startDelay?: number; strongMagnitude?: number; weakMagnitude?: number };
type Actuator = { readonly type: 'dual-rumble'; readonly effects: readonly string[];
  playEffect(type: string, effect?: Effect): Promise<'complete' | 'preempted'>; reset(): Promise<'complete'> };
type Controller = PadEntry & { pad?: Pad; timestamp: number; shown: boolean; snapshot?: PadLike; actuator: Actuator };
export type Rumble = { slot: number; duration: number; strong: number; weak: number };

/** The places browsers keep for a device's own gamepads, before the screen's. */
const OWN_PLACES = 4;
const within = (value: unknown, most: number) =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(most, Math.max(0, value)) : 0);
const unit = (value: unknown) => within(value, 1);
const milliseconds = (value: unknown, most: number) => Math.round(within(value, most));

/** Wraps navigator.getGamepads in this frame; rumble sends a controller's rumble to its host. */
export function screenPads(rumble: (effect: Rumble) => void) {
  const controllers = new Map<number, Controller>();
  const own = typeof navigator.getGamepads === 'function' ? navigator.getGamepads.bind(navigator) : undefined;
  // A frame without the gamepad permission throws: it still has the screen's.
  const ownPads = (): (Gamepad | null)[] => { try { return own ? [...own()] : []; } catch { return []; } };

  function actuator(slot: number): Actuator {
    let playing: { done: (result: 'complete' | 'preempted') => void; timer: number } | undefined;
    const stop = () => { if (playing) { clearTimeout(playing.timer); playing.done('preempted'); playing = undefined; } };
    return Object.freeze({
      type: 'dual-rumble' as const, effects: Object.freeze(['dual-rumble']),
      playEffect(type: string, effect: Effect = {}) {
        if (type !== 'dual-rumble') return Promise.reject(new TypeError('This gamepad plays dual-rumble effects.'));
        stop();
        const duration = milliseconds(effect.duration, 5000), delay = milliseconds(effect.startDelay, 4000);
        return new Promise<'complete' | 'preempted'>((done) => {
          const timer = window.setTimeout(() => {
            rumble({ slot, duration, strong: unit(effect.strongMagnitude), weak: unit(effect.weakMagnitude) });
            playing = { done, timer: window.setTimeout(() => { playing = undefined; done('complete'); }, duration) };
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

  function snapshot(controller: Controller, index: number, connected = true): PadLike {
    const pad = controller.pad!;
    const pressed = (button: number) => (pad.pressed >>> button & 1) === 1;
    const name = controller.kind === 'phone' ? 'phone' : 'box';
    return Object.freeze({
      id: 'Zirbel ' + name + ' ' + (controller.slot + 1) + ' (' + (pad.standard ? 'STANDARD GAMEPAD' : controller.name || 'gamepad') + ')',
      index, mapping: pad.standard ? 'standard' as const : '' as const, connected, timestamp: controller.timestamp,
      axes: Object.freeze([...pad.axes]),
      buttons: Object.freeze(pad.values.map((value, button) =>
        Object.freeze({ pressed: pressed(button), touched: pressed(button) || value > 0, value: pressed(button) && !value ? 1 : value }))),
      vibrationActuator: controller.actuator, hapticActuators: Object.freeze([]),
    });
  }

  const place = () => Math.max(OWN_PLACES, ownPads().length);
  function announce(type: 'gamepadconnected' | 'gamepaddisconnected', gamepad: PadLike) {
    // GamepadEvent takes only a real Gamepad: a plain event that carries one, as games read it.
    const event = new Event(type);
    Object.defineProperty(event, 'gamepad', { value: gamepad, enumerable: true });
    window.dispatchEvent(event);
  }
  function show(controller: Controller) {
    if (controller.shown || !controller.connected || !controller.pad) return;
    controller.shown = true;
    announce('gamepadconnected', snapshot(controller, place() + controller.slot));
  }
  function hide(controller: Controller) {
    if (!controller.shown) return;
    controller.shown = false;
    controller.snapshot = undefined;
    announce('gamepaddisconnected', snapshot(controller, place() + controller.slot, false));
  }

  function getGamepads(): (Gamepad | null)[] {
    const pads: (Gamepad | PadLike | null)[] = ownPads();
    const first = Math.max(OWN_PLACES, pads.length);
    while (pads.length < first) pads.push(null);
    const shown = [...controllers.values()].filter(({ shown }) => shown);
    for (const controller of shown) {
      const index = first + controller.slot;
      if (controller.snapshot?.index !== index) controller.snapshot = snapshot(controller, index);
      while (pads.length <= index) pads.push(null);
      pads[index] = controller.snapshot;
    }
    return pads as (Gamepad | null)[];
  }
  Object.defineProperty(navigator, 'getGamepads', { value: getGamepads, configurable: true, writable: true });

  return {
    /** The screen's controllers now, as its host lists them. */
    list(entries: PadEntry[]) {
      for (const [slot, controller] of controllers) {
        const entry = entries.find((item) => item.slot === slot);
        if (entry?.connected && entry.kind === controller.kind) { controller.name = entry.name; continue; }
        hide(controller);
        controllers.delete(slot);
      }
      for (const entry of entries) {
        if (!entry.connected || controllers.has(entry.slot)) continue;
        controllers.set(entry.slot, { ...entry, timestamp: performance.now(), shown: false, actuator: actuator(entry.slot) });
      }
    },
    /** A controller's state as it last sent it. */
    frame(slot: number, pad: Pad) {
      const controller = controllers.get(slot);
      if (!controller) return;
      const next = pad.standard ? { ...pad, values: fit(pad.values, STANDARD_BUTTONS), axes: fit(pad.axes, STANDARD_AXES) } : pad;
      // A controller keeps the layout it came with: one that changes it comes back as a new gamepad.
      const before = controller.pad;
      if (before && (before.standard !== next.standard || before.values.length !== next.values.length ||
          before.axes.length !== next.axes.length)) hide(controller);
      controller.pad = next;
      controller.timestamp = performance.now();
      controller.snapshot = undefined;
      show(controller);
    },
  };
}

/** A standard pad's buttons or axes, exactly as many as the layout has. */
const fit = (values: number[], length: number) => Array.from({ length }, (_, index) => values[index] ?? 0);
