import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, PluginStore } from '@quirky/protocol'

const SETTING = 'setting:quirky.terminal/scrollback'
const MIN_LINES = 500
const MAX_LINES = 10000

export const importMigrations = ['CREATE TABLE imports (name TEXT PRIMARY KEY)']

function v1Scrollback(home: string): unknown {
  const path = join(home, 'quirky.db')
  if (!existsSync(path)) return undefined
  const v1 = new Database(path, { readonly: true })
  try {
    if (!v1.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) return undefined
    const row = v1.query("SELECT value FROM settings WHERE key = 'terminalScrollback'").get() as { value: string } | null
    return row ? JSON.parse(row.value) : undefined
  } finally {
    v1.close()
  }
}

/**
 * Carries v1's `terminalScrollback` over once, clamped into the setting's range. A value the user
 * has already set here is kept, and a v1 value of the wrong type is skipped.
 */
export async function importV1Scrollback(context: PluginContext, store: PluginStore): Promise<void> {
  if (store.get("SELECT 1 FROM imports WHERE name = 'scrollback'")) return
  const lines = v1Scrollback(context.home)
  if (lines !== undefined) {
    if (typeof lines !== 'number' || !Number.isFinite(lines)) {
      context.log(`skipped v1 terminalScrollback ${JSON.stringify(lines)}: not a number`)
    } else if (((await context.call('setting.get', { id: SETTING })) as { stored?: unknown }).stored === undefined) {
      await context.call('setting.set', { id: SETTING, value: Math.min(MAX_LINES, Math.max(MIN_LINES, lines)) })
    }
  }
  store.run("INSERT INTO imports (name) VALUES ('scrollback')")
}
