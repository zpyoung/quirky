import type { PluginCaller, PluginErrorKind, PluginStore, StoreMigration } from '@quirky/protocol'

/** The one preference the chat window stores: the visual panel's share of the chat body. */
export const WIDTH_RATIO_KEY = 'chat.visual-panel.width-ratio'

const KEY = /^[a-z0-9.-]{1,64}$/
const MAX_VALUE_BYTES = 4 * 1024
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

/** Appended after `sessionMigrations`, so databases that ran those only gain the table. */
export const uiPrefsMigration: StoreMigration = 'CREATE TABLE ui_prefs (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER)'

function isWindow(caller: PluginCaller): boolean {
  return (caller.role === 'ui' || caller.role === 'desktop') && caller.sessionId === undefined && caller.sessionAuthority === undefined
}

/** Window-only interface preferences that outlive a chat, such as the visual panel's width. */
export class UiPrefs {
  constructor(
    private readonly store: PluginStore,
    private readonly fail: (kind: PluginErrorKind, message: string) => Error
  ) {}

  uiPref = (params: Record<string, unknown>, caller: PluginCaller): { value: unknown } => {
    this.windowOnly(caller, 'uiPref')
    const row = this.store.get<{ value_json: string | null }>('SELECT value_json FROM ui_prefs WHERE key = ?', this.keyOf(params))
    return { value: row?.value_json == null ? null : JSON.parse(row.value_json) }
  }

  setUiPref = (params: Record<string, unknown>, caller: PluginCaller): Record<string, never> => {
    this.windowOnly(caller, 'setUiPref')
    const key = this.keyOf(params)
    const { value } = params
    if (value === undefined) throw this.fail('invalid-params', 'value is required')
    if (key === WIDTH_RATIO_KEY && !(typeof value === 'number' && value >= MIN_RATIO && value <= MAX_RATIO)) {
      throw this.fail('invalid-params', `${key} must be a number from ${MIN_RATIO} to ${MAX_RATIO}`)
    }
    const json = JSON.stringify(value)
    if (json === undefined || Buffer.byteLength(json) > MAX_VALUE_BYTES) throw this.fail('invalid-params', 'value must be JSON of at most 4 KiB')
    this.store.run(
      `INSERT INTO ui_prefs (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      json,
      Date.now()
    )
    return {}
  }

  private keyOf(params: Record<string, unknown>): string {
    const { key } = params
    if (typeof key !== 'string' || !KEY.test(key)) throw this.fail('invalid-params', 'key must be 1 to 64 lowercase letters, digits, dots or dashes')
    return key
  }

  private windowOnly(caller: PluginCaller, method: string): void {
    if (!isWindow(caller)) throw this.fail('conflict', `${method} is available to the window only`)
  }
}
