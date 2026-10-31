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

export type SettingSection = { section?: string; fields: SettingField[] }

export type SettingGroup =
  | { kind: 'plugin'; plugin: string; title: string; category?: never; sections?: never; fields: SettingField[] }
  | { kind: 'category'; plugin?: never; category?: string; sections: SettingSection[]; fields: SettingField[] }

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

function byOptionalName(a?: string, b?: string): number {
  if (a === undefined) return b === undefined ? 0 : -1
  if (b === undefined) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function settingFields(settings: SettingInfo[]): SettingField[] {
  return [...settings].sort(byId).map((setting) => ({
    id: setting.id,
    title: setting.title,
    description: setting.description,
    control: controlFor(setting),
    value: setting.value
  }))
}

/**
 * Groups categorized settings by their declared category and section.
 * Settings without either field remain grouped by plugin ID, use that plugin's manifest name,
 * and keep every group's fields sorted by setting ID.
 */
export function settingsGroups(settings: SettingInfo[]): SettingGroup[] {
  const plugins = new Map<string, SettingInfo[]>()
  const categories = new Map<string | undefined, Map<string | undefined, SettingInfo[]>>()

  for (const setting of settings) {
    if (setting.category === undefined && setting.section === undefined) {
      const members = plugins.get(setting.plugin)
      if (members) members.push(setting)
      else plugins.set(setting.plugin, [setting])
      continue
    }

    let sections = categories.get(setting.category)
    if (!sections) {
      sections = new Map()
      categories.set(setting.category, sections)
    }
    const members = sections.get(setting.section)
    if (members) members.push(setting)
    else sections.set(setting.section, [setting])
  }

  const categorized = [...categories.entries()]
    .sort(([a], [b]) => byOptionalName(a, b))
    .map(([category, bySection]): SettingGroup => {
      const sections = [...bySection.entries()]
        .sort(([a], [b]) => byOptionalName(a, b))
        .map(([section, members]) => ({
          ...(section !== undefined ? { section } : {}),
          fields: settingFields(members)
        }))
      return {
        kind: 'category',
        ...(category !== undefined ? { category } : {}),
        sections,
        fields: sections.flatMap((section) => section.fields).sort(byId)
      }
    })
  const uncategorized = [...plugins.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([plugin, members]): SettingGroup => ({ kind: 'plugin', plugin, title: members[0].pluginName, fields: settingFields(members) }))

  return [...categorized, ...uncategorized]
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
