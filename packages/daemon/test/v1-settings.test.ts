import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { migrateV1Settings } from '../src/v1-settings'
import { makeTempHome, startHarness } from './helpers'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const WORKTREES_ROOT = 'setting:quirky.worktree/worktreesRoot'
const SCROLLBACK = 'setting:quirky.terminal/scrollback'
const NOTIFICATIONS = 'setting:quirky.agent-status/notifications'

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qd-v1s-'))
  dirs.push(dir)
  return join(dir, 'quirky.db')
}

/** A store whose v1 `settings` table holds `legacy`, as an older daemon wrote it. */
function storeWithLegacy(legacy: Record<string, unknown>, path = dbPath()): Store {
  const store = new Store(path)
  store.close()
  const db = new Database(path)
  for (const [key, value] of Object.entries(legacy)) {
    db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }
  db.close()
  return new Store(path)
}

const quiet = () => {}

describe('v1 settings migration', () => {
  test('SC-26: v1 settings become plugin setting values', () => {
    const store = storeWithLegacy({ worktreesRoot: '/w/root', terminalScrollback: 4000, notifications: false })
    migrateV1Settings(store, quiet)
    expect(store.getSettingValue(WORKTREES_ROOT)).toEqual({ value: '/w/root' })
    expect(store.getSettingValue(SCROLLBACK)).toEqual({ value: 4000 })
    expect(store.getSettingValue(NOTIFICATIONS)).toEqual({ value: false })
    store.close()
  })

  test('SC-26: a scrollback outside 500..10000 is clamped into the range', () => {
    const low = storeWithLegacy({ terminalScrollback: 100 })
    migrateV1Settings(low, quiet)
    expect(low.getSettingValue(SCROLLBACK)).toEqual({ value: 500 })
    low.close()
    const high = storeWithLegacy({ terminalScrollback: 250_000 })
    migrateV1Settings(high, quiet)
    expect(high.getSettingValue(SCROLLBACK)).toEqual({ value: 10_000 })
    high.close()
  })

  test('a value already stored for the setting is kept', () => {
    const store = storeWithLegacy({ terminalScrollback: 4000, notifications: false })
    store.setSettingValue(SCROLLBACK, 1234)
    migrateV1Settings(store, quiet)
    expect(store.getSettingValue(SCROLLBACK)).toEqual({ value: 1234 })
    expect(store.getSettingValue(NOTIFICATIONS)).toEqual({ value: false })
    store.close()
  })

  test('a value of the wrong type is skipped and logged', () => {
    const store = storeWithLegacy({ worktreesRoot: 7, terminalScrollback: 'lots', notifications: 'yes' })
    const lines: string[] = []
    migrateV1Settings(store, (line) => lines.push(line))
    expect(store.getSettingValue(WORKTREES_ROOT)).toBeNull()
    expect(store.getSettingValue(SCROLLBACK)).toBeNull()
    expect(store.getSettingValue(NOTIFICATIONS)).toBeNull()
    expect(lines).toHaveLength(3)
    store.close()
  })

  test('it runs once: a setting the user reset is not restored by a later start', () => {
    const path = dbPath()
    const first = storeWithLegacy({ terminalScrollback: 4000 }, path)
    migrateV1Settings(first, quiet)
    first.deleteSettingValue(SCROLLBACK)
    first.close()
    const second = new Store(path)
    migrateV1Settings(second, quiet)
    expect(second.getSettingValue(SCROLLBACK)).toBeNull()
    second.close()
  })

  test('a home with no v1 settings gains no setting values', () => {
    const store = new Store(dbPath())
    migrateV1Settings(store, quiet)
    for (const id of [WORKTREES_ROOT, SCROLLBACK, NOTIFICATIONS]) expect(store.getSettingValue(id)).toBeNull()
    store.close()
  })

  test('SC-26: the daemon migrates at startup without activating any plugin', async () => {
    const home = makeTempHome()
    storeWithLegacy({ terminalScrollback: 4000 }, join(home, 'quirky.db')).close()
    const harness = await startHarness({ home })
    try {
      const reader = new Store(join(home, 'quirky.db'))
      expect(reader.getSettingValue(SCROLLBACK)).toEqual({ value: 4000 })
      reader.close()
      const client = await harness.connect()
      expect(await client.call('plugin.list', {})).toEqual([])
    } finally {
      await harness.cleanup()
    }
  })
})
