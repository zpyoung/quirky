import { describe, expect, it } from 'vitest'
import type { AskQuestion } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import { buildAskSubmission } from './build-ask-submission'
import type { AskQuestionDraft } from './ask-question-draft'

function draft(overrides: Partial<AskQuestionDraft>): AskQuestionDraft {
  return { selected: [], freeText: '', text: '', confirm: null, ...overrides }
}

function errorFor(question: AskQuestion, overrides: Partial<AskQuestionDraft>): string | undefined {
  const result = buildAskSubmission([question], { [question.id]: draft(overrides) })
  return result.ok ? undefined : result.errors[question.id]
}

describe('buildAskSubmission agrees with the server parsers', () => {
  const url: AskQuestion = { id: 'u', type: 'text', question: 'Link?', format: 'url' }

  it('rejects a URL without a scheme separator that `new URL` would accept', () => {
    expect(errorFor(url, { text: 'mailto:someone' })).toBe('Enter a valid URL.')
    expect(errorFor(url, { text: 'https://example.com' })).toBeUndefined()
  })

  it('rejects a pattern answer past the server length cap as a format miss', () => {
    const pattern: AskQuestion = { id: 'p', type: 'text', question: 'Code?', pattern: '^a+$' }
    expect(errorFor(pattern, { text: 'a'.repeat(201) })).toBe("Doesn't match the expected format.")
  })

  it('reports in-progress number text as invalid rather than required', () => {
    const number: AskQuestion = { id: 'n', type: 'number', question: 'Size?', required: true }
    expect(errorFor(number, { text: '', numberBadInput: true })).toBe('Enter a number.')
    expect(errorFor(number, { text: '' })).toBe('This question is required.')
  })

  it('names the violated number bound', () => {
    const number: AskQuestion = {
      id: 'n',
      type: 'number',
      question: 'Size?',
      integer: true,
      min: 1,
      max: 5
    }
    expect(errorFor(number, { text: '2.5' })).toBe('Enter a whole number.')
    expect(errorFor(number, { text: '0' })).toBe('Enter a number of at least 1.')
    expect(errorFor(number, { text: '9' })).toBe('Enter a number of at most 5.')
  })

  it('rejects a calendar-invalid date', () => {
    const date: AskQuestion = { id: 'd', type: 'date', question: 'When?' }
    expect(errorFor(date, { text: '2026-02-30' })).toBe('Enter a valid date.')
  })
})
