import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin, writePlugin } from './fixtures'

const SETTING = 'setting:acme.ui/fontSize'
const UI_SOURCE = 'export function activate() {}\n'

const harnesses: Harness[] = []

/** The error a call rejects with; `.rejects` misreports daemon errors raised in the same process. */
async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

/** Writes `acme.ui` (a UI module, a setting, a theme, a method that reads the setting) and `acme.bare` (a command and no UI module) under a fresh home. */
function writeFixtures(home: string): void {
  const installed = join(home, 'plugins')
  const marker = join(makeTempDir(), 'marker.log')
  const dir = writeModulePlugin(
    installed,
    marker,
    {
      id: 'acme.ui',
      ui: 'ui/main.js',
      contributes: {
        view: [{ id: 'board', title: 'Board' }],
        setting: [{ id: 'fontSize', type: 'number', title: 'Font size', default: 14, minimum: 8, maximum: 40 }],
        theme: [{ id: 'night', title: 'Night', appearance: 'dark', colors: { bg: '#000000' } }],
        method: [{ id: 'fontSize' }]
      }
    },
    { activate: "context.provide('method:acme.ui/fontSize', () => ({ value: context.getSetting('fontSize') }))" }
  )
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'ui', 'main.js'), UI_SOURCE)
  writePlugin(installed, { id: 'acme.bare', name: 'acme.bare', version: '1.0.0', contributes: { command: [{ id: 'go', title: 'Go' }] } })
}

async function boot(home = makeTempHome()) {
  writeFixtures(home)
  const harness = await startHarness({ home, builtinPluginsDir: null })
  harnesses.push(harness)
  return harness
}

describe('UI plugin API wiring', () => {
  test('ui.contributions returns a model for a fixture plugin', async () => {
    const harness = await boot()
    const client = await harness.connect()
    const model = await client.call('ui.contributions', {})
    expect(model.views).toMatchObject([{ id: 'view:acme.ui/board', plugin: 'acme.ui', title: 'Board', module: '/plugins/acme.ui/ui/main.js' }])
    expect(model.settings.map((entry) => entry.id)).toEqual([SETTING])
    expect(model.modules['acme.ui']).toEqual({ url: '/plugins/acme.ui/ui/main.js', provides: ['view:acme.ui/board'] })
    expect(model.theme).toEqual({ chosen: 'default', active: 'default' })
  })

  test('setting.set, get and reset round-trip and broadcast the effective value', async () => {
    const harness = await boot()
    const { client, events } = await harness.connectWithEvents()

    expect(await client.call('setting.get', { id: SETTING })).toMatchObject({ value: 14 })
    expect(await client.call('setting.list', { pluginId: 'acme.ui' })).toHaveLength(1)
    expect(await client.call('setting.list', { pluginId: 'acme.bare' })).toEqual([])

    const set = await client.call('setting.set', { id: SETTING, value: 20 })
    expect(set).toMatchObject({ value: 20, stored: { value: 20, valid: true } })
    await waitFor(() => events.find((event) => event.type === 'setting.changed' && event.value === 20))
    expect(events).toContainEqual({ type: 'setting.changed', id: SETTING, value: 20 })

    const reset = await client.call('setting.reset', { id: SETTING })
    expect(reset.value).toBe(14)
    expect(reset.stored).toBeUndefined()
    await waitFor(() => events.find((event) => event.type === 'setting.changed' && event.value === 14))
  })

  test('setting errors use the contract texts', async () => {
    const harness = await boot()
    const client = await harness.connect()
    expect(await failure(client.call('setting.get', { id: 'setting:acme.ui/nope' }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no setting setting:acme.ui/nope'
    })
    expect(await failure(client.call('setting.set', { id: SETTING, value: 99 }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: `${SETTING} must be at most 40`
    })
    expect(await failure(client.callAny('setting.set', { id: SETTING }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'value is required'
    })
    expect(await failure(client.call('theme.set', { id: 'theme:acme.ui/missing' }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no theme theme:acme.ui/missing'
    })
  })

  test('theme.set persists across a daemon restart on the same home', async () => {
    const harness = await boot()
    const { client, events } = await harness.connectWithEvents()
    const list = await client.call('theme.set', { id: 'theme:acme.ui/night' })
    expect(list).toMatchObject({ chosen: 'theme:acme.ui/night', active: 'theme:acme.ui/night' })
    await waitFor(() => events.find((event) => event.type === 'theme.changed'))
    const { home } = harness
    harnesses.splice(harnesses.indexOf(harness), 1)
    await harness.daemon.stop()
    harness.pty.stop()
    for (const connected of harness.clients) connected.close()

    const restarted = await startHarness({ home, builtinPluginsDir: null })
    harnesses.push(restarted)
    const again = await restarted.connect()
    expect(await again.call('theme.list', {})).toMatchObject({ chosen: 'theme:acme.ui/night', active: 'theme:acme.ui/night' })
  })

  test('a daemon plugin reads the effective setting through context.getSetting', async () => {
    const harness = await boot()
    const client = await harness.connect()
    expect(await client.callAny('acme.ui/fontSize', {})).toEqual({ value: 14 })
    await client.call('setting.set', { id: SETTING, value: 22 })
    expect(await client.callAny('acme.ui/fontSize', {})).toEqual({ value: 22 })
  })

  test('plugin.list carries ui and the warning for a plugin with code-backed entries and no ui module', async () => {
    const harness = await boot()
    const client = await harness.connect()
    const plugins = await client.call('plugin.list', {})
    const bare = plugins.find((plugin) => plugin.id === 'acme.bare')!
    expect(bare.diagnostics).toEqual([
      { level: 'warning', message: 'declares commands, views, panels or sidebar sections but has no ui module' }
    ])
    expect(bare.ui).toBeUndefined()
    const withUi = plugins.find((plugin) => plugin.id === 'acme.ui')!
    expect(withUi.ui).toBe('ui/main.js')
    expect(withUi.diagnostics).toEqual([])
  })

  test('/plugins/<id>/<ui> serves the file and a path that leaves the directory is 404', async () => {
    const harness = await boot()
    const base = `http://127.0.0.1:${harness.runtime.port}`
    const served = await fetch(`${base}/plugins/acme.ui/ui/main.js`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toContain('text/javascript')
    expect(await served.text()).toBe(UI_SOURCE)

    expect((await fetch(`${base}/plugins/acme.ui/../x`)).status).toBe(404)
    expect((await fetch(`${base}/plugins/acme.ui/%2e%2e/acme.bare/quirky-plugin.json`)).status).toBe(404)
    expect((await fetch(`${base}/plugins/acme.bare/quirky-plugin.json`)).status).toBe(404)
    expect((await fetch(`${base}/plugins/acme.nobody/ui/main.js`)).status).toBe(404)
  })
})
