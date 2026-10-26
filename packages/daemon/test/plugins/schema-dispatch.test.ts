import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { KERNEL_METHOD_SCHEMAS, RpcErrorCode, type ApiDescription, type Schema } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>
type Fixture = { manifest: Manifest; behavior?: ModuleBehavior }

/** Starts a daemon over the installed plugins and connects a CLI client. */
async function boot(fixtures: Fixture[]) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const { manifest, behavior } of fixtures) writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const client = await harness.connect()
  return {
    harness,
    client,
    lines: () => readMarker(marker),
    state: async (id: string) => (await client.call('plugin.list', {})).find((plugin) => plugin.id === id)!.state,
    describe: () => client.call('api.describe', {}) as Promise<ApiDescription>
  }
}

async function rejection(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

const notesParams = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    color: { type: 'string', enum: ['red', 'blue'] },
    tags: { type: 'array', items: { type: 'string' } }
  }
}

const notes: Fixture = {
  manifest: {
    id: 'acme.notes',
    contributes: {
      method: [
        { id: 'add', params: notesParams },
        { id: 'count' },
        {
          id: 'import',
          params: { type: 'object', properties: { source: { type: 'string' } }, additionalProperties: true }
        }
      ]
    }
  },
  behavior: {
    activate: `
      context.provide('method:acme.notes/add', (params) => ({ added: params }))
      context.provide('method:acme.notes/count', () => 0)
      context.provide('method:acme.notes/import', (params) => ({ received: params }))`
  }
}

describe('SC-3: bad params are refused before the plugin activates', () => {
  const rows: [string, Record<string, unknown>, string][] = [
    ['{}', {}, 'params.title is required'],
    ['a title that is not a string', { title: 5 }, 'params.title must be a string'],
    ['a priority that is not an integer', { title: 'a', priority: '3' }, 'params.priority must be an integer'],
    ['a priority above the maximum', { title: 'a', priority: 9 }, 'params.priority must be at most 5'],
    ['a color outside the enum', { title: 'a', color: 'green' }, 'params.color must be one of red, blue'],
    ['a tag that is not a string', { title: 'a', tags: ['x', 1] }, 'params.tags[1] must be a string'],
    ['an undeclared property', { title: 'a', colour: 'red' }, 'params.colour is not allowed']
  ]

  test.each(rows)('%s', async (_name, params, message) => {
    const s = await boot([notes])
    expect(await s.state('acme.notes')).toBe('inactive')

    expect(await rejection(s.client.callAny('acme.notes/add', params))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message
    })

    expect(await s.state('acme.notes')).toBe('inactive')
    expect(s.lines()).toEqual([])
  })

  test('valid params activate the plugin and reach the handler', async () => {
    const s = await boot([notes])
    const params = { title: 'a', priority: 3, color: 'red', tags: ['x'] }
    expect(await s.client.callAny('acme.notes/add', params)).toEqual({ added: params })
    expect(await s.state('acme.notes')).toBe('active')
  })
})

describe('SC-4: a method with no declared params takes none', () => {
  test('an empty call works and an extra property is refused', async () => {
    const s = await boot([notes])
    expect(await s.client.callAny('acme.notes/count', {})).toBe(0)
    expect(await rejection(s.client.callAny('acme.notes/count', { verbose: true }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'params.verbose is not allowed'
    })
  })

  test('a refused call to a method with no params does not activate the plugin', async () => {
    const s = await boot([notes])
    await rejection(s.client.callAny('acme.notes/count', { verbose: true }))
    expect(await s.state('acme.notes')).toBe('inactive')
    expect(s.lines()).toEqual([])
  })
})

describe('SC-5: additionalProperties true lets undeclared properties through', () => {
  test('the handler receives declared and undeclared properties', async () => {
    const s = await boot([notes])
    expect(await s.client.callAny('acme.notes/import', { source: 'a', extra: 1 })).toEqual({
      received: { source: 'a', extra: 1 }
    })
  })

  test('declared properties are still checked', async () => {
    const s = await boot([notes])
    expect(await rejection(s.client.callAny('acme.notes/import', { source: 5 }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'params.source must be a string'
    })
  })
})

describe('SC-6: kernel methods have schemas, and the daemon checks them', () => {
  test('repo.add with a path that is not a string is refused', async () => {
    const s = await boot([])
    expect(await rejection(s.client.callAny('repo.add', { path: 5 }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'params.path must be a string'
    })
  })

  test('a kernel method refuses a property its schema does not declare', async () => {
    const s = await boot([])
    expect(await rejection(s.client.callAny('repo.list', { extra: 1 }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'params.extra is not allowed'
    })
  })

  test('api.describe lists every kernel method with no plugin and an object params schema', async () => {
    const s = await boot([])
    const description = await s.describe()
    expect(description.methods.map((entry) => entry.name).sort()).toEqual(Object.keys(KERNEL_METHOD_SCHEMAS).sort())
    for (const entry of description.methods) {
      expect(entry.plugin).toBeNull()
      expect(entry.params.type).toBe('object')
    }
    expect(description.methods.some((entry) => entry.name === 'api.describe')).toBe(true)
  })

  test('calls the clients make keep working', async () => {
    const s = await boot([])
    s.harness.git.addRepo('/fake/alpha')
    const repo = await s.client.call('repo.add', { path: '/fake/alpha' })
    expect((await s.client.call('repo.list', {})).map((entry) => entry.id)).toEqual([repo.id])
    expect(await s.client.call('status.get', {})).toMatchObject({ daemonVersion: expect.any(String) })
  })

  test('a plugin calling a connection method gets the connection message before any params check', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.caller', contributes: { method: [{ id: 'hello' }] } },
        behavior: {
          activate: `
            context.provide('method:acme.caller/hello', async () => {
              try { await context.call('client.hello', {}) } catch (error) { return { code: error.code, message: error.message } }
            })`
        }
      }
    ])
    expect(await s.client.callAny('acme.caller/hello', {})).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: 'client.hello needs a client connection'
    })
  })

  test('a plugin calling a kernel method with bad params gets InvalidParams', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.caller', contributes: { method: [{ id: 'bad' }] } },
        behavior: {
          activate: `
            context.provide('method:acme.caller/bad', async () => {
              try { await context.call('repo.add', { path: 5 }) } catch (error) { return { code: error.code, message: error.message } }
            })`
        }
      }
    ])
    expect(await s.client.callAny('acme.caller/bad', {})).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: 'params.path must be a string'
    })
  })
})

describe('plugin calls through context.call', () => {
  test('a plugin calling a plugin method with bad params gets InvalidParams and the callee stays inactive', async () => {
    const s = await boot([
      notes,
      {
        manifest: { id: 'acme.caller', contributes: { method: [{ id: 'relay' }] } },
        behavior: {
          activate: `
            context.provide('method:acme.caller/relay', async () => {
              try { await context.call('acme.notes/add', { title: 5 }) } catch (error) { return { code: error.code, message: error.message } }
            })`
        }
      }
    ])
    expect(await s.client.callAny('acme.caller/relay', {})).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: 'params.title must be a string'
    })
    expect(await s.state('acme.notes')).toBe('inactive')
    expect(await s.state('acme.caller')).toBe('active')
  })
})

describe('SC-7: results and event data are not checked', () => {
  test('a result and an event that miss their declared schemas are delivered unchanged', async () => {
    const s = await boot([
      {
        manifest: {
          id: 'acme.notes',
          contributes: {
            method: [
              {
                id: 'add',
                params: { type: 'object', properties: { title: { type: 'string' } } },
                result: { type: 'object', required: ['id', 'title'], properties: { id: { type: 'integer' }, title: { type: 'string' } } }
              }
            ],
            event: [
              { id: 'added', data: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } }
            ]
          }
        },
        behavior: {
          activate: `
            context.provide('method:acme.notes/add', () => {
              context.emit('added', { noteId: 1 })
              return { id: 1 }
            })`
        }
      }
    ])
    const { events } = await s.harness.connectWithEvents()

    expect(await s.client.callAny('acme.notes/add', { title: 'a' })).toEqual({ id: 1 })

    const event = await waitFor(() => events.find((candidate) => candidate.type === 'acme.notes/added'))
    expect(event).toEqual({ type: 'acme.notes/added', data: { noteId: 1 } })
  })
})

describe('SC-8: an override brings its own schema', () => {
  const betterParams: Schema = {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' }, color: { type: 'string', enum: ['red', 'blue', 'green'] } }
  }
  const better: Fixture = {
    manifest: {
      id: 'acme.better',
      overrides: [
        {
          id: 'method:acme.notes/add',
          params: betterParams
        }
      ]
    },
    behavior: { activate: "context.provide('method:acme.notes/add', (params) => ({ by: 'acme.better', params }))" }
  }

  test('the catalog shows the override schema with the overrider as plugin', async () => {
    const s = await boot([notes, better])
    const entry = (await s.describe()).methods.find((candidate) => candidate.name === 'acme.notes/add')
    expect(entry?.plugin).toBe('acme.better')
    expect(entry?.params).toEqual(betterParams)
  })

  test('a call the base schema refuses reaches the override handler', async () => {
    const s = await boot([notes, better])
    const params = { title: 'a', color: 'green' }
    expect(await s.client.callAny('acme.notes/add', params)).toEqual({ by: 'acme.better', params })
    expect(await s.state('acme.notes')).toBe('inactive')
    expect(await s.state('acme.better')).toBe('active')
  })

  test('the override schema still refuses what it does not allow', async () => {
    const s = await boot([notes, better])
    expect(await rejection(s.client.callAny('acme.notes/add', { title: 'a', color: 'pink' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'params.color must be one of red, blue, green'
    })
  })
})
