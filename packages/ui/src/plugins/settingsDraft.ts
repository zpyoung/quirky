import type { SettingInfo } from '@quirky/protocol'

/** What a Settings dialog field holds while being edited: text for inputs, a boolean for checkboxes. */
export type DraftValue = string | boolean

/** The value a field displays: the edit if there is one, else the setting's current value. */
export function draftOf(setting: { value: boolean | number | string }, edits: Record<string, DraftValue>, id: string): DraftValue {
  const edit = edits[id]
  if (edit !== undefined) return edit
  return typeof setting.value === 'number' ? String(setting.value) : setting.value
}

function coerce(setting: SettingInfo, edit: DraftValue): boolean | number | string {
  if (setting.type === 'number') {
    const text = String(edit).trim()
    return text === '' ? Number.NaN : Number(text)
  }
  return edit
}

/**
 * The edits that differ from the settings' current values, converted to each setting's type, keyed
 * by setting ID. An empty or non-numeric number edit becomes NaN so the daemon refuses it by name.
 */
export function changedSettings(
  settings: SettingInfo[],
  edits: Record<string, DraftValue>
): Record<string, boolean | number | string> {
  const changed: Record<string, boolean | number | string> = {}
  for (const setting of settings) {
    const edit = edits[setting.id]
    if (edit === undefined) continue
    const value = coerce(setting, edit)
    if (value !== setting.value) changed[setting.id] = value
  }
  return changed
}
