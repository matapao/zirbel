/**
 * Fixed ticks from frames: each frame adds the time since the one before (from the frames' own timestamps), and
 * the ticks due are taken from it. What is left over says how far the frame is between the last tick and the next
 * (alpha), for drawing between the two.
 */

/**
 * Where ticks fall between frames at first, and again after a stall: away from the frames themselves, so a screen
 * at the tick rate, or at 2 or 4 times it, gets the same number of ticks every frame, not none in one and two in
 * the next.
 */
const PHASE = 0.375;
/** The most ticks a frame catches up after a stall. */
const CATCH_UP = 8;

export class Ticks {
  /** ms a tick. */
  readonly ms: number;
  #acc: number;

  constructor(perSecond: number) {
    this.ms = 1000 / perSecond;
    this.#acc = this.ms * PHASE;
  }

  /** Starts again from no time owed. */
  reset(): void {
    this.#acc = this.ms * PHASE;
  }

  /** A frame, dt ms after the one before. */
  add(dt: number): void {
    this.#acc += dt;
    if (this.#acc > this.ms * CATCH_UP) this.#acc = this.ms * (CATCH_UP - 1 + PHASE);
  }

  /** Whether a tick is due. */
  get due(): boolean {
    return this.#acc >= this.ms;
  }

  take(): void {
    this.#acc -= this.ms;
  }

  /** How far this frame is from the last tick to the next, 0 to 1. */
  get alpha(): number {
    return Math.min(1, this.#acc / this.ms);
  }
}
