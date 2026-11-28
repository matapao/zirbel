// What a proposal's operations do to a revision's content, and the references a note or a turn marks in a scene.
import { scene, sceneObject, type FullRevision, type Operation, type Reference } from '../sdk/contracts.ts';
import { ZirbelError } from './errors.ts';

export function applyOperations(base: Pick<FullRevision, 'scene' | 'assets' | 'game'>, operations: Operation[]) {
  let game = base.game;
  let background = base.scene?.background;
  const objects = new Map((base.scene?.objects ?? []).map((item) => [item.id, { ...item }]));
  const assets = new Map(base.assets.map((asset) => [asset.id, asset]));
  for (const operation of operations) {
    switch (operation.op) {
      case 'writeGame':
        // Only a game with its files replaces a folder game: one document alone would drop them.
        if (game?.files && !operation.game.files)
          throw new ZirbelError(
            422,
            'This game is a folder of files, which this change would drop. Change it in a harness turn, or import a new build.',
          );
        game = operation.game;
        break;
      case 'background':
        background = operation.color;
        break;
      case 'add':
        if (objects.has(operation.object.id)) throw new ZirbelError(409, 'An object already uses that ID.');
        objects.set(operation.object.id, operation.object);
        break;
      case 'update': {
        const object = objects.get(operation.id);
        if (!object) throw new ZirbelError(409, 'The target object is missing.');
        // The change's properties over the object's, read back as an object (each change and object is one already).
        objects.set(operation.id, sceneObject.parse({ ...object, ...operation.changes }));
        break;
      }
      case 'remove':
        if (!objects.delete(operation.id)) throw new ZirbelError(409, 'The target object is missing.');
        break;
      case 'addAsset':
        if (assets.has(operation.asset.id)) throw new ZirbelError(409, 'An asset already uses that ID.');
        assets.set(operation.asset.id, operation.asset);
        break;
      case 'removeAsset':
        if (!assets.delete(operation.id)) throw new ZirbelError(409, 'The target asset is missing.');
        break;
    }
  }
  if (assets.size > 80) throw new ZirbelError(400, 'A project can reference up to 80 assets.');
  return {
    scene: base.scene && scene.parse({ ...base.scene, background, objects: [...objects.values()] }),
    game,
    assets: [...assets.values()],
  };
}

export function referencesFor(base: Pick<FullRevision, 'id' | 'scene'>, references: Reference[]): Reference[] {
  return references.map((reference) => {
    if (!base.scene || reference.sceneId !== base.scene.id || reference.revision !== base.id)
      throw new ZirbelError(409, 'A selected reference belongs to another revision.');
    if (reference.type === 'instance') {
      const object = base.scene.objects.find((item) => item.id === reference.object.id);
      if (!object) throw new ZirbelError(409, 'A selected object no longer exists.');
      return { ...reference, object };
    }
    const { x, y, width, height } = reference.bounds;
    return {
      ...reference,
      objects: base.scene.objects.filter(
        (item) => item.x >= x && item.x <= x + width && item.y >= y && item.y <= y + height,
      ),
    };
  });
}
