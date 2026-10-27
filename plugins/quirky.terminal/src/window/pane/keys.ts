import type { OptionAsAlt } from './settings'

/** The parts of a keyboard event the pane's byte translations read. */
export type KeyEventLike = {
  type?: string
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

export type KeyContext = {
  /** The kitty keyboard flags the running program negotiated; 0 when none. */
  kittyFlags: number
  optionAsAlt: OptionAsAlt
  /** Which Option key is held, when known. */
  optionSide: 'left' | 'right' | null
}

export type KeyAction = { type: 'send'; data: string } | { type: 'scroll'; position: 'top' | 'bottom' }

const META_CHARACTERS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Space: ' '
}

function metaCharacter(code: string | undefined): string | null {
  if (!code) return null
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]!
  return META_CHARACTERS[code] ?? null
}

/**
 * The bytes (or scroll) Orca sends for macOS line-editing chords xterm has no encoding for, so
 * Cmd+Left reaches readline as Ctrl+A and Shift+Enter as a newline that doesn't submit. Returns
 * null for every other key, which then goes to xterm untouched.
 */
export function resolveKeyAction(event: KeyEventLike, context: KeyContext): KeyAction | null {
  if (event.type !== undefined && event.type !== 'keydown') return null
  if (event.isComposing || event.keyCode === 229) return null
  const { key, metaKey, ctrlKey, altKey, shiftKey } = event
  const send = (data: string): KeyAction => ({ type: 'send', data })

  if (shiftKey && key === 'Enter' && !metaKey && !ctrlKey && !altKey) {
    return send(context.kittyFlags > 0 ? '\x1b[13;2u' : '\x1b\r')
  }
  if (ctrlKey && key === 'Backspace' && !metaKey && !altKey && !shiftKey) return send('\x17')

  if (metaKey && !ctrlKey && !altKey && !shiftKey) {
    if (key === 'Backspace') return send('\x15')
    if (key === 'Delete') return send('\x0b')
    if (key === 'ArrowLeft') return send('\x01')
    if (key === 'ArrowRight') return send('\x05')
    if (key === 'ArrowUp') return { type: 'scroll', position: 'top' }
    if (key === 'ArrowDown') return { type: 'scroll', position: 'bottom' }
  }

  if (altKey && !metaKey && !ctrlKey && !shiftKey) {
    // a kitty program binds the sequences xterm already emits for these chords
    if (key === 'Backspace') return context.kittyFlags > 0 ? null : send('\x1b\x7f')
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && event.code?.startsWith('Numpad') !== true) {
      return context.kittyFlags > 0 ? null : send(key === 'ArrowLeft' ? '\x1bb' : '\x1bf')
    }
    const metaSide = context.optionAsAlt === 'left' || context.optionAsAlt === 'right' ? context.optionAsAlt : null
    if (metaSide && context.optionSide === metaSide) {
      const character = metaCharacter(event.code)
      if (character) return send(`\x1b${character}`)
    }
  }
  return null
}
