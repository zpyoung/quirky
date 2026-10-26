import { DEFAULT_THEME, type SettingInfo, type ThemeInfo } from '@quirky/protocol'

/** The input a Settings dialog renders for one setting, chosen by the setting's declared type. */
export type SettingControl =
  | { kind: 'checkbox' }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'text' }
  | { kind: 'select'; options: string[] }

export type SettingField = {
  id: string
  title: string
  description?: string
  control: SettingControl
  /** The setting's current effective value. */
  value: boolean | number | string
}

export type SettingGroup = { plugin: string; fields: SettingField[] }

export type ThemeOption = { id: string; title: string; appearance: ThemeInfo['appearance'] }

function controlFor(setting: SettingInfo): SettingControl {
  switch (setting.type) {
    case 'boolean':
      return { kind: 'checkbox' }
    case 'number':
      return { kind: 'number', min: setting.minimum, max: setting.maximum }
    case 'string':
      return { kind: 'text' }
    case 'enum':
      return { kind: 'select', options: setting.values ?? [] }
  }
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Groups settings by declaring plugin for the Settings dialog. Groups are sorted by plugin ID and
 * the fields within a group by setting ID, so the dialog reads the same whatever order the daemon
 * listed them in. Each field carries the control for its type and the current value.
 */
export function settingsGroups(settings: SettingInfo[]): SettingGroup[] {
  const groups = new Map<string, SettingInfo[]>()
  for (const setting of settings) {
    const members = groups.get(setting.plugin)
    if (members) members.push(setting)
    else groups.set(setting.plugin, [setting])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([plugin, members]) => ({
      plugin,
      fields: [...members].sort(byId).map((setting) => ({
        id: setting.id,
        title: setting.title,
        description: setting.description,
        control: controlFor(setting),
        value: setting.value
      }))
    }))
}

/**
 * The theme picker: one option per theme in the order given, and the ID to show as selected. A
 * chosen theme that is no longer offered (its plugin is disabled) is shown as the default, which
 * is what the window is applying.
 */
export function themePicker(themes: ThemeInfo[], chosen: string): { options: ThemeOption[]; selected: string } {
  const options = themes.map(({ id, title, appearance }) => ({ id, title, appearance }))
  return { options, selected: options.some((option) => option.id === chosen) ? chosen : DEFAULT_THEME.id }
}
