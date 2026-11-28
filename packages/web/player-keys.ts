// The keys that move a player in the built-in games (WASD, the arrows, and the touch pad's buttons, which stand for
// them): which of them are held, and the direction they add up to.

/** The movement keys held now, in lower case. */
export const keys = new Set<string>();
const north = ['w', 'arrowup'];
const south = ['s', 'arrowdown'];
const west = ['a', 'arrowleft'];
const east = ['d', 'arrowright'];
export const controls = [...north, ...south, ...west, ...east];

/** The direction the held keys add up to: -1, 0 or 1 on each axis, y down. */
export function motion() {
  const held = (list: string[]) => Number(list.some((key) => keys.has(key)));
  return { x: held(east) - held(west), y: held(south) - held(north) };
}
