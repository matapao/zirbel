// Spatial focus for the TV page (tv.ts): from the focused tile, the nearest one in a direction, as a TV's own menus
// move. Tiles in line come first; then those beside the line, by how far off it they are.
import type { Command } from './tv-input.ts';

export type Rect = { left: number; top: number; width: number; height: number };

/** How far apart two spans are along one axis: none where they touch or overlap. */
const gap = (a: number, aSize: number, b: number, bSize: number) => Math.max(0, b - (a + aSize), a - (b + bSize));
/** How much two spans share along one axis: none or less where they don't. */
const shared = (a: number, aSize: number, b: number, bSize: number) => Math.min(a + aSize, b + bSize) - Math.max(a, b);

/** The rect nearest to rects[from] in a direction, by its index, or none where nothing lies that way. */
export function nextFocus(rects: readonly Rect[], from: number, toward: Command): number | undefined {
  const here = rects[from];
  if (!here) return rects.length ? 0 : undefined;
  const horizontal = toward === 'left' || toward === 'right';
  const sign = toward === 'right' || toward === 'down' ? 1 : -1;
  const centre = (rect: Rect) => horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  const across = (rect: Rect) => horizontal ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
  let best: number | undefined, score = Infinity;
  rects.forEach((rect, index) => {
    // Beyond the tile's own edge that way, by its middle.
    const start = horizontal ? here.left : here.top;
    const edge = sign > 0 ? start + (horizontal ? here.width : here.height) : start;
    if (index === from || (centre(rect) - edge) * sign <= -1) return;
    const along = horizontal ? gap(here.left, here.width, rect.left, rect.width) : gap(here.top, here.height, rect.top, rect.height);
    const off = horizontal ? gap(here.top, here.height, rect.top, rect.height) : gap(here.left, here.width, rect.left, rect.width);
    const inLine = (horizontal ? shared(here.top, here.height, rect.top, rect.height)
      : shared(here.left, here.width, rect.left, rect.width)) > 0;
    const value = (inLine ? along : 1e6 + along + off * 3) + Math.abs(across(rect) - across(here)) * 0.05;
    if (value < score) { score = value; best = index; }
  });
  return best;
}
