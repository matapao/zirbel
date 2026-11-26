// A stand-in for track P's codec until it lands: the pad state every controller sends and every screen receives, as
// the screens design gives its binary frame. slot is the host's; flags bit 0 is the standard mapping; then the counts,
// the pressed buttons as a little-endian bitmask, each button's value (0..255) and each axis (-32767..32767).
export const MAX_BUTTONS = 32;
export const MAX_AXES = 8;

/** A pad's state: values 0..1 and axes -1..1, as the Gamepad API gives them. */
export type PadState = { slot: number; standard: boolean; pressed: number; values: number[]; axes: number[] };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));

export function encodePad(state: PadState): Uint8Array<ArrayBuffer> {
  const values = state.values.slice(0, MAX_BUTTONS), axes = state.axes.slice(0, MAX_AXES);
  const bytes = new Uint8Array(8 + values.length + axes.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([clamp(state.slot, 0, 7) | 0, state.standard ? 1 : 0, values.length, axes.length]);
  view.setUint32(4, state.pressed >>> 0, true);
  values.forEach((value, index) => { bytes[8 + index] = Math.round(clamp(value, 0, 1) * 255); });
  axes.forEach((axis, index) => view.setInt16(8 + values.length + index * 2, Math.round(clamp(axis, -1, 1) * 32767), true));
  return bytes;
}

export function decodePad(data: ArrayBuffer | Uint8Array): PadState | undefined {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 8) return undefined;
  const [slot = 0, flags = 0, count = 0, axisCount = 0] = bytes;
  if (slot > 7 || flags > 1 || count > MAX_BUTTONS || axisCount > MAX_AXES || bytes.length !== 8 + count + axisCount * 2) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { slot, standard: flags === 1, pressed: view.getUint32(4, true),
    values: Array.from(bytes.subarray(8, 8 + count), (value) => value / 255),
    axes: Array.from({ length: axisCount }, (_, index) => Math.max(-1, view.getInt16(8 + count + index * 2, true) / 32767)) };
}
