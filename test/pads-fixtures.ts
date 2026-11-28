// For the pads socket's routing tests: a fake socket a screen, phone or controller service is held by, with what it is
// sent, a pad's state, and a screen's controllers and a phone's place as they were last said.
import type { PadsLink } from '../packages/core/pads.ts';

type Sent = { type: string; [key: string]: unknown };
export function link() {
  const texts: Sent[] = [], frames: Uint8Array[] = [];
  let closed: number | undefined;
  const self: PadsLink & { texts: Sent[]; frames: Uint8Array[]; readonly closed: number | undefined; last(type: string): Sent | undefined } = {
    texts, frames,
    text(message) { texts.push(structuredClone(message) as Sent); },
    binary(frame) { frames.push(frame.slice()); },
    close(code) { closed ??= code; },
    get closed() { return closed; },
    last(type) { return texts.findLast((message) => message.type === type); },
  };
  return self;
}
export const state = (pressed: number[] = [], axes = [0, 0, 0, 0]) =>
  ({ standard: true, buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })), axes });
export type Listed = { slot: number; place: number; kind: string; name: string; label: { name: string } | null };
export const listed = (screen: ReturnType<typeof link>) => ((screen.last('pads')?.pads ?? []) as Listed[])
  .map(({ slot, place, kind, name, label }) => (slot === place ? slot : '?') + ' ' + kind + ' ' + name + (label ? ' · ' + label.name : ''));
export const placed = (phone: ReturnType<typeof link>) => phone.last('pad')?.slot;
