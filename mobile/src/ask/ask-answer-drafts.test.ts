import { describe, expect, it } from 'vitest'
import type { AskSpec } from '../../../src/shared/fork-ask-question-tool/ask-question-schema'
import {
  askDraftsToPartial,
  buildAskSubmission,
  initialAskDrafts,
  type AskDrafts
} from './ask-answer-drafts'

const SPEC: AskSpec = {
  questions: [
    {
      id: 'pick',
      type: 'select',
      question: 'Which?',
      required: true,
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' }
      ]
    },
    {
      id: 'many',
      type: 'multiselect',
      question: 'Which many?',
      options: [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' }
      ]
    },
    { id: 'age', type: 'number', question: 'Age?', integer: true, min: 1, max: 120 },
    { id: 'when', type: 'date', question: 'When?' },
    { id: 'ok', type: 'confirm', question: 'Sure?' },
    { id: 'mail', type: 'text', question: 'Email?', format: 'email' }
  ]
}

function drafts(overrides: Partial<AskDrafts> = {}): AskDrafts {
  const blank = { selected: [], freeText: '', text: '', confirm: null }
  return {
    pick: { ...blank, selected: ['b'], freeText: 'because' },
    many: { ...blank, selected: ['y', 'x'] },
    age: { ...blank, text: '41' },
    when: { ...blank, text: '2026-02-28' },
    ok: { ...blank, confirm: false },
    mail: blank,
    ...overrides
  }
}

describe('buildAskSubmission', () => {
  it('builds the answer shapes the desktop card sends and skips blank optional questions', () => {
    const result = buildAskSubmission(SPEC, drafts())
    expect(result).toEqual({
      ok: true,
      answers: {
        pick: { value: 'b', label: 'Beta', note: 'because', source: 'option' },
        many: { values: ['x', 'y'], labels: ['X', 'Y'], other: undefined, source: 'options' },
        age: { value: 41, source: 'input' },
        when: { value: '2026-02-28', source: 'input' },
        ok: { value: false, source: 'input' }
      },
      skipped: ['mail']
    })
  })

  it('answers a select with the free-text value when no option is picked', () => {
    const result = buildAskSubmission(
      SPEC,
      drafts({ pick: { selected: [], freeText: 'Gamma', text: '', confirm: null } })
    )
    expect(result.ok && result.answers.pick).toEqual({ value: 'Gamma', source: 'other' })
  })

  it('blocks on a missing required answer and on out-of-domain values, per field', () => {
    const blank = { selected: [], freeText: '', text: '', confirm: null }
    const result = buildAskSubmission(
      SPEC,
      drafts({
        pick: blank,
        age: { ...blank, text: '0' },
        when: { ...blank, text: '2026-02-30' },
        mail: { ...blank, text: 'not-an-email' }
      })
    )
    expect(result).toEqual({
      ok: false,
      formError: null,
      errors: {
        pick: 'This question is required.',
        age: 'Enter a number of at least 1.',
        when: 'Enter a valid date as YYYY-MM-DD.',
        mail: 'Enter a valid email address.'
      }
    })
  })
})

describe('ask drafts', () => {
  it('seeds drafts from the host partial only, never from spec defaults', () => {
    const spec: AskSpec = {
      questions: [
        { id: 'n', type: 'number', question: 'N?', default: 3 },
        { id: 'c', type: 'confirm', question: 'C?', default: true }
      ]
    }
    const seeded = initialAskDrafts(spec, { c: { confirm: false } })
    expect(seeded.n?.text).toBe('')
    expect(seeded.c?.confirm).toBe(false)
  })

  it('normalizes drafts to the stored partial shape and omits untouched questions', () => {
    expect(askDraftsToPartial(drafts())).toEqual({
      pick: { selected: ['b'], note: 'because' },
      many: { selected: ['y', 'x'] },
      age: { draft: '41' },
      when: { draft: '2026-02-28' },
      ok: { confirm: false }
    })
  })
})
