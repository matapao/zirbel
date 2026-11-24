// Split from chat.ts; shares state through ws in state.ts.
// Suggested messages under the composer once a game exists, and the chat settings that turn them off. The suggestions
// ask about or explain the game on screen; they never propose content.
import { $, action, el, openDialog, option } from './editor-ui.ts';
import {
  chatBusy,
  chatSettings,
  chatSettingsKey,
  MAX_SUGGESTIONS,
  objectPreferenceKey,
  SUGGESTIONS,
  ws,
} from './state.ts';
import { hasContent } from './workspace.ts';
import { harnessReady } from './chat.ts';

export function renderSuggestions() {
  const host = $('chat-suggestions');
  if (!host) return;
  host.replaceChildren();
  if (!hasContent() || !chatSettings.suggestions || !harnessReady() || chatBusy()) return;
  for (const text of SUGGESTIONS.slice(0, Math.min(chatSettings.count, MAX_SUGGESTIONS))) {
    host.append(
      action(
        text,
        () => {
          $<HTMLTextAreaElement>('prompt').value = text;
          $('prompt').focus();
        },
        'suggest',
      ),
    );
  }
}

export function openChatSettings() {
  const body = openDialog('Chat settings');
  const show = el('input');
  show.type = 'checkbox';
  show.checked = chatSettings.suggestions;
  const showLabel = el('label', 'Show suggested messages');
  showLabel.append(show);
  const count = el('select');
  count.append(...Array.from({ length: MAX_SUGGESTIONS }, (_, index) => option(String(index + 1), String(index + 1))));
  count.value = String(Math.min(chatSettings.count, MAX_SUGGESTIONS));
  count.disabled = !show.checked;
  const countLabel = el('label', 'Number of suggestions');
  countLabel.append(count);
  const objects = el('input');
  objects.type = 'checkbox';
  objects.checked = ws.registerObjects;
  const objectsLabel = el('label', 'Register editable objects');
  objectsLabel.append(objects);
  body.append(
    showLabel,
    countLabel,
    objectsLabel,
    el('p', 'Games written with this on register their objects, so Edit can list them and you can mark them for chat.'),
  );
  const save = () => {
    chatSettings.suggestions = show.checked;
    chatSettings.count = Number(count.value);
    count.disabled = !show.checked;
    ws.registerObjects = objects.checked;
    try {
      localStorage.setItem(chatSettingsKey, JSON.stringify(chatSettings));
      localStorage.setItem(objectPreferenceKey, ws.registerObjects ? 'on' : 'off');
    } catch {
      /* Use memory for this session. */
    }
    renderSuggestions();
  };
  for (const input of [show, count, objects]) input.addEventListener('change', save);
}
