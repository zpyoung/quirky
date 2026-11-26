import { describe, expect, it } from 'vitest'
import { resolveOutputMode } from './output-mode'

describe('resolveOutputMode', () => {
  it('is text with no flag and no environment', () => {
    expect(resolveOutputMode(new Map(), {})).toBe('text')
  })

  it('is json when --json is set', () => {
    expect(resolveOutputMode(new Map([['json', true]]), {})).toBe('json')
  })

  it('is json when QUIRKY_OUTPUT is json', () => {
    expect(resolveOutputMode(new Map(), { QUIRKY_OUTPUT: 'json' })).toBe('json')
  })

  it('ignores any other QUIRKY_OUTPUT value', () => {
    expect(resolveOutputMode(new Map(), { QUIRKY_OUTPUT: 'text' })).toBe('text')
    expect(resolveOutputMode(new Map(), { QUIRKY_OUTPUT: '' })).toBe('text')
  })
})
