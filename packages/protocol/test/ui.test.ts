import { describe, expect, test } from 'bun:test'
import {
  CODE_BACKED_KINDS,
  DEFAULT_THEME,
  RESERVED_CHORDS,
  THEME_COLOR_RE,
  THEME_TOKENS,
  UI_KINDS,
  checkSettingValue,
  chordFromKeyEvent,
  parseChord,
  type SettingDeclaration
} from '../src'

function chord(text: string): string {
  const result = parseChord(text)
  if (!result.ok) throw new Error(`expected ${text} to parse, got: ${result.error}`)
  return result.chord
}

function error(text: string): string {
  const result = parseChord(text)
  if (result.ok) throw new Error(`expected ${text} to fail, got: ${result.chord}`)
  return result.error
}

describe('parseChord', () => {
  test('canonical form rewrites cmd to mod, orders modifiers and lowercases', () => {
    expect(chord('Shift+Cmd+K')).toBe('mod+shift+k')
    expect(chord('shift+alt+ctrl+x')).toBe('ctrl+alt+shift+x')
    expect(chord('ALT+MOD+Enter')).toBe('mod+alt+enter')
    expect(chord('mod+shift+p')).toBe('mod+shift+p')
  })

  test('accepts every key class', () => {
    expect(chord('mod+0')).toBe('mod+0')
    expect(chord('mod+9')).toBe('mod+9')
    expect(chord('ctrl+PageUp')).toBe('ctrl+pageup')
    for (const key of ['enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pagedown']) {
      expect(chord(`mod+${key}`)).toBe(`mod+${key}`)
    }
    for (const key of [',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`']) {
      expect(chord(`mod+${key}`)).toBe(`mod+${key}`)
    }
  })

  test('function keys need no modifier', () => {
    expect(chord('f1')).toBe('f1')
    expect(chord('F12')).toBe('f12')
    expect(chord('shift+f5')).toBe('shift+f5')
    expect(error('f13')).toBe('unknown key `f13`')
  })

  test('a plain key needs a mod, cmd, ctrl or alt modifier', () => {
    expect(error('x')).toBe('key needs a modifier or a function key')
    expect(error('shift+x')).toBe('key needs a modifier or a function key')
    expect(error('enter')).toBe('key needs a modifier or a function key')
    expect(chord('alt+x')).toBe('alt+x')
    expect(chord('ctrl+x')).toBe('ctrl+x')
    expect(chord('cmd+x')).toBe('mod+x')
  })

  test('reports a missing or doubled key', () => {
    expect(error('mod+shift')).toBe('key must end in one key')
    expect(error('mod+')).toBe('key must end in one key')
    expect(error('')).toBe('key must end in one key')
    expect(error('mod+k+j')).toBe('key must end in one key')
  })

  test('reports an unknown key', () => {
    expect(error('mod+zz')).toBe('unknown key `zz`')
    expect(error('mod+Home2')).toBe('unknown key `home2`')
  })

  test('reports an unknown modifier', () => {
    expect(error('super+k')).toBe('unknown modifier `super`')
    expect(error('mod+hyper+k')).toBe('unknown modifier `hyper`')
  })

  test('reports a duplicate modifier, including cmd after mod', () => {
    expect(error('mod+mod+k')).toBe('duplicate modifier `mod`')
    expect(error('shift+Shift+k')).toBe('duplicate modifier `shift`')
    expect(error('mod+cmd+k')).toBe('duplicate modifier `cmd`')
  })
})

const event = (init: Partial<Parameters<typeof chordFromKeyEvent>[0]>) =>
  chordFromKeyEvent({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init })

describe('chordFromKeyEvent', () => {
  test('maps metaKey to mod and orders modifiers', () => {
    expect(event({ key: 'k', code: 'KeyK', metaKey: true })).toBe('mod+k')
    expect(event({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true, altKey: true, shiftKey: true })).toBe(
      'mod+ctrl+alt+shift+k'
    )
  })

  test('reads letters from code so Shift and Alt do not change them', () => {
    expect(event({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true })).toBe('mod+shift+k')
    expect(event({ key: 'Dead', code: 'KeyN', altKey: true })).toBe('alt+n')
    expect(event({ key: 'å', code: 'KeyA', altKey: true, ctrlKey: true })).toBe('ctrl+alt+a')
  })

  test('reads digits from code', () => {
    expect(event({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true })).toBe('mod+shift+1')
    expect(event({ key: '9', code: 'Digit9', metaKey: true })).toBe('mod+9')
  })

  test('reads punctuation from code', () => {
    const cases: Array<[string, string]> = [
      ['Comma', ','],
      ['Period', '.'],
      ['Slash', '/'],
      ['Semicolon', ';'],
      ['Quote', "'"],
      ['BracketLeft', '['],
      ['BracketRight', ']'],
      ['Backslash', '\\'],
      ['Minus', '-'],
      ['Equal', '='],
      ['Backquote', '`']
    ]
    for (const [code, key] of cases) {
      expect(event({ key: 'x', code, metaKey: true })).toBe(`mod+${key}`)
    }
  })

  test('reads function keys and named keys from key', () => {
    expect(event({ key: 'F5', code: 'F5' })).toBe('f5')
    expect(event({ key: 'F12', code: 'F12', shiftKey: true })).toBe('shift+f12')
    const named: Array<[string, string]> = [
      ['Enter', 'enter'],
      ['Escape', 'escape'],
      ['Tab', 'tab'],
      [' ', 'space'],
      ['Backspace', 'backspace'],
      ['Delete', 'delete'],
      ['ArrowUp', 'up'],
      ['ArrowDown', 'down'],
      ['ArrowLeft', 'left'],
      ['ArrowRight', 'right'],
      ['Home', 'home'],
      ['End', 'end'],
      ['PageUp', 'pageup'],
      ['PageDown', 'pagedown']
    ]
    for (const [key, name] of named) {
      expect(event({ key, code: key, metaKey: true })).toBe(`mod+${name}`)
    }
  })

  test('returns null for a bare modifier press and for keys outside the grammar', () => {
    expect(event({ key: 'Meta', code: 'MetaLeft', metaKey: true })).toBeNull()
    expect(event({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBeNull()
    expect(event({ key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBeNull()
    expect(event({ key: 'Alt', code: 'AltLeft', altKey: true })).toBeNull()
    expect(event({ key: 'Dead', code: 'IntlRo' })).toBeNull()
  })

  test('produces what parseChord accepts', () => {
    expect(event({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true })).toBe(chord('Cmd+Shift+K'))
  })
})

describe('RESERVED_CHORDS', () => {
  test('holds only the command palette', () => {
    expect([...RESERVED_CHORDS]).toEqual(['mod+shift+p'])
  })

  test('every entry is already canonical', () => {
    for (const reserved of RESERVED_CHORDS) expect(chord(reserved)).toBe(reserved)
  })
})

describe('checkSettingValue', () => {
  const id = 'setting:acme.notes/x'
  const bool: SettingDeclaration = { type: 'boolean', title: 'B', default: false }
  const num: SettingDeclaration = { type: 'number', title: 'N', default: 13, minimum: 8, maximum: 32 }
  const str: SettingDeclaration = { type: 'string', title: 'S', default: '' }
  const enumeration: SettingDeclaration = { type: 'enum', title: 'E', default: 'list', values: ['list', 'grid'] }

  test('accepts matching values', () => {
    expect(checkSettingValue(id, bool, true)).toBeNull()
    expect(checkSettingValue(id, num, 16)).toBeNull()
    expect(checkSettingValue(id, num, 8)).toBeNull()
    expect(checkSettingValue(id, num, 32)).toBeNull()
    expect(checkSettingValue(id, str, '')).toBeNull()
    expect(checkSettingValue(id, enumeration, 'grid')).toBeNull()
  })

  test('boolean type message', () => {
    expect(checkSettingValue(id, bool, 'true')).toBe(`${id} must be a boolean`)
    expect(checkSettingValue(id, bool, 1)).toBe(`${id} must be a boolean`)
  })

  test('number type message, finite numbers only', () => {
    expect(checkSettingValue(id, num, 'big')).toBe(`${id} must be a number`)
    expect(checkSettingValue(id, num, Number.NaN)).toBe(`${id} must be a number`)
    expect(checkSettingValue(id, num, Infinity)).toBe(`${id} must be a number`)
    expect(checkSettingValue(id, { ...num, minimum: undefined, maximum: undefined }, -Infinity)).toBe(
      `${id} must be a number`
    )
  })

  test('string type message', () => {
    expect(checkSettingValue(id, str, 3)).toBe(`${id} must be a string`)
    expect(checkSettingValue(id, str, null)).toBe(`${id} must be a string`)
  })

  test('range messages', () => {
    expect(checkSettingValue(id, num, 7)).toBe(`${id} must be at least 8`)
    expect(checkSettingValue(id, num, 40)).toBe(`${id} must be at most 32`)
    expect(checkSettingValue(id, { ...num, minimum: undefined }, -1000)).toBeNull()
    expect(checkSettingValue(id, { ...num, maximum: undefined }, 1000)).toBeNull()
  })

  test('enum messages check the type before membership', () => {
    expect(checkSettingValue(id, enumeration, 'tiles')).toBe(`${id} must be one of list, grid`)
    expect(checkSettingValue(id, enumeration, 3)).toBe(`${id} must be a string`)
  })
})

describe('theme tokens and the default theme', () => {
  test('THEME_TOKENS lists the sixteen tokens in order', () => {
    expect([...THEME_TOKENS]).toEqual([
      'bg',
      'bg-raised',
      'bg-hover',
      'bg-active',
      'border',
      'text',
      'muted',
      'accent',
      'amber',
      'green',
      'grey',
      'dim',
      'danger',
      'terminal-background',
      'terminal-foreground',
      'terminal-cursor'
    ])
  })

  test('DEFAULT_THEME fills exactly THEME_TOKENS with valid colors', () => {
    expect(DEFAULT_THEME).toMatchObject({ id: 'default', plugin: null, title: 'Quirky Dark', appearance: 'dark' })
    expect(Object.keys(DEFAULT_THEME.colors).sort()).toEqual([...THEME_TOKENS].sort())
    for (const value of Object.values(DEFAULT_THEME.colors)) expect(THEME_COLOR_RE.test(value)).toBe(true)
    expect(DEFAULT_THEME.colors.bg).toBe('#16181d')
    expect(DEFAULT_THEME.colors['terminal-cursor']).toBe('#d7dae0')
  })

  test('THEME_COLOR_RE accepts 3, 6 and 8 digit hex only', () => {
    for (const ok of ['#abc', '#AABBCC', '#aabbccdd']) expect(THEME_COLOR_RE.test(ok)).toBe(true)
    for (const bad of ['abc', '#abcd', '#abcde', '#ggg', 'red', '#aabbccdde', ' #abc']) {
      expect(THEME_COLOR_RE.test(bad)).toBe(false)
    }
  })
})

describe('UI kinds', () => {
  test('lists the seven kinds, four of them code-backed', () => {
    expect([...UI_KINDS].sort()).toEqual<string[]>(
      ['command', 'keybinding', 'panel', 'setting', 'sidebar-section', 'theme', 'view'].sort()
    )
    expect([...CODE_BACKED_KINDS].sort()).toEqual(['command', 'panel', 'sidebar-section', 'view'])
    for (const kind of CODE_BACKED_KINDS) expect(UI_KINDS.includes(kind)).toBe(true)
  })
})
