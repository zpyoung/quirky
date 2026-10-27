import { describe, expect, test } from 'bun:test'
import type { AskQuestion, AskSpec } from '@quirky/protocol'
import { buildSubmission, draftsToPartial, initialDraftFor, type QuestionDraft } from '../../src/core/submission'

const draft = (patch: Partial<QuestionDraft> = {}): QuestionDraft => ({ ...initialDraftFor(), ...patch })

const spec = (...questions: AskQuestion[]): AskSpec => ({ questions })

const framework: AskQuestion = {
  id: 'framework',
  type: 'select',
  question: 'Framework?',
  options: [
    { value: 'react', label: 'React' },
    { value: 'vue', label: 'Vue' }
  ]
}
const features: AskQuestion = {
  id: 'features',
  type: 'multiselect',
  question: 'Features?',
  options: [
    { value: 'auth', label: 'Auth' },
    { value: 'search', label: 'Search' },
    { value: 'billing', label: 'Billing' }
  ]
}

describe('initialDraftFor and draftsToPartial', () => {
  test('SC-13: a saved partial round-trips through the window draft', () => {
    const partial = {
      framework: { selected: ['vue'], note: 'small bundle size' },
      features: { selected: ['auth', 'search'], note: 'Exports' },
      other: { other: 'Svelte' },
      replicas: { draft: '3' },
      go: { confirm: false }
    }
    const drafts = Object.fromEntries(Object.entries(partial).map(([id, p]) => [id, initialDraftFor(p)]))
    expect(drafts.framework).toEqual({ selected: ['vue'], freeText: 'small bundle size', text: '', confirm: null })
    expect(drafts.other).toEqual({ selected: [], freeText: 'Svelte', text: '', confirm: null })
    expect(drafts.replicas).toEqual({ selected: [], freeText: '', text: '3', confirm: null })
    expect(drafts.go).toEqual({ selected: [], freeText: '', text: '', confirm: false })
    expect(draftsToPartial(drafts)).toEqual(partial)
  })

  test('SC-13: an untouched draft saves nothing', () => {
    expect(initialDraftFor()).toEqual({ selected: [], freeText: '', text: '', confirm: null })
    expect(draftsToPartial({ a: initialDraftFor(), b: initialDraftFor({}) })).toEqual({})
  })

  test('SC-8: a multiselect with picks and free text round-trips through the partial as selected and other', () => {
    const s = spec(framework, features)
    const drafts = {
      framework: draft({ selected: ['vue'], freeText: 'small bundle size' }),
      features: draft({ selected: ['auth', 'search'], freeText: 'Exports' })
    }
    const partial = draftsToPartial(drafts, s)
    expect(partial).toEqual({
      framework: { selected: ['vue'], note: 'small bundle size' },
      features: { selected: ['auth', 'search'], other: 'Exports' }
    })
    expect(initialDraftFor(partial.features)).toEqual(drafts.features)
    expect(initialDraftFor(partial.framework)).toEqual(drafts.framework)
  })

  test('free text is a note beside a pick and other without one', () => {
    expect(draftsToPartial({ q: draft({ selected: ['a'], freeText: 'why' }) })).toEqual({ q: { selected: ['a'], note: 'why' } })
    expect(draftsToPartial({ q: draft({ freeText: 'mine' }) })).toEqual({ q: { other: 'mine' } })
  })
})

describe('buildSubmission', () => {
  test('SC-6: a select pick with free text is an option answer with a note', () => {
    const result = buildSubmission(spec(framework), { framework: draft({ selected: ['vue'], freeText: ' small bundle size ' }) })
    expect(result).toEqual({
      ok: true,
      answers: { framework: { value: 'vue', label: 'Vue', note: 'small bundle size', source: 'option' } },
      skipped: []
    })
  })

  test('SC-6: a select pick without free text has no note key', () => {
    const result = buildSubmission(spec(framework), { framework: draft({ selected: ['react'] }) })
    expect(result).toEqual({ ok: true, answers: { framework: { value: 'react', label: 'React', source: 'option' } }, skipped: [] })
    if (result.ok) expect('note' in result.answers.framework!).toBe(false)
  })

  test('SC-6: nothing picked and free text typed is the other answer', () => {
    const result = buildSubmission(spec(framework), { framework: draft({ freeText: 'Svelte' }) })
    expect(result).toEqual({ ok: true, answers: { framework: { value: 'Svelte', source: 'other' } }, skipped: [] })
  })

  test('SC-6: a multiselect lists picks in spec order with free text as other', () => {
    const result = buildSubmission(spec(features), { features: draft({ selected: ['search', 'auth'], freeText: 'Exports' }) })
    expect(result).toEqual({
      ok: true,
      answers: { features: { values: ['auth', 'search'], labels: ['Auth', 'Search'], other: 'Exports', source: 'options' } },
      skipped: []
    })
  })

  test('SC-6: a multiselect with only free text has empty picks', () => {
    const result = buildSubmission(spec(features), { features: draft({ freeText: 'Exports' }) })
    expect(result).toEqual({
      ok: true,
      answers: { features: { values: [], labels: [], other: 'Exports', source: 'options' } },
      skipped: []
    })
  })

  test('a pick of a value the spec does not list counts as nothing picked', () => {
    expect(buildSubmission(spec(framework), { framework: draft({ selected: ['angular'] }) })).toEqual({ ok: true, answers: {}, skipped: ['framework'] })
  })

  test('optional blanks are skipped in spec order and required blanks are not', () => {
    const s = spec(
      { id: 'a', type: 'text', question: 'A' },
      { id: 'b', type: 'number', question: 'B' },
      { id: 'c', type: 'date', question: 'C' },
      { id: 'd', type: 'confirm', question: 'D' },
      framework
    )
    expect(buildSubmission(s, {})).toEqual({ ok: true, answers: {}, skipped: ['a', 'b', 'c', 'd', 'framework'] })
  })

  test('text, number, date and confirm answers are input answers', () => {
    const s = spec(
      { id: 'name', type: 'text', question: 'Name' },
      { id: 'replicas', type: 'number', question: 'Replicas', integer: true },
      { id: 'when', type: 'date', question: 'When' },
      { id: 'go', type: 'confirm', question: 'Go' }
    )
    const result = buildSubmission(s, {
      name: draft({ text: 'ada' }),
      replicas: draft({ text: ' 3 ' }),
      when: draft({ text: '2026-02-28' }),
      go: draft({ confirm: false })
    })
    expect(result).toEqual({
      ok: true,
      answers: {
        name: { value: 'ada', source: 'input' },
        replicas: { value: 3, source: 'input' },
        when: { value: '2026-02-28', source: 'input' },
        go: { value: false, source: 'input' }
      },
      skipped: []
    })
  })

  test('a question without a draft is treated as blank', () => {
    const s = spec({ id: 'a', type: 'text', question: 'A', required: true })
    expect(buildSubmission(s, {})).toEqual({ ok: false, errors: { a: 'This question is required.' } })
  })
})

describe('buildSubmission messages', () => {
  const required = (q: AskQuestion) => ({ ...q, required: true }) as AskQuestion

  const message = (q: AskQuestion, d: Partial<QuestionDraft>): string | undefined => {
    const result = buildSubmission(spec(q), { [q.id]: draft(d) })
    return result.ok ? undefined : result.errors[q.id]
  }

  test('SC-22: required blanks, for every type', () => {
    const required_ = 'This question is required.'
    expect(message(required(framework), {})).toBe(required_)
    expect(message(required(features), {})).toBe(required_)
    expect(message(required({ id: 'q', type: 'text', question: 'Q' }), { text: '   ' })).toBe(required_)
    expect(message(required({ id: 'q', type: 'number', question: 'Q' }), {})).toBe(required_)
    expect(message(required({ id: 'q', type: 'date', question: 'Q' }), {})).toBe(required_)
    expect(message(required({ id: 'q', type: 'confirm', question: 'Q' }), {})).toBe(required_)
    expect(message(required(framework), { freeText: '   ' })).toBe(required_)
  })

  test('SC-22: email, url and pattern', () => {
    const email: AskQuestion = { id: 'q', type: 'text', question: 'Q', format: 'email' }
    expect(message(email, { text: 'not-an-email' })).toBe('Enter a valid email address.')
    expect(message(email, { text: 'a@b.co' })).toBeUndefined()
    const url: AskQuestion = { id: 'q', type: 'text', question: 'Q', format: 'url' }
    expect(message(url, { text: 'example' })).toBe('Enter a valid URL.')
    expect(message(url, { text: 'https://example.com/x' })).toBeUndefined()
    const pattern: AskQuestion = { id: 'q', type: 'text', question: 'Q', pattern: '^[a-z]+$' }
    expect(message(pattern, { text: 'ABC' })).toBe("Doesn't match the expected format.")
    expect(message(pattern, { text: 'abc' })).toBeUndefined()
  })

  test('text over 200 characters is refused when a pattern applies, as the daemon does', () => {
    const pattern: AskQuestion = { id: 'q', type: 'text', question: 'Q', pattern: '^a+$' }
    expect(message(pattern, { text: 'a'.repeat(200) })).toBeUndefined()
    expect(message(pattern, { text: 'a'.repeat(201) })).toBe("Doesn't match the expected format.")
    expect(message({ id: 'q', type: 'text', question: 'Q' }, { text: 'a'.repeat(201) })).toBeUndefined()
  })

  test('an unparseable pattern never blocks a submit', () => {
    expect(message({ id: 'q', type: 'text', question: 'Q', pattern: '(' }, { text: 'abc' })).toBeUndefined()
  })

  test('SC-22: number messages', () => {
    const replicas: AskQuestion = { id: 'q', type: 'number', question: 'Q', integer: true, min: 1, max: 10 }
    expect(message(replicas, { text: 'abc' })).toBe('Enter a number.')
    expect(message(replicas, { text: 'Infinity' })).toBe('Enter a number.')
    expect(message(replicas, { text: '2.5' })).toBe('Enter a whole number.')
    expect(message(replicas, { text: '0' })).toBe('Enter a number of at least 1.')
    expect(message(replicas, { text: '12' })).toBe('Enter a number of at most 10.')
    expect(message(replicas, { text: '10' })).toBeUndefined()
    expect(message(replicas, { text: '1' })).toBeUndefined()
  })

  test('SC-22: date message', () => {
    const when: AskQuestion = { id: 'q', type: 'date', question: 'Q' }
    expect(message(when, { text: 'tomorrow' })).toBe('Enter a valid date.')
    expect(message(when, { text: '2026-02-30' })).toBe('Enter a valid date.')
    expect(message(when, { text: '2026-02-28' })).toBeUndefined()
  })

  test('SC-22: any error blocks the whole submission and every failing question is reported', () => {
    const s = spec(
      required({ id: 'env', type: 'select', question: 'Env', options: [{ value: 'prod', label: 'Prod' }] }),
      { id: 'replicas', type: 'number', question: 'Replicas', max: 10 },
      { id: 'email', type: 'text', question: 'Email', format: 'email' },
      { id: 'fine', type: 'text', question: 'Fine' }
    )
    const result = buildSubmission(s, {
      replicas: draft({ text: '12' }),
      email: draft({ text: 'not-an-email' }),
      fine: draft({ text: 'ok' })
    })
    expect(result).toEqual({
      ok: false,
      errors: {
        env: 'This question is required.',
        replicas: 'Enter a number of at most 10.',
        email: 'Enter a valid email address.'
      }
    })
  })
})
