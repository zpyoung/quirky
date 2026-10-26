import { describe, expect, test } from 'bun:test'
import { checkSchemaDeclaration, flagNameOf, validateValue, type Schema } from '../src/schema'

const objectCheck = (value: unknown) => checkSchemaDeclaration(value, 'params', { object: true })

describe('checkSchemaDeclaration', () => {
  test('accepts a full valid object schema', () => {
    expect(
      objectCheck({
        type: 'object',
        description: 'x',
        properties: {
          title: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
          color: { type: 'string', enum: ['red', 'blue'] },
          level: { type: 'number', enum: [1, 2.5] },
          tags: { type: 'array', items: { type: 'string' } },
          anything: {},
          nested: { type: 'object', properties: { a: { type: 'boolean' } }, additionalProperties: false },
          nothing: { type: 'null' }
        },
        required: ['title'],
        additionalProperties: true
      })
    ).toEqual([])
  })

  test('accepts {} and skips default', () => {
    expect(checkSchemaDeclaration({}, 'data')).toEqual([])
    expect(checkSchemaDeclaration({ default: { anything: [1] } }, 'data')).toEqual([])
  })

  test('rejects non-object schemas', () => {
    expect(checkSchemaDeclaration('object', 'data')).toEqual(['data must be a schema object'])
    expect(checkSchemaDeclaration(null, 'data')).toEqual(['data must be a schema object'])
    expect(checkSchemaDeclaration([], 'data')).toEqual(['data must be a schema object'])
    expect(objectCheck({ type: 'object', properties: { a: 'string' } })).toEqual([
      'params.properties.a must be a schema object'
    ])
    expect(objectCheck({ type: 'object', properties: { a: { type: 'array', items: 3 } } })).toEqual([
      'params.properties.a.items must be a schema object'
    ])
  })

  test('requires an object schema only at the top level', () => {
    expect(objectCheck({ type: 'string' })).toEqual(['params must be an object schema'])
    expect(objectCheck({})).toEqual(['params must be an object schema'])
    expect(objectCheck({ type: 'object', properties: { a: { type: 'string' } } })).toEqual([])
  })

  test('reports unsupported keywords one per key', () => {
    expect(objectCheck({ type: 'object', oneOf: [] })).toEqual(['params: unsupported keyword oneOf'])
    expect(objectCheck({ type: 'object', oneOf: [], pattern: 'x' })).toEqual([
      'params: unsupported keyword oneOf',
      'params: unsupported keyword pattern'
    ])
  })

  test('validates type and description', () => {
    expect(objectCheck({ type: 'object', properties: { when: { type: 'date' } } })).toEqual([
      'params.properties.when: unknown type date'
    ])
    expect(checkSchemaDeclaration({ type: 3 }, 'data')).toEqual(['data: type must be a string'])
    expect(checkSchemaDeclaration({ description: 3 }, 'data')).toEqual(['data: description must be a string'])
  })

  test('validates enum', () => {
    expect(objectCheck({ type: 'object', properties: { color: { type: 'string', enum: [] } } })).toEqual([
      'params.properties.color: enum must be a non-empty list'
    ])
    expect(checkSchemaDeclaration({ type: 'string', enum: 'a' }, 'data')).toEqual(['data: enum must be a non-empty list'])
    expect(objectCheck({ type: 'object', properties: { choice: { enum: ['1', 1] } } })).toEqual([
      'params.properties.choice: enum needs type string, integer or number'
    ])
    expect(checkSchemaDeclaration({ type: 'boolean', enum: [true] }, 'data')).toEqual([
      'data: enum needs type string, integer or number'
    ])
    expect(objectCheck({ type: 'object', properties: { choice: { type: 'string', enum: ['a', 2] } } })).toEqual([
      'params.properties.choice: enum values must be strings'
    ])
    expect(checkSchemaDeclaration({ type: 'integer', enum: [1, 1.5] }, 'data')).toEqual([
      'data: enum values must be integers'
    ])
    expect(checkSchemaDeclaration({ type: 'number', enum: [1, 'x'] }, 'data')).toEqual([
      'data: enum values must be numbers'
    ])
  })

  test('validates items', () => {
    expect(checkSchemaDeclaration({ type: 'string', items: {} }, 'data')).toEqual([
      'data: items is only allowed for an array'
    ])
    expect(checkSchemaDeclaration({ items: { type: 'string' } }, 'data')).toEqual([])
    expect(checkSchemaDeclaration({ type: 'array', items: { type: 'x' } }, 'data')).toEqual([
      'data.items: unknown type x'
    ])
  })

  test('validates properties, required and additionalProperties', () => {
    expect(checkSchemaDeclaration({ properties: [] }, 'data')).toEqual(['data: properties must be an object'])
    expect(checkSchemaDeclaration({ type: 'array', properties: {} }, 'data')).toEqual([
      'data: properties is only allowed for an object'
    ])
    expect(checkSchemaDeclaration({ required: 'x' }, 'data')).toEqual(['data: required must be a list of property names'])
    expect(checkSchemaDeclaration({ required: [1] }, 'data')).toEqual(['data: required must be a list of property names'])
    expect(checkSchemaDeclaration({ type: 'string', required: [] }, 'data')).toEqual([
      'data: required is only allowed for an object'
    ])
    expect(objectCheck({ type: 'object', required: ['x'] })).toEqual(['params: required names undeclared property x'])
    expect(objectCheck({ type: 'object', properties: { a: {} }, required: ['x', 'a', 'y'] })).toEqual([
      'params: required names undeclared property x',
      'params: required names undeclared property y'
    ])
    expect(checkSchemaDeclaration({ additionalProperties: 'no' }, 'data')).toEqual([
      'data: additionalProperties must be true or false'
    ])
    expect(checkSchemaDeclaration({ type: 'string', additionalProperties: true }, 'data')).toEqual([
      'data: additionalProperties is only allowed for an object'
    ])
  })

  test('validates minimum and maximum', () => {
    expect(checkSchemaDeclaration({ type: 'integer', minimum: '1' }, 'data')).toEqual(['data: minimum must be a number'])
    expect(checkSchemaDeclaration({ type: 'integer', maximum: Infinity }, 'data')).toEqual([
      'data: maximum must be a number'
    ])
    expect(checkSchemaDeclaration({ type: 'string', minimum: 1 }, 'data')).toEqual([
      'data: minimum is only allowed for a number'
    ])
    expect(checkSchemaDeclaration({ type: 'number', minimum: 5, maximum: 1 }, 'data')).toEqual([
      'data: minimum must not be greater than maximum'
    ])
    expect(checkSchemaDeclaration({ minimum: 1, maximum: 1 }, 'data')).toEqual([])
  })
})

const params: Schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    color: { type: 'string', enum: ['red', 'blue'] },
    tags: { type: 'array', items: { type: 'string' } }
  },
  required: ['title']
}

describe('validateValue', () => {
  test('accepts a valid value', () => {
    expect(validateValue(params, { title: 'a', priority: 3, color: 'red', tags: ['x'] })).toBeNull()
    expect(validateValue(params, { title: 'a' })).toBeNull()
  })

  test.each([
    [{}, 'params.title is required'],
    [{ title: 5 }, 'params.title must be a string'],
    [{ title: 'a', priority: '3' }, 'params.priority must be an integer'],
    [{ title: 'a', priority: 1.5 }, 'params.priority must be an integer'],
    [{ title: 'a', priority: 9 }, 'params.priority must be at most 5'],
    [{ title: 'a', priority: 0 }, 'params.priority must be at least 1'],
    [{ title: 'a', color: 'green' }, 'params.color must be one of red, blue'],
    [{ title: 'a', tags: ['x', 1] }, 'params.tags[1] must be a string'],
    [{ title: 'a', tags: 'x' }, 'params.tags must be an array'],
    [{ title: 'a', colour: 'red' }, 'params.colour is not allowed']
  ])('rejects %j', (value, message) => {
    expect(validateValue(params, value)).toBe(message)
  })

  test('uses the given path and rejects a non-object root', () => {
    expect(validateValue(params, 'x')).toBe('params must be an object')
    expect(validateValue(params, [])).toBe('params must be an object')
    expect(validateValue(params, null, 'data')).toBe('data must be an object')
    expect(validateValue(params, {}, 'data')).toBe('data.title is required')
  })

  test('reports type messages for every type', () => {
    expect(validateValue({ type: 'number' }, 'x', 'v')).toBe('v must be a number')
    expect(validateValue({ type: 'number' }, NaN, 'v')).toBe('v must be a number')
    expect(validateValue({ type: 'boolean' }, 1, 'v')).toBe('v must be a boolean')
    expect(validateValue({ type: 'null' }, 0, 'v')).toBe('v must be null')
    expect(validateValue({ type: 'null' }, null, 'v')).toBeNull()
    expect(validateValue({ type: 'string' }, 1, 'v')).toBe('v must be a string')
  })

  test('rejects every property of an object schema without properties', () => {
    expect(validateValue({ type: 'object' }, { verbose: true })).toBe('params.verbose is not allowed')
    expect(validateValue({ type: 'object' }, {})).toBeNull()
    expect(validateValue({ type: 'object', additionalProperties: true }, { verbose: true })).toBeNull()
  })

  test('checks required, declared, then undeclared properties in order', () => {
    const schema: Schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['b', 'a']
    }
    expect(validateValue(schema, { a: 1, b: 2, z: 1 })).toBe('params.a must be a string')
    expect(validateValue(schema, { z: 1 })).toBe('params.b is required')
    expect(validateValue(schema, { b: 'x', a: 'x', z: 1, y: 1 })).toBe('params.z is not allowed')
    expect(validateValue({ ...schema, required: ['a'] }, { b: 2, a: 'x' })).toBe('params.b must be a string')
  })

  test('treats an explicitly undefined property as missing', () => {
    expect(validateValue(params, { title: undefined })).toBe('params.title is required')
  })

  test('recurses into nested paths', () => {
    const schema: Schema = {
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } } }
    }
    expect(validateValue(schema, { list: [{ n: 1 }, { n: 'x' }] })).toBe('params.list[1].n must be an integer')
  })

  test('an untyped schema accepts any type but applies enum and bounds', () => {
    expect(validateValue({}, { a: [1] }, 'v')).toBeNull()
    expect(validateValue({}, null, 'v')).toBeNull()
    expect(validateValue({ enum: ['a', 1] }, 'b', 'v')).toBe('v must be one of a, 1')
    expect(validateValue({ enum: ['a', 1] }, 1, 'v')).toBeNull()
    expect(validateValue({ minimum: 2 }, 1, 'v')).toBe('v must be at least 2')
    expect(validateValue({ minimum: 2 }, 'x', 'v')).toBeNull()
    expect(validateValue({ properties: { a: { type: 'string' } } }, { a: 1 }, 'v')).toBe('v.a must be a string')
    expect(validateValue({ required: ['a'] }, {}, 'v')).toBe('v.a is required')
  })
})

describe('flagNameOf', () => {
  test('hyphenates camelCase and leaves other names alone', () => {
    expect(flagNameOf('worktreeId')).toBe('worktree-id')
    expect(flagNameOf('fooBar')).toBe('foo-bar')
    expect(flagNameOf('foo-bar')).toBe('foo-bar')
    expect(flagNameOf('timeoutMs')).toBe('timeout-ms')
    expect(flagNameOf('name')).toBe('name')
  })
})
