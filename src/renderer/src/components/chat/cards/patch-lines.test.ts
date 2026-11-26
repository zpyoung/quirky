import { describe, expect, it } from 'vitest'
import { countPatchLines, parsePatchLines } from './patch-lines'

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  'index 1..2 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -10,3 +10,3 @@ fn',
  ' keep',
  '-old',
  '+new',
  ' tail',
  '\\ No newline at end of file'
].join('\n')

describe('parsePatchLines', () => {
  it('numbers each side from the hunk header and skips file headers', () => {
    const lines = parsePatchLines(PATCH)
    expect(lines.map((line) => line.kind)).toEqual([
      'hunk',
      'context',
      'removed',
      'added',
      'context'
    ])
    expect(lines[2]).toMatchObject({ oldLine: 11, newLine: null, text: 'old' })
    expect(lines[3]).toMatchObject({ oldLine: null, newLine: 11, text: 'new' })
    expect(lines[4]).toMatchObject({ oldLine: 12, newLine: 12 })
  })

  it('counts nothing for a patch that was cut short', () => {
    expect(countPatchLines(PATCH, false)).toEqual({ added: 1, removed: 1 })
    expect(countPatchLines(PATCH, true)).toBeNull()
  })
})
