import { describe, expect, it } from 'vitest'
import { buildTimeoutResult } from './ask-registry-timeout-answers'
import type {
  AskPartial,
  AskQuestion,
  AskSpec
} from '../../shared/fork-ask-question-tool/ask-question-schema'

function specOf(...questions: AskQuestion[]): AskSpec {
  return { questions }
}

describe('buildTimeoutResult', () => {
  it('applies a declared default even when the partial holds a different value', () => {
    const spec = specOf({
      id: 'db',
      type: 'select',
      question: 'Which database?',
      default: 'pg',
      options: [
        { value: 'pg', label: 'Postgres' },
        { value: 'mysql', label: 'MySQL' }
      ]
    })
    const partial: AskPartial = { db: { selected: ['mysql'] } }
    const result = buildTimeoutResult(spec, partial)
    expect(result.answers.db).toEqual({ value: 'pg', label: 'Postgres', source: 'default' })
    expect(result.skipped).toEqual([])
  })

  it('falls through to the partial when there is no default', () => {
    const spec = specOf({
      id: 'db',
      type: 'select',
      question: 'Which database?',
      options: [{ value: 'pg', label: 'Postgres' }]
    })
    const partial: AskPartial = { db: { selected: ['pg'], note: 'preferred' } }
    const result = buildTimeoutResult(spec, partial)
    expect(result.answers.db).toEqual({
      value: 'pg',
      label: 'Postgres',
      note: 'preferred',
      source: 'option'
    })
  })

  it('skips a question with no default and no partial entry', () => {
    const spec = specOf({
      id: 'db',
      type: 'select',
      question: 'Which database?',
      options: [{ value: 'pg', label: 'Postgres' }]
    })
    const result = buildTimeoutResult(spec, {})
    expect(result.answers).toEqual({})
    expect(result.skipped).toEqual(['db'])
  })

  it('resolves a select free-text draft to source "other"', () => {
    const spec = specOf({
      id: 'db',
      type: 'select',
      question: 'Which database?',
      options: [{ value: 'pg', label: 'Postgres' }]
    })
    const result = buildTimeoutResult(spec, { db: { other: 'sqlite' } })
    expect(result.answers.db).toEqual({ value: 'sqlite', note: undefined, source: 'other' })
  })

  it('treats a whitespace-only select draft as absent', () => {
    const spec = specOf({
      id: 'db',
      type: 'select',
      question: 'Which database?',
      options: [{ value: 'pg', label: 'Postgres' }]
    })
    const result = buildTimeoutResult(spec, { db: { other: '   ' } })
    expect(result.skipped).toEqual(['db'])
  })

  it('resolves a multiselect draft to matched values plus an other remainder', () => {
    const spec = specOf({
      id: 'tags',
      type: 'multiselect',
      question: 'Tags?',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    })
    const result = buildTimeoutResult(spec, {
      tags: { selected: ['b', 'unknown'], other: 'extra' }
    })
    expect(result.answers.tags).toEqual({
      values: ['b'],
      labels: ['B'],
      other: 'extra',
      source: 'options'
    })
  })

  it('skips a multiselect draft whose selections all fail to match and carries no other text', () => {
    const spec = specOf({
      id: 'tags',
      type: 'multiselect',
      question: 'Tags?',
      options: [{ value: 'a', label: 'A' }]
    })
    const result = buildTimeoutResult(spec, { tags: { selected: ['unknown'] } })
    expect(result.skipped).toEqual(['tags'])
  })

  it('normalizes a valid text draft and keeps a value that fails its pattern out of the envelope', () => {
    const spec = specOf({ id: 'name', type: 'text', question: 'Name?', pattern: '^[a-z]+$' })
    const ok = buildTimeoutResult(spec, { name: { draft: 'abc' } })
    expect(ok.answers.name).toEqual({ value: 'abc', source: 'input' })

    const badPattern = buildTimeoutResult(spec, { name: { draft: 'ABC' } })
    expect(badPattern.answers).toEqual({})
    expect(badPattern.skipped).toEqual(['name'])
  })

  it('treats a whitespace-only text draft as absent', () => {
    const spec = specOf({ id: 'name', type: 'text', question: 'Name?' })
    const result = buildTimeoutResult(spec, { name: { draft: '   ' } })
    expect(result.skipped).toEqual(['name'])
  })

  it('normalizes a valid number draft and skips one outside min/max rather than coercing it', () => {
    const spec = specOf({
      id: 'pool',
      type: 'number',
      question: 'Pool size?',
      min: 1,
      max: 10,
      integer: true
    })
    const ok = buildTimeoutResult(spec, { pool: { draft: '5' } })
    expect(ok.answers.pool).toEqual({ value: 5, source: 'input' })

    const outOfRange = buildTimeoutResult(spec, { pool: { draft: '99' } })
    expect(outOfRange.answers).toEqual({})
    expect(outOfRange.skipped).toEqual(['pool'])

    const notANumber = buildTimeoutResult(spec, { pool: { draft: 'abc' } })
    expect(notANumber.skipped).toEqual(['pool'])
  })

  it('normalizes a valid date draft and skips a malformed one', () => {
    const spec = specOf({ id: 'due', type: 'date', question: 'Due date?' })
    const ok = buildTimeoutResult(spec, { due: { draft: '2026-08-23' } })
    expect(ok.answers.due).toEqual({ value: '2026-08-23', source: 'input' })

    const malformed = buildTimeoutResult(spec, { due: { draft: '2026-02-30' } })
    expect(malformed.skipped).toEqual(['due'])
  })

  it('reads a confirm draft as already-typed boolean, and skips when absent', () => {
    const spec = specOf({ id: 'ready', type: 'confirm', question: 'Ready?' })
    expect(buildTimeoutResult(spec, { ready: { confirm: false } }).answers.ready).toEqual({
      value: false,
      source: 'input'
    })
    expect(buildTimeoutResult(spec, {}).skipped).toEqual(['ready'])
  })

  it('applies defaults for multiselect, number, date, and confirm', () => {
    const spec = specOf(
      {
        id: 'tags',
        type: 'multiselect',
        question: 'Tags?',
        default: ['a'],
        options: [{ value: 'a', label: 'A' }]
      },
      { id: 'pool', type: 'number', question: 'Pool size?', default: 5 },
      { id: 'due', type: 'date', question: 'Due date?', default: '2026-01-01' },
      { id: 'ready', type: 'confirm', question: 'Ready?', default: true }
    )
    const result = buildTimeoutResult(spec, {})
    expect(result.answers.tags).toEqual({ values: ['a'], labels: ['A'], source: 'default' })
    expect(result.answers.pool).toEqual({ value: 5, source: 'default' })
    expect(result.answers.due).toEqual({ value: '2026-01-01', source: 'default' })
    expect(result.answers.ready).toEqual({ value: true, source: 'default' })
    expect(result.skipped).toEqual([])
  })

  it('builds the summary only from answered questions, in spec order', () => {
    const spec = specOf(
      {
        id: 'db',
        type: 'select',
        question: 'Which database?',
        header: 'Database',
        default: 'pg',
        options: [{ value: 'pg', label: 'Postgres' }]
      },
      { id: 'pool', type: 'number', question: 'Pool size?' }
    )
    const result = buildTimeoutResult(spec, {})
    expect(result.summary).toBe('Database: Postgres')
    expect(result.skipped).toEqual(['pool'])
  })
})
