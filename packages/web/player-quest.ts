// Lantern Quest on the player page: the quest it plays, its panel (the quest's message, Interact, Attack, Guard and
// Restart) and HP line, and the loop that moves the explorer by the held keys, in the 3D garden or on the 2D scene.
import type { Scene } from '../sdk/contracts.ts';
import { createQuest, type Quest } from '../games/quest.ts';
import { motion } from './player-keys.ts';
import { drawScene } from './scene.ts';

/** The page's parts the quest shows in: its elements by id, the game's canvas and the line under it. */
type Page = { byId: (id: string) => HTMLElement; canvas: HTMLCanvasElement; score: HTMLElement };

/** The page's Lantern Quest: none until show, and none again after stop. */
export function lanternQuest({ byId, canvas, score }: Page) {
  let quest: Quest | undefined;
  let frame = 0;
  let disposeGarden: (() => void) | undefined;

  function refreshQuest() {
    if (!quest) return;
    const { state } = quest;
    byId('quest-message').textContent = state.message;
    byId('interact').hidden = state.fighting || !state.health || state.won;
    byId('attack').hidden = !state.fighting;
    byId('guard').hidden = !state.fighting;
    byId('restart-quest').hidden = Boolean(state.health) && !state.won;
    score.textContent =
      'HP ' +
      state.health +
      ' / ' +
      quest.maxHealth +
      (state.fighting ? ' · ' + state.enemyName + ' HP ' + state.enemyHealth : '') +
      (state.total > 1 ? ' · Relics ' + state.relics + '/' + state.total : '');
  }

  async function showQuest(scene: Scene) {
    const active = (quest = createQuest(scene));
    byId('quest-panel').hidden = false;
    byId('touch').hidden = false;
    byId('instructions').textContent = matchMedia('(pointer: coarse)').matches
      ? 'Move with the arrows'
      : 'WASD or arrow keys · E to interact';
    byId('interact').onclick = () => {
      active.interact();
      refreshQuest();
    };
    byId('attack').onclick = () => {
      active.battle('attack');
      refreshQuest();
    };
    byId('guard').onclick = () => {
      active.battle('guard');
      refreshQuest();
    };
    byId('restart-quest').onclick = () => {
      active.restart();
      refreshQuest();
    };
    refreshQuest();
    let fallback: CanvasRenderingContext2D | null = null;
    try {
      const { showGarden } = await import('./garden-3d.ts');
      if (quest !== active) return;
      disposeGarden = showGarden(canvas, scene, active);
    } catch {
      if (quest !== active) return;
      fallback = canvas.getContext('2d');
    }

    let last = performance.now();
    function animate(time: number) {
      if (quest !== active) return;
      const { x, y } = motion();
      active.move(x, y, (time - last) / 1000);
      last = time;
      if (fallback)
        drawScene(fallback, scene, {
          time,
          collected: active.state.hidden,
          explorers: [{ id: 'you', x: active.state.x, y: active.state.y, color: '#f3f6ad', score: 0 }],
          currentSeat: 'you',
        });
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
  }

  return {
    /** Whether a quest is being played: its explorer moves on this page, not through the room. */
    playing: () => quest !== undefined,
    /** E on the keyboard, the quest's Interact. */
    interact: () => {
      if (!quest) return;
      quest.interact();
      refreshQuest();
    },
    /** Plays a new quest in the scene. */
    show: showQuest,
    /** Ends the quest, its loop and its garden, and hides its panel. */
    stop: () => {
      cancelAnimationFrame(frame);
      disposeGarden?.();
      disposeGarden = undefined;
      quest = undefined;
      byId('quest-panel').hidden = true;
    },
  };
}
