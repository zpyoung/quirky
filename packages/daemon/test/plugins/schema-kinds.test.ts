import { PLUGIN_API_VERSION } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { parseManifest } from '../../src/plugins/manifest'

const base = { id: 'acme', name: 'Acme', version: '1.0.0', apiVersion: PLUGIN_API_VERSION }

function result(manifest: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...base, ...manifest }), {
    dirName: 'acme',
    dir: '/plugins/acme',
    source: 'installed',
  })
}

function errorsOf(manifest: Record<string, unknown>): string[] {
  const parsed = result(manifest)
  if (parsed.ok) throw new Error('expected the manifest to be rejected')
  return parsed.errors
}

const contributes = (kind: string, entry: Record<string, unknown>) => ({ contributes: { [kind]: [entry] } })
const method = (fields: Record<string, unknown>) => contributes('method', { id: 'm', ...fields })

describe('SC-2: a malformed schema makes the plugin invalid', () => {
  const rows: [string, Record<string, unknown>, string][] = [
    ['params of the wrong type', method({ params: { type: 'string' } }), 'method m: params must be an object schema'],
    [
      'params using oneOf',
      method({ params: { type: 'object', oneOf: [] } }),
      'method m: params: unsupported keyword oneOf',
    ],
    [
      'a property of an unknown type',
      method({ params: { type: 'object', properties: { when: { type: 'date' } } } }),
      'method m: params.properties.when: unknown type date',
    ],
    [
      'required naming an undeclared property',
      method({ params: { type: 'object', required: ['x'] } }),
      'method m: params: required names undeclared property x',
    ],
    [
      'an empty enum',
      method({ params: { type: 'object', properties: { color: { type: 'string', enum: [] } } } }),
      'method m: params.properties.color: enum must be a non-empty list',
    ],
    [
      'an enum with no type',
      method({ params: { type: 'object', properties: { choice: { enum: ['1', 1] } } } }),
      'method m: params.properties.choice: enum needs type string, integer or number',
    ],
    [
      'an enum value of the wrong type',
      method({ params: { type: 'object', properties: { choice: { type: 'string', enum: ['a', 2] } } } }),
      'method m: params.properties.choice: enum values must be strings',
    ],
    [
      'two properties with one flag name',
      method({ params: { type: 'object', properties: { fooBar: { type: 'string' }, 'foo-bar': { type: 'string' } } } }),
      'method m: params fooBar and foo-bar both map to --foo-bar',
    ],
    ['event data that is not an object', contributes('event', { id: 'e', data: 'object' }), 'event e: data must be a schema object'],
    [
      'a UI command whose args is not an object schema',
      contributes('command', { id: 'c', args: { type: 'array' } }),
      'command c: args must be an object schema',
    ],
  ]

  test.each(rows)('%s', (_name, manifest, message) => {
    expect(errorsOf(manifest)).toEqual([message])
  })

  test('a malformed result schema is reported with the method label', () => {
    expect(errorsOf(method({ result: { type: 'date' } }))).toEqual(['method m: result: unknown type date'])
  })

  test('a non-object result is reported as a missing schema object', () => {
    expect(errorsOf(method({ result: 5 }))).toEqual(['method m: result must be a schema object'])
  })

  test('a malformed event data schema is reported with the event label', () => {
    expect(errorsOf(contributes('event', { id: 'e', data: { type: 'object', properties: { n: { type: 'x' } } } }))).toEqual([
      'event e: data.properties.n: unknown type x',
    ])
  })

  test('every problem in one schema is reported', () => {
    const errors = errorsOf(method({ params: { type: 'object', required: ['x'], properties: { a: { type: 'date' } } } }))
    expect(errors).toEqual([
      'method m: params.properties.a: unknown type date',
      'method m: params: required names undeclared property x',
    ])
  })
})

describe('valid schema declarations', () => {
  test('accepts params, result, event data and command args', () => {
    const parsed = result({
      contributes: {
        method: [
          {
            id: 'add',
            params: {
              type: 'object',
              required: ['title'],
              properties: {
                title: { type: 'string' },
                priority: { type: 'integer', minimum: 1, maximum: 5 },
                color: { type: 'string', enum: ['red', 'blue'] },
                tags: { type: 'array', items: { type: 'string' } },
                worktreeId: { type: 'string' },
              },
              additionalProperties: false,
            },
            result: { type: 'object', properties: { id: { type: 'integer' } } },
          },
          { id: 'bare' },
        ],
        event: [{ id: 'added', data: { type: 'object', properties: { noteId: { type: 'integer' } } } }, { id: 'plain' }],
        command: [{ id: 'open', args: { type: 'object', properties: { id: { type: 'string' } } } }],
      },
    })
    expect(parsed.ok).toBe(true)
  })

  test('accepts a result schema of any type, including the empty schema', () => {
    expect(result(method({ result: {} })).ok).toBe(true)
    expect(result(method({ result: { type: 'array', items: { type: 'string' } } })).ok).toBe(true)
  })

  test('a result schema nested far beyond the call stack makes the plugin invalid without throwing', () => {
    const levels = 20_000
    const deep = '{"type":"array","items":'.repeat(levels) + '{}' + '}'.repeat(levels)
    const text = `{"id":"acme","name":"Acme","version":"1.0.0","apiVersion":"1.0.0","contributes":{"method":[{"id":"m","result":${deep}}]}}`
    const parsed = parseManifest(text, { dirName: 'acme', dir: '/plugins/acme', source: 'installed' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.some((error) => error.startsWith('method m: result'))).toBe(true)
  })

  test('properties that differ only after the flag mapping are distinct', () => {
    const params = { type: 'object', properties: { fooBar: { type: 'string' }, foobar: { type: 'string' } } }
    expect(result(method({ params })).ok).toBe(true)
  })
})

describe('schemas on overrides', () => {
  test('an override carrying params is validated with the override label', () => {
    expect(errorsOf({ overrides: [{ id: 'method:acme.notes/add', params: { type: 'string' } }] })).toEqual([
      'override method:acme.notes/add: params must be an object schema',
    ])
  })

  test('an override carrying a valid params schema is accepted', () => {
    const params = { type: 'object', properties: { color: { type: 'string', enum: ['red', 'green'] } } }
    expect(result({ overrides: [{ id: 'method:acme.notes/add', params }] }).ok).toBe(true)
  })

  test('an event override and a command override are validated too', () => {
    expect(errorsOf({ overrides: [{ id: 'event:acme.notes/added', data: 'x' }] })).toEqual([
      'override event:acme.notes/added: data must be a schema object',
    ])
    expect(errorsOf({ overrides: [{ id: 'command:acme.notes/open', args: { type: 'array' } }] })).toEqual([
      'override command:acme.notes/open: args must be an object schema',
    ])
  })
})
