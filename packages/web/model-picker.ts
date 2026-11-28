import { modelChoices, type ModelSelection, type ModelSetting, type ModelSettings } from '../sdk/model-settings.ts';
import type { Processor } from '../server/processors.ts';
import { $, action, api, el, option } from './editor-ui.ts';

type Settings = { selection: ModelSelection; available?: ModelSettings };

export function modelPicker(onChange: () => void) {
  const picker = $<HTMLDetailsElement>('model-picker');
  const label = $('model-picker-label');
  const fields = $('model-picker-fields');
  const harnesses = new Map<string, Settings>();
  let processor: string | undefined;
  let loading: { controller: AbortController; changedModel: boolean } | undefined;
  let fault = '';
  const current = () => (processor ? harnesses.get(processor) : undefined);

  function render() {
    const settings = current();
    label.textContent =
      modelChoices(settings?.available?.model).find(({ value }) => value === settings?.selection.model)?.name ??
      'Model';
    fields.replaceChildren();
    if (loading) {
      fields.append(el('span', 'Checking harness options…', 'model-picker-status'));
      return;
    }
    if (fault)
      fields.append(
        el('span', fault, 'model-picker-status'),
        action('Refresh choices', () => load()),
      );
    if (!settings?.available) return;
    const { model, effort } = settings.available;
    if (model && modelChoices(model).length)
      fields.append(selectSetting(model, settings.selection.model, (model) => void load(model, true)));
    if (effort && modelChoices(effort).length)
      fields.append(
        selectSetting(effort, settings.selection.effort, (effort) => {
          settings.selection = { model: settings.selection.model ?? model?.currentValue, effort };
          render();
        }),
      );
    if (!fields.childElementCount)
      fields.append(el('span', 'This harness reported no model or reasoning choices.', 'model-picker-status'));
    if (settings.selection.model || settings.selection.effort)
      fields.append(
        action('Use harness defaults', () => {
          settings.selection = {};
          return load();
        }),
      );
  }

  async function load(model = current()?.selection.model, changedModel = false) {
    const settings = current();
    if (!processor || !settings) return;
    loading?.controller.abort();
    const request = { controller: new AbortController(), changedModel };
    loading = request;
    fault = '';
    render();
    onChange();
    try {
      const available = await api<ModelSettings>(
        'processors/' + processor + '/model-settings',
        { model },
        request.controller.signal,
      );
      if (loading !== request) return;
      if (changedModel) settings.selection = { model };
      const effort = settings.selection.effort;
      if (effort && !modelChoices(available.effort).some(({ value }) => value === effort))
        settings.selection.effort = undefined;
      settings.available = available;
    } catch (error) {
      if (loading === request) fault = (error as Error).message;
    } finally {
      if (loading === request) {
        loading = undefined;
        render();
        onChange();
      }
    }
  }

  function cancelLookup() {
    if (loading && !loading.changedModel) {
      loading.controller.abort();
      loading = undefined;
      onChange();
    }
  }

  function close(restoreFocus = false) {
    if (!picker.open) return false;
    picker.open = false;
    cancelLookup();
    if (restoreFocus) label.focus();
    return true;
  }

  $('close-model-picker').addEventListener('click', () => close(true));
  picker.addEventListener('toggle', () => {
    if (!picker.open) cancelLookup();
    else if (!loading) void load();
  });

  return {
    close,
    setProcessor(value: Processor | undefined, locked: boolean) {
      const next = value?.modelSettings ? value.id : undefined;
      if (processor !== next) {
        loading?.controller.abort();
        loading = undefined;
        fault = '';
        picker.open = false;
        processor = next;
        if (next && !harnesses.has(next)) harnesses.set(next, { selection: {} });
      }
      picker.hidden = !processor;
      picker.inert = locked;
      if (locked) close();
      render();
    },
    get loading() {
      return Boolean(loading);
    },
    selection: () => {
      const selection = current()?.selection;
      return selection?.model || selection?.effort ? { ...selection } : undefined;
    },
  };
}

function selectSetting(setting: ModelSetting, selection: string | undefined, change: (value: string) => void) {
  const field = el('label');
  field.append(el('span', setting.name));
  if (setting.description) field.title = setting.description;
  const select = el('select');
  const choice = (entry: ReturnType<typeof modelChoices>[number]) => {
    const item = option(entry.value, entry.name);
    if (entry.description) item.title = entry.description;
    return item;
  };
  for (const entry of setting.options) {
    if ('group' in entry) {
      const group = el('optgroup');
      group.label = entry.name;
      group.append(...entry.options.map(choice));
      select.append(group);
    } else select.append(choice(entry));
  }
  const selected = selection ?? setting.currentValue;
  const offered = [...select.options].some(({ value }) => value === selected);
  if (!offered) {
    const unselected = option('', 'Select…');
    unselected.disabled = true;
    select.prepend(unselected);
  }
  select.value = offered ? selected : '';
  select.addEventListener('change', () => change(select.value));
  field.append(select);
  return field;
}
