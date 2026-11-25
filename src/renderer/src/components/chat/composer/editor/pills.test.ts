import { describe, expect, it } from 'vitest'
import { parsePills, pillText } from './pills'

describe('file pill serialisation', () => {
  it.each(['src/a b/c d.ts', '"quoted".ts', 'dir/say "hi" now.ts', 'back\\slash dir/x.ts'])(
    'round-trips %s',
    (path) => {
      const text = `see ${pillText({ kind: 'file', path })}`
      expect(parsePills(text).map((p) => p.pill)).toEqual([{ kind: 'file', path }])
    }
  )

  it('keeps a path without whitespace unquoted', () => {
    expect(pillText({ kind: 'file', path: 'src/a.ts' })).toBe('@src/a.ts ')
  })
})
