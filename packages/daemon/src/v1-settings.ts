import type { Store } from './store'

const MARKER = 'v1SettingsMigrated'
const SCROLLBACK_MIN = 500
const SCROLLBACK_MAX = 10_000

type Mapping = {
  from: string
  to: string
  /** The value to store, or null when the v1 value is the wrong type. */
  convert(value: unknown): string | number | boolean | null
}

const MAPPINGS: Mapping[] = [
  {
    from: 'worktreesRoot',
    to: 'setting:quirky.worktree/worktreesRoot',
    convert: (value) => (typeof value === 'string' && value.trim() !== '' ? value : null)
  },
  {
    from: 'terminalScrollback',
    to: 'setting:quirky.terminal/scrollback',
    convert: (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(value)))
        : null
  },
  {
    from: 'notifications',
    to: 'setting:quirky.agent-status/notifications',
    convert: (value) => (typeof value === 'boolean' ? value : null)
  }
]

/**
 * Carries v1's kernel settings over to the plugin settings that replaced them, once per home.
 * Writes `setting_values` directly because the declarations may not be loaded yet, and never
 * overwrites a value the setting already has.
 */
export function migrateV1Settings(store: Store, log: (message: string) => void): void {
  if (store.getUiState(MARKER) !== null) return
  const legacy = store.legacySettings()
  for (const { from, to, convert } of MAPPINGS) {
    if (!(from in legacy) || store.getSettingValue(to) !== null) continue
    const value = convert(legacy[from])
    if (value === null) {
      log(`skipped v1 setting ${from}: unexpected value ${JSON.stringify(legacy[from])}`)
      continue
    }
    store.setSettingValue(to, value)
  }
  store.setUiState(MARKER, true)
}
