import { describe, expect, test } from 'bun:test'
import type { PluginCaller, PluginErrorKind } from '@quirky/protocol'
import { UiPrefs, uiPrefsMigration, WIDTH_RATIO_KEY } from '../src/uiPrefs'
import { memoryStore } from './memory-store'

const fail = (kind: PluginErrorKind, message: string) => Object.assign(new Error(message), { kind })
const kindOf = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return (error as { kind?: string }).kind
  }
  return undefined
}

const WINDOW: PluginCaller = { role: 'ui' }
const AGENT: PluginCaller = {
  role: 'agent',
  sessionId: 's_1',
  sessionAuthority: { sessionId: 's_1', live: true }
} as unknown as PluginCaller

const make = () => {
  const store = memoryStore()
  store.exec(uiPrefsMigration as string)
  return { store, prefs: new UiPrefs(store, fail) }
}

describe('ui preferences', () => {
  test('a key with nothing stored reads as null', () => {
    expect(make().prefs.uiPref({ key: WIDTH_RATIO_KEY }, WINDOW)).toEqual({ value: null })
  })

  test('a stored value reads back and a later one replaces it', () => {
    const { prefs } = make()
    expect(prefs.setUiPref({ key: WIDTH_RATIO_KEY, value: 0.5 }, WINDOW)).toEqual({})
    expect(prefs.uiPref({ key: WIDTH_RATIO_KEY }, WINDOW)).toEqual({ value: 0.5 })
    prefs.setUiPref({ key: WIDTH_RATIO_KEY, value: 0.3 }, WINDOW)
    expect(prefs.uiPref({ key: WIDTH_RATIO_KEY }, WINDOW)).toEqual({ value: 0.3 })
  })

  test('the desktop shell may call it, an agent session may not', () => {
    const { prefs } = make()
    expect(prefs.uiPref({ key: WIDTH_RATIO_KEY }, { role: 'desktop' })).toEqual({ value: null })
    expect(kindOf(() => prefs.uiPref({ key: WIDTH_RATIO_KEY }, AGENT))).toBe('conflict')
    expect(kindOf(() => prefs.setUiPref({ key: WIDTH_RATIO_KEY, value: 0.5 }, AGENT))).toBe('conflict')
    expect(kindOf(() => prefs.setUiPref({ key: WIDTH_RATIO_KEY, value: 0.5 }, { role: 'plugin', pluginId: 'x' }))).toBe('conflict')
  })

  test('a key must be 1 to 64 lowercase letters, digits, dots or dashes', () => {
    const { prefs } = make()
    for (const key of ['', 'Upper', 'has space', 'a'.repeat(65), 'under_score', 5]) {
      expect(kindOf(() => prefs.uiPref({ key }, WINDOW))).toBe('invalid-params')
      expect(kindOf(() => prefs.setUiPref({ key, value: 1 }, WINDOW))).toBe('invalid-params')
    }
    expect(prefs.setUiPref({ key: 'a'.repeat(64), value: 1 }, WINDOW)).toEqual({})
  })

  test('a value over 4 KiB or one that is missing is refused', () => {
    const { prefs } = make()
    expect(kindOf(() => prefs.setUiPref({ key: 'big', value: 'x'.repeat(4097) }, WINDOW))).toBe('invalid-params')
    expect(kindOf(() => prefs.setUiPref({ key: 'big' }, WINDOW))).toBe('invalid-params')
    expect(prefs.setUiPref({ key: 'fits', value: 'x'.repeat(4000) }, WINDOW)).toEqual({})
  })

  test('the width ratio must be a number from 0.2 to 0.8', () => {
    const { prefs } = make()
    for (const value of [0.19, 0.81, '0.5', null, Number.NaN]) {
      expect(kindOf(() => prefs.setUiPref({ key: WIDTH_RATIO_KEY, value }, WINDOW))).toBe('invalid-params')
    }
    expect(prefs.setUiPref({ key: WIDTH_RATIO_KEY, value: 0.2 }, WINDOW)).toEqual({})
    expect(prefs.setUiPref({ key: WIDTH_RATIO_KEY, value: 0.8 }, WINDOW)).toEqual({})
  })

  test('the migration adds the table to a store that has every earlier migration', () => {
    const store = memoryStore()
    expect(() => store.get('SELECT * FROM ui_prefs')).toThrow()
    store.exec(uiPrefsMigration as string)
    expect(store.get('SELECT * FROM ui_prefs')).toBeNull()
  })
})
