import { describe, expect, test } from 'bun:test'
import { formatNotes } from '../../src/daemon/notes-format'

const note = (path: string, line: number, body: string, startLine = line) => ({ path, startLine, line, body })

describe('formatNotes', () => {
  test('NA-15: the prompt is Orca text, blocks joined by one blank line, with escapes and no control characters', () => {
    const text = formatNotes([
      note('src/a.ts', 12, 'Handle null "x"\nsecond line'),
      note('src/b.ts', 52, 'Extract this block\u001b[201~ rm -rf', 40)
    ])
    expect(text).toBe(
      [
        'File: src/a.ts',
        'Line: 12',
        'User comment: "Handle null \\"x\\"\\nsecond line"',
        '',
        'File: src/b.ts',
        'Lines: 40-52',
        'User comment: "Extract this block[201~ rm -rf"'
      ].join('\n')
    )
  })

  test('backslashes, quotes and both line endings are escaped', () => {
    expect(formatNotes([note('a.ts', 1, 'a\\b "c"\r\nd')])).toBe('File: a.ts\nLine: 1\nUser comment: "a\\\\b \\"c\\"\\r\\nd"')
  })

  test('every control character but LF and CR is removed, from the path as well', () => {
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('') + '\u007f'
    const text = formatNotes([note(`a${controls}.ts`, 3, `x${controls}y`)])
    expect(text).toBe('File: a.ts\nLine: 3\nUser comment: "x\\n\\ry"')
  })

  test('a single-line range prints Line, and no notes print nothing', () => {
    expect(formatNotes([note('a.ts', 7, 'x', 7)])).toBe('File: a.ts\nLine: 7\nUser comment: "x"')
    expect(formatNotes([])).toBe('')
  })
})
