// The canvas helpers the scene's drawing shares: filled polygons and ellipses, a colour made darker or lighter, and a
// seeded random generator, so the grass and the ripples fall in the same places every time a scene is drawn.
export type CTX = CanvasRenderingContext2D;
export type Point = [number, number];

export function polygon(ctx: CTX, points: Point[], fill: string, stroke?: string) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function ellipse(ctx: CTX, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function tint(hex: string, amount: number) {
  const base = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) =>
    Math.min(255, Math.max(0, Math.round(Number.parseInt(base.slice(i, i + 2), 16) * amount))),
  );
  return 'rgb(' + channels.join(',') + ')';
}

export function generator(seed: number) {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
