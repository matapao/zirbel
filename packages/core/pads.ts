// The pads socket's routing. A screen is any page that shows a game; its controllers are phones, which join it by its
// code, and the box's own gamepads, which its controller service reads. The host never reads their input: it checks a
// pad frame's shape (sdk/pads.ts), writes the controller's slot into it and passes it to the screen. A screen is kept
// for a while after its socket drops, so a page that navigates resumes it with its code and controllers.
// packages/server/pads-socket.ts carries this over WebSocket at /pads and the box's local socket; the Go host runs the
// same (host/pads.go), and test/pads.contract.test.ts holds the two alike.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PadsScreenMessage, PadsServiceMessage } from '../sdk/contracts.ts';
import { decodePad, PAD_SLOTS } from '../sdk/pads.ts';
import { CodeTries, newCode, readCode } from './lobby.ts';
import { secret } from './rooms.ts';

export type Access = 'local' | 'lan';

/** Screens one listener holds, the claims open at once on the host. */
const SCREENS = 64;
const CLAIMS = 16;
/** How long a screen whose socket dropped is kept for its resume, and how long a claim waits for a box gamepad. */
export const RESUME = 15_000;
export const CLAIM = 30_000;
/** Pad frames a controller, and control messages a screen, may send in a second; more are dropped. */
const PER_SECOND = 120;

/** WebSocket close codes: done is a screen's own close, which ends it at once (any other keeps it for its resume). */
export const PADS_CLOSE = { done: 1000, unsupported: 1003, released: 4000, replaced: 4001, unknown: 4404, full: 4409, tries: 4429 } as const;

/** A socket as the pads see it: its JSON messages, its binary frames and its close. */
export type PadsLink = { text(message: object): void; binary(frame: Uint8Array): void; close(code: number): void };

type Rate = { window: number; count: number };
type Device = { readonly id: number; name: string; standard: boolean; on?: Screen; slot: number; pressed: number; rate: Rate };
export type Phone = { readonly link: PadsLink; readonly screen: Screen; readonly slot: number; rate: Rate; gone: boolean };
type Controller = { kind: 'phone'; phone: Phone } | { kind: 'box'; device: Device };
export type Screen = {
  readonly id: string; readonly code: string; readonly resume: string; readonly access: Access; readonly order: number;
  box: boolean; link?: PadsLink; lost: number; open?: string; readonly slots: (Controller | undefined)[]; rate: Rate;
};

const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const free = (screen: Screen) => screen.slots.findIndex((slot) => !slot);

export class Pads {
  private readonly screens = new Map<string, Screen>();
  private readonly devices = new Map<number, Device>();
  private claims: { screen: Screen; at: number }[] = [];
  private service?: PadsLink;
  private order = 0;
  private readonly tries: CodeTries;
  /** The controller service's last view of the box's controllers and Bluetooth, while it is connected. */
  controllers?: Record<string, unknown>;

  constructor(private readonly now = Date.now) { this.tries = new CodeTries(now); }

  /** A screen's socket on a listener: the screen its resume names there, or a new one. box: the socket is the box's own
   *  (from loopback). Undefined when the listener holds all the screens it may; the link is closed. */
  openScreen(link: PadsLink, access: Access, box: boolean, resume = '') {
    const tv = this.tv(access);
    let screen = resume ? [...this.screens.values()].find((item) => item.access === access && same(item.resume, resume)) : undefined;
    if (screen) {
      screen.link?.close(PADS_CLOSE.replaced);
      Object.assign(screen, { link, lost: 0, box });
    } else {
      if ([...this.screens.values()].filter((item) => item.access === access).length >= SCREENS) {
        link.close(PADS_CLOSE.full);
        return undefined;
      }
      screen = { id: randomBytes(6).toString('hex'), code: newCode((code) => this.byCode(code) !== undefined), resume: secret(),
        access, order: ++this.order, box, link, lost: 0, slots: Array<undefined>(PAD_SLOTS).fill(undefined), rate: { window: 0, count: 0 } };
      this.screens.set(screen.id, screen);
      // The box's own screen takes every box gamepad that is on no screen.
      if (box) for (const device of this.devices.values()) if (!device.on && free(screen) >= 0) this.place(device, screen, false);
    }
    link.text(this.about(screen));
    this.list(screen);
    if (screen.open !== undefined) link.text({ type: 'open', link: screen.open });
    screen.open = undefined;
    if (this.tv(access) !== tv) this.retell(access, screen);
    return screen;
  }

  /** A control message from a screen's socket. */
  screenMessage(screen: Screen, link: PadsLink, message: PadsScreenMessage) {
    if (screen.link !== link || !this.counts(screen.rate)) return;
    const held = message.type === 'release' || message.type === 'rumble' ? screen.slots[message.slot] : undefined;
    if (message.type === 'claim') {
      const at = this.now();
      this.claims = [...this.claims.filter((claim) => claim.screen !== screen && at - claim.at < CLAIM), { screen, at }].slice(-CLAIMS);
    } else if (message.type === 'release' && held) {
      screen.slots[message.slot] = undefined;
      if (held.kind === 'phone') {
        held.phone.gone = true;
        held.phone.link.close(PADS_CLOSE.released);
      } else held.device.on = undefined;
      this.list(screen);
    } else if (message.type === 'rumble' && held) {
      const { duration, strong, weak } = message;
      if (held.kind === 'phone') held.phone.link.text({ type: 'rumble', slot: message.slot, duration, strong, weak });
      else this.service?.text({ type: 'rumble', device: held.device.id, duration, strong, weak });
    } else if (message.type === 'show') {
      const target = this.newestBox((item) => item !== screen && item.access === screen.access, false);
      if (!target) return;
      if (target.link) target.link.text({ type: 'open', link: message.link });
      else target.open = message.link;
      link.text({ type: 'shown', code: target.code });
    }
  }

  /** A screen's socket closed with code: its own close ends it, and any other keeps it for its resume. */
  screenGone(screen: Screen, link: PadsLink, code: number) {
    if (screen.link !== link) return;
    screen.link = undefined;
    screen.lost = this.now();
    if (code === PADS_CLOSE.done) this.end(screen);
  }

  /** A phone's socket on a listener, from address, with the code it was opened with: its place on that screen, or
   *  undefined when it has none (the link is closed: no such screen, a full one, or too many wrong codes). */
  openPad(link: PadsLink, access: Access, address: string, input: string): Phone | undefined {
    if (this.tries.blocked(address)) { link.close(PADS_CLOSE.tries); return undefined; }
    const code = readCode(input);
    const screen = code === undefined ? undefined : this.byCode(code, access);
    if (!screen) {
      this.tries.miss(address);
      link.close(PADS_CLOSE.unknown);
      return undefined;
    }
    const slot = free(screen);
    if (slot < 0) { link.close(PADS_CLOSE.full); return undefined; }
    const phone: Phone = { link, screen, slot, rate: { window: 0, count: 0 }, gone: false };
    screen.slots[slot] = { kind: 'phone', phone };
    link.text({ type: 'pad', slot, screen: screen.id });
    this.list(screen);
    return phone;
  }

  /** A pad frame from a phone, to its screen with its slot. Anything that isn't a pad frame closes the phone. */
  padFrame(phone: Phone, frame: Uint8Array) {
    if (phone.gone) return;
    if (!decodePad(frame)) {
      this.padGone(phone);
      phone.link.close(PADS_CLOSE.unsupported);
      return;
    }
    if (this.counts(phone.rate)) this.forward(phone.screen, phone.slot, frame);
  }

  /** A phone's socket closed: it leaves its slot. */
  padGone(phone: Phone) {
    if (phone.gone) return;
    phone.gone = true;
    const held = phone.screen.slots[phone.slot];
    if (held?.kind !== 'phone' || held.phone !== phone) return;
    phone.screen.slots[phone.slot] = undefined;
    this.list(phone.screen);
  }

  /** The box's controller service connected: it replaces any other, whose gamepads are gone. */
  attachService(link: PadsLink) {
    const old = this.service;
    if (old) { this.serviceGone(old); old.close(PADS_CLOSE.done); }
    this.service = link;
  }

  /** A control message from the service: a gamepad appeared or went, or its view of the controllers. */
  serviceMessage(link: PadsLink, message: PadsServiceMessage) {
    if (link !== this.service) return;
    if (message.type === 'controllers') { this.controllers = message; return; }
    const known = this.devices.get(message.device);
    if (message.type === 'gone') {
      if (known) this.leave(known);
      this.devices.delete(message.device);
    } else if (known) {
      Object.assign(known, { name: message.name, standard: message.standard });
      if (known.on) this.list(known.on);
    } else {
      const device: Device = { id: message.device, name: message.name, standard: message.standard, slot: 0, pressed: 0,
        rate: { window: 0, count: 0 } };
      this.devices.set(device.id, device);
      // The box's own screen takes each gamepad that appears.
      const target = this.newestBox();
      if (target) this.place(device, target);
    }
  }

  /** A gamepad's state from the service: false for one that isn't a pad state. A gamepad on no screen whose button
   *  goes down joins the newest screen that claims one, or else the box's own screen. */
  serviceInput(link: PadsLink, id: number, frame: Uint8Array) {
    if (!decodePad(frame)) return false;
    const device = this.devices.get(id);
    if (link !== this.service || !device || !this.counts(device.rate)) return true;
    const pressed = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true);
    const down = (pressed & ~device.pressed) !== 0;
    device.pressed = pressed;
    if (!device.on && down) {
      const at = this.now();
      this.claims = this.claims.filter((claim) => at - claim.at < CLAIM);
      const claim = this.claims.findLast((item) => free(item.screen) >= 0);
      this.claims = this.claims.filter((item) => item !== claim);
      const target = claim?.screen ?? this.newestBox();
      if (target) this.place(device, target);
    }
    if (device.on) this.forward(device.on, device.slot, frame);
    return true;
  }

  /** The service's connection closed: its gamepads are gone. */
  serviceGone(link: PadsLink) {
    if (link !== this.service) return;
    this.service = undefined;
    this.controllers = undefined;
    for (const device of this.devices.values()) this.leave(device);
    this.devices.clear();
  }

  /** Sends the service a control message: false while none is connected. */
  toService(message: object) {
    this.service?.text(message);
    return this.service !== undefined;
  }

  /** Ends the screens whose sockets dropped longer ago than their resume keeps them, and forgets old claims. */
  sweep() {
    const at = this.now();
    for (const screen of this.screens.values()) if (!screen.link && at - screen.lost >= RESUME) this.end(screen);
    this.claims = this.claims.filter((claim) => at - claim.at < CLAIM);
  }

  /** A screen ends: its phones are told and closed, and its box gamepads go back to no screen, and to the box's own
   *  screen when one is open. */
  private end(screen: Screen) {
    const tv = this.tv(screen.access);
    this.screens.delete(screen.id);
    this.claims = this.claims.filter((claim) => claim.screen !== screen);
    const freed: Device[] = [];
    for (const held of screen.slots) {
      if (held?.kind === 'phone') {
        held.phone.gone = true;
        held.phone.link.text({ type: 'closed' });
        held.phone.link.close(PADS_CLOSE.done);
      } else if (held) {
        held.device.on = undefined;
        freed.push(held.device);
      }
    }
    for (const device of freed) {
      const target = this.newestBox();
      if (target) this.place(device, target);
    }
    if (this.tv(screen.access) !== tv) this.retell(screen.access);
  }

  /** A gamepad leaves its screen. */
  private leave(device: Device) {
    const screen = device.on;
    if (!screen) return;
    device.on = undefined;
    screen.slots[device.slot] = undefined;
    this.list(screen);
  }

  private place(device: Device, screen: Screen, tell = true) {
    const slot = free(screen);
    screen.slots[slot] = { kind: 'box', device };
    Object.assign(device, { on: screen, slot });
    if (tell) this.list(screen);
  }

  private forward(screen: Screen, slot: number, frame: Uint8Array) {
    const copy = frame.slice();
    copy[0] = slot;
    screen.link?.binary(copy);
  }

  /** Counts one more in this second: false past the limit. */
  private counts(rate: Rate) {
    const at = this.now();
    if (at - rate.window >= 1000) Object.assign(rate, { window: at, count: 0 });
    return ++rate.count <= PER_SECOND;
  }

  private byCode(code: string, access?: Access) {
    return [...this.screens.values()].find((screen) => screen.code === code && (access === undefined || screen.access === access));
  }

  /** The newest of the box's own screens that passes also, and has room for a controller unless any will do. */
  private newestBox(also: (screen: Screen) => boolean = () => true, room = true) {
    let newest: Screen | undefined;
    for (const screen of this.screens.values()) {
      if (screen.box && (!room || free(screen) >= 0) && also(screen) && (!newest || screen.order > newest.order)) newest = screen;
    }
    return newest;
  }

  /** A box screen is open on the listener: Show on TV has one to show on. */
  private tv(access: Access) {
    return [...this.screens.values()].some((screen) => screen.box && screen.access === access);
  }

  private about(screen: Screen) {
    return { type: 'screen', id: screen.id, code: screen.code, resume: screen.resume, box: screen.box, tv: this.tv(screen.access) };
  }

  /** Every other connected screen on the listener hears that tv changed. */
  private retell(access: Access, except?: Screen) {
    for (const screen of this.screens.values()) if (screen !== except && screen.access === access) screen.link?.text(this.about(screen));
  }

  private list(screen: Screen) {
    screen.link?.text({ type: 'pads', pads: screen.slots.flatMap((held, slot) => !held ? [] : [{ slot, kind: held.kind === 'phone' ? 'phone' : 'box',
      name: held.kind === 'phone' ? 'Phone ' + (slot + 1) : held.device.name, connected: true }]) });
  }
}
