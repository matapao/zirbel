// One scene object as the scene draws it, at its place and size: trees, cabins, ponds, bridges, rocks, crystals,
// campfires, spawn points, characters, enemies and placeholders. Crystals, campfires and ponds move with the time.
import type { SceneObject } from '../sdk/contracts.ts';
import { ellipse, generator, polygon, tint, type CTX, type Point } from './scene-paint.ts';

function pond(ctx: CTX, item: SceneObject, time: number) {
  const random = generator(713);
  const points: Point[] = [
    [-0.48, 0.05],
    [-0.43, -0.24],
    [-0.29, -0.36],
    [-0.09, -0.38],
    [0.03, -0.29],
    [0.17, -0.34],
    [0.31, -0.22],
    [0.47, -0.14],
    [0.49, 0.03],
    [0.38, 0.19],
    [0.18, 0.28],
    [0.01, 0.27],
    [-0.14, 0.23],
    [-0.29, 0.25],
    [-0.42, 0.16],
  ];
  const shape = (spread: number) => points.map(([x, y]): Point => [x * item.size * spread, y * item.size * spread]);
  polygon(ctx, shape(1.18), '#87936a39');
  polygon(ctx, shape(1.06), '#192f2b', '#668c6d');
  const gradient = ctx.createLinearGradient(0, -item.size / 3, 0, item.size / 3);
  gradient.addColorStop(0, tint(item.color, 0.76));
  gradient.addColorStop(0.48, tint(item.color, 0.92));
  gradient.addColorStop(1, tint(item.color, 1.13));
  ctx.save();
  polygon(ctx, shape(1), tint(item.color, 0.8), '#76b9a48a');
  ctx.clip();
  ctx.fillStyle = gradient;
  ctx.fillRect(-400, -400, 800, 800);
  for (let i = 0; i < 72; i++) {
    const x = (random() - 0.5) * item.size,
      y = (random() - 0.5) * item.size;
    ctx.fillStyle = i % 4 ? '#9bdedc34' : '#142f3890';
    ctx.fillRect(x + Math.sin(time / 1400 + i) * 3, y, (0.02 + random() * 0.13) * item.size, i % 9 ? 1.3 : 2);
  }
  [0.15, 0.46, 0.7].forEach((spot, index) => {
    const x = (spot - 0.5) * item.size,
      y = (0.1 - index * 0.081) * item.size;
    ellipse(ctx, x, y, 6, 3, '#355f3c');
    ellipse(ctx, x + 3, y - 1, 2, 1, '#c8b78c');
  });
  ctx.restore();
}

function tree(ctx: CTX, item: SceneObject) {
  const s = item.size;
  ellipse(ctx, s * 0.11, 6, s * 0.4, s * 0.16, '#0b1d18a8');
  ctx.fillStyle = '#4a4430';
  ctx.fillRect(-s * 0.045, -s * 0.3, s * 0.1, s * 0.35);
  for (let i = 0; i < 4; i++) {
    const y = -s * (0.12 + i * 0.16);
    const w = s * (0.39 - 0.063 * i);
    const height = s * (0.55 - i * 0.038);
    const points: Point[] = [
      [-w, y],
      [-w * 0.77, y - height * 0.33],
      [-w * 0.5, y - height * 0.55],
      [0, y - height],
      [w * 0.48, y - height * 0.55],
      [w * 0.77, y - height * 0.33],
      [w, y],
      [w * 0.6, y + height * 0.14],
      [0, y + height * 0.16],
      [-w * 0.65, y + height * 0.13],
    ];
    polygon(ctx, points, tint(item.color, 0.73 + i * 0.135), '#102f25');
    polygon(
      ctx,
      [
        [0, y - height],
        [-w * 0.77, y - height * 0.33],
        [-w, y],
        [-w * 0.6, y + height * 0.1],
        [-w * 0.03, y + height * 0.04],
      ],
      tint(item.color, 0.99 + i * 0.143),
    );
    polygon(
      ctx,
      [
        [-w * 0.68, y - height * 0.24],
        [-w * 0.23, y - height * 0.39],
        [-w * 0.13, y - height * 0.22],
        [-w * 0.57, y - height * 0.09],
      ],
      '#a7cb831c',
    );
  }
}

function cabin(ctx: CTX, item: SceneObject) {
  const s = item.size / 70;
  ctx.scale(s, s);
  polygon(
    ctx,
    [
      [-48, 6],
      [17, 17],
      [57, 0],
      [34, -22],
      [-26, -24],
    ],
    '#13271ebb',
  );
  polygon(
    ctx,
    [
      [-35, -26],
      [17, -21],
      [17, 12],
      [-35, 8],
    ],
    tint(item.color, 0.96),
    '#283522',
  );
  polygon(
    ctx,
    [
      [17, -21],
      [43, -37],
      [43, -5],
      [17, 12],
    ],
    tint(item.color, 0.65),
    '#283522',
  );
  for (let y = -20; y < 8; y += 6) {
    ctx.fillStyle = '#3a332981';
    ctx.fillRect(-34, y, 50, 1);
  }
  polygon(
    ctx,
    [
      [-44, -23],
      [-19, -51],
      [31, -45],
      [20, -20],
    ],
    '#6d7750',
    '#24382c',
  );
  polygon(
    ctx,
    [
      [-19, -51],
      [11, -69],
      [58, -38],
      [31, -45],
    ],
    '#a9a674',
    '#253a29',
  );
  polygon(
    ctx,
    [
      [31, -45],
      [58, -38],
      [20, -20],
    ],
    '#677451',
    '#283822',
  );
  polygon(
    ctx,
    [
      [-19, -50],
      [-11, -42],
      [27, -36],
      [31, -44],
    ],
    '#b3aa8149',
  );
  for (let x = -14; x < 26; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, -46 + (x + 14) * 0.12);
    ctx.lineTo(x - 18, -23 + (x + 14) * 0.1);
    ctx.strokeStyle = '#2b442f72';
    ctx.stroke();
  }
  ctx.fillStyle = '#322e23';
  ctx.fillRect(-8, -15, 13, 25);
  ctx.fillStyle = '#eae7a0';
  ctx.fillRect(-28, -14, 10, 7);
  ctx.fillRect(25, -16, 8, 5);
  ctx.fillStyle = '#805f39';
  ctx.fillRect(-24, -14, 1.5, 7);
  polygon(
    ctx,
    [
      [17, -52],
      [23, -53],
      [23, -76],
      [17, -76],
    ],
    '#776d56',
    '#474f3d',
  );
  ctx.fillStyle = '#b0a27b';
  ctx.fillRect(16, -77, 9, 3);
}

export function drawObject(ctx: CTX, item: SceneObject, time: number) {
  ctx.save();
  ctx.translate(item.x, item.y);
  const s = item.size;
  switch (item.kind) {
    case 'tree':
      tree(ctx, item);
      break;
    case 'cabin':
      cabin(ctx, item);
      break;
    case 'water':
      pond(ctx, item, time);
      break;
    case 'bridge': {
      ctx.rotate(-0.06);
      ellipse(ctx, 0, 4, s * 0.58, s * 0.18, '#111e15bb');
      ctx.fillStyle = '#3e4b38';
      ctx.fillRect(-s / 2, -s / 7, s, s / 3.3);
      for (let i = 0; i < 11; i++) {
        ctx.fillStyle = tint(item.color, i % 2 ? 0.85 : 1.02);
        ctx.fillRect(-s / 2 + (i * s) / 11, -s / 6, s / 11 - 1, s / 3.6);
      }
      ctx.fillStyle = tint(item.color, 1.2);
      ctx.fillRect(-s / 2, -s / 6 - 3, s, 3);
      break;
    }
    case 'rock':
      ellipse(ctx, 3, 5, s * 0.56, s * 0.26, '#13291faa');
      polygon(
        ctx,
        [
          [-s * 0.52, 0],
          [-s * 0.35, -s * 0.31],
          [s * 0.13, -s * 0.56],
          [s * 0.49, -s * 0.28],
          [s * 0.57, s * 0.04],
          [s * 0.15, s * 0.2],
        ],
        tint(item.color, 0.75),
        '#283b33',
      );
      polygon(
        ctx,
        [
          [-s * 0.35, -s * 0.31],
          [s * 0.13, -s * 0.56],
          [s * 0.49, -s * 0.28],
          [s * 0.16, -s * 0.1],
          [-s * 0.11, -s * 0.1],
        ],
        item.color,
      );
      break;
    case 'crystal': {
      const flicker = Math.sin(time / 500 + item.x) * 0.11 + 0.85;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.75);
      glow.addColorStop(0, item.color + '55');
      glow.addColorStop(1, item.color + '00');
      ellipse(ctx, 0, 0, s * 1.75, s * 1.75, glow);
      polygon(
        ctx,
        [
          [0, -s * 0.66 * flicker],
          [s * 0.35, -s * 0.09],
          [0, s * 0.33],
          [-s * 0.34, -s * 0.09],
        ],
        item.color,
      );
      polygon(
        ctx,
        [
          [0, -s * 0.66 * flicker],
          [0, s * 0.33],
          [-s * 0.34, -s * 0.09],
        ],
        '#ffffff81',
      );
      break;
    }
    case 'campfire': {
      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, s * 2.6);
      glow.addColorStop(0, item.color + '95');
      glow.addColorStop(1, item.color + '00');
      ellipse(ctx, 0, 0, s * 2.6, s * 2.6, glow);
      for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2;
        ellipse(ctx, Math.cos(angle) * s * 0.51, Math.sin(angle) * s * 0.32 + 4, 4, 3, i % 2 ? '#938169' : '#6f6953');
      }
      ellipse(ctx, 0, 5, s * 0.45, 4, '#473f2c');
      const sway = Math.sin(time / 160) * 3;
      polygon(
        ctx,
        [
          [-8, 5],
          [-11, -4],
          [-6, -11],
          [-2, -6],
          [sway, -23],
          [8, -13],
          [11, -3],
          [8, 5],
        ],
        tint(item.color, 1.13),
      );
      polygon(
        ctx,
        [
          [-4, 5],
          [-5, -1],
          [1, -13],
          [6, -3],
          [4, 5],
        ],
        '#fff0ab',
      );
      ellipse(ctx, -6 + sway, -29, 1.4, 1.4, '#f4bd7c');
      ellipse(ctx, 7 - sway, -22, 1, 1, '#ffdc8f');
      break;
    }
    case 'spawn':
      ellipse(ctx, 0, 1, s * 0.54, s * 0.26, '#d5f2ac31');
      ctx.beginPath();
      ctx.ellipse(0, 1, s * 0.43, s * 0.22, 0, 0, Math.PI * 2);
      ctx.strokeStyle = item.color;
      ctx.stroke();
      break;
    case 'npc':
      ellipse(ctx, 2, 4, s * 0.38, s * 0.17, '#203128a0');
      polygon(
        ctx,
        [
          [-s * 0.3, 4],
          [-s * 0.25, -s * 0.51],
          [s * 0.25, -s * 0.51],
          [s * 0.32, 4],
        ],
        item.color,
        '#24382d',
      );
      ellipse(ctx, 0, -s * 0.61, s * 0.21, s * 0.21, '#efd5a7');
      ellipse(ctx, 0, -s * 0.74, s * 0.25, s * 0.1, tint(item.color, 0.78));
      break;
    case 'enemy':
      ellipse(ctx, 2, 4, s * 0.5, s * 0.17, '#203128a0');
      ellipse(ctx, 0, -s * 0.19, s * 0.43, s * 0.35, item.color);
      ellipse(ctx, -s * 0.13, -s * 0.24, 2, 2, '#2a2632');
      ellipse(ctx, s * 0.13, -s * 0.24, 2, 2, '#2a2632');
      break;
    case 'placeholder':
      polygon(
        ctx,
        [
          [0, -s * 0.54],
          [s * 0.5, -s * 0.22],
          [s * 0.47, s * 0.22],
          [0, s * 0.47],
          [-s * 0.47, s * 0.22],
          [-s * 0.5, -s * 0.22],
        ],
        tint(item.color, 0.72),
        item.color,
      );
      polygon(
        ctx,
        [
          [0, -s * 0.54],
          [s * 0.5, -s * 0.22],
          [0, s * 0.03],
          [-s * 0.5, -s * 0.22],
        ],
        tint(item.color, 1.2),
      );
      break;
  }
  ctx.restore();
}
