import { describe, expect, test } from 'bun:test'
import { AGENT_KINDS, CONNECTION_METHODS, KERNEL_EVENT_SCHEMAS, KERNEL_METHOD_SCHEMAS, type Schema } from '../src'

const METHOD_COUNT = 48
const EVENT_TYPES = [
  'repo.changed',
  'worktree.changed',
  'session.changed',
  'session.removed',
  'git.changed',
  'ask.created',
  'ask.resolved',
  'notify',
  'structured.message',
  'plugin.changed',
  'setting.changed',
  'theme.changed'
]

const methodNames = Object.keys(KERNEL_METHOD_SCHEMAS)
const methodSchemas: Record<string, Schema> = {}
for (const [name, entry] of Object.entries(KERNEL_METHOD_SCHEMAS)) methodSchemas[name] = entry.params

/** Every schema in `schema`, itself included. */
function walk(schema: Schema): Schema[] {
  return [
    schema,
    ...Object.values(schema.properties ?? {}).flatMap(walk),
    ...(schema.items ? walk(schema.items) : [])
  ]
}

describe('kernel method schemas', () => {
  test('cover every method, including api.describe', () => {
    expect(methodNames).toHaveLength(METHOD_COUNT)
    for (const name of ['api.describe', 'repo.add', 'client.hello', 'theme.set', 'plugin.activate']) {
      expect(methodNames).toContain(name)
    }
  })

  test('every connection method has a schema', () => {
    for (const name of CONNECTION_METHODS) expect(methodNames).toContain(name)
  })

  test('every entry has a description, an object params schema and a result schema', () => {
    for (const [name, entry] of Object.entries(KERNEL_METHOD_SCHEMAS)) {
      expect(entry.description, name).not.toBe('')
      expect(entry.params.type, name).toBe('object')
      expect(typeof entry.result, name).toBe('object')
    }
  })

  test('every enum names the type of its values', () => {
    const all = [
      ...Object.values(KERNEL_METHOD_SCHEMAS).flatMap((entry) => [...walk(entry.params), ...walk(entry.result)]),
      ...Object.values(KERNEL_EVENT_SCHEMAS).flatMap((entry) => walk(entry.data))
    ]
    for (const schema of all) if (schema.enum) expect(schema.type).toBeDefined()
  })

  test('every required name is a declared property', () => {
    for (const [name, params] of Object.entries(methodSchemas)) {
      for (const key of params.required ?? []) expect(Object.keys(params.properties ?? {}), name).toContain(key)
    }
  })

  test('params never reject what the handlers accept', () => {
    const p = (name: string) => methodSchemas[name]!
    expect(p('git.diff').required).not.toContain('staged')
    expect(p('git.diff').properties!.staged!.type).toBe('boolean')
    expect(p('settings.set').required ?? []).toEqual([])
    expect(Object.keys(p('settings.set').properties!).sort()).toEqual(['notifications', 'terminalScrollback', 'worktreesRoot'])
    expect(p('settings.set').properties!.terminalScrollback).toMatchObject({ type: 'integer', minimum: 0 })
    expect(p('setting.set').required).toEqual(['id', 'value'])
    expect(p('setting.set').properties!.value!.type).toBeUndefined()
    expect(p('ask.create').properties!.spec).toMatchObject({ type: 'object', additionalProperties: true })
    expect(p('ask.answer').properties!.answers).toMatchObject({ type: 'object', additionalProperties: true })
    expect(p('ask.answer').properties!.skipped).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(p('ask.wait').properties!.timeoutMs).toMatchObject({ type: 'integer', minimum: 0 })
    expect(p('ask.wait').properties!.timeoutMs!.maximum).toBeUndefined()
    expect(p('client.hello').properties!.protocolVersion).toMatchObject({ type: 'integer', minimum: 0 })
    expect(p('client.hello').properties!.role!.enum).toEqual(['desktop', 'ui', 'cli', 'mobile'])
    expect(p('terminal.detach').properties!.streamId).toMatchObject({ type: 'integer', minimum: 0 })
    expect(p('terminal.read').properties!.lines).toMatchObject({ type: 'integer', minimum: 1 })
    expect(p('structured.messages').properties!.afterSeq).toMatchObject({ type: 'integer', minimum: 0 })
    expect(p('session.create').required).toEqual(['worktreeId', 'agent'])
    expect(p('session.create').properties!.agent!.enum).toEqual([...AGENT_KINDS])
    expect(p('git.stage').properties!.paths).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(p('status.get')).toEqual({ type: 'object' })
  })
})

describe('kernel event schemas', () => {
  test('cover every event type', () => {
    expect(Object.keys(KERNEL_EVENT_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort())
  })

  test('every entry describes an object without a type property', () => {
    for (const [type, entry] of Object.entries(KERNEL_EVENT_SCHEMAS)) {
      expect(entry.description, type).not.toBe('')
      const data: Schema = entry.data
      expect(data.type, type).toBe('object')
      expect(data.properties?.type, type).toBeUndefined()
    }
  })
})
