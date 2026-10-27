import { describe, expect, test } from 'bun:test'
import { fenced, fenceFor } from '../../src/core/fence'

describe('fenceFor', () => {
  test('uses three backticks when the text has none', () => {
    expect(fenceFor('plain')).toBe('```')
  })

  test('uses three backticks when the longest run is shorter', () => {
    expect(fenceFor('a `b` and ``c``')).toBe('```')
  })

  test('is one longer than the longest run (SC-20)', () => {
    expect(fenceFor('x ````` y')).toBe('``````')
    expect(fenceFor('```')).toBe('````')
  })
})

describe('fenced', () => {
  test('wraps text so the text cannot close the fence (SC-20)', () => {
    const note = 'before ````` after'
    expect(fenced(note)).toBe(`\`\`\`\`\`\`text\n${note}\n\`\`\`\`\`\``)
  })
})
