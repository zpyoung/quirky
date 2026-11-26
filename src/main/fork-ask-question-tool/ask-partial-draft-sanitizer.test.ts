import { describe, expect, it } from 'vitest'
import { sanitizeAskPartial } from './ask-partial-draft-sanitizer'
import { buildTimeoutResult } from './ask-registry-timeout-answers'
import type { AskSpec } from '../../shared/fork-ask-question-tool/ask-question-schema'

const SPEC: AskSpec = {
  questions: [
    { id: 'q1', type: 'text', question: 'Q1?' },
    {
      id: 'q2',
      type: 'multiselect',
      question: 'Q2?',
      options: [{ value: 'a', label: 'A' }]
    }
  ]
}

describe('sanitizeAskPartial', () => {
  it('drops unknown ids, non-object entries, and malformed fields', () => {
    expect(
      sanitizeAskPartial(SPEC, {
        q1: { draft: 5, note: 'n' },
        q2: { selected: ['a', 3], confirm: 'yes' },
        nope: { draft: 'x' }
      })
    ).toEqual({ q1: { note: 'n' }, q2: { selected: ['a'] } })
    expect(sanitizeAskPartial(SPEC, { q1: 'text' })).toEqual({})
    expect(sanitizeAskPartial(SPEC, null)).toEqual({})
  })

  it('lets a malformed draft resolve at timeout without throwing', () => {
    const partial = sanitizeAskPartial(SPEC, { q1: { draft: 5 }, q2: { selected: 'a' } })
    expect(buildTimeoutResult(SPEC, partial).skipped).toEqual(['q1', 'q2'])
  })
})
