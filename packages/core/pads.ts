// The pads socket's routing. A screen is any page that shows a game; each of its controllers holds a place on it, P1 to
// P8 (0 to 7): phones, which join it by its code, and the box's own gamepads, which its controller service reads (the
// screen's own device gamepads are the page's, and it says which places they hold). The host never reads input: it
// checks a pad frame's shape (sdk/pads.ts), writes the controller's place into it and passes it to the screen, and it
// only looks at a frame's buttons for one going down, which may take a controller to a screen or a place. A screen is
// kept 15 s after its socket drops, so a page that navigates resumes it, and a phone's place 60 s, and a box gamepad's
// too, by its uid, when it goes and comes back (a Bluetooth gamepad that reconnects, the service restarting).
// packages/server/pads-socket.ts carries this over WebSocket at /pads and the box's local socket; the Go host runs the
// same (host/pads.go), and test/pads.contract.test.ts holds the two alike.
import { randomBytes } from 'node:crypto';
import type { PadsPadMessage, PadsScreenMessage, PadsServiceMessage } from '../sdk/contracts.ts';
import { decodePad } from '../sdk/pads.ts';
import { CodeTries, newCode, readCode } from './lobby.ts';
import {
  A, CLAIM, CLAIMS, free, KEPT, open, PAD_RESUME, PadPlaces, PADS_CLOSE, RESUME, same, SCREENS, slots, type Access, type Device,
  type Label, type PadsLink, type Phone, type Screen,
} from './pad-places.ts';
import { secret } from './rooms.ts';

export { CLAIM, PAD_RESUME, PADS_CLOSE, RESUME, type Access, type PadsLink, type Phone, type Screen };

export class Pads extends PadPlaces {
  private readonly devices = new Map<number, Device>();
  private service: PadsLink | undefined;
  private order = 0;
  private readonly tries: CodeTries;
  /** The controller service's last view of the box's controllers and Bluetooth, while it is connected. */
  controllers: Record<string, unknown> | undefined;
  /** Called with each view the service sends (Box settings' controllers wait on it). */
  viewed?: () => void;
  /** Where box gamepads that went were, by their uid: one back within a minute takes its place again. */
  private readonly away = new Map<string, { screen: Screen; place: number; at: number }>();

  constructor(now = Date.now) {
    super(now);
    this.tries = new CodeTries(now);
  }

  /** A screen's socket on a listener: the screen its resume names there, or a new one. box: the socket is the box's own
   *  (from loopback). A resumed screen's labels and local places are the new page's to say. Undefined when the listener
   *  holds all the screens it may; the link is closed. */
  openScreen(link: PadsLink, access: Access, box: boolean, resume = '') {
    const tv = this.tv(access);
    let screen = resume ? [...this.screens.values()].find((item) => item.access === access && same(item.resume, resume)) : undefined;
    if (screen) {
      screen.link?.close(PADS_CLOSE.replaced);
      Object.assign(screen, { link, lost: 0, box, local: new Set<number>() });
      this.label(screen, slots(), false);
    } else {
      if ([...this.screens.values()].filter((item) => item.access === access).length >= SCREENS) {
        link.close(PADS_CLOSE.full);
        return undefined;
      }
      screen = { id: randomBytes(6).toString('hex'), code: newCode((code) => this.byCode(code) !== undefined), resume: secret(),
        access, order: ++this.order, box, link, lost: 0, rate: { window: 0, count: 0 }, slots: slots(), labels: slots(), local: new Set(),
        kept: new Map() };
      this.screens.set(screen.id, screen);
      // The box's own screen takes every box gamepad that is on no screen.
      if (box) for (const device of this.devices.values()) if (!device.on && free(screen) >= 0) this.seat(device, screen, free(screen));
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
    if (message.type === 'claim') {
      const at = this.now();
      this.claims = [...this.claims.filter((claim) => claim.screen !== screen && at - claim.at < CLAIM), { screen, at, place: message.place }]
        .slice(-CLAIMS);
    } else if (message.type === 'release') {
      const held = screen.slots[message.slot];
      if (!held) return;
      screen.slots[message.slot] = undefined;
      if (held.kind === 'phone') {
        held.gone = true;
        held.link.close(PADS_CLOSE.released);
      } else held.on = undefined;
      this.list(screen);
    } else if (message.type === 'rumble') {
      const held = screen.slots[message.slot];
      const { duration, strong, weak } = message;
      if (held?.kind === 'phone') held.link.text({ type: 'rumble', slot: message.slot, duration, strong, weak });
      else if (held) this.service?.text({ type: 'rumble', device: held.id, duration, strong, weak });
    } else if (message.type === 'show') {
      const target = this.newestBox((item) => item !== screen && item.access === screen.access, false);
      if (!target) return;
      if (target.link) target.link.text({ type: 'open', link: message.link });
      else target.open = message.link;
      link.text({ type: 'shown', code: target.code });
    } else if (message.type === 'move') {
      const [from, to] = [screen.slots[message.from], screen.slots[message.to]];
      if (message.from === message.to || (!from && !to)) return;
      screen.slots[message.from] = screen.slots[message.to] = undefined;
      if (from) this.seat(from, screen, message.to, false);
      if (to) this.seat(to, screen, message.from, false);
      this.list(screen);
    } else if (message.type === 'labels') {
      const labels = slots<Label>();
      for (const { place, name, color } of message.labels) labels[place] = { name, color };
      this.label(screen, labels);
    } else {
      screen.local = new Set(message.places);
      // A place the screen's own gamepad took is no longer to be claimed.
      this.claims = this.claims.filter((claim) => claim.screen !== screen || claim.place === undefined || !screen.local.has(claim.place));
    }
  }

  /** A screen's socket closed with code: its own close ends it, and any other keeps it for its resume. */
  screenGone(screen: Screen, link: PadsLink, code: number) {
    if (screen.link !== link) return;
    screen.link = undefined;
    screen.lost = this.now();
    if (code === PADS_CLOSE.done) this.end(screen);
  }

  /** A phone's socket on a listener, from address, with the code it was opened with: the place it asked for (by its
   *  resume, its old one within 60 s; else place) when that is free, else the first free one. Undefined when it gets
   *  none, and the link is closed: no such screen, a full one, or too many wrong codes. */
  openPad(link: PadsLink, access: Access, address: string, input: string, asked?: number, resume = '') {
    if (this.tries.blocked(address)) { link.close(PADS_CLOSE.tries); return undefined; }
    const code = readCode(input);
    const screen = code === undefined ? undefined : this.byCode(code, access);
    if (!screen) {
      this.tries.miss(address);
      link.close(PADS_CLOSE.unknown);
      return undefined;
    }
    let token = '', back: number | undefined;
    // The same phone again before its old socket was seen to drop: it takes the place over.
    const live = resume ? screen.slots.find((held): held is Phone => held?.kind === 'phone' && same(held.resume, resume)) : undefined;
    if (live) {
      live.gone = true;
      live.link.close(PADS_CLOSE.replaced);
      screen.slots[live.place] = undefined;
      [token, back] = [live.resume, live.place];
    }
    for (const [kept, { place }] of resume && !live ? screen.kept : []) {
      if (!same(kept, resume)) continue;
      screen.kept.delete(kept);
      [token, back] = [kept, place];
    }
    const place = [back, asked].find((item) => item !== undefined && open(screen, item)) ?? free(screen);
    if (place < 0) { link.close(PADS_CLOSE.full); return undefined; }
    const phone: Phone = { kind: 'phone', link, on: screen, resume: token || secret(), place, pressed: 0, rate: { window: 0, count: 0 },
      gone: false };
    this.seat(phone, screen, place);
    return phone;
  }

  /** A pad frame from a phone, to its screen with its place. Anything that isn't a pad frame closes the phone. A phone
   *  whose A goes down while its screen claims a free place takes it. */
  padFrame(phone: Phone, frame: Uint8Array) {
    if (phone.gone) return;
    if (!decodePad(frame)) {
      this.padGone(phone, false);
      phone.link.close(PADS_CLOSE.unsupported);
      return;
    }
    if (!this.counts(phone.rate)) return;
    const pressed = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true);
    const down = pressed & ~phone.pressed;
    phone.pressed = pressed;
    if ((down & A) !== 0) this.claimed(phone, phone.on);
    this.forward(phone.on, phone.place, frame);
  }

  /** A control message from a phone: it moves to a free place. */
  padMessage(phone: Phone, message: PadsPadMessage) {
    if (phone.gone || !this.counts(phone.rate) || !open(phone.on, message.place)) return;
    phone.on.slots[phone.place] = undefined;
    this.seat(phone, phone.on, message.place);
  }

  /** A phone's socket closed: it leaves its place, which its resume may take back within 60 s (keep). */
  padGone(phone: Phone, keep = true) {
    if (phone.gone) return;
    phone.gone = true;
    const screen = phone.on;
    if (screen.slots[phone.place] !== phone) return;
    screen.slots[phone.place] = undefined;
    if (keep && this.screens.get(screen.id) === screen) {
      screen.kept.set(phone.resume, { place: phone.place, at: this.now() });
      if (screen.kept.size > KEPT) screen.kept.delete(screen.kept.keys().next().value!);
    }
    this.list(screen);
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
    if (message.type === 'controllers') { this.controllers = message; this.viewed?.(); return; }
    const known = this.devices.get(message.device);
    if (message.type === 'gone') {
      if (known) this.leave(known, true);
      this.devices.delete(message.device);
    } else if (known) {
      Object.assign(known, { name: message.name, standard: message.standard, uid: message.uid });
      if (known.on) this.list(known.on);
    } else {
      const device: Device = { kind: 'box', id: message.device, name: message.name, standard: message.standard, uid: message.uid,
        place: 0, pressed: 0, rate: { window: 0, count: 0 } };
      this.devices.set(device.id, device);
      // One that went a moment ago takes its place again, where it is still free; else the box's own screen takes it.
      const back = message.uid === undefined ? undefined : this.away.get(message.uid);
      if (message.uid !== undefined) this.away.delete(message.uid);
      if (back && this.now() - back.at < PAD_RESUME && this.screens.get(back.screen.id) === back.screen && open(back.screen, back.place))
        this.seat(device, back.screen, back.place);
      else {
        const target = this.newestBox();
        if (target) this.seat(device, target, free(target));
      }
    }
  }

  /** A gamepad's state from the service: false for one that isn't a pad state. A gamepad on no screen whose button goes
   *  down joins the newest screen that claims one (its A, for a claim of a place: that place), or else the box's own
   *  screen; one on a screen whose A goes down while it claims a free place takes it. */
  serviceInput(link: PadsLink, id: number, frame: Uint8Array) {
    if (!decodePad(frame)) return false;
    const device = this.devices.get(id);
    if (link !== this.service || !device || !this.counts(device.rate)) return true;
    const pressed = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true);
    const down = pressed & ~device.pressed;
    device.pressed = pressed;
    if (device.on && (down & A) !== 0) this.claimed(device, device.on);
    else if (!device.on && down) {
      const at = this.now();
      this.claims = this.claims.filter((claim) => at - claim.at < CLAIM);
      const claim = this.claims.findLast((item) =>
        item.place === undefined ? free(item.screen) >= 0 : (down & A) !== 0 && open(item.screen, item.place));
      this.claims = this.claims.filter((item) => item !== claim);
      const target = claim?.screen ?? this.newestBox();
      if (target) this.seat(device, target, claim?.place ?? free(target));
    }
    if (device.on) this.forward(device.on, device.place, frame);
    return true;
  }

  /** The service's connection closed: its gamepads are gone. */
  serviceGone(link: PadsLink) {
    if (link !== this.service) return;
    this.service = undefined;
    this.controllers = undefined;
    for (const device of this.devices.values()) this.leave(device, true);
    this.devices.clear();
  }

  /** Whether the box's controller service is connected. */
  get connected() { return this.service !== undefined; }

  /** The screen a box gamepad is on now, by its number: its code, whether it is the box's own, and its place there. */
  screenOf(id: number) {
    const device = this.devices.get(id);
    return device?.on ? { code: device.on.code, box: device.on.box, place: device.place } : undefined;
  }

  /** Sends the service a control message: false while none is connected. */
  toService(message: object) {
    this.service?.text(message);
    return this.service !== undefined;
  }

  /** Ends the screens whose sockets dropped longer ago than their resume keeps them, and forgets old claims and places. */
  sweep() {
    const at = this.now();
    for (const screen of this.screens.values()) {
      if (!screen.link && at - screen.lost >= RESUME) this.end(screen);
      for (const [token, kept] of screen.kept) if (at - kept.at >= PAD_RESUME) screen.kept.delete(token);
    }
    for (const [uid, away] of this.away) if (at - away.at >= PAD_RESUME || !this.screens.has(away.screen.id)) this.away.delete(uid);
    this.claims = this.claims.filter((claim) => at - claim.at < CLAIM);
  }

  /** A gamepad leaves its screen; one that goes (away) is remembered there by its uid for a while. */
  private leave(device: Device, away = false) {
    const screen = device.on;
    if (!screen) return;
    if (away && device.uid !== undefined) {
      if (this.away.size >= KEPT) this.away.delete(this.away.keys().next().value!);
      this.away.set(device.uid, { screen, place: device.place, at: this.now() });
    }
    device.on = undefined;
    screen.slots[device.place] = undefined;
    this.list(screen);
  }
}
