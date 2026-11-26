import { describe, expect, it } from 'vitest'
import { flattenAskSpecToQuestion, mapCoordinatorReply } from './ask-handoff-flatten'
import type { AskQuestion, AskSpec } from '../../shared/fork-ask-question-tool/ask-question-schema'

function specOf(...questions: AskQuestion[]): AskSpec {
  return { questions }
}

describe('flattenAskSpecToQuestion', () => {
  it('renders numbered blocks with one option line each, closed by the reply instruction', () => {
    const spec = specOf(
      {
        id: 'db',
        type: 'select',
        question: 'Which database?',
        options: [
          { value: 'pg', label: 'Postgres' },
          { value: 'mysql', label: 'MySQL' }
        ]
      },
      { id: 'pool', type: 'number', question: 'Pool size?' }
    )
    expect(flattenAskSpecToQuestion(spec)).toBe(
      [
        '1. [db] Which database?',
        '- pg — Postgres',
        '- mysql — MySQL',
        '',
        '2. [pool] Pool size?',
        '',
        'answer with one line per question: <id>: <answer>'
      ].join('\n')
    )
  })

  it('omits option lines for a question type with no options', () => {
    const spec = specOf({ id: 'name', type: 'text', question: 'Name?' })
    expect(flattenAskSpecToQuestion(spec)).toBe(
      '1. [name] Name?\n\nanswer with one line per question: <id>: <answer>'
    )
  })
})

describe('flattenAskSpecToQuestion answer hints', () => {
  it('includes option descriptions and a per-type format hint', () => {
    const spec = specOf(
      {
        id: 'tags',
        type: 'multiselect',
        question: 'Tags?',
        required: true,
        options: [{ value: 'a', label: 'A', description: 'the first' }]
      },
      { id: 'go', type: 'confirm', question: 'Go?' },
      { id: 'due', type: 'date', question: 'Due?' },
      { id: 'n', type: 'number', question: 'How many?', integer: true, min: 1, max: 9 }
    )
    const flattened = flattenAskSpecToQuestion(spec)
    expect(flattened).toContain('1. [tags] Tags? (required; comma-separated values)')
    expect(flattened).toContain('- a — A: the first')
    expect(flattened).toContain('2. [go] Go? (yes/no)')
    expect(flattened).toContain('3. [due] Due? (YYYY-MM-DD)')
    expect(flattened).toContain('4. [n] How many? (integer; min 1; max 9)')
  })
})

describe('mapCoordinatorReply', () => {
  const dbQuestion: AskQuestion = {
    id: 'db',
    type: 'select',
    question: 'Which database?',
    options: [
      { value: 'pg', label: 'Postgres' },
      { value: 'mysql', label: 'MySQL' }
    ]
  }

  it('matches a line by exact question id', () => {
    const spec = specOf(dbQuestion)
    const result = mapCoordinatorReply(spec, 'db: pg')
    expect(result.answers.db).toEqual({ value: 'pg', label: 'Postgres', source: 'option' })
    expect(result.skipped).toEqual([])
  })

  it('matches a line by exact option label', () => {
    const spec = specOf(dbQuestion)
    const result = mapCoordinatorReply(spec, 'db: MySQL')
    expect(result.answers.db).toEqual({ value: 'mysql', label: 'MySQL', source: 'option' })
  })

  it('accepts a positional line when the id is not used', () => {
    const spec = specOf(dbQuestion, { id: 'pool', type: 'number', question: 'Pool size?' })
    const result = mapCoordinatorReply(spec, '1: pg\n2: 20')
    expect(result.answers.db).toEqual({ value: 'pg', label: 'Postgres', source: 'option' })
    expect(result.answers.pool).toEqual({ value: 20, source: 'input' })
  })

  it('treats select text with no option match as free text, source "other"', () => {
    const spec = specOf(dbQuestion)
    const result = mapCoordinatorReply(spec, 'db: sqlite')
    expect(result.answers.db).toEqual({ value: 'sqlite', source: 'other' })
  })

  it('matches comma-separated multiselect tokens and carries an unmatched remainder as other', () => {
    const spec = specOf({
      id: 'tags',
      type: 'multiselect',
      question: 'Tags?',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    })
    const result = mapCoordinatorReply(spec, 'tags: B, a, extra')
    expect(result.answers.tags).toEqual({
      values: ['a', 'b'],
      labels: ['A', 'B'],
      other: 'extra',
      source: 'options'
    })
  })

  it('skips a question with no matching line', () => {
    const spec = specOf(dbQuestion, { id: 'pool', type: 'number', question: 'Pool size?' })
    const result = mapCoordinatorReply(spec, 'db: pg')
    expect(result.skipped).toEqual(['pool'])
  })

  it('skips a typed scalar on an unparseable value rather than assigning "other"', () => {
    const spec = specOf({ id: 'pool', type: 'number', question: 'Pool size?' })
    const result = mapCoordinatorReply(spec, 'pool: not-a-number')
    expect(result.answers).toEqual({})
    expect(result.skipped).toEqual(['pool'])
  })

  it('parses date and confirm lines per type', () => {
    const spec = specOf(
      { id: 'due', type: 'date', question: 'Due date?' },
      { id: 'ready', type: 'confirm', question: 'Ready?' }
    )
    const result = mapCoordinatorReply(spec, 'due: 2026-08-23\nready: yes')
    expect(result.answers.due).toEqual({ value: '2026-08-23', source: 'input' })
    expect(result.answers.ready).toEqual({ value: true, source: 'input' })
  })

  it('treats a matched but blank line as absent rather than an empty "other" answer', () => {
    const spec = specOf(dbQuestion)
    const result = mapCoordinatorReply(spec, 'db:   ')
    expect(result.answers).toEqual({})
    expect(result.skipped).toEqual(['db'])
  })

  describe('no parseable line at all', () => {
    it('applies the whole reply to the first question and skips the rest', () => {
      const spec = specOf(dbQuestion, { id: 'pool', type: 'number', question: 'Pool size?' })
      const result = mapCoordinatorReply(spec, 'just use postgres please')
      expect(result.answers.db).toEqual({ value: 'just use postgres please', source: 'other' })
      expect(result.skipped).toEqual(['pool'])
    })

    it('applies the fallback to a multiselect as an other-only answer', () => {
      const spec = specOf({
        id: 'tags',
        type: 'multiselect',
        question: 'Tags?',
        options: [{ value: 'a', label: 'A' }]
      })
      const result = mapCoordinatorReply(spec, 'no thanks')
      expect(result.answers.tags).toEqual({
        values: [],
        labels: [],
        other: 'no thanks',
        source: 'options'
      })
    })

    it('applies the fallback to text verbatim', () => {
      const spec = specOf({ id: 'name', type: 'text', question: 'Name?' })
      const result = mapCoordinatorReply(spec, 'call it quirky')
      expect(result.answers.name).toEqual({ value: 'call it quirky', source: 'input' })
    })

    it('skips a typed-scalar first question when the whole reply fails to parse', () => {
      const spec = specOf(
        { id: 'pool', type: 'number', question: 'Pool size?' },
        { id: 'ready', type: 'confirm', question: 'Ready?' }
      )
      const result = mapCoordinatorReply(spec, 'sure, whenever works')
      expect(result.answers).toEqual({})
      expect(result.skipped).toEqual(['pool', 'ready'])
    })

    it('parses a typed-scalar first question when the whole reply does parse', () => {
      const spec = specOf({ id: 'ready', type: 'confirm', question: 'Ready?' })
      const result = mapCoordinatorReply(spec, 'yes')
      expect(result.answers.ready).toEqual({ value: true, source: 'input' })
    })
  })

  it('appends continuation lines without an id prefix to the previous answer', () => {
    const spec = specOf(
      { id: 'why', type: 'text', question: 'Why?' },
      { id: 'db', type: 'select', question: 'DB?', options: [{ value: 'pg', label: 'Postgres' }] }
    )
    const result = mapCoordinatorReply(spec, 'why: first line\nsecond line\ndb: pg')
    expect(result.answers.why).toEqual({ value: 'first line\nsecond line', source: 'input' })
    expect(result.answers.db).toMatchObject({ value: 'pg' })
  })
})
