import type { Manifest, Scene, SceneObject, Template } from '../sdk/contracts.ts';

export const templates: Record<Template, {
  title: string; description: string; simulation: Manifest['simulation']; max: number; capabilities: Manifest['capabilities'];
}> = {
  blank: { title: 'Blank canvas', description: 'An empty scene for your own idea.', simulation: null, max: 1, capabilities: [] },
  mosslight: { title: 'Mosslight Valley', description: 'Gather lights in a woodland valley with up to four explorers.', simulation: 'mosslight-v1', max: 4, capabilities: ['multiplayer'] },
  tessellate: { title: 'Tessellate', description: 'Take turns placing tiles. Connect three to win.', simulation: 'tessellate-v1', max: 2, capabilities: ['multiplayer'] },
  'lantern-quest': { title: 'Lantern Vale', description: 'A 3D JRPG with a village guide, a turn-based battle, and a lost relic.', simulation: null, max: 1, capabilities: ['webgl'] },
  'orbit-garden': { title: 'Orbit Garden', description: 'Explore a small, floating 3D garden.', simulation: null, max: 1, capabilities: ['webgl'] },
};

export const palette = {
  tree: '#487b59', rock: '#849486', crystal: '#e4f9a8', campfire: '#f3a664',
  cabin: '#a78862', water: '#397d7b', bridge: '#a49369', spawn: '#e1f59d', placeholder: '#ac93df', npc: '#8dd6ef', enemy: '#d77085',
} satisfies Record<SceneObject['kind'], string>;

export function newObject(kind: SceneObject['kind'], id: string, x: number, y: number): SceneObject {
  return {
    id, kind, name: kind.charAt(0).toUpperCase() + kind.slice(1), x, y,
    size: { tree: 53, rock: 23, crystal: 17, campfire: 28, cabin: 78, water: 195, bridge: 78, spawn: 26, placeholder: 38, npc: 35, enemy: 39 }[kind],
    color: palette[kind],
  };
}

export function starterScene(template: Template): Scene {
  if (template === 'blank' || template === 'tessellate') return { id: 'main', background: '#20342c', objects: [] };
  const objects: SceneObject[] = [
    { ...newObject('water', 'mirror-pond', 585, 338), name: 'Mirror Pond', size: 280 },
    { ...newObject('bridge', 'footbridge', 574, 408), name: 'Old Footbridge' },
    { ...newObject('cabin', 'rangers-cabin', 304, 183), name: 'Ranger’s Cabin' },
    { ...newObject('campfire', 'campfire', 363, 365), name: 'Campfire' },
    { ...newObject('spawn', 'player-spawn', 242, 340), name: 'Player Spawn' },
  ];
  const trees = [[179,120,61],[234,116,53],[348,112,61],[401,146,51],[452,124,60],[507,105,65],
    [561,127,48],[643,105,55],[696,142,64],[737,181,49],[768,237,57],[794,298,62],
    [791,380,67],[732,428,53],[697,469,47],[628,493,55],[538,496,51],[474,528,51],
    [415,513,64],[329,517,55],[248,491,62],[195,464,66],[154,416,54],[121,361,56],[142,299,55],
    [151,225,63],[201,195,44],[748,350,47],[450,221,55],[419,199,42],[658,181,41],[162,484,48],
    [293,471,52],[209,260,51],[690,252,46],[685,487,43],[434,462,40]];
  trees.forEach(([x = 0, y = 0, size = 53], index) => {
    objects.push({ ...newObject('tree', 'pine-' + (index + 1), x, y), name: 'Pine ' + (index + 1), size,
      color: ['#457756', '#528560', '#38644d', '#62865a'][index % 4] ?? palette.tree });
  });
  [[216,365],[427,298],[495,469],[699,361],[559,190],[338,445],[666,411],[263,244]].forEach(([x = 0, y = 0], i) =>
    objects.push({ ...newObject('crystal', 'light-' + (i + 1), x, y), name: 'Valley Light ' + (i + 1) }));
  [[285,387],[464,275],[658,451],[722,322],[525,221],[349,411],[187,381]].forEach(([x = 0, y = 0], i) =>
    objects.push({ ...newObject('rock', 'stone-' + (i + 1), x, y), name: 'Stone ' + (i + 1) }));
  if (template === 'lantern-quest') {
    const quest: SceneObject[] = [
      { ...newObject('spawn', 'player-spawn', 340, 355), name: 'Player Spawn' },
      { ...newObject('npc', 'village-guide', 378, 338), name: 'Village Guide',
        description: 'Welcome to Lantern Vale. A slime stole our Sunstone. Follow the trail east, defeat the slime and bring it back.' },
      { ...newObject('enemy', 'slime', 478, 355), name: 'Slime', health: 20, power: 4 },
      { ...newObject('crystal', 'sunstone', 570, 330), name: 'Sunstone' },
    ];
    const scenery = objects.filter(({ kind, x }) =>
      ['tree', 'rock', 'cabin', 'campfire'].includes(kind) && (kind === 'cabin' || x < 770));
    return { id: 'main', background: '#395b45', objects: [...quest, ...scenery] };
  }
  return template === 'orbit-garden'
    ? { id: 'main', background: '#243d37', objects: objects.filter((item) => item.kind !== 'water' && item.kind !== 'bridge') }
    : { id: 'main', background: '#243b32', objects };
}
