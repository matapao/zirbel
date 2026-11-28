import { WORLD, type Scene, type SceneObject } from '../sdk/contracts.ts';

/** What is left once a relic is recovered: more relics, or the way back to the guide. */
function relicsLeft(remaining: number, guide: SceneObject | undefined) {
  if (remaining) return remaining + (remaining === 1 ? ' relic remains.' : ' relics remain.');
  return 'Return to ' + (guide?.name ?? 'the final guardian') + '.';
}

/** Where a won battle leads: to the relic it freed, or on exploring. */
const afterBattle = (prize: SceneObject | undefined) => (prize ? 'Recover ' + prize.name + '.' : 'Continue exploring.');

export function createQuest(scene: Scene) {
  const spawn = scene.objects.find((object) => object.kind === 'spawn') ?? { x: 340, y: 355 };
  const guides = scene.objects.filter((object) => object.kind === 'npc');
  const guide = guides[0];
  const enemies = scene.objects.filter((object) => object.kind === 'enemy');
  const relics = scene.objects.filter((object) => object.kind === 'crystal');
  const maxHealth = 24;
  let opponent: SceneObject | undefined;
  const state = {
    x: spawn.x,
    y: spawn.y,
    health: maxHealth,
    enemyHealth: enemies[0]?.health ?? 20,
    enemyName: '',
    fighting: false,
    defeated: !enemies.length,
    found: !relics.length,
    won: false,
    relics: 0,
    total: relics.length,
    message: guide ? 'Approach ' + guide.name + ' and interact.' : 'Explore and recover the relics.',
    hidden: new Set<string>(),
  };
  const distanceTo = (target: SceneObject) => Math.hypot(state.x - target.x, state.y - target.y);
  const nearest = (objects: SceneObject[]) =>
    objects
      .filter(({ id }) => !state.hidden.has(id))
      .sort((a, b) => distanceTo(a) - distanceTo(b))
      .find((item) => distanceTo(item) <= 55);
  const names = new Map(scene.objects.map(({ id, name }) => [id, name]));
  const requirement = (item: SceneObject) => {
    if (item.requires && names.has(item.requires) && !state.hidden.has(item.requires)) return names.get(item.requires);
    if (item.kind === 'crystal' && !item.requires && enemies.length === 1 && !state.defeated) return enemies[0]?.name;
    return undefined;
  };

  return {
    state,
    maxHealth,
    move(x: number, y: number, seconds: number) {
      if (state.fighting || state.health <= 0 || state.won) return;
      const distance = (Math.max(0, Math.min(0.05, seconds)) * 172) / Math.max(1, Math.hypot(x, y));
      state.x = Math.max(65, Math.min(WORLD.width - 65, state.x + x * distance));
      state.y = Math.max(70, Math.min(WORLD.height - 65, state.y + y * distance));
    },
    interact() {
      if (state.fighting || state.health <= 0 || state.won) return;
      const target = nearest([...enemies, ...relics, ...guides]);
      if (!target) {
        state.message = 'Move closer to someone or something to interact.';
        return;
      }
      const blocked = requirement(target);
      if (blocked) {
        state.message = 'Resolve ' + blocked + ' before approaching ' + target.name + '.';
        return;
      }
      if (target.kind === 'enemy') {
        opponent = target;
        state.fighting = true;
        state.enemyHealth = target.health ?? 20;
        state.enemyName = target.name;
        state.message = target.name + ' challenges you. Choose an attack or guard.';
      } else if (target.kind === 'crystal') {
        state.hidden.add(target.id);
        state.relics++;
        state.found = state.relics === relics.length;
        state.won = state.found && state.defeated && !guide;
        const remaining = relics.length - state.relics;
        state.message =
          'You recovered ' + target.name + '. ' + (state.won ? 'Quest complete!' : relicsLeft(remaining, guide));
      } else {
        state.won = target === guide && state.defeated && state.found;
        if (target !== guide) state.health = maxHealth;
        state.message = state.won
          ? 'You restored the relics to the village. Quest complete!'
          : target.description || target.name + ': Defeat the guardians and bring back the relics.';
      }
    },
    battle(action: 'attack' | 'guard') {
      if (!state.fighting || !opponent) return;
      if (action === 'attack') {
        state.enemyHealth = Math.max(0, state.enemyHealth - 7);
        if (!state.enemyHealth) {
          state.hidden.add(opponent.id);
          state.defeated = enemies.every(({ id }) => state.hidden.has(id));
          state.fighting = false;
          if (enemies.length > 1) state.health = Math.min(maxHealth, state.health + 5);
          const prize = relics.find(
            ({ requires, id }) => !state.hidden.has(id) && (requires === opponent?.id || enemies.length === 1),
          );
          state.won = state.defeated && state.found && !guide;
          state.message = 'You defeated ' + opponent.name + '. ' + (state.won ? 'Quest complete!' : afterBattle(prize));
          opponent = undefined;
          return;
        }
      }
      const damage = action === 'guard' ? Math.max(1, Math.floor((opponent.power ?? 4) / 3)) : (opponent.power ?? 4);
      state.health = Math.max(0, Math.min(maxHealth, state.health + (action === 'guard' ? 3 : 0) - damage));
      state.message = state.health
        ? (action === 'attack' ? 'Your attack dealt 7 damage. ' : 'You guarded and recovered 3 HP. ') +
          opponent.name +
          ' dealt ' +
          damage +
          ' damage.'
        : 'You fell in battle. Try again.';
      if (!state.health) state.fighting = false;
    },
    restart() {
      opponent = undefined;
      Object.assign(state, {
        x: spawn.x,
        y: spawn.y,
        health: maxHealth,
        enemyHealth: enemies[0]?.health ?? 20,
        enemyName: '',
        fighting: false,
        defeated: !enemies.length,
        found: !relics.length,
        won: false,
        relics: 0,
        message: guide ? 'You returned to ' + guide.name + '.' : 'Explore and recover the relics.',
      });
      state.hidden.clear();
    },
  };
}

export type Quest = ReturnType<typeof createQuest>;
