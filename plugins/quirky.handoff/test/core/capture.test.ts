import { describe, expect, test } from 'bun:test'
import { boundCapture } from '../../src/core/capture'

const ESC = '\x1b'

describe('boundCapture', () => {
  test('joins lines unchanged when they are short and clean', () => {
    expect(boundCapture(['one', 'two'])).toBe('one\ntwo')
  })

  test('is null when nothing readable remains', () => {
    expect(boundCapture([])).toBeNull()
    expect(boundCapture(['', '  ', `${ESC}[31m${ESC}[0m`])).toBeNull()
  })

  test('keeps the last 36,000 characters and says how many came before (SC-31)', () => {
    const lines = [...Array.from({ length: 49 }, () => `${ESC}[32m${'a'.repeat(1000)}${ESC}[0m`), 'b'.repeat(951)]
    expect(lines.join('\n').replace(/\x1b\[\d+m/g, '').length).toBe(50_000)
    const result = boundCapture(lines)!
    expect(result).not.toContain(ESC)
    const note = '[Earlier terminal output omitted: 14000 characters]\n'
    expect(result.startsWith(note)).toBe(true)
    expect(result.length - note.length).toBe(36_000)
    expect(result.endsWith('b'.repeat(951))).toBe(true)
  })

  test('strips CSI, OSC and single-character escapes and other control characters', () => {
    const lines = [
      `${ESC}[1;31mred${ESC}[0m`,
      `${ESC}]0;window title\x07title-bel`,
      `${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`,
      `${ESC}7saved${ESC}8`,
      `${ESC}(Bcharset`,
      'bell\x07 back\bspace\ttab\r'
    ]
    expect(boundCapture(lines)).toBe('red\ntitle-bel\nlink\nsaved\ncharset\nbell backspace\ttab')
  })

  test('does not start the kept text in the middle of a surrogate pair', () => {
    const result = boundCapture(['😀'.repeat(18_001) + 'a'])!
    const [note, text] = result.split('\n')
    expect(note).toBe('[Earlier terminal output omitted: 4 characters]')
    expect(text!.codePointAt(0)).toBe(0x1f600)
    expect(text!.length).toBe(35_999)
  })
})
