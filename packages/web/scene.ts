// A scene drawn on a 2D canvas, for the player and the editor's viewport: the valley (scene-land.ts), its objects
// (scene-objects.ts) and explorers in depth order, the selection and a selected region; and the objects under a point.
import { WORLD, type Scene, type SceneObject } from '../sdk/contracts.ts';
import { drawLand } from './scene-land.ts';
import { drawObject } from './scene-objects.ts';
import { ellipse, polygon, tint, type CTX } from './scene-paint.ts';

type Explorer = { id: string; x: number; y: number; color: string; score: number };
type Drawing = {
  selected?: Set<string> | undefined; collected?: Set<string> | undefined; explorers?: Explorer[] | undefined;
  currentSeat?: string | undefined; grid?: boolean | undefined; time?: number | undefined;
  region?: { x: number; y: number; width: number; height: number } | undefined; blank?: boolean | undefined;
};

function hitBounds(item: SceneObject) {
  const { x, y, size: s } = item;
  switch (item.kind) {
    case 'tree': return { x: x - s * .43, y: y - s * .96, width: s * .86, height: s * 1.1 };
    case 'cabin': return { x: x - s * .66, y: y - s * 1.1, width: s * 1.49, height: s * 1.3 };
    case 'water': return { x: x - s * .51, y: y - s * .4, width: s * 1.02, height: s * .7 };
    default: return { x: x - s * .58, y: y - s * .88, width: s * 1.16, height: s * 1.35 };
  }
}

export function hitObjects(scene: Scene, x: number, y: number) {
  return [...scene.objects].filter((item) => {
    const area = hitBounds(item);
    return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
  }).sort((a,b) => Number(a.kind === 'water') - Number(b.kind === 'water') || b.y - a.y);
}

export function drawScene(ctx: CTX, scene: Scene, options: Drawing = {}) {
  const { time = 0, selected = new Set(), collected = new Set(), explorers = [] } = options;
  if (options.blank) { ctx.fillStyle = scene.background; ctx.fillRect(0, 0, WORLD.width, WORLD.height); }
  else drawLand(ctx, scene);
  if (options.grid) {
    ctx.beginPath();
    for (let x = 0; x <= 960; x += 48) { ctx.moveTo(x, 0); ctx.lineTo(x, 600); }
    for (let y = 0; y <= 600; y += 48) { ctx.moveTo(0, y); ctx.lineTo(960, y); }
    ctx.strokeStyle = '#d3ebc424'; ctx.lineWidth = 1; ctx.stroke();
  }
  const floor = scene.objects.filter((item) => item.kind === 'water' || item.kind === 'bridge');
  for (const item of floor.sort((a,b) => Number(b.kind === 'water') - Number(a.kind === 'water'))) drawObject(ctx, item, time);
  const items = scene.objects.filter((item) => !floor.includes(item) && !collected.has(item.id) && !(item.kind === 'spawn' && options.explorers));
  const order = [...items.map((value) => ({ y: value.y, item: value, explorer: null })),
    ...explorers.map((value) => ({ y: value.y, item: null, explorer: value }))].sort((a, b) => a.y - b.y);
  for (const entry of order) {
    if (entry.item) drawObject(ctx, entry.item, time);
    if (entry.explorer) {
      const { id, x, y, color } = entry.explorer;
      ellipse(ctx, x + 1, y + 4, 12, 5, '#0b1d17a9');
      polygon(ctx, [[x-7,y+3],[x-6,y-9],[x+6,y-9],[x+8,y+3]], color, '#253628');
      ellipse(ctx, x, y - 12, 8, 8, tint(color, .86));
      ellipse(ctx, x, y - 14, 7, 5, color);
      ellipse(ctx, x - 3, y - 11, 1, 1, '#26342b'); ellipse(ctx, x + 3, y - 11, 1, 1, '#26342b');
      if (id === options.currentSeat) polygon(ctx, [[x-5,y-27],[x+5,y-27],[x,y-22]], '#e4fa9b');
    }
  }
  for (const item of scene.objects) {
    if (!selected.has(item.id)) continue;
    const b = hitBounds(item);
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#deffa9'; ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x - 5, b.y - 4, b.width + 10, b.height + 8); ctx.setLineDash([]);
    ctx.font = '600 11px system-ui';
    const width = ctx.measureText(item.name).width + 14;
    ctx.fillStyle = '#d7f5aa'; ctx.fillRect(b.x - 5, b.y - 23, width, 16);
    ctx.fillStyle = '#15261a'; ctx.fillText(item.name, b.x + 2, b.y - 11);
  }
  if (options.region) {
    const b = options.region;
    ctx.fillStyle = '#bde68524'; ctx.fillRect(b.x,b.y,b.width,b.height);
    ctx.strokeStyle = '#d7f5aa'; ctx.setLineDash([4, 3]); ctx.strokeRect(b.x,b.y,b.width,b.height); ctx.setLineDash([]);
  }
}
