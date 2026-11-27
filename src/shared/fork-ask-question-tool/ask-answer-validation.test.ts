import { describe, expect, it } from 'vitest'
import { validateAskAnswerSubmission } from './ask-answer-validation'
import type { AskSpec } from './ask-question-schema'

const SELECT_SPEC: AskSpec = {
  questions: [
    {
      id: 'flavor',
      type: 'select',
      question: 'Pick one',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    }
  ]
}

const TWO_QUESTION_SPEC: AskSpec = {
  questions: [
    { id: 'q1', type: 'text', question: 'Q1?' },
    { id: 'q2', type: 'number', question: 'Q2?', min: 0, max: 10 }
  ]
}

describe('validateAskAnswerSubmission (C4)', () => {
  it('accepts a valid select answer inside the option domain', () => {
    const result = validateAskAnswerSubmission(
      SELECT_SPEC,
      { flavor: { value: 'a', source: 'option' } },
      []
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a select value outside the option domain', () => {
    const result = validateAskAnswerSubmission(
      SELECT_SPEC,
      { flavor: { value: 'z', source: 'option' } },
      []
    )
    expect(result.ok).toBe(false)
  })

  it('exempts a select answer declared source "other" from option membership', () => {
    const result = validateAskAnswerSubmission(
      SELECT_SPEC,
      { flavor: { value: 'anything the user typed', source: 'other' } },
      []
    )
    expect(result).toEqual({
      ok: true,
      answers: { flavor: { value: 'anything the user typed', note: undefined, source: 'other' } },
      skipped: []
    })
  })

  it('rejects an unknown question id in answers', () => {
    const result = validateAskAnswerSubmission(
      SELECT_SPEC,
      { nope: { value: 'a', source: 'option' } },
      ['flavor']
    )
    expect(result.ok).toBe(false)
  })

  it('rejects a required question listed in skipped', () => {
    const required: AskSpec = {
      questions: [{ ...SELECT_SPEC.questions[0], required: true } as AskSpec['questions'][number]]
    }
    const result = validateAskAnswerSubmission(required, {}, ['flavor'])
    expect(result.ok).toBe(false)
  })

  it('rejects a question that is neither answered nor skipped', () => {
    const result = validateAskAnswerSubmission(
      TWO_QUESTION_SPEC,
      { q1: { value: 'hi', source: 'input' } },
      []
    )
    expect(result.ok).toBe(false)
  })

  it('rejects a number answer outside min/max', () => {
    const result = validateAskAnswerSubmission(
      TWO_QUESTION_SPEC,
      { q1: { value: 'hi', source: 'input' }, q2: { value: 99, source: 'input' } },
      []
    )
    expect(result.ok).toBe(false)
  })

  it('commits nothing to report on rejection: caller sees only errors, never a partial answers map', () => {
    const result = validateAskAnswerSubmission(
      TWO_QUESTION_SPEC,
      { q1: { value: 'hi', source: 'input' }, q2: { value: 99, source: 'input' } },
      []
    )
    expect(result).not.toHaveProperty('answers')
  })

  it('accepts a fully answered-and-skipped split with a field-naming error list when invalid', () => {
    const result = validateAskAnswerSubmission(
      TWO_QUESTION_SPEC,
      { q1: { value: 'hi', source: 'input' } },
      ['q2']
    )
    expect(result.ok).toBe(true)
  })
})

describe('validateAskAnswerSubmission — required and prototype-shaped input', () => {
  const REQUIRED_SPEC: AskSpec = {
    questions: [
      { id: 'note', type: 'text', question: 'Note?', required: true },
      {
        id: 'tags',
        type: 'multiselect',
        question: 'Tags?',
        required: true,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ]
      }
    ]
  }

  it('rejects a blank answer to a required text question', () => {
    const result = validateAskAnswerSubmission(
      REQUIRED_SPEC,
      { note: { value: '   ', source: 'input' }, tags: { values: ['a'], source: 'options' } },
      []
    )
    expect(result.ok).toBe(false)
  })

  it('rejects an empty required multiselect without other', () => {
    const result = validateAskAnswerSubmission(
      REQUIRED_SPEC,
      { note: { value: 'x', source: 'input' }, tags: { values: [], source: 'options' } },
      []
    )
    expect(result.ok).toBe(false)
  })

  it('accepts an empty required multiselect that carries a non-blank other', () => {
    const result = validateAskAnswerSubmission(
      REQUIRED_SPEC,
      {
        note: { value: 'x', source: 'input' },
        tags: { values: [], other: 'custom', source: 'options' }
      },
      []
    )
    expect(result.ok).toBe(true)
  })

  it('dedupes repeated multiselect values', () => {
    const result = validateAskAnswerSubmission(
      REQUIRED_SPEC,
      { note: { value: 'x', source: 'input' }, tags: { values: ['a', 'a'], source: 'options' } },
      []
    )
    expect(result.ok && result.answers.tags).toMatchObject({ values: ['a'], labels: ['A'] })
  })

  it('does not treat inherited Object.prototype names as answered', () => {
    const spec: AskSpec = {
      questions: [{ id: 'toString', type: 'text', question: 'Q?', required: false }]
    }
    const result = validateAskAnswerSubmission(spec, {}, [])
    expect(result.ok).toBe(false)
  })
})
