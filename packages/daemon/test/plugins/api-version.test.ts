import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_API_VERSION, RpcErrorCode, type ApiDescription, type PluginInfo, type UiModel } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writePlugin } from './fixtures'

type TestPluginManifest = { id: string } & Record<string, unknown>

const SETTINGS_ID = 'setting:quirky.terminal/scrollback'
const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

async function errorOf(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to fail')
}

function pluginMain(marker: string, id: string, result: string): string {
  return [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`import ${id}\n`)})`,
    'export function activate(context: { provide(id: string, implementation: () => string): void }) {',
    `  appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`activate ${id}\n`)})`,
    `  context.provide('method:${id}/hello', () => ${JSON.stringify(result)})`,
    '}',
    ''
  ].join('\n')
}

describe('daemon plugin API version freeze', () => {
  test('compatible install and invoke preserve the declaration in API catalog and UI model', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    const source = writePlugin(
      makeTempDir(),
      {
        id: 'acme.compat',
        name: 'Compatible plugin',
        version: '7.3.2',
        apiVersion: '1.0.0',
        main: 'main.ts',
        cli: 'cli.ts',
        ui: 'ui.js',
        contributes: {
          method: [{ id: 'hello' }],
          'cli-command': [{ id: 'hello', summary: 'Hello', method: 'hello' }],
          view: [{ id: 'home', title: 'Home' }]
        }
      },
      {
        'main.ts': pluginMain(marker, 'acme.compat', 'hello'),
        'cli.ts': 'export const commands = {}\n',
        'ui.js': 'export function activate() {}\n'
      }
    )
    const harness = await startHarness({ home, builtinPluginsDir: null })
    harnesses.push(harness)
    const client = await harness.connect()
    const uiClient = await harness.connect('ui')

    const installed = (await client.call('plugin.install', { path: source, yes: true })) as PluginInfo
    const description = (await client.call('api.describe', {})) as ApiDescription
    const model = (await uiClient.call('ui.contributions', {})) as UiModel

    expect(installed.apiVersion).toBe('1.0.0')
    expect(description.pluginApiVersion).toBe(PLUGIN_API_VERSION)
    expect(description.cli.commands.find((command) => command.id === 'cli-command:acme.compat/hello')).toMatchObject({
      plugin: 'acme.compat',
      apiVersion: '1.0.0'
    })
    expect(model.modules['acme.compat']).toEqual({
      url: '/plugins/acme.compat/ui.js',
      provides: ['view:acme.compat/home'],
      apiVersion: '1.0.0'
    })
    expect(readMarker(marker)).toEqual([])
    expect(await client.callAny('acme.compat/hello', {})).toBe('hello')
    expect(readMarker(marker)).toEqual(['import acme.compat', 'activate acme.compat'])
  })

  test('incompatible discovered and source plugins stay inert, uninstalled and isolated from valid plugins', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    const invalidManifest = {
      id: 'acme.future-discovered',
      name: 'Future plugin',
      version: '1.0.0',
      apiVersion: '1.3.0',
      main: 'main.ts',
      contributes: { method: [{ id: 'hidden' }] }
    }
    writePlugin(join(home, 'plugins'), invalidManifest, {
      'main.ts': `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(marker)}, 'invalid discovered import\\n')\n`
    })
    writePlugin(
      join(home, 'plugins'),
      {
        id: 'acme.missing-api',
        name: 'Missing API declaration',
        version: '1.0.0',
        apiVersion: undefined,
        main: 'main.ts',
        contributes: { method: [{ id: 'missing' }] }
      },
      { 'main.ts': `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(marker)}, 'invalid missing import\\n')\n` }
    )
    const invalidSource = writePlugin(
      makeTempDir(),
      {
        ...invalidManifest,
        id: 'acme.future-source',
        contributes: { method: [{ id: 'not-installed' }] }
      },
      {
        'main.ts': `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(marker)}, 'invalid source import\\n')\n`
      }
    )
    writePlugin(
      join(home, 'plugins'),
      {
        id: 'acme.healthy',
        name: 'Healthy plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        main: 'main.ts',
        contributes: { method: [{ id: 'hello' }] }
      },
      { 'main.ts': pluginMain(marker, 'acme.healthy', 'healthy') }
    )
    const harness = await startHarness({ home, builtinPluginsDir: null })
    harnesses.push(harness)
    const client = await harness.connect()
    const { events } = await harness.connectWithEvents('ui')
    events.length = 0

    const listed = (await client.call('plugin.list', {})) as PluginInfo[]
    const discovered = listed.find((plugin) => plugin.id === 'acme.future-discovered')!
    expect(discovered.state).toBe('invalid')
    expect(discovered.apiVersion).toBeUndefined()
    expect(discovered.diagnostics.map((item) => item.message).join('\n')).toContain('1.3.0')
    expect(discovered.diagnostics.map((item) => item.message).join('\n')).toContain(PLUGIN_API_VERSION)
    expect((await errorOf(client.call('plugin.activate', { pluginId: 'acme.future-discovered' }))).code).toBe(RpcErrorCode.Conflict)
    const missing = listed.find((plugin) => plugin.id === 'acme.missing-api')!
    expect(missing.state).toBe('invalid')
    expect(missing.apiVersion).toBeUndefined()
    expect(missing.diagnostics.map((item) => item.message).join('\n')).toContain("missing required field 'apiVersion'")

    const description = (await client.call('api.describe', {})) as ApiDescription
    expect(description.methods.map((method) => method.name)).not.toContain('acme.future-discovered/hidden')
    expect(description.methods.map((method) => method.name)).toContain('acme.healthy/hello')
    expect(description.methods.map((method) => method.name)).not.toContain('acme.missing-api/missing')

    const inspection = await errorOf(client.call('plugin.inspect', { path: invalidSource }))
    const install = await errorOf(client.call('plugin.install', { path: invalidSource, yes: true }))
    for (const refusal of [inspection, install]) {
      expect(refusal.code).toBe(RpcErrorCode.InvalidParams)
      expect(refusal.message).toContain('apiVersion')
      expect(refusal.message).toContain('1.3.0')
      expect(refusal.message).toContain(PLUGIN_API_VERSION)
    }
    expect(existsSync(join(home, 'plugins', 'acme.future-source'))).toBe(false)
    expect(readMarker(marker)).toEqual([])
    expect(events.some((event) => event.type === 'plugin.changed')).toBe(false)
    expect(await client.callAny('acme.healthy/hello', {})).toBe('healthy')
    expect(readMarker(marker)).toEqual(['import acme.healthy', 'activate acme.healthy'])
  })

  test('incompatible bundled plugins are refused by distro inspection and install without changing live state', async () => {
    const home = makeTempHome()
    const builtin = makeTempDir()
    const marker = join(makeTempDir(), 'marker.log')
    writePlugin(builtin, {
      id: 'quirky.terminal',
      name: 'Terminal',
      version: '1.0.0',
      contributes: { setting: [{ id: 'scrollback', type: 'number', title: 'Scrollback', default: 1000 }] }
    })

    const makeDistro = (root: string, id: string, plugin: TestPluginManifest, settings: number, disable: string[] = []): string => {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, 'quirky-distro.json'),
        JSON.stringify({
          id,
          name: id,
          version: '1.0.0',
          plugins: [`plugins/${plugin.id}`],
          settings: { [SETTINGS_ID]: settings },
          disable
        })
      )
      writePlugin(join(root, 'plugins'), plugin, { 'main.ts': pluginMain(marker, plugin.id, `${id}-method`) })
      return root
    }

    const validDistro = makeDistro(makeTempDir(), 'stable', {
      id: 'acme.stable',
      name: 'Stable plugin',
      version: '3.2.1',
      apiVersion: '1.0.0',
      main: 'main.ts',
      contributes: { method: [{ id: 'hello' }] }
    }, 1500)
    const invalidDistro = makeDistro(makeTempDir(), 'stable', {
      id: 'acme.stable',
      name: 'Future plugin',
      version: '1.0.0',
      apiVersion: '1.3.0',
      main: 'main.ts',
      contributes: { method: [{ id: 'never' }] }
    }, 9000, ['acme.stable'])
    const harness = await startHarness({ home, builtinPluginsDir: builtin })
    harnesses.push(harness)
    const client = await harness.connect()
    const watcher = await harness.connectWithEvents('ui')
    await client.call('distro.install', { path: validDistro, yes: true })
    expect(await client.callAny('acme.stable/hello', {})).toBe('stable-method')
    const before = {
      distros: await client.call('distro.list', {}),
      pluginDirectories: readdirSync(join(home, 'plugins')).sort(),
      setting: await client.call('setting.get', { id: SETTINGS_ID }),
      methods: await client.call('plugin.contributions', { kind: 'method' })
    }
    watcher.events.length = 0

    const inspected = await errorOf(client.call('distro.inspect', { path: invalidDistro }))
    const installed = await errorOf(client.call('distro.install', { path: invalidDistro, yes: true }))

    for (const refusal of [inspected, installed]) {
      expect(refusal.code).toBe(RpcErrorCode.InvalidParams)
      expect(refusal.message).toContain('acme.stable')
      expect(refusal.message).toContain('1.3.0')
      expect(refusal.message).toContain(PLUGIN_API_VERSION)
    }
    expect({
      distros: await client.call('distro.list', {}),
      pluginDirectories: readdirSync(join(home, 'plugins')).sort(),
      setting: await client.call('setting.get', { id: SETTINGS_ID }),
      methods: await client.call('plugin.contributions', { kind: 'method' })
    }).toEqual(before)
    expect(existsSync(join(home, 'plugins', 'acme.future'))).toBe(false)
    expect(readMarker(marker)).toEqual(['import acme.stable', 'activate acme.stable'])
    expect(watcher.events).toEqual([])
  })
})
