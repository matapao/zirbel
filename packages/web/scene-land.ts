// The valley under every scene but a blank one: the island's ground, its edge and shadow, the light on it, the grass
// and the trail across it.
import type { Scene } from '../sdk/contracts.ts';
import { ellipse, generator, polygon, type CTX, type Point } from './scene-paint.ts';

const boundary: Point[] = [
  [89, 234],
  [115, 179],
  [173, 150],
  [198, 112],
  [285, 89],
  [372, 87],
  [455, 64],
  [548, 77],
  [601, 69],
  [677, 99],
  [709, 117],
  [773, 135],
  [810, 174],
  [835, 234],
  [845, 302],
  [834, 377],
  [808, 426],
  [757, 490],
  [677, 519],
  [594, 528],
  [527, 549],
  [442, 553],
  [383, 543],
  [321, 560],
  [244, 520],
  [179, 495],
  [149, 453],
  [110, 425],
  [81, 364],
  [74, 300],
];

export function drawLand(ctx: CTX, scene: Scene) {
  const base = ctx.createLinearGradient(0, 75, 0, 590);
  base.addColorStop(0, '#172c26');
  base.addColorStop(1, '#101f1b');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 960, 600);
  const random = generator(72011);
  for (let i = 0; i < 140; i++) {
    const x = random() * 960,
      y = random() * 600;
    ctx.fillStyle = '#83ba870b';
    ctx.fillRect(x, y, 2 + random() * 11, 1);
  }
  ctx.save();
  ctx.translate(0, 18);
  polygon(ctx, boundary, '#071713');
  ctx.translate(0, -8);
  polygon(ctx, boundary, '#243b2b', '#304435');
  ctx.translate(0, -10);
  polygon(ctx, boundary, scene.background, '#4b684d');
  ctx.clip();
  const light = ctx.createRadialGradient(397, 272, 20, 452, 310, 462);
  light.addColorStop(0, '#7796595c');
  light.addColorStop(0.67, '#456d452b');
  light.addColorStop(1, '#081d1788');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, 960, 600);
  for (let i = 0; i < 540; i++) {
    const x = random() * 960,
      y = random() * 600;
    const colors = ['#a9af5d33', '#93b07927', '#c3c47d22', '#10291f65', '#101f1988', '#81a26d27', '#071d172e'];
    const c = colors[Math.floor(random() * colors.length)]!;
    const length = 1 + Math.floor(random() * 6);
    ctx.fillStyle = c;
    ctx.fillRect(x, y, length, 2);
    if (i % 3 === 0) {
      ctx.fillRect(x - 1, y - 3, 1, 3);
      ctx.fillRect(x + 2, y - 4, 1, 4);
    }
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const trail = (c: string, w: number) => {
    ctx.beginPath();
    ctx.moveTo(196, 418);
    ctx.bezierCurveTo(238, 372, 255, 363, 284, 306);
    ctx.bezierCurveTo(331, 270, 346, 256, 325, 215);
    ctx.moveTo(282, 309);
    ctx.bezierCurveTo(353, 319, 324, 399, 390, 414);
    ctx.bezierCurveTo(443, 429, 490, 429, 562, 421);
    ctx.bezierCurveTo(628, 418, 667, 434, 703, 389);
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.stroke();
  };
  trail('#b9a17216', 48);
  trail('#b4a17225', 34);
  trail('#bfa87d18', 16);
  for (let i = 0; i < 65; i++) {
    const x = 172 + random() * 550,
      y = 180 + random() * 295;
    if (i % 4) {
      ellipse(ctx, x, y, 2 + random() * 4, 1.3, '#bfba801c');
    } else {
      ellipse(ctx, x, y, 3, 2, '#9cb57b50');
      ellipse(ctx, x + 3, y - 3, 1.5, 1.3, '#e3d38b80');
    }
  }
  ctx.restore();
}
