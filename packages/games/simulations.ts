import { z } from 'zod';
import { WORLD, type Scene } from '../sdk/contracts.ts';

const movement = z.strictObject({
  type: z.literal('move'), x: z.number().min(-1).max(1), y: z.number().min(-1).max(1),
});
const placement = z.strictObject({ type: z.literal('place'), cell: z.number().int().min(0).max(8) });
const reset = z.strictObject({ type: z.literal('reset') });
export const mossState = z.strictObject({
  explorers: z.array(z.strictObject({
    id: z.string(), x: z.number(), y: z.number(), score: z.number(), color: z.string(),
  })),
  collected: z.array(z.string()), total: z.number(), finished: z.boolean(),
});
export const tileState = z.strictObject({
  board: z.array(z.string().nullable()).length(9), order: z.array(z.string()),
  turn: z.string().nullable(), winner: z.string().nullable(), draw: z.boolean(), solo: z.boolean(),
});

export interface Simulation {
  add(seat: string): void;
  remove(seat: string): void;
  suspend(seat: string): void;
  apply(seat: string, action: unknown): string | undefined;
  tick(dt: number): boolean;
  snapshot(): z.core.util.JSONType;
}

export function mosslight(scene: Scene): Simulation {
  const spawn = scene.objects.find((item) => item.kind === 'spawn') ?? { x: 240, y: 340 };
  const lights = scene.objects.filter((item) => item.kind === 'crystal');
  const ink = ['#e6fa9e', '#a5dcf1', '#edabcb', '#edbf87'];
  const explorers = new Map<string, { id: string; x: number; y: number; score: number; color: string; dx: number; dy: number }>();
  const collected = new Set<string>();
  return {
    add(seat) {
      const color = ink.find((candidate) => ![...explorers.values()].some((player) => player.color === candidate)) ?? '#ffffff';
      explorers.set(seat, { id: seat, x: spawn.x + explorers.size * 18, y: spawn.y, score: 0, color, dx: 0, dy: 0 });
    },
    remove(seat) { explorers.delete(seat); },
    suspend(seat) {
      const player = explorers.get(seat);
      if (player) player.dx = player.dy = 0;
    },
    apply(seat, action) {
      const edited = movement.safeParse(action);
      const player = explorers.get(seat);
      if (!edited.success || !player) return 'Use a valid movement vector.';
      const { x, y } = edited.data;
      const length = Math.max(1, Math.hypot(x, y));
      player.dx = x / length;
      player.dy = y / length;
      return undefined;
    },
    tick(dt) {
      let changed = false;
      for (const player of explorers.values()) {
        if (!player.dx && !player.dy) continue;
        const x = Math.max(24, Math.min(WORLD.width - 24, player.x + player.dx * 155 * dt));
        const y = Math.max(30, Math.min(WORLD.height - 18, player.y + player.dy * 155 * dt));
        changed ||= x !== player.x || y !== player.y;
        player.x = x;
        player.y = y;
        for (const light of lights) {
          if (collected.has(light.id) || Math.hypot(x - light.x, y - light.y) >= 23) continue;
          collected.add(light.id);
          player.score++;
        }
      }
      return changed;
    },
    snapshot() {
      return {
        explorers: [...explorers.values()].map(({ id, x, y, color, score }) => ({ id, x, y, color, score })),
        collected: [...collected], total: lights.length, finished: lights.length > 0 && collected.size === lights.length,
      };
    },
  };
}

const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]] as const;

export function tessellate(solo: boolean): Simulation {
  const board: (string | null)[] = Array.from({ length: 9 }, () => null);
  let order: string[] = [];
  let turn: string | null = null;
  let winner: string | null = null;
  let draw = false;

  function clear() {
    board.fill(null);
    winner = null;
    draw = false;
    turn = order.length === 2 ? order[0] ?? null : null;
  }

  function place(seat: string, cell: number) {
    board[cell] = seat;
    if (lines.some(([a, b, c]) => board[a] === seat && board[b] === seat && board[c] === seat)) winner = seat;
    draw = !winner && board.every(Boolean);
    turn = winner || draw ? null : order.find((candidate) => candidate !== seat) ?? null;
  }

  return {
    add(seat) {
      order.push(seat);
      if (solo) order.push('bot');
      if (order.length === 2) clear();
    },
    remove(seat) { order = order.filter((candidate) => candidate !== seat && candidate !== 'bot'); clear(); },
    suspend() {},
    apply(seat, input) {
      if (reset.safeParse(input).success && (winner || draw) && order.includes(seat)) { clear(); return; }
      const action = placement.safeParse(input);
      if (!action.success) return 'Choose an open tile.';
      if (turn !== seat) return 'Wait for your turn.';
      if (board[action.data.cell] !== null) return 'That tile is occupied.';
      place(seat, action.data.cell);
      if (turn === 'bot') {
        const next = [4, 0, 8, 2, 6, 1, 3, 5, 7].find((cell) => board[cell] === null);
        if (next !== undefined) place('bot', next);
      }
      return undefined;
    },
    tick() { return false; },
    snapshot() { return { board: [...board], order: [...order], turn, winner, draw, solo }; },
  };
}
