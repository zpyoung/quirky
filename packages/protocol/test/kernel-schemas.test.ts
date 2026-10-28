import { describe, expect, test } from 'bun:test'
import { CONNECTION_METHODS, KERNEL_EVENT_SCHEMAS, KERNEL_METHOD_SCHEMAS, type KernelMethodSchema, type Schema } from '../src'

const METHOD_COUNT = 38
const EVENT_TYPES = [
  'notify',
  'plugin.changed',
  'setting.changed',
  'theme.changed',
  'ui.state.changed',
  'ui.command.request',
  'ui.window.changed',
  'ui.report.changed',
  'hook.received'
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
    for (const name of ['api.describe', 'client.hello', 'theme.set', 'plugin.activate', 'ui.state']) {
      expect(methodNames).toContain(name)
    }
  })

  test('read-only and destructive methods are flagged', () => {
    const entries = KERNEL_METHOD_SCHEMAS as Record<string, KernelMethodSchema>
    const readOnly = Object.keys(entries).filter((name) => entries[name]!.readOnly)
    expect(readOnly.sort()).toEqual(
      [
        'status.get', 'plugin.list', 'plugin.contributions', 'plugin.inspect', 'api.describe', 'job.list',
        'ui.contributions', 'ui.state', 'setting.list', 'setting.get', 'theme.list', 'distro.list',
        'distro.inspect'
      ].sort()
    )
    const destructive = Object.keys(entries).filter((name) => entries[name]!.destructive)
    expect(destructive.sort()).toEqual(['distro.install', 'distro.remove', 'plugin.install', 'plugin.uninstall'])
    for (const name of destructive) {
      expect(entries[name]!.destructive!.confirm, name).not.toBe('')
      expect(Object.keys(entries[name]!.params.properties!), name).toEqual(expect.arrayContaining(['yes', 'confirmation']))
    }
  })

  test('ui window methods are connection methods', () => {
    for (const name of ['ui.report', 'ui.window.focused', 'ui.window.activity', 'ui.command.reply']) {
      expect(CONNECTION_METHODS).toContain(name as (typeof CONNECTION_METHODS)[number])
    }
  })

  test('only the hello, subscribe and ui window methods are connection methods', () => {
    expect([...CONNECTION_METHODS].sort()).toEqual([
      'client.hello',
      'events.subscribe',
      'ui.command.reply',
      'ui.report',
      'ui.window.activity',
      'ui.window.focused'
    ])
  })

  test('no v1 feature method keeps a schema', () => {
    const v1 = /^(settings|repo|worktree|session|terminal|git|ask|structured)\./
    expect(methodNames.filter((name) => v1.test(name))).toEqual([])
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
    expect(p('setting.set').required).toEqual(['id', 'value'])
    expect(p('setting.set').properties!.value!.type).toBeUndefined()
    expect(p('client.hello').properties!.protocolVersion).toMatchObject({ type: 'integer', minimum: 0 })
    expect(p('client.hello').properties!.role!.enum).toEqual(['desktop', 'ui', 'cli', 'mobile'])
    expect(p('status.get')).toEqual({ type: 'object' })
  })
  test('sessionToken is an optional hello field separate from sessionId', () => {
    const hello = methodSchemas['client.hello']!
    expect(hello.required).not.toContain('sessionToken')
    expect(hello.properties?.sessionToken).toEqual({ type: 'string' })
    expect(hello.properties?.sessionId).toEqual({ type: 'string' })
  })

})

describe('kernel event schemas', () => {
  test('cover every event type', () => {
    expect(Object.keys(KERNEL_EVENT_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort())
  })

  test('notify requires desktop', () => {
    expect(KERNEL_EVENT_SCHEMAS.notify.data.required).toEqual(['title', 'body', 'desktop'])
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
