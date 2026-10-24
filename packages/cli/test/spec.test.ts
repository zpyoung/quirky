import { describe, expect, test } from 'bun:test'
import { UsageError } from '../src/args'
import { parseAskSpec, validateAskSpec } from '../src/commands/spec'

const good = {
  title: 'Deploy?',
  questions: [
    { id: 'env', type: 'select', question: 'Where?', options: [{ value: 'prod', label: 'Prod' }] },
    { id: 'tags', type: 'multiselect', question: 'Tags?', options: [{ value: 'a', label: 'A' }] },
    { id: 'why', type: 'text', question: 'Why?', multiline: true },
    { id: 'ok', type: 'confirm', question: 'Sure?' }
  ]
}

function message(value: unknown): string {
  try {
    validateAskSpec(value)
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError)
    return (error as Error).message
  }
  throw new Error('expected validation to fail')
}

describe('validateAskSpec', () => {
  test('accepts a well-formed spec', () => {
    expect(validateAskSpec(good)).toEqual(good as never)
  })

  test('requires an object with a questions array', () => {
    expect(message(null)).toMatch(/spec must be an object/)
    expect(message({})).toMatch(/questions/)
    expect(message({ questions: [] })).toMatch(/questions must contain at least one/)
  })

  test('names a missing or empty id', () => {
    expect(message({ questions: [{ type: 'text', question: 'x' }] })).toMatch(/questions\[0\]\.id/)
    expect(message({ questions: [{ id: '', type: 'text', question: 'x' }] })).toMatch(/questions\[0\]\.id/)
  })

  test('rejects duplicate ids', () => {
    const dup = { questions: [{ id: 'a', type: 'text', question: 'x' }, { id: 'a', type: 'confirm', question: 'y' }] }
    expect(message(dup)).toMatch(/questions\[1\]\.id.*duplicate/)
  })

  test('rejects unknown types', () => {
    expect(message({ questions: [{ id: 'a', type: 'date', question: 'x' }] })).toMatch(/questions\[0\]\.type/)
  })

  test('requires question text', () => {
    expect(message({ questions: [{ id: 'a', type: 'text' }] })).toMatch(/questions\[0\]\.question/)
  })

  test('select questions need well-formed options', () => {
    expect(message({ questions: [{ id: 'a', type: 'select', question: 'x' }] })).toMatch(/questions\[0\]\.options/)
    expect(
      message({ questions: [{ id: 'a', type: 'select', question: 'x', options: [{ value: 'v' }] }] })
    ).toMatch(/questions\[0\]\.options\[0\]\.label/)
  })
})

describe('parseAskSpec', () => {
  test('parses inline JSON', () => {
    expect(parseAskSpec(JSON.stringify(good), () => '')).toEqual(good as never)
  })

  test('reads @path through the injected reader', () => {
    let seen = ''
    const spec = parseAskSpec('@spec.json', (path) => ((seen = path), JSON.stringify(good)))
    expect(seen).toBe('spec.json')
    expect(spec.questions).toHaveLength(4)
  })

  test('reports invalid JSON as a usage error', () => {
    expect(() => parseAskSpec('{nope', () => '')).toThrow(/--spec is not valid JSON/)
  })

  test('reports an unreadable file as a usage error', () => {
    const reader = () => {
      throw new Error('ENOENT')
    }
    expect(() => parseAskSpec('@missing.json', reader)).toThrow(UsageError)
  })
})
