import { describe, expect, it } from 'vitest'
import {
  buildResultSummary,
  nonBlank,
  parseConfirmAnswerValue,
  parseDateAnswerValue,
  parseNumberAnswerValue,
  parseTextAnswerValue
} from './ask-answer-value-parsing'
import type { AskAnswers } from './ask-answer-envelope'
import type { AskNumberQuestion, AskSpec, AskTextQuestion } from './ask-question-schema'

describe('nonBlank', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['x', 'x'],
    ['  x  ', '  x  ']
  ])('nonBlank(%j) -> %j', (input, expected) => {
    expect(nonBlank(input)).toBe(expected)
  })
})

describe('parseTextAnswerValue', () => {
  const base: AskTextQuestion = { id: 'q', type: 'text', question: 'Q?' }

  it('accepts any text when no pattern or format is set', () => {
    expect(parseTextAnswerValue(base, 'anything')).toBe('anything')
  })

  it('rejects text that fails the pattern', () => {
    const question: AskTextQuestion = { ...base, pattern: '^[a-z]+$' }
    expect(parseTextAnswerValue(question, 'ABC')).toBeNull()
    expect(parseTextAnswerValue(question, 'abc')).toBe('abc')
  })

  it('rejects text that fails the format', () => {
    const question: AskTextQuestion = { ...base, format: 'email' }
    expect(parseTextAnswerValue(question, 'not-an-email')).toBeNull()
    expect(parseTextAnswerValue(question, 'a@b.com')).toBe('a@b.com')
  })

  it('rejects an answer longer than the pattern test-input bound instead of running the regex on it', () => {
    const question: AskTextQuestion = { ...base, pattern: '^[a-z]+$' }
    expect(parseTextAnswerValue(question, 'a'.repeat(201))).toBeNull()
    expect(parseTextAnswerValue(question, 'a'.repeat(200))).toBe('a'.repeat(200))
  })
})

describe('parseNumberAnswerValue', () => {
  const base: AskNumberQuestion = { id: 'q', type: 'number', question: 'Q?' }

  it('rejects non-numeric text', () => {
    expect(parseNumberAnswerValue(base, 'abc')).toBeNull()
  })

  it('enforces integer', () => {
    const question: AskNumberQuestion = { ...base, integer: true }
    expect(parseNumberAnswerValue(question, '1.5')).toBeNull()
    expect(parseNumberAnswerValue(question, '2')).toBe(2)
  })

  it('enforces min/max', () => {
    const question: AskNumberQuestion = { ...base, min: 1, max: 10 }
    expect(parseNumberAnswerValue(question, '0')).toBeNull()
    expect(parseNumberAnswerValue(question, '11')).toBeNull()
    expect(parseNumberAnswerValue(question, '5')).toBe(5)
  })
})

describe('parseDateAnswerValue', () => {
  it('accepts a real calendar date', () => {
    expect(parseDateAnswerValue('2026-08-23')).toBe('2026-08-23')
  })

  it('rejects a malformed or non-existent date', () => {
    expect(parseDateAnswerValue('2026/08/23')).toBeNull()
    expect(parseDateAnswerValue('2026-02-30')).toBeNull()
  })
})

describe('parseConfirmAnswerValue', () => {
  it.each([
    ['yes', true],
    ['YES', true],
    ['true', true],
    ['no', false],
    ['false', false]
  ])('parses %j -> %j', (input, expected) => {
    expect(parseConfirmAnswerValue(input)).toBe(expected)
  })

  it('rejects anything else', () => {
    expect(parseConfirmAnswerValue('maybe')).toBeNull()
  })
})

describe('buildResultSummary', () => {
  const spec: AskSpec = {
    questions: [
      {
        id: 'db',
        type: 'select',
        question: 'Which database?',
        header: 'Database',
        options: [{ value: 'pg', label: 'Postgres' }]
      },
      { id: 'pool', type: 'number', question: 'Pool size?' },
      {
        id: 'tags',
        type: 'multiselect',
        question: 'Tags?',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ]
      },
      { id: 'ready', type: 'confirm', question: 'Ready?' }
    ]
  }

  it('renders one line per answered question, in spec order, skipping unanswered ids', () => {
    const answers: AskAnswers = {
      db: { value: 'pg', label: 'Postgres', source: 'option' },
      pool: { value: 20, source: 'input' },
      ready: { value: true, source: 'input' }
    }
    expect(buildResultSummary(spec, answers)).toBe(
      'Database: Postgres\nPool size?: 20\nReady?: Yes'
    )
  })

  it('renders a select "other" answer by its free-text value, and a multiselect with an other remainder', () => {
    const answers: AskAnswers = {
      db: { value: 'sqlite', source: 'other' },
      tags: { values: ['a'], labels: ['A'], other: 'c', source: 'options' }
    }
    expect(buildResultSummary(spec, answers)).toBe('Database: sqlite\nTags?: A, c')
  })
})
