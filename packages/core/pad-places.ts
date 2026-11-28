// The pads' screens and the controllers in their places, P1 to P8: their shapes, limits and close codes, and what the
// routing (pads.ts) does to them for every socket alike: a controller seated, a screen's labels, its list and its end.
import { timingSafeEqual } from 'node:crypto';
import { PAD_SLOTS } from '../sdk/pads.ts';

export type Access = 'local' | 'lan';

/** Screens one listener holds, the claims open at once on the host, the dropped phones a screen keeps places for. */
export const SCREENS = 64;
export const CLAIMS = 16;
export const KEPT = 32;
/** How long a screen whose socket dropped is kept for its resume, a dropped phone's place, and a claim. */
export const RESUME = 15_000;
export const PAD_RESUME = 60_000;
export const CLAIM = 30_000;
/** Pad frames and control messages a controller, and control messages a screen, may send in a second; more are dropped. */
const PER_SECOND = 120;
/** Button 0, A in the standard layout. */
export const A = 1;

/** WebSocket close codes: done is a screen's own close, which ends it at once (any other keeps it for its resume). */
export const PADS_CLOSE = { done: 1000, unsupported: 1003, released: 4000, replaced: 4001, unknown: 4404, full: 4409, tries: 4429 } as const;

/** A socket as the pads see it: its JSON messages, its binary frames and its close. */
export type PadsLink = { text(message: object): void; binary(frame: Uint8Array): void; close(code: number): void };

type Rate = { window: number; count: number };
export type Label = { name: string; color: string };
export type Device = { kind: 'box'; readonly id: number; name: string; standard: boolean; uid?: string | undefined; on?: Screen | undefined; place: number;
  pressed: number; rate: Rate };
export type Phone = { kind: 'phone'; readonly link: PadsLink; readonly on: Screen; readonly resume: string; place: number; pressed: number;
  rate: Rate; gone: boolean };
type Controller = Phone | Device;
type Claim = { screen: Screen; at: number; place?: number | undefined };
export type Screen = {
  readonly id: string; readonly code: string; readonly resume: string; readonly access: Access; readonly order: number;
  box: boolean; link?: PadsLink | undefined; lost: number; open?: string | undefined; rate: Rate;
  readonly slots: (Controller | undefined)[]; labels: (Label | undefined)[]; local: Set<number>;
  /** Dropped phones' places, by their resume tokens. */
  readonly kept: Map<string, { place: number; at: number }>;
};

export const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const open = (screen: Screen, place: number) => place >= 0 && place < PAD_SLOTS && !screen.slots[place] && !screen.local.has(place);
export const free = (screen: Screen) => screen.slots.findIndex((_, place) => open(screen, place));
export const slots = <T>() => Array<T | undefined>(PAD_SLOTS).fill(undefined);

/** The screens with their controllers and the claims open on them, and the moves of them every socket's messages share. */
export class PadPlaces {
  protected readonly screens = new Map<string, Screen>();
  protected claims: Claim[] = [];

  protected readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** A screen ends: its phones are told and closed, and its box gamepads go back to no screen, and to the box's own
   *  screen when one is open. */
  protected end(screen: Screen) {
    const tv = this.tv(screen.access);
    this.screens.delete(screen.id);
    this.claims = this.claims.filter((claim) => claim.screen !== screen);
    const freed: Device[] = [];
    for (const held of screen.slots) {
      if (held?.kind === 'phone') {
        held.gone = true;
        held.link.text({ type: 'closed' });
        held.link.close(PADS_CLOSE.done);
      } else if (held) {
        held.on = undefined;
        freed.push(held);
      }
    }
    for (const device of freed) {
      const target = this.newestBox();
      if (target) this.seat(device, target, free(target));
    }
    if (this.tv(screen.access) !== tv) this.retell(screen.access);
  }

  /** The controller whose A went down on its screen takes the place the screen claims, when it is free. */
  protected claimed(held: Controller, screen: Screen) {
    const claim = this.claims.find((item) => item.screen === screen && item.place !== undefined);
    if (claim?.place === undefined || this.now() - claim.at >= CLAIM || !open(screen, claim.place)) return;
    this.claims = this.claims.filter((item) => item !== claim);
    screen.slots[held.place] = undefined;
    this.seat(held, screen, claim.place);
  }

  /** Puts a controller in a place of a screen; a phone hears its place, and the screen its list unless more follows. */
  protected seat(held: Controller, screen: Screen, place: number, tell = true) {
    screen.slots[place] = held;
    held.place = place;
    if (held.kind === 'box') held.on = screen;
    else this.told(held);
    if (tell) this.list(screen);
  }

  private told(phone: Phone) {
    phone.link.text({ type: 'pad', slot: phone.place, screen: phone.on.id, resume: phone.resume, label: phone.on.labels[phone.place] ?? null });
  }

  /** The screen's labels are these: each phone whose own changed hears it, and the screen its list (tell). */
  protected label(screen: Screen, labels: (Label | undefined)[], tell = true) {
    const before = screen.labels;
    screen.labels = labels;
    const changed = screen.slots.filter((held, place) =>
      held && (before[place]?.name !== labels[place]?.name || before[place]?.color !== labels[place]?.color));
    for (const held of changed) if (held?.kind === 'phone') this.told(held);
    if (changed.length && tell) this.list(screen);
  }

  protected forward(screen: Screen, place: number, frame: Uint8Array) {
    const copy = frame.slice();
    copy[0] = place;
    screen.link?.binary(copy);
  }

  /** Counts one more in this second: false past the limit. */
  protected counts(rate: Rate) {
    const at = this.now();
    if (at - rate.window >= 1000) Object.assign(rate, { window: at, count: 0 });
    return ++rate.count <= PER_SECOND;
  }

  protected byCode(code: string, access?: Access) {
    return [...this.screens.values()].find((screen) => screen.code === code && (access === undefined || screen.access === access));
  }

  /** The newest of the box's own screens that passes also, and has room for a controller unless any will do. */
  protected newestBox(also: (screen: Screen) => boolean = () => true, room = true) {
    let newest: Screen | undefined;
    for (const screen of this.screens.values()) {
      if (screen.box && (!room || free(screen) >= 0) && also(screen) && (!newest || screen.order > newest.order)) newest = screen;
    }
    return newest;
  }

  /** A box screen is open on the listener: Show on TV has one to show on. */
  protected tv(access: Access) {
    return [...this.screens.values()].some((screen) => screen.box && screen.access === access);
  }

  protected about(screen: Screen) {
    return { type: 'screen', id: screen.id, code: screen.code, resume: screen.resume, box: screen.box, tv: this.tv(screen.access) };
  }

  /** Every other connected screen on the listener hears that tv changed. */
  protected retell(access: Access, except?: Screen) {
    for (const screen of this.screens.values()) if (screen !== except && screen.access === access) screen.link?.text(this.about(screen));
  }

  protected list(screen: Screen) {
    screen.link?.text({ type: 'pads', pads: screen.slots.flatMap((held, place) => !held ? [] : [{ slot: place, place, kind: held.kind,
      name: held.kind === 'phone' ? 'Phone ' + (place + 1) : held.name, connected: true, label: screen.labels[place] ?? null }]) });
  }
}
