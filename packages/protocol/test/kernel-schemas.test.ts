import { describe, expect, test } from 'bun:test'
import { CONNECTION_METHODS, KERNEL_EVENT_SCHEMAS, KERNEL_METHOD_SCHEMAS, type KernelMethodSchema, type Schema } from '../src'


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

  test('only the hello, subscribe and ui window methods are connection methods', () => {
    expect([...CONNECTION_METHODS].sort()).toEqual([
      'client.hello',
      'events.subscribe',
      'ui.command.reply',
      'ui.report',
      'ui.shell.report',
      'ui.window.activity',
      'ui.window.focused'
    ])
  })

  test('every connection method has a schema', () => {
    for (const name of CONNECTION_METHODS) expect(methodNames).toContain(name)
  })

  test('every method has object params and a result schema', () => {
    for (const [name, entry] of Object.entries(KERNEL_METHOD_SCHEMAS)) {
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



})

describe('kernel event schemas', () => {
  test('cover every event type', () => {
    expect(Object.keys(KERNEL_EVENT_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort())
  })

  test('notify requires desktop', () => {
    expect(KERNEL_EVENT_SCHEMAS.notify.data.required).toEqual(['title', 'body', 'desktop'])
  })

  test('every entry has object data without a type property', () => {
    for (const [type, entry] of Object.entries(KERNEL_EVENT_SCHEMAS)) {
      const data: Schema = entry.data
      expect(data.type, type).toBe('object')
      expect(data.properties?.type, type).toBeUndefined()
    }
  })
})
