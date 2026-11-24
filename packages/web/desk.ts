// The desk: the running game in the middle, as large as the window allows, and the thread beside it, which the person
// can hide. The imported layout draws the two panes and the line between them; its own title bars, pane buttons and
// shelf stay out of sight (workspace.css), so the split is all that shows. Before a game exists, the thread is alone.
import { Shell, mountShell, type ShellHandle } from '@matapao/vindu';
import { $ } from './editor-ui.ts';
import { threadOpenKey, ws } from './state.ts';

type Arrangement = 'thread' | 'game' | 'both';
const both = [
  { view: 'game', size: 0.7 },
  { view: 'thread', size: 0.3 },
];
let mount: ShellHandle | undefined;
let arranged: Arrangement | undefined;
let split: unknown;
const layout = new Shell({
  arrange: 'off',
  options: { line: 8, margin: 0, min: { w: 280, h: 180 } },
  onChange: (state) => mount?.state(state),
});

try {
  ws.threadOpen = localStorage.getItem(threadOpenKey) !== 'off';
} catch {
  /* Browser storage is optional. */
}

function drawer(template: string, initialize: () => void, place?: () => void) {
  return ({ body }: { body: HTMLElement }) => {
    body.replaceChildren($<HTMLTemplateElement>(template).content.cloneNode(true));
    initialize();
    return { place };
  };
}

/** Draws both panes once, so each pane's controls exist from the start, whatever the desk shows first. */
export function mountDesk(game: () => void, thread: () => void, place: () => void) {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue('--' + name).trim();
  mount = mountShell($('desk'), {
    theme: 'dark',
    tokens: {
      desk: token('app'),
      pane: token('pane'),
      head: token('pane'),
      line: token('line'),
      hair: token('line'),
      ink: token('ink'),
      ink2: token('ink'),
      muted: token('quiet'),
      accent: token('accent'),
      wash: token('hover'),
    },
    labels: { mode: () => '', resize: () => 'Resize the game and the thread' },
    onEvent: (event) => {
      layout.event(event);
    },
    panes: { game: drawer('game-pane', game, place), thread: drawer('thread-pane', thread) },
  });
  layout.show('game', { title: 'Game', panels: 'game', kind: 'game', fill: true });
  layout.show('thread', { title: 'Thread', panels: 'thread', kind: 'thread', fill: true });
  layout.setLayout(both);
  arranged = 'both';
}

/** Shows the thread alone before a game exists, then the game with the thread beside it, or the game alone. */
export function arrangeDesk(empty: boolean) {
  const next: Arrangement = empty ? 'thread' : ws.threadOpen ? 'both' : 'game';
  if (next === arranged) return;
  if (arranged === 'both') split = layout.layoutNow();
  arranged = next;
  layout.setLayout(next === 'both' ? (split ?? both) : [{ view: next, size: 1 }]);
}

export function setThreadOpen(open: boolean) {
  ws.threadOpen = open;
  try {
    localStorage.setItem(threadOpenKey, open ? 'on' : 'off');
  } catch {
    /* Use memory for this session. */
  }
}
