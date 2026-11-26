export type ModelSelection = { model?: string | undefined; effort?: string | undefined };

type ModelChoice = { value: string; name: string; description?: string | null };
export type ModelSetting = {
  name: string;
  description?: string | null;
  currentValue: string;
  options: Array<ModelChoice | { group: string; name: string; options: ModelChoice[] }>;
};
export type ModelSettings = Partial<Record<keyof ModelSelection, ModelSetting>>;

export function modelChoices(setting: ModelSetting | undefined) {
  return setting?.options.flatMap((option) => 'group' in option ? option.options : [option]) ?? [];
}
