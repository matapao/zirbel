// Edit: the editing affordances on the running game, shown on demand. The Edit button or E (outside a text field)
// turns it on and off, and Escape turns it off. A click into the game turns it off too, so the person plays: the game
// runs in a frame from another origin, so the editor sees that click only as its own window losing focus to the frame.
import { $ } from './editor-ui.ts';
import { ws } from './state.ts';
import { authored, hasContent } from './workspace.ts';
import { renderViewport, scheduleDraw } from './viewport.ts';
import { renderObjects } from './inspector.ts';
import { popupOpen } from './menu.ts';

function setEditing(on: boolean) {
  const next = on && hasContent();
  if (ws.editing === next) return;
  ws.editing = next;
  // Focus in a control that Edit hides goes back to the Edit button; focus in the game stays there.
  if (
    !next &&
    ['edit-bar', 'objects-drawer', 'source-drawer', 'scene'].some((id) => $(id).contains(document.activeElement))
  )
    $('edit-toggle').focus();
  renderEditing();
}

export function renderEditing() {
  $('desk').toggleAttribute('data-editing', ws.editing);
  const toggle = $('edit-toggle');
  toggle.setAttribute('aria-pressed', String(ws.editing));
  $('hint').textContent = !ws.editing
    ? ''
    : ws.candidate
      ? 'Showing a proposal · switch to Before to edit'
      : ws.project && !authored()
        ? 'Select to inspect · drag to move · drag empty space to mark'
        : 'Click the game to play';
  renderViewport();
  renderObjects();
  scheduleDraw();
}

const textField = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .composer'));

export function setupEditing() {
  $('edit-toggle').addEventListener('click', () => setEditing(!ws.editing));
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if ($<HTMLDialogElement>('dialog').open || popupOpen() || textField(event.target)) return;
    if ((event.key === 'e' || event.key === 'E') && !event.repeat && hasContent()) {
      event.preventDefault();
      setEditing(!ws.editing);
    } else if (event.key === 'Escape' && ws.editing) {
      event.preventDefault();
      setEditing(false);
    }
  });
  // When focus moves into the game's frame, the window blurs with the frame as its active element.
  window.addEventListener('blur', () =>
    setTimeout(() => {
      if (ws.editing && document.activeElement === $('playframe')) setEditing(false);
    }),
  );
}
