import { describe, expect, test } from 'bun:test'
import { CONNECTION_METHODS, KERNEL_EVENT_SCHEMAS, KERNEL_METHOD_SCHEMAS, type KernelMethodSchema, type Schema } from '../src'



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

  test('destructive methods declare confirmation text and override params', () => {
    const entries = KERNEL_METHOD_SCHEMAS as Record<string, KernelMethodSchema>
    const destructive = Object.keys(entries).filter((name) => entries[name]!.destructive)
    for (const name of destructive) {
      expect(entries[name]!.destructive!.confirm, name).not.toBe('')
      expect(Object.keys(entries[name]!.params.properties!), name).toEqual(expect.arrayContaining(['yes', 'confirmation']))
    }
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

  test('setting and plugin info schemas carry whenSetting and repository', () => {
    const settingItem = KERNEL_METHOD_SCHEMAS['setting.list'].result.items!
    expect(Object.keys(settingItem.properties!)).toContain('whenSetting')
    expect(Object.keys(KERNEL_METHOD_SCHEMAS['plugin.list'].result.items!.properties!)).toContain('repository')
  })



})

describe('kernel event schemas', () => {

  test('every entry has object data without a type property', () => {
    for (const [type, entry] of Object.entries(KERNEL_EVENT_SCHEMAS)) {
      const data: Schema = entry.data
      expect(data.type, type).toBe('object')
      expect(data.properties?.type, type).toBeUndefined()
    }
  })
})
