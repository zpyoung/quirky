import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  CATALOG_SCHEMA_VERSION,
  CONNECTION_METHODS,
  KERNEL_EVENT_SCHEMAS,
  KERNEL_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  type ApiDescription
} from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>

/** A daemon over a temp built-in directory and a temp installed directory, with a CLI client. */
async function boot(plugins: { builtin?: Manifest[]; installed?: Manifest[] }) {
  const home = makeTempHome()
  const builtin = makeTempDir('qd-builtin-')
  const marker = join(makeTempDir(), 'marker.log')
  for (const manifest of plugins.builtin ?? []) writeModulePlugin(builtin, marker, manifest)
  for (const manifest of plugins.installed ?? []) writeModulePlugin(join(home, 'plugins'), marker, manifest)
  const harness = await startHarness({ home, builtinPluginsDir: builtin })
  h = harness
  const client = await harness.connect()
  return {
    client,
    lines: () => readMarker(marker),
    describe: () => client.call('api.describe', {}) as Promise<ApiDescription>,
    state: async (id: string) => (await client.call('plugin.list', {})).find((plugin) => plugin.id === id)!.state
  }
}

const lazyPlugin: Manifest = {
  id: 'acme.tools',
  contributes: {
    method: [{ id: 'refresh', description: 'Refreshes the widgets.' }, { id: 'bare' }],
    event: [{ id: 'refreshed', description: 'A refresh finished.' }],
    command: [{ id: 'go', title: 'Go there', description: 'Navigates.' }, { id: 'untitled' }]
  }
}

describe('api.describe', () => {
  test('lists every kernel method and event with no plugin and flags connection methods', async () => {
    const s = await boot({})
    const description = await s.describe()

    expect(description.schemaVersion).toBe(CATALOG_SCHEMA_VERSION)
    expect(description.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(description.daemonVersion).toBe((await s.client.call('status.get', {})).daemonVersion)
    expect(description.methods.map((m) => m.name)).toEqual(Object.keys(KERNEL_METHOD_SCHEMAS).sort())
    expect(description.methods.every((m) => m.plugin === null)).toBe(true)
    expect(description.methods.filter((m) => m.connection).map((m) => m.name)).toEqual([...CONNECTION_METHODS].sort())
    expect(description.methods.find((m) => m.name === 'plugin.enable')).toEqual({
      name: 'plugin.enable',
      plugin: null,
      description: KERNEL_METHOD_SCHEMAS['plugin.enable'].description,
      params: KERNEL_METHOD_SCHEMAS['plugin.enable'].params,
      result: KERNEL_METHOD_SCHEMAS['plugin.enable'].result
    })
    expect(description.methods.some((m) => m.name === 'api.describe')).toBe(true)
    expect(description.events.map((e) => e.name)).toEqual(Object.keys(KERNEL_EVENT_SCHEMAS).sort())
    expect(description.events.every((e) => e.plugin === null)).toBe(true)
    expect(description.events.find((e) => e.name === 'plugin.changed')).toEqual({
      name: 'plugin.changed',
      plugin: null,
      description: KERNEL_EVENT_SCHEMAS['plugin.changed'].description,
      data: KERNEL_EVENT_SCHEMAS['plugin.changed'].data
    })
    expect(description.uiCommands).toEqual([])
  })

  test('lists a lazy plugin\'s methods, events and commands with defaults, and activates nothing', async () => {
    const s = await boot({ installed: [lazyPlugin] })
    const description = await s.describe()

    expect(description.methods.filter((m) => m.plugin !== null)).toEqual([
      {
        name: 'acme.tools/bare',
        plugin: 'acme.tools',
        params: { type: 'object' },
        result: {}
      },
      {
        name: 'acme.tools/refresh',
        plugin: 'acme.tools',
        description: 'Refreshes the widgets.',
        params: { type: 'object' },
        result: {}
      }
    ])
    expect(description.events.filter((e) => e.plugin !== null)).toEqual([
      { name: 'acme.tools/refreshed', plugin: 'acme.tools', description: 'A refresh finished.', data: null }
    ])
    expect(description.uiCommands).toEqual([
      { id: 'command:acme.tools/go', plugin: 'acme.tools', title: 'Go there', description: 'Navigates.', args: { type: 'object' } },
      { id: 'command:acme.tools/untitled', plugin: 'acme.tools', title: 'untitled', args: { type: 'object' } }
    ])
    expect(await s.state('acme.tools')).toBe('inactive')
    expect(s.lines()).toEqual([])
  })

  test('SC-8: an installed plugin overriding a built-in method is the listed plugin', async () => {
    const s = await boot({
      builtin: [{ id: 'quirky.sample', contributes: { method: [{ id: 'ping', description: 'Built-in ping.' }] } }],
      installed: [
        { id: 'acme.better', overrides: [{ id: 'method:quirky.sample/ping', description: 'Better ping.' }] }
      ]
    })
    const entries = (await s.describe()).methods.filter((m) => m.name === 'quirky.sample/ping')

    expect(entries).toEqual([
      { name: 'quirky.sample/ping', plugin: 'acme.better', description: 'Better ping.', params: { type: 'object' }, result: {} }
    ])
  })

  test('sorts every list by name with plain string comparison', async () => {
    const s = await boot({
      installed: [
        { id: 'zeta.p', contributes: { method: [{ id: 'b' }, { id: 'a' }], event: [{ id: 'y' }, { id: 'x' }] } },
        { id: 'alpha.p', contributes: { method: [{ id: 'z' }], command: [{ id: 'c2', title: 'Two' }, { id: 'c1', title: 'One' }] } }
      ]
    })
    const description = await s.describe()
    const sorted = (names: string[]) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    for (const names of [
      description.methods.map((m) => m.name),
      description.events.map((e) => e.name),
      description.uiCommands.map((c) => c.id)
    ]) {
      expect(names).toEqual(sorted(names))
    }
    expect(description.methods.map((m) => m.name).filter((n) => n.includes('/'))).toEqual([
      'alpha.p/z',
      'zeta.p/a',
      'zeta.p/b'
    ])
    expect(description.uiCommands.map((c) => c.id)).toEqual(['command:alpha.p/c1', 'command:alpha.p/c2'])
  })

  test('a disabled method disappears from the description', async () => {
    const s = await boot({ installed: [lazyPlugin] })
    await s.client.call('plugin.disable', { id: 'method:acme.tools/refresh' })
    const names = (await s.describe()).methods.map((m) => m.name)

    expect(names).not.toContain('acme.tools/refresh')
    expect(names).toContain('acme.tools/bare')
  })
})
