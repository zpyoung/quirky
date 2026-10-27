import { describe, expect, test } from 'bun:test'
import type { AskPartial, AskQuestion, AskSpec } from '@quirky/protocol'
import { buildTimeoutResult } from '../../src/core/timeout'

function specOf(...questions: AskQuestion[]): AskSpec {
  return { questions }
}

const dbOptions = [
  { value: 'pg', label: 'Postgres' },
  { value: 'mysql', label: 'MySQL' }
]

describe('buildTimeoutResult', () => {
  test('applies a declared default even when the draft holds a different value', () => {
    const spec = specOf({ id: 'db', type: 'select', question: 'Which database?', default: 'pg', options: dbOptions })
    const result = buildTimeoutResult(spec, { db: { selected: ['mysql'] } })
    expect(result.answers.db).toEqual({ value: 'pg', label: 'Postgres', source: 'default' })
    expect(result.skipped).toEqual([])
  })

  test('falls through to the draft when there is no default', () => {
    const spec = specOf({ id: 'db', type: 'select', question: 'Which database?', options: dbOptions })
    const result = buildTimeoutResult(spec, { db: { selected: ['pg'], note: 'preferred' } })
    expect(result.answers.db).toEqual({ value: 'pg', label: 'Postgres', note: 'preferred', source: 'option' })
  })

  test('skips a question with no default and no draft', () => {
    const spec = specOf({ id: 'db', type: 'select', question: 'Which database?', options: dbOptions })
    const result = buildTimeoutResult(spec, {})
    expect(result.answers).toEqual({})
    expect(result.skipped).toEqual(['db'])
  })

  test('resolves a select free-text draft to source other', () => {
    const spec = specOf({ id: 'db', type: 'select', question: 'Which database?', options: dbOptions })
    expect(buildTimeoutResult(spec, { db: { other: 'sqlite' } }).answers.db).toEqual({ value: 'sqlite', source: 'other' })
  })

  test('treats a whitespace-only select draft as absent', () => {
    const spec = specOf({ id: 'db', type: 'select', question: 'Which database?', options: dbOptions })
    expect(buildTimeoutResult(spec, { db: { other: '   ' } }).skipped).toEqual(['db'])
  })

  test('resolves a multiselect draft to matched values plus an other remainder', () => {
    const spec = specOf({ id: 'tags', type: 'multiselect', question: 'Tags?', options: dbOptions })
    const result = buildTimeoutResult(spec, { tags: { selected: ['mysql', 'unknown'], other: 'extra' } })
    expect(result.answers.tags).toEqual({ values: ['mysql'], labels: ['MySQL'], other: 'extra', source: 'options' })
  })

  test('skips a multiselect draft whose selections all fail to match and has no other text', () => {
    const spec = specOf({ id: 'tags', type: 'multiselect', question: 'Tags?', options: dbOptions })
    expect(buildTimeoutResult(spec, { tags: { selected: ['unknown'] } }).skipped).toEqual(['tags'])
  })

  test('normalizes a valid text draft and keeps a value that fails its pattern out of the envelope', () => {
    const spec = specOf({ id: 'name', type: 'text', question: 'Name?', pattern: '^[a-z]+$' })
    expect(buildTimeoutResult(spec, { name: { draft: 'abc' } }).answers.name).toEqual({ value: 'abc', source: 'input' })
    const bad = buildTimeoutResult(spec, { name: { draft: 'ABC' } })
    expect(bad.answers).toEqual({})
    expect(bad.skipped).toEqual(['name'])
  })

  test('treats a whitespace-only text draft as absent', () => {
    const spec = specOf({ id: 'name', type: 'text', question: 'Name?' })
    expect(buildTimeoutResult(spec, { name: { draft: '   ' } }).skipped).toEqual(['name'])
  })

  test('normalizes a valid number draft and skips one outside min and max rather than coercing it', () => {
    const spec = specOf({ id: 'pool', type: 'number', question: 'Pool size?', min: 1, max: 10, integer: true })
    expect(buildTimeoutResult(spec, { pool: { draft: '5' } }).answers.pool).toEqual({ value: 5, source: 'input' })
    const outOfRange = buildTimeoutResult(spec, { pool: { draft: '99' } })
    expect(outOfRange.answers).toEqual({})
    expect(outOfRange.skipped).toEqual(['pool'])
    expect(buildTimeoutResult(spec, { pool: { draft: 'abc' } }).skipped).toEqual(['pool'])
  })

  test('normalizes a valid date draft and skips a malformed one', () => {
    const spec = specOf({ id: 'due', type: 'date', question: 'Due date?' })
    expect(buildTimeoutResult(spec, { due: { draft: '2026-08-23' } }).answers.due).toEqual({ value: '2026-08-23', source: 'input' })
    expect(buildTimeoutResult(spec, { due: { draft: '2026-02-30' } }).skipped).toEqual(['due'])
  })

  test('reads a confirm draft as the boolean and skips when absent', () => {
    const spec = specOf({ id: 'ready', type: 'confirm', question: 'Ready?' })
    expect(buildTimeoutResult(spec, { ready: { confirm: false } }).answers.ready).toEqual({ value: false, source: 'input' })
    expect(buildTimeoutResult(spec, {}).skipped).toEqual(['ready'])
  })

  test('applies defaults for multiselect, number, date and confirm', () => {
    const spec = specOf(
      { id: 'tags', type: 'multiselect', question: 'Tags?', default: ['pg'], options: dbOptions },
      { id: 'pool', type: 'number', question: 'Pool size?', default: 5 },
      { id: 'due', type: 'date', question: 'Due date?', default: '2026-01-01' },
      { id: 'ready', type: 'confirm', question: 'Ready?', default: true }
    )
    const result = buildTimeoutResult(spec, {})
    expect(result.answers).toEqual({
      tags: { values: ['pg'], labels: ['Postgres'], source: 'default' },
      pool: { value: 5, source: 'default' },
      due: { value: '2026-01-01', source: 'default' },
      ready: { value: true, source: 'default' }
    })
    expect(result.skipped).toEqual([])
  })

  test('builds the summary only from answered questions, in spec order', () => {
    const spec = specOf(
      { id: 'db', type: 'select', question: 'Which database?', header: 'Database', default: 'pg', options: dbOptions },
      { id: 'pool', type: 'number', question: 'Pool size?' }
    )
    const result = buildTimeoutResult(spec, {})
    expect(result.summary).toBe('Database: Postgres')
    expect(result.skipped).toEqual(['pool'])
  })

  test('SC-8: defaults win, then the draft, then the question is skipped; unparseable abc is not coerced', () => {
    const spec = specOf(
      { id: 'color', type: 'select', question: 'Color?', default: 'blue', options: [{ value: 'blue', label: 'Blue' }, { value: 'red', label: 'Red' }] },
      { id: 'note', type: 'text', question: 'Note?' },
      { id: 'size', type: 'number', question: 'Size?' },
      { id: 'agree', type: 'confirm', question: 'Agree?', default: true }
    )
    const partial: AskPartial = {
      note: { draft: 'typed draft before the timeout' },
      size: { draft: 'abc' }
    }
    const result = buildTimeoutResult(spec, partial)
    expect(result.answers).toEqual({
      color: { value: 'blue', label: 'Blue', source: 'default' },
      note: { value: 'typed draft before the timeout', source: 'input' },
      agree: { value: true, source: 'default' }
    })
    expect(result.skipped).toEqual(['size'])
    expect(result.summary).toBe('Color?: Blue\nNote?: typed draft before the timeout\nAgree?: Yes')
  })

  test('SC-10: with no draft, defaults fill in and the rest are skipped', () => {
    const spec = specOf(
      { id: 'env', type: 'select', question: 'Env?', default: 'dev', options: [{ value: 'dev', label: 'Dev' }] },
      { id: 'replicas', type: 'number', question: 'Replicas?' },
      { id: 'ship', type: 'date', question: 'Ship?' },
      { id: 'go', type: 'confirm', question: 'Go?', default: true }
    )
    const result = buildTimeoutResult(spec, {})
    expect(Object.keys(result.answers)).toEqual(['env', 'go'])
    expect(result.skipped).toEqual(['replicas', 'ship'])
  })
})
