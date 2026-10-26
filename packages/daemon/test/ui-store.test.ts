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
  const dir = mkdtempSync(join(tmpdir(), 'qd-ui-store-'))
  dirs.push(dir)
  return join(dir, 'quirky.db')
}

describe('setting values', () => {
  test('an unset id reads as null', () => {
    const store = new Store(dbPath())
    expect(store.getSettingValue('acme.notes.fontSize')).toBeNull()
    store.close()
  })

  test('a value round-trips for each JSON type', () => {
    const store = new Store(dbPath())
    store.setSettingValue('a.number', 16)
    store.setSettingValue('a.string', 'grid')
    store.setSettingValue('a.true', true)
    store.setSettingValue('a.false', false)
    expect(store.getSettingValue('a.number')).toEqual({ value: 16 })
    expect(store.getSettingValue('a.string')).toEqual({ value: 'grid' })
    expect(store.getSettingValue('a.true')).toEqual({ value: true })
    expect(store.getSettingValue('a.false')).toEqual({ value: false })
    store.close()
  })

  test('setting an id twice keeps the latest value', () => {
    const store = new Store(dbPath())
    store.setSettingValue('a.number', 1)
    store.setSettingValue('a.number', 2)
    expect(store.getSettingValue('a.number')).toEqual({ value: 2 })
    store.close()
  })

  test('delete removes the value, and deleting an absent id does not throw', () => {
    const store = new Store(dbPath())
    store.setSettingValue('a.number', 1)
    store.deleteSettingValue('a.number')
    expect(store.getSettingValue('a.number')).toBeNull()
    expect(() => store.deleteSettingValue('a.number')).not.toThrow()
    store.close()
  })

  test('values stay out of the v1 settings table', () => {
    const store = new Store(dbPath())
    const before = store.getSettings()
    store.setSettingValue('a.number', 1)
    expect(store.getSettings()).toEqual(before)
    store.close()
  })

  test('a reopened store keeps values', () => {
    const path = dbPath()
    const first = new Store(path)
    first.setSettingValue('a.string', 'grid')
    first.close()
    const second = new Store(path)
    expect(second.getSettingValue('a.string')).toEqual({ value: 'grid' })
    second.close()
  })
})

describe('ui state', () => {
  test('an unset key reads as null', () => {
    const store = new Store(dbPath())
    expect(store.getUiState('theme')).toBeNull()
    store.close()
  })

  test('a value round-trips and a second set replaces it', () => {
    const store = new Store(dbPath())
    store.setUiState('theme', 'acme.dark')
    expect(store.getUiState('theme')).toBe('acme.dark')
    store.setUiState('theme', 'acme.light')
    expect(store.getUiState('theme')).toBe('acme.light')
    store.close()
  })

  test('a reopened store keeps the value', () => {
    const path = dbPath()
    const first = new Store(path)
    first.setUiState('theme', 'acme.dark')
    first.close()
    const second = new Store(path)
    expect(second.getUiState('theme')).toBe('acme.dark')
    second.close()
  })
})
