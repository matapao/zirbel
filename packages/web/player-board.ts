// Tessellate's board on the player page: its nine tiles, the players' marks on them, which tiles this seat may place on,
// and the line under the board with its New round button.
import type { tileState } from '../games/simulations.ts';
import type { SeatInfo } from '../sdk/contracts.ts';

type Tiles = ReturnType<typeof tileState.parse>;

/** The first and the second player's marks on a tile; any other tile shows a dot. */
const MARKS = new Map([
  [1, '✧'],
  [2, '●'],
]);

/** The line under the board: who won, a draw, or whose turn it is. */
function scoreLine(state: Tiles, seat: SeatInfo | undefined, name: (id: string) => string) {
  if (state.winner) return name(state.winner) + ' wins';
  if (state.draw) return 'Draw';
  if (!state.turn) return 'Waiting for another player';
  return seat?.id === state.turn ? 'Your turn' : name(state.turn) + '’s turn';
}

/** Nine empty tiles on the board, each of which places on its cell when clicked. */
export function buildBoard(board: HTMLElement, place: (cell: number) => void) {
  board.replaceChildren();
  for (let index = 0; index < 9; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cell = String(index);
    button.addEventListener('click', () => place(index));
    board.append(button);
  }
}

/** The tiles as the room's state has them, for this seat among the room's seats, with the score line and New round. */
export function renderBoard(
  view: { board: HTMLElement; score: HTMLElement; reset: HTMLButtonElement },
  tile: Tiles,
  seats: SeatInfo[],
  seat: SeatInfo | undefined,
) {
  const name = (id: string) => (id === 'bot' ? 'Computer' : (seats.find((seat) => seat.id === id)?.name ?? 'Player'));
  for (const button of view.board.querySelectorAll<HTMLButtonElement>('button')) {
    const index = Number(button.dataset.cell);
    const value = tile.board[index];
    const mark = value ? tile.order.indexOf(value) + 1 : 0;
    button.textContent = MARKS.get(mark) ?? '·';
    button.disabled = !!value || !seat || seat.id !== tile.turn;
    delete button.dataset.mark;
    if (mark) button.dataset.mark = String(mark);
    button.setAttribute('aria-label', value ? name(value) + ', tile ' + (index + 1) : 'Place on tile ' + (index + 1));
  }
  view.score.textContent = scoreLine(tile, seat, name);
  view.reset.hidden = (!tile.winner && !tile.draw) || seat?.role !== 'player';
}
