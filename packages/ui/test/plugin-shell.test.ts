import { expect, test } from 'bun:test'
import type { SettingInfo } from '@quirky/protocol'
import { isPaletteChord, paletteKey } from '../src/plugins/palette'
import { changedSettings, draftOf } from '../src/plugins/settingsDraft'

const key = (init: Partial<Parameters<typeof isPaletteChord>[0]>) => ({
  key: 'p',
  code: 'KeyP',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init
})

test('the palette chord is Cmd+Shift+P and nothing near it', () => {
  expect(isPaletteChord(key({ metaKey: true, shiftKey: true, key: 'P' }))).toBe(true)
  expect(isPaletteChord(key({ metaKey: true }))).toBe(false)
  expect(isPaletteChord(key({ shiftKey: true }))).toBe(false)
  expect(isPaletteChord(key({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false)
})

test('palette arrows move and wrap, Enter runs the selection', () => {
  expect(paletteKey('ArrowDown', 0, 3)).toEqual({ selected: 1, run: false })
  expect(paletteKey('ArrowDown', 2, 3)).toEqual({ selected: 0, run: false })
  expect(paletteKey('ArrowUp', 0, 3)).toEqual({ selected: 2, run: false })
  expect(paletteKey('Enter', 1, 3)).toEqual({ selected: 1, run: true })
  expect(paletteKey('a', 1, 3)).toEqual({ selected: 1, run: false })
})

test('palette with no entries never runs and resets the selection', () => {
  expect(paletteKey('Enter', 4, 0)).toEqual({ selected: 0, run: false })
  expect(paletteKey('ArrowDown', 4, 0)).toEqual({ selected: 0, run: false })
})

test('palette clamps a selection left over from a longer list', () => {
  expect(paletteKey('Enter', 9, 2)).toEqual({ selected: 1, run: true })
})

const setting = (over: Partial<SettingInfo> & Pick<SettingInfo, 'id' | 'type' | 'value'>): SettingInfo => ({
  plugin: 'acme.notes',
  title: over.id,
  default: over.value,
  ...over
})
const settings: SettingInfo[] = [
  setting({ id: 'setting:acme.notes/fontSize', type: 'number', value: 12, minimum: 8, maximum: 32 }),
  setting({ id: 'setting:acme.notes/mode', type: 'enum', value: 'list', values: ['list', 'grid'] }),
  setting({ id: 'setting:acme.files/hidden', type: 'boolean', value: false }),
  setting({ id: 'setting:acme.files/root', type: 'string', value: '/x' })
]

test('changedSettings returns only edits that differ, typed per setting', () => {
  const changed = changedSettings(settings, {
    'setting:acme.notes/fontSize': '18',
    'setting:acme.notes/mode': 'list',
    'setting:acme.files/hidden': true,
    'setting:acme.files/root': '/x'
  })
  expect(changed).toEqual({ 'setting:acme.notes/fontSize': 18, 'setting:acme.files/hidden': true })
})

test('changedSettings ignores an edit that was put back and untouched fields', () => {
  expect(changedSettings(settings, { 'setting:acme.notes/fontSize': '12' })).toEqual({})
  expect(changedSettings(settings, {})).toEqual({})
})

test('changedSettings turns an empty or non-numeric number into NaN for the daemon to refuse', () => {
  const empty = changedSettings(settings, { 'setting:acme.notes/fontSize': ' ' })
  const junk = changedSettings(settings, { 'setting:acme.notes/fontSize': 'abc' })
  expect(Number.isNaN(empty['setting:acme.notes/fontSize'] as number)).toBe(true)
  expect(Number.isNaN(junk['setting:acme.notes/fontSize'] as number)).toBe(true)
})

test('draftOf shows the edit, else the current value as text for numbers', () => {
  expect(draftOf(settings[0]!, {}, settings[0]!.id)).toBe('12')
  expect(draftOf(settings[0]!, { [settings[0]!.id]: '1' }, settings[0]!.id)).toBe('1')
  expect(draftOf(settings[2]!, {}, settings[2]!.id)).toBe(false)
})
