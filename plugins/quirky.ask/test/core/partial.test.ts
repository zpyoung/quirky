import { describe, expect, test } from 'bun:test'
import type { AskSpec } from '@quirky/protocol'
import { validatePartial } from '../../src/core/partial'

const deploy: AskSpec = {
  questions: [
    {
      id: 'env',
      type: 'select',
      question: 'Which environment?',
      options: [
        { value: 'prod', label: 'Prod' },
        { value: 'dev', label: 'Dev' }
      ]
    },
    { id: 'replicas', type: 'number', question: 'How many replicas?' },
    { id: 'go', type: 'confirm', question: 'Go ahead?' }
  ]
}

function refused(raw: unknown): string {
  const result = validatePartial(deploy, raw)
  expect(result.ok).toBe(false)
  return result.ok ? '' : result.message
}

describe('validatePartial', () => {
  test('SC-12: keeps drafts for known questions and drops the rest', () => {
    const result = validatePartial(deploy, {
      env: { selected: ['prod'], note: 'eu only' },
      replicas: { draft: '3' },
      color: { draft: 'x' }
    })
    expect(result).toEqual({
      ok: true,
      partial: { env: { selected: ['prod'], note: 'eu only' }, replicas: { draft: '3' } }
    })
  })

  test('SC-12: accepts every draft key with its type', () => {
    const draft = { selected: ['a'], other: 'o', note: 'n', draft: 'd', confirm: false }
    expect(validatePartial(deploy, { go: draft })).toEqual({ ok: true, partial: { go: draft } })
  })

  test('SC-12: an empty partial is accepted', () => {
    expect(validatePartial(deploy, {})).toEqual({ ok: true, partial: {} })
  })

  test('SC-12: a selected that is not a list of strings is refused', () => {
    expect(refused({ env: { selected: 'prod' } })).toContain('partial.env.selected')
    expect(refused({ env: { selected: ['prod', 3] } })).toContain('partial.env.selected')
  })

  test('SC-12: other, note and draft must be strings and confirm a boolean', () => {
    expect(refused({ env: { other: 1 } })).toContain('partial.env.other')
    expect(refused({ env: { note: null } })).toContain('partial.env.note')
    expect(refused({ replicas: { draft: 3 } })).toContain('partial.replicas.draft')
    expect(refused({ go: { confirm: 'yes' } })).toContain('partial.go.confirm')
  })

  test('SC-12: a key outside the five is refused', () => {
    expect(refused({ env: { selected: ['prod'], extra: 1 } })).toContain('partial.env.extra')
  })

  test('SC-12: a draft entry that is not an object is refused', () => {
    expect(refused({ env: 'prod' })).toContain('partial.env')
    expect(refused({ env: ['prod'] })).toContain('partial.env')
  })

  test('SC-12: a partial that is not an object is refused', () => {
    for (const raw of [null, undefined, 'x', 3, ['env']]) expect(refused(raw)).toContain('partial')
  })

  test('SC-12: strings over 10000 characters are refused, 10000 are not', () => {
    const long = 'a'.repeat(10001)
    expect(refused({ replicas: { draft: long } })).toContain('partial.replicas.draft')
    expect(refused({ env: { note: long } })).toContain('partial.env.note')
    expect(refused({ env: { other: long } })).toContain('partial.env.other')
    expect(refused({ env: { selected: [long] } })).toContain('partial.env.selected')
    expect(validatePartial(deploy, { replicas: { draft: 'a'.repeat(10000) } }).ok).toBe(true)
  })

  test('SC-12: an unknown question is dropped even when its entry is malformed', () => {
    expect(validatePartial(deploy, { color: 'not even an object' })).toEqual({ ok: true, partial: {} })
  })
})
