import {
  AmbientLight,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  Scene as ThreeScene,
  SphereGeometry,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import type { Quest } from '../games/quest.ts';
import type { Scene } from '../sdk/contracts.ts';

export function showGarden(canvas: HTMLCanvasElement, authored: Scene, quest?: Quest) {
  const world = new ThreeScene();
  world.background = new Color('#172925');
  const camera = new PerspectiveCamera(42, 1, 0.1, 190);
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const garden = new Group();
  world.add(garden);
  const material = (color: string) => new MeshStandardMaterial({ color, roughness: 0.88, flatShading: true });
  function mesh(geometry: BufferGeometry, color: string, x: number, y: number, z: number) {
    const object = new Mesh(geometry, material(color));
    object.position.set(x, y, z);
    garden.add(object);
    return object;
  }
  const land = hip(15.6);
  land.scale.z = 0.78;
  mesh(new CylinderGeometry(14.8, 10.5, 1.9, 9), '#253a31', 0, -1.1, 0).scale.z = 0.8;
  function hip(radius: number) {
    return mesh(new CylinderGeometry(radius, radius * 0.94, 0.7, 9), authored.background, 0, 0, 0);
  }
  const crystals: Mesh[] = [];
  const questObjects = new Map<string, Mesh[]>();
  function figure(color: string, x: number, z: number, size: number) {
    return [
      mesh(new CylinderGeometry(size * 0.2, size * 0.33, size * 0.7, 9), color, x, size * 0.64, z),
      mesh(new SphereGeometry(size * 0.2, 10, 9), '#f4d8ad', x, size * 1.13, z),
      mesh(new ConeGeometry(size * 0.35, size * 0.3, 8), color, x, size * 1.34, z),
    ];
  }
  const hero = quest ? figure('#e5e791', 0, 0, 1) : [];
  for (const item of authored.objects) {
    const x = (item.x - 480) / 28,
      z = (item.y - 300) / 28;
    const size = item.size / 46;
    if (item.kind === 'tree') {
      mesh(new CylinderGeometry(0.13 * size, 0.18 * size, 1.15 * size, 6), '#645339', x, 0.85 * size, z);
      for (let tier = 0; tier < 3; tier++)
        mesh(new ConeGeometry((0.92 - tier * 0.2) * size, 1.5 * size, 7), item.color, x, (1.36 + tier * 0.6) * size, z);
    } else if (item.kind === 'crystal') {
      const crystal = mesh(new OctahedronGeometry(Math.max(0.42, size)), item.color, x, 1.25, z);
      crystals.push(crystal);
      questObjects.set(item.id, [crystal]);
    } else if (item.kind === 'npc') {
      questObjects.set(item.id, figure(item.color, x, z, Math.max(0.77, size)));
    } else if (item.kind === 'enemy') {
      const slime = mesh(new SphereGeometry(Math.max(0.53, size * 0.65), 13, 11), item.color, x, 0.67, z);
      slime.scale.set(1, 0.72, 1);
      const eyes = [-0.17, 0.17].map((offset) =>
        mesh(new SphereGeometry(0.072, 8, 5), '#382538', x + offset, 0.78, z + 0.46),
      );
      questObjects.set(item.id, [slime, ...eyes]);
    } else if (item.kind === 'spawn' && quest) {
      continue;
    } else if (item.kind === 'cabin') {
      mesh(new BoxGeometry(size * 2, size * 1.25, size * 1.45), item.color, x, size * 0.67, z);
      const roof = mesh(new ConeGeometry(size * 1.5, size, 4), '#827451', x, size * 1.64, z);
      roof.rotation.y = Math.PI / 4;
    } else {
      mesh(new SphereGeometry(Math.max(0.24, size * 0.6), 6, 4), item.color, x, 0.5, z).scale.y = 0.63;
    }
  }
  world.add(new AmbientLight('#e3f0dd', 1.75));
  const light = new DirectionalLight('#ffebc2', 2.5);
  light.position.set(-6, 14, 8);
  world.add(light);
  let angle = 0.74,
    elevation = 0.76,
    distance = 38,
    dragging = false;
  const onDown = (event: PointerEvent) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
  };
  const onUp = () => {
    dragging = false;
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    angle -= event.movementX * 0.008;
    elevation = Math.max(0.22, Math.min(1.42, elevation + event.movementY * 0.006));
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    distance = Math.max(16, Math.min(59, distance + event.deltaY * 0.025));
  };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const resize = new ResizeObserver(() => {
    const width = Math.max(1, canvas.clientWidth),
      height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(canvas);
  renderer.setAnimationLoop((time) => {
    const x = quest ? (quest.state.x - 480) / 28 : 0;
    const z = quest ? (quest.state.y - 300) / 28 : 0;
    for (const mesh of hero) {
      mesh.position.x = x;
      mesh.position.z = z;
    }
    if (quest)
      for (const [id, meshes] of questObjects) {
        for (const mesh of meshes) mesh.visible = !quest.state.hidden.has(id);
      }
    const radius = quest ? distance * 0.49 : distance;
    const heading = quest ? angle - 0.74 : angle;
    camera.position.set(
      x + Math.sin(heading) * Math.cos(elevation) * radius,
      Math.sin(elevation) * radius,
      z + Math.cos(heading) * Math.cos(elevation) * radius,
    );
    camera.lookAt(x, 0, z);
    for (const [index, crystal] of crystals.entries()) {
      crystal.rotation.y = time / 1700 + index;
      crystal.position.y = 1.24 + Math.sin(time / 640 + index) * 0.22;
    }
    renderer.render(world, camera);
  });
  return () => {
    renderer.setAnimationLoop(null);
    renderer.dispose();
    resize.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('wheel', onWheel);
    garden.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
  };
}
