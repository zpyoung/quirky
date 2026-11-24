import { describe, expect, it } from 'vitest'
import { literalPathspec } from './git-pathspec'

describe('literalPathspec', () => {
  it('leaves a host path untouched', () => {
    expect(literalPathspec('src\\index.ts', {})).toBe(':(literal)src\\index.ts')
  })
})
