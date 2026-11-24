import { WORLD, type Scene, type SceneObject } from '../sdk/contracts.ts';

type CTX = CanvasRenderingContext2D;
type Point = [number, number];
type Explorer = { id: string; x: number; y: number; color: string; score: number };
type Drawing = {
  selected?: Set<string>; collected?: Set<string>; explorers?: Explorer[]; currentSeat?: string;
  grid?: boolean; time?: number; region?: { x: number; y: number; width: number; height: number };
  blank?: boolean;
};

function polygon(ctx: CTX, points: Point[], fill: string, stroke?: string) {
  ctx.beginPath();
  points.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function ellipse(ctx: CTX, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
}

function tint(hex: string, amount: number) {
  const base = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => Math.min(255, Math.max(0, Math.round(Number.parseInt(base.slice(i, i + 2), 16) * amount))));
  return 'rgb(' + channels.join(',') + ')';
}

function generator(seed: number) {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const boundary: Point[] = [[89,234],[115,179],[173,150],[198,112],[285,89],[372,87],[455,64],[548,77],
  [601,69],[677,99],[709,117],[773,135],[810,174],[835,234],[845,302],[834,377],[808,426],
  [757,490],[677,519],[594,528],[527,549],[442,553],[383,543],[321,560],[244,520],[179,495],
  [149,453],[110,425],[81,364],[74,300]];

function land(ctx: CTX, scene: Scene) {
  const base = ctx.createLinearGradient(0, 75, 0, 590);
  base.addColorStop(0, '#172c26'); base.addColorStop(1, '#101f1b');
  ctx.fillStyle = base; ctx.fillRect(0, 0, 960, 600);
  const random = generator(72011);
  for (let i = 0; i < 140; i++) {
    const x = random() * 960, y = random() * 600;
    ctx.fillStyle = '#83ba870b'; ctx.fillRect(x, y, 2 + random() * 11, 1);
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
  light.addColorStop(0, '#7796595c'); light.addColorStop(0.67, '#456d452b'); light.addColorStop(1, '#081d1788');
  ctx.fillStyle = light; ctx.fillRect(0, 0, 960, 600);
  for (let i = 0; i < 540; i++) {
    const x = random() * 960, y = random() * 600;
    const colors = ['#a9af5d33','#93b07927','#c3c47d22','#10291f65','#101f1988','#81a26d27','#071d172e'];
    const c = colors[Math.floor(random() * colors.length)]!;
    const length = 1 + Math.floor(random() * 6);
    ctx.fillStyle = c; ctx.fillRect(x, y, length, 2);
    if (i % 3 === 0) { ctx.fillRect(x - 1, y - 3, 1, 3); ctx.fillRect(x + 2, y - 4, 1, 4); }
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const trail = (c: string, w: number) => {
    ctx.beginPath(); ctx.moveTo(196, 418);
    ctx.bezierCurveTo(238, 372, 255, 363, 284, 306);
    ctx.bezierCurveTo(331, 270, 346, 256, 325, 215);
    ctx.moveTo(282, 309);
    ctx.bezierCurveTo(353, 319, 324, 399, 390, 414);
    ctx.bezierCurveTo(443, 429, 490, 429, 562, 421);
    ctx.bezierCurveTo(628, 418, 667, 434, 703, 389);
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke();
  };
  trail('#b9a17216', 48); trail('#b4a17225', 34); trail('#bfa87d18', 16);
  for (let i = 0; i < 65; i++) {
    const x = 172 + random() * 550, y = 180 + random() * 295;
    if (i % 4) {
      ellipse(ctx, x, y, 2 + random() * 4, 1.3, '#bfba801c');
    } else {
      ellipse(ctx, x, y, 3, 2, '#9cb57b50'); ellipse(ctx, x + 3, y - 3, 1.5, 1.3, '#e3d38b80');
    }
  }
  ctx.restore();
}

function pond(ctx: CTX, item: SceneObject, time: number) {
  const random = generator(713);
  const points: Point[] = [[-0.48,0.05],[-0.43,-0.24],[-0.29,-0.36],[-0.09,-0.38],[0.03,-0.29],
    [0.17,-0.34],[0.31,-0.22],[0.47,-0.14],[0.49,0.03],[0.38,0.19],[0.18,0.28],[0.01,0.27],
    [-0.14,0.23],[-0.29,0.25],[-0.42,0.16]];
  const shape = (spread: number) => points.map(([x, y]): Point => [x * item.size * spread, y * item.size * spread]);
  polygon(ctx, shape(1.18), '#87936a39');
  polygon(ctx, shape(1.06), '#192f2b', '#668c6d');
  const gradient = ctx.createLinearGradient(0, -item.size / 3, 0, item.size / 3);
  gradient.addColorStop(0, tint(item.color, 0.76)); gradient.addColorStop(0.48, tint(item.color, 0.92));
  gradient.addColorStop(1, tint(item.color, 1.13));
  ctx.save();
  polygon(ctx, shape(1), tint(item.color, 0.8), '#76b9a48a');
  ctx.clip();
  ctx.fillStyle = gradient; ctx.fillRect(-400, -400, 800, 800);
  for (let i = 0; i < 72; i++) {
    const x = (random() - 0.5) * item.size, y = (random() - 0.5) * item.size;
    ctx.fillStyle = i % 4 ? '#9bdedc34' : '#142f3890';
    ctx.fillRect(x + Math.sin(time / 1400 + i) * 3, y, (0.02 + random() * 0.13) * item.size, i % 9 ? 1.3 : 2);
  }
  [0.15, 0.46, 0.7].forEach((spot, index) => {
    const x = (spot - 0.5) * item.size, y = (0.1 - index * 0.081) * item.size;
    ellipse(ctx, x, y, 6, 3, '#355f3c'); ellipse(ctx, x + 3, y - 1, 2, 1, '#c8b78c');
  });
  ctx.restore();
}

function tree(ctx: CTX, item: SceneObject) {
  const s = item.size;
  ellipse(ctx, s * 0.11, 6, s * 0.4, s * 0.16, '#0b1d18a8');
  ctx.fillStyle = '#4a4430'; ctx.fillRect(-s * 0.045, -s * 0.3, s * 0.1, s * 0.35);
  for (let i = 0; i < 4; i++) {
    const y = -s * (0.12 + i * 0.16);
    const w = s * (0.39 - 0.063 * i);
    const height = s * (0.55 - i * 0.038);
    const points: Point[] = [[-w,y],[-w*0.77,y-height*.33],[-w*.5,y-height*.55],[0,y-height],
      [w*.48,y-height*.55],[w*.77,y-height*.33],[w,y],[w*.6,y+height*.14],[0,y+height*.16],[-w*.65,y+height*.13]];
    polygon(ctx, points, tint(item.color, 0.73 + i * 0.135), '#102f25');
    polygon(ctx, [[0,y-height],[-w*.77,y-height*.33],[-w,y],[-w*.6,y+height*.1],[-w*.03,y+height*.04]],
      tint(item.color, 0.99 + i * 0.143));
    polygon(ctx, [[-w*.68,y-height*.24],[-w*.23,y-height*.39],[-w*.13,y-height*.22],[-w*.57,y-height*.09]],
      '#a7cb831c');
  }
}

function cabin(ctx: CTX, item: SceneObject) {
  const s = item.size / 70;
  ctx.scale(s, s);
  polygon(ctx, [[-48,6],[17,17],[57,0],[34,-22],[-26,-24]], '#13271ebb');
  polygon(ctx, [[-35,-26],[17,-21],[17,12],[-35,8]], tint(item.color, 0.96), '#283522');
  polygon(ctx, [[17,-21],[43,-37],[43,-5],[17,12]], tint(item.color, 0.65), '#283522');
  for (let y = -20; y < 8; y += 6) {
    ctx.fillStyle = '#3a332981'; ctx.fillRect(-34, y, 50, 1);
  }
  polygon(ctx, [[-44,-23],[-19,-51],[31,-45],[20,-20]], '#6d7750', '#24382c');
  polygon(ctx, [[-19,-51],[11,-69],[58,-38],[31,-45]], '#a9a674', '#253a29');
  polygon(ctx, [[31,-45],[58,-38],[20,-20]], '#677451', '#283822');
  polygon(ctx, [[-19,-50],[-11,-42],[27,-36],[31,-44]], '#b3aa8149');
  for (let x = -14; x < 26; x += 7) {
    ctx.beginPath(); ctx.moveTo(x, -46 + (x + 14) * 0.12); ctx.lineTo(x - 18, -23 + (x + 14) * 0.10);
    ctx.strokeStyle = '#2b442f72'; ctx.stroke();
  }
  ctx.fillStyle = '#322e23'; ctx.fillRect(-8, -15, 13, 25);
  ctx.fillStyle = '#eae7a0'; ctx.fillRect(-28, -14, 10, 7); ctx.fillRect(25, -16, 8, 5);
  ctx.fillStyle = '#805f39'; ctx.fillRect(-24, -14, 1.5, 7);
  polygon(ctx, [[17,-52],[23,-53],[23,-76],[17,-76]], '#776d56', '#474f3d');
  ctx.fillStyle = '#b0a27b'; ctx.fillRect(16, -77, 9, 3);
}

function object(ctx: CTX, item: SceneObject, time: number) {
  ctx.save(); ctx.translate(item.x, item.y);
  const s = item.size;
  switch (item.kind) {
    case 'tree': tree(ctx, item); break;
    case 'cabin': cabin(ctx, item); break;
    case 'water': pond(ctx, item, time); break;
    case 'bridge': {
      ctx.rotate(-0.06);
      ellipse(ctx, 0, 4, s * 0.58, s * 0.18, '#111e15bb');
      ctx.fillStyle = '#3e4b38'; ctx.fillRect(-s / 2, -s / 7, s, s / 3.3);
      for (let i = 0; i < 11; i++) {
        ctx.fillStyle = tint(item.color, i % 2 ? .85 : 1.02);
        ctx.fillRect(-s / 2 + i * s / 11, -s / 6, s / 11 - 1, s / 3.6);
      }
      ctx.fillStyle = tint(item.color, 1.2); ctx.fillRect(-s / 2, -s / 6 - 3, s, 3);
      break;
    }
    case 'rock':
      ellipse(ctx, 3, 5, s * .56, s * .26, '#13291faa');
      polygon(ctx, [[-s*.52,0],[-s*.35,-s*.31],[s*.13,-s*.56],[s*.49,-s*.28],[s*.57,s*.04],[s*.15,s*.2]],
        tint(item.color, .75), '#283b33');
      polygon(ctx, [[-s*.35,-s*.31],[s*.13,-s*.56],[s*.49,-s*.28],[s*.16,-s*.10],[-s*.11,-s*.10]], item.color);
      break;
    case 'crystal': {
      const flicker = Math.sin(time / 500 + item.x) * 0.11 + 0.85;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.75);
      glow.addColorStop(0, item.color + '55'); glow.addColorStop(1, item.color + '00');
      ellipse(ctx, 0, 0, s * 1.75, s * 1.75, glow);
      polygon(ctx, [[0,-s*.66*flicker],[s*.35,-s*.09],[0,s*.33],[-s*.34,-s*.09]], item.color);
      polygon(ctx, [[0,-s*.66*flicker],[0,s*.33],[-s*.34,-s*.09]], '#ffffff81');
      break;
    }
    case 'campfire': {
      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, s * 2.6);
      glow.addColorStop(0, item.color + '95'); glow.addColorStop(1, item.color + '00');
      ellipse(ctx, 0, 0, s * 2.6, s * 2.6, glow);
      for (let i = 0; i < 10; i++) {
        const angle = i / 10 * Math.PI * 2;
        ellipse(ctx, Math.cos(angle)*s*.51, Math.sin(angle)*s*.32+4, 4, 3, i % 2 ? '#938169' : '#6f6953');
      }
      ellipse(ctx, 0, 5, s*.45, 4, '#473f2c');
      const sway = Math.sin(time / 160) * 3;
      polygon(ctx, [[-8,5],[-11,-4],[-6,-11],[-2,-6],[sway,-23],[8,-13],[11,-3],[8,5]], tint(item.color, 1.13));
      polygon(ctx, [[-4,5],[-5,-1],[1,-13],[6,-3],[4,5]], '#fff0ab');
      ellipse(ctx, -6 + sway, -29, 1.4, 1.4, '#f4bd7c');
      ellipse(ctx, 7 - sway, -22, 1, 1, '#ffdc8f');
      break;
    }
    case 'spawn':
      ellipse(ctx, 0, 1, s * .54, s * .26, '#d5f2ac31');
      ctx.beginPath(); ctx.ellipse(0, 1, s*.43, s*.22, 0, 0, Math.PI*2);
      ctx.strokeStyle = item.color; ctx.stroke(); break;
    case 'npc':
      ellipse(ctx, 2, 4, s * .38, s * .17, '#203128a0');
      polygon(ctx, [[-s*.3,4],[-s*.25,-s*.51],[s*.25,-s*.51],[s*.32,4]], item.color, '#24382d');
      ellipse(ctx, 0, -s*.61, s*.21, s*.21, '#efd5a7');
      ellipse(ctx, 0, -s*.74, s*.25, s*.1, tint(item.color, .78));
      break;
    case 'enemy':
      ellipse(ctx, 2, 4, s * .5, s * .17, '#203128a0');
      ellipse(ctx, 0, -s*.19, s*.43, s*.35, item.color);
      ellipse(ctx, -s*.13, -s*.24, 2, 2, '#2a2632');
      ellipse(ctx, s*.13, -s*.24, 2, 2, '#2a2632');
      break;
    case 'placeholder':
      polygon(ctx, [[0,-s*.54],[s*.5,-s*.22],[s*.47,s*.22],[0,s*.47],[-s*.47,s*.22],[-s*.5,-s*.22]],
        tint(item.color,.72), item.color);
      polygon(ctx, [[0,-s*.54],[s*.5,-s*.22],[0,s*.03],[-s*.5,-s*.22]], tint(item.color, 1.2));
      break;
  }
  ctx.restore();
}

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
  else land(ctx, scene);
  if (options.grid) {
    ctx.beginPath();
    for (let x = 0; x <= 960; x += 48) { ctx.moveTo(x, 0); ctx.lineTo(x, 600); }
    for (let y = 0; y <= 600; y += 48) { ctx.moveTo(0, y); ctx.lineTo(960, y); }
    ctx.strokeStyle = '#d3ebc424'; ctx.lineWidth = 1; ctx.stroke();
  }
  const floor = scene.objects.filter((item) => item.kind === 'water' || item.kind === 'bridge');
  for (const item of floor.sort((a,b) => Number(b.kind === 'water') - Number(a.kind === 'water'))) object(ctx, item, time);
  const items = scene.objects.filter((item) => !floor.includes(item) && !collected.has(item.id) && !(item.kind === 'spawn' && options.explorers));
  const order = [...items.map((value) => ({ y: value.y, item: value, explorer: null })),
    ...explorers.map((value) => ({ y: value.y, item: null, explorer: value }))].sort((a, b) => a.y - b.y);
  for (const entry of order) {
    if (entry.item) object(ctx, entry.item, time);
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
