import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'qd-disabled-'))
  dirs.push(dir)
  return join(dir, 'quirky.db')
}

describe('disabled ids', () => {
  test('a new store has none', () => {
    const store = new Store(dbPath())
    expect(store.listDisabledIds()).toEqual([])
    store.close()
  })

  test('ids come back sorted ascending', () => {
    const store = new Store(dbPath())
    for (const id of ['b.plugin', 'c.plugin', 'a.plugin']) store.setDisabledId(id, true)
    expect(store.listDisabledIds()).toEqual(['a.plugin', 'b.plugin', 'c.plugin'])
    store.close()
  })

  test('disabling twice is a no-op and keeps the original timestamp', async () => {
    const path = dbPath()
    const store = new Store(path)
    store.setDisabledId('a.plugin', true)
    const first = readDisabledAt(path, 'a.plugin')
    await Bun.sleep(5)
    store.setDisabledId('a.plugin', true)
    expect(store.listDisabledIds()).toEqual(['a.plugin'])
    expect(readDisabledAt(path, 'a.plugin')).toBe(first)
    store.close()
  })

  test('enabling removes the id, and enabling an absent id does not throw', () => {
    const store = new Store(dbPath())
    store.setDisabledId('a.plugin', true)
    store.setDisabledId('a.plugin', false)
    expect(store.listDisabledIds()).toEqual([])
    expect(() => store.setDisabledId('never.disabled', false)).not.toThrow()
    store.close()
  })

  test('disabled ids survive closing and reopening the store', () => {
    const path = dbPath()
    const first = new Store(path)
    first.setDisabledId('b.plugin', true)
    first.setDisabledId('a.plugin', true)
    first.close()
    const second = new Store(path)
    expect(second.listDisabledIds()).toEqual(['a.plugin', 'b.plugin'])
    second.close()
  })

  test('settings are untouched', () => {
    const store = new Store(dbPath())
    const before = store.getSettings()
    store.setDisabledId('a.plugin', true)
    expect(store.getSettings()).toEqual(before)
    store.close()
  })
})

function readDisabledAt(path: string, id: string): number {
  const db = new Database(path, { readonly: true })
  const row = db.query('SELECT disabled_at FROM disabled_ids WHERE id = ?').get(id) as { disabled_at: number }
  db.close()
  return row.disabled_at
}
