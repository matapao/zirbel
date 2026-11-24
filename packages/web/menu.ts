// Menus and panels that open from a button in the top bar. One is open at a time. Escape, a click elsewhere, a choice,
// or the window losing focus (a click into the game) closes it. A menu follows the ARIA menu-button pattern: the arrow
// keys, Home and End move between its items, and Escape returns focus to its button.
import { $, el } from './editor-ui.ts';

export type MenuItem =
  | 'separator'
  | {
      label: string;
      run?: () => void;
      href?: string;
      /** A choice among several, such as the open game. */
      checked?: boolean;
      disabled?: boolean;
      note?: string;
    };

type Popup = { button: HTMLButtonElement; panel: HTMLElement; close(restore?: boolean): void };
let open: Popup | undefined;

export const popupOpen = () => Boolean(open);
function closePopups(restore = false) {
  open?.close(restore);
}

const itemsOf = (menu: HTMLElement) => [
  ...menu.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]'),
];

function popup(button: HTMLButtonElement, panel: HTMLElement): Popup {
  const self: Popup = {
    button,
    panel,
    close(restore = false) {
      if (open !== self) return;
      open = undefined;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (restore) button.focus();
    },
  };
  return self;
}

function showPopup(self: Popup) {
  closePopups();
  self.panel.hidden = false;
  self.button.setAttribute('aria-expanded', 'true');
  open = self;
}

function menuItem(item: Exclude<MenuItem, 'separator'>, close: () => void) {
  const node = item.href ? el('a') : el('button');
  if (node instanceof HTMLAnchorElement) {
    node.href = item.href!;
    node.download = '';
  } else node.type = 'button';
  node.className = 'menu-item';
  node.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
  if (item.checked !== undefined) node.setAttribute('aria-checked', String(item.checked));
  node.tabIndex = -1;
  node.append(el('span', item.label));
  if (item.note) node.append(el('small', item.note));
  if (item.disabled) node.setAttribute('aria-disabled', 'true');
  node.addEventListener('click', (event) => {
    if (item.disabled) {
      event.preventDefault();
      return;
    }
    close();
    item.run?.();
  });
  return node;
}

/** A button that opens a menu built fresh each time from build(). */
export function menuButton(buttonId: string, menuId: string, build: () => MenuItem[]) {
  const button = $<HTMLButtonElement>(buttonId);
  const menu = $(menuId);
  const self = popup(button, menu);
  const show = (focus: 'first' | 'last') => {
    menu.replaceChildren(
      ...build().map((item) => {
        if (item !== 'separator') return menuItem(item, () => self.close(true));
        const line = el('div', undefined, 'menu-separator');
        line.setAttribute('role', 'separator');
        return line;
      }),
    );
    showPopup(self);
    const items = itemsOf(menu);
    (focus === 'last' ? items.at(-1) : items[0])?.focus();
  };
  button.addEventListener('click', () => {
    if (open === self) self.close();
    else show('first');
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    show(event.key === 'ArrowUp' ? 'last' : 'first');
  });
  menu.addEventListener('keydown', (event) => {
    const items = itemsOf(menu);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined && items.length) {
      event.preventDefault();
      items[(move + items.length) % items.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      self.close(true);
    } else if (event.key === 'Tab') self.close();
  });
}

/** A button that opens a non-modal panel; fill() draws its contents each time it opens. */
export function panelButton(buttonId: string, panelId: string, fill: () => void) {
  const button = $<HTMLButtonElement>(buttonId);
  const panel = $(panelId);
  const self = popup(button, panel);
  button.addEventListener('click', () => {
    if (open === self) {
      self.close();
      return;
    }
    fill();
    showPopup(self);
    panel.querySelector<HTMLElement>('button,a,input,select,textarea')?.focus();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    self.close(true);
  });
  return {
    get open() {
      return open === self;
    },
  };
}

document.addEventListener(
  'pointerdown',
  (event) => {
    if (!open) return;
    const path = event.composedPath();
    if (!path.includes(open.panel) && !path.includes(open.button)) open.close();
  },
  { capture: true },
);
window.addEventListener('blur', () => closePopups());
