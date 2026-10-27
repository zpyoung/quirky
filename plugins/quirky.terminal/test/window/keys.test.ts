import { describe, expect, test } from 'bun:test'
import { resolveKeyAction, type KeyContext, type KeyEventLike } from '../../src/window/pane/keys'

const ctx: KeyContext = { kittyFlags: 0, optionAsAlt: 'auto', optionSide: null }

function key(init: Partial<KeyEventLike> & Pick<KeyEventLike, 'key'>): KeyEventLike {
  return { type: 'keydown', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }
}

describe('byte translations', () => {
  test.each([
    ['Shift+Enter', { key: 'Enter', shiftKey: true }, '\x1b\r'],
    ['Ctrl+Backspace', { key: 'Backspace', ctrlKey: true }, '\x17'],
    ['Alt+Backspace', { key: 'Backspace', altKey: true }, '\x1b\x7f'],
    ['Cmd+Backspace', { key: 'Backspace', metaKey: true }, '\x15'],
    ['Cmd+Delete', { key: 'Delete', metaKey: true }, '\x0b'],
    ['Cmd+Left', { key: 'ArrowLeft', metaKey: true }, '\x01'],
    ['Cmd+Right', { key: 'ArrowRight', metaKey: true }, '\x05'],
    ['Alt+Left', { key: 'ArrowLeft', altKey: true }, '\x1bb'],
    ['Alt+Right', { key: 'ArrowRight', altKey: true }, '\x1bf']
  ] as const)('SC-62: %s sends the readline bytes', (_name, init, data) => {
    expect(resolveKeyAction(key(init), ctx)).toEqual({ type: 'send', data })
  })

  test('SC-62: Cmd+Up and Cmd+Down scroll to the top and bottom', () => {
    expect(resolveKeyAction(key({ key: 'ArrowUp', metaKey: true }), ctx)).toEqual({ type: 'scroll', position: 'top' })
    expect(resolveKeyAction(key({ key: 'ArrowDown', metaKey: true }), ctx)).toEqual({ type: 'scroll', position: 'bottom' })
  })

  test('SC-62: Shift+Enter sends the kitty sequence once kitty flags are active', () => {
    expect(resolveKeyAction(key({ key: 'Enter', shiftKey: true }), { ...ctx, kittyFlags: 1 })).toEqual({ type: 'send', data: '\x1b[13;2u' })
  })

  test('Alt+Backspace and Alt+Arrow are left to xterm under kitty flags', () => {
    const kitty = { ...ctx, kittyFlags: 1 }
    expect(resolveKeyAction(key({ key: 'Backspace', altKey: true }), kitty)).toBeNull()
    expect(resolveKeyAction(key({ key: 'ArrowLeft', altKey: true }), kitty)).toBeNull()
  })

  test('chords with extra modifiers are not translated', () => {
    expect(resolveKeyAction(key({ key: 'Enter', shiftKey: true, metaKey: true }), ctx)).toBeNull()
    expect(resolveKeyAction(key({ key: 'ArrowLeft', metaKey: true, shiftKey: true }), ctx)).toBeNull()
    expect(resolveKeyAction(key({ key: 'Backspace', altKey: true, shiftKey: true }), ctx)).toBeNull()
    expect(resolveKeyAction(key({ key: 'ArrowLeft', altKey: true, code: 'Numpad4' }), ctx)).toBeNull()
  })

  test.each(['a', 'Enter', 'ArrowUp', 'Tab', 'Escape'])('passes plain %s to xterm', (name) => {
    expect(resolveKeyAction(key({ key: name }), ctx)).toBeNull()
  })

  test('only keydown translates, and IME composition is left alone', () => {
    expect(resolveKeyAction(key({ key: 'Enter', shiftKey: true, type: 'keyup' }), ctx)).toBeNull()
    expect(resolveKeyAction(key({ key: 'Enter', shiftKey: true, isComposing: true }), ctx)).toBeNull()
    expect(resolveKeyAction(key({ key: 'Backspace', ctrlKey: true, keyCode: 229 }), ctx)).toBeNull()
  })
})

describe('option as alt per side', () => {
  const left = { ...ctx, optionAsAlt: 'left' as const, optionSide: 'left' as const }

  test('the configured side sends ESC plus the key from its physical code', () => {
    expect(resolveKeyAction(key({ key: 'å', code: 'KeyA', altKey: true }), left)).toEqual({ type: 'send', data: '\x1ba' })
    expect(resolveKeyAction(key({ key: '1', code: 'Digit1', altKey: true }), { ...ctx, optionAsAlt: 'right', optionSide: 'right' })).toEqual({ type: 'send', data: '\x1b1' })
  })

  test('the other side composes characters as usual', () => {
    expect(resolveKeyAction(key({ key: 'å', code: 'KeyA', altKey: true }), { ...left, optionSide: 'right' })).toBeNull()
  })

  test('both, off and auto leave letter chords to xterm', () => {
    for (const optionAsAlt of ['both', 'off', 'auto'] as const) {
      expect(resolveKeyAction(key({ key: 'å', code: 'KeyA', altKey: true }), { ...ctx, optionAsAlt, optionSide: 'left' })).toBeNull()
    }
  })

  test('shifted option chords are left to xterm', () => {
    expect(resolveKeyAction(key({ key: 'Å', code: 'KeyA', altKey: true, shiftKey: true }), left)).toBeNull()
  })
})
