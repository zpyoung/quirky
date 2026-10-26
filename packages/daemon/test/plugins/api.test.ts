import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode, type PluginInfo } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startDaemon, type DaemonOptions } from '../../src/daemon'
import { Store } from '../../src/store'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin, writePlugin, type ModuleBehavior } from './fixtures'

const COMMAND = 'command:acme.tools/refresh'
const SIDEBAR = 'view:quirky.sample/sidebar'

let h: Harness | null = null
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>

type Kit = {
  home: string
  builtinDir: string
  installedDir: string
  marker: string
  gate: string
  builtin(manifest: Manifest, behavior?: ModuleBehavior): void
  installed(manifest: Manifest, behavior?: ModuleBehavior): void
}

/** Writes the plugin layout, starts a daemon over it and connects a CLI client. */
async function boot(layout: (kit: Kit) => void = () => {}, options: Partial<DaemonOptions> = {}) {
  const home = makeTempHome()
  const root = makeTempDir()
  const builtinDir = join(root, 'builtin')
  const installedDir = join(home, 'plugins')
  mkdirSync(builtinDir)
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const gate = join(root, 'gate')
  layout({
    home,
    builtinDir,
    installedDir,
    marker,
    gate,
    builtin: (manifest, behavior) => void writeModulePlugin(builtinDir, marker, manifest, behavior),
    installed: (manifest, behavior) => void writeModulePlugin(installedDir, marker, manifest, behavior)
  })
  const harness = await startHarness({ home, builtinPluginsDir: builtinDir, ...options })
  h = harness
  const client = await harness.connect()
  return {
    harness,
    client,
    home,
    builtinDir,
    installedDir,
    marker,
    gate,
    lines: () => readMarker(marker),
    release: () => writeFileSync(gate, ''),
    list: () => client.call('plugin.list', {}),
    info: async (id: string) => (await client.call('plugin.list', {})).find((plugin) => plugin.id === id)!,
    ids: async (params: { kind?: string; pluginId?: string; all?: boolean } = {}) =>
      (await client.call('plugin.contributions', params)).map((contribution) => contribution.id)
  }
}

const messages = (info: PluginInfo) => info.diagnostics.map((diagnostic) => diagnostic.message)

const toolsManifest = {
  id: 'acme.tools',
  version: '1.2.0',
  dependencies: ['acme.base'],
  contributes: { command: [{ id: 'refresh', title: 'Refresh' }], view: [{ id: 'panel' }] }
}

const sampleSidebar = { id: 'quirky.sample', version: '0.1.0', ui: 'ui.js', contributes: { view: [{ id: 'sidebar', title: 'Repos' }] } }
const override = (id: string, title = id) => ({ id, ui: 'ui.js', overrides: [{ id: SIDEBAR, title }] })

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  await waitFor(() => check() || undefined, timeoutMs)
}

describe('discovery and IDs', () => {
  test('SC-1: plugins from both places are listed with source, state and diagnostics, and none activated', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.installed({ id: 'acme.tools', version: '1.2.0' })
    })
    const plugins = await s.list()
    expect(plugins.map((plugin) => [plugin.id, plugin.name, plugin.version, plugin.source, plugin.state])).toEqual([
      ['acme.tools', 'acme.tools', '1.2.0', 'installed', 'inactive'],
      ['quirky.sample', 'quirky.sample', '0.1.0', 'builtin', 'inactive']
    ])
    expect(plugins.every((plugin) => plugin.diagnostics.length === 0)).toBe(true)
    expect(s.lines()).toEqual([])
  })

  test('SC-2: own contributions get full IDs, the owner and the declared data', async () => {
    const s = await boot((kit) => {
      kit.installed(toolsManifest)
      kit.installed({ id: 'acme.base' })
    })
    const contributions = await s.client.call('plugin.contributions', { pluginId: 'acme.tools' })
    expect(contributions).toMatchObject([
      { id: COMMAND, kind: 'command', name: 'refresh', plugin: 'acme.tools', status: 'effective', data: { title: 'Refresh' } },
      { id: 'view:acme.tools/panel', kind: 'view', name: 'panel', plugin: 'acme.tools', status: 'effective' }
    ])
  })

  test('SC-3: contributions can be filtered by kind', async () => {
    const s = await boot((kit) => {
      kit.installed(toolsManifest)
      kit.installed({ id: 'acme.base' })
    })
    expect(await s.ids({ kind: 'command' })).toEqual([COMMAND])
    expect(await s.ids({ kind: 'view' })).toEqual(['view:acme.tools/panel'])
  })
})

describe('activation', () => {
  test('SC-4: an unused plugin is never loaded', async () => {
    const s = await boot((kit) => {
      kit.installed({ id: 'acme.base' })
      kit.installed(toolsManifest)
    })
    await s.list()
    await s.ids()
    await s.ids({ all: true })
    expect(existsSync(s.marker)).toBe(false)
    expect((await s.info('acme.tools')).state).toBe('inactive')
  })

  test('SC-6: plugin.activate activates the plugin and its dependency first and returns the new state', async () => {
    const s = await boot((kit) => {
      kit.installed({ id: 'acme.base' })
      kit.installed(toolsManifest)
    })
    const info = await s.client.call('plugin.activate', { pluginId: 'acme.tools' })
    expect(info).toMatchObject({ id: 'acme.tools', state: 'active' })
    expect((await s.info('acme.base')).state).toBe('active')
    expect(s.lines()).toEqual(['import acme.base', 'activate acme.base', 'import acme.tools', 'activate acme.tools'])
  })

  test('SC-7: startup plugins are active when the daemon is reachable', async () => {
    const s = await boot((kit) => {
      kit.installed({ id: 'acme.watch', activation: 'startup' })
      kit.installed({ id: 'acme.lazy' })
    })
    expect((await s.info('acme.watch')).state).toBe('active')
    expect((await s.info('acme.lazy')).state).toBe('inactive')
    expect(s.lines()).toEqual(['import acme.watch', 'activate acme.watch'])
  })

  test('SC-8: concurrent activation runs the plugin once', async () => {
    const s = await boot((kit) => kit.installed({ id: 'acme.tools' }, { activate: waitForFile(kit.gate) }))
    const first = s.client.call('plugin.activate', { pluginId: 'acme.tools' })
    const second = s.client.call('plugin.activate', { pluginId: 'acme.tools' })
    await until(() => s.lines().includes('activate acme.tools'))
    await Bun.sleep(30)
    s.release()
    expect((await Promise.all([first, second])).map((info) => info.state)).toEqual(['active', 'active'])
    expect(s.lines().filter((line) => line === 'activate acme.tools')).toHaveLength(1)
  })

  test('SC-9: providing an undeclared ID fails the activation and the diagnostic names the ID', async () => {
    const s = await boot((kit) =>
      kit.installed(
        { id: 'acme.tools', contributes: { command: [{ id: 'refresh' }] } },
        { activate: "context.provide('command:acme.tools/undeclared', 1)" }
      )
    )
    await expect(s.client.call('plugin.activate', { pluginId: 'acme.tools' })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict
    })
    const info = await s.info('acme.tools')
    expect(info.state).toBe('failed')
    expect(messages(info).join('\n')).toContain('command:acme.tools/undeclared')
  })
})

describe('overrides', () => {
  test('SC-10: an installed plugin overrides a built-in contribution, and all shows the overridden declaration', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.installed(override('acme.sidebar', 'Acme'))
    })
    expect(await s.client.call('plugin.contributions', {})).toMatchObject([
      { id: SIDEBAR, plugin: 'acme.sidebar', override: true, data: { title: 'Acme' }, status: 'effective' }
    ])
    const all = await s.client.call('plugin.contributions', { all: true })
    expect(all).toMatchObject([
      { id: SIDEBAR, plugin: 'acme.sidebar', status: 'effective' },
      { id: SIDEBAR, plugin: 'quirky.sample', status: 'overridden', overriddenBy: 'acme.sidebar', data: { title: 'Repos' } }
    ])
  })

  test('SC-12: two plugins overriding the same ID have a deterministic winner and a conflict diagnostic', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.installed(override('acme.two'))
      kit.installed(override('acme.one'))
    })
    const [winner] = await s.client.call('plugin.contributions', {})
    expect(winner).toMatchObject({ id: SIDEBAR, plugin: 'acme.one' })
    expect(messages(await s.info('acme.two'))).toContain(`override of ${SIDEBAR} conflicts with acme.one`)
    const rejected = (await s.client.call('plugin.contributions', { all: true })).find((c) => c.plugin === 'acme.two')
    expect(rejected).toMatchObject({ status: 'rejected', conflictWith: 'acme.one' })
  })

  test('SC-13: a dependent override beats its dependency, with no conflict', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.installed(override('acme.one'))
      kit.installed({ ...override('acme.two'), dependencies: ['acme.one'] })
    })
    expect(await s.client.call('plugin.contributions', {})).toMatchObject([{ id: SIDEBAR, plugin: 'acme.two' }])
    expect(messages(await s.info('acme.one'))).toEqual([])
    expect(messages(await s.info('acme.two'))).toEqual([])
  })

  test('SC-14: an installed override beats a built-in override', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.builtin(override('quirky.other'))
      kit.installed(override('acme.zed'))
    })
    expect(await s.client.call('plugin.contributions', {})).toMatchObject([{ id: SIDEBAR, plugin: 'acme.zed' }])
    expect(messages(await s.info('quirky.other'))).toEqual([])
    expect(messages(await s.info('acme.zed'))).toEqual([])
  })

  test('SC-15: an override of an ID nobody declares takes effect with a warning, unless its plugin is disabled', async () => {
    const missing = 'view:quirky.missing/sidebar'
    const s = await boot((kit) => {
      kit.builtin({ id: 'quirky.missing' })
      kit.installed({ id: 'acme.sidebar', ui: 'ui.js', overrides: [{ id: missing }] })
    })
    expect(await s.client.call('plugin.contributions', {})).toMatchObject([{ id: missing, plugin: 'acme.sidebar' }])
    expect((await s.info('acme.sidebar')).diagnostics).toContainEqual({
      level: 'warning',
      message: `override of ${missing} replaces nothing`
    })

    await s.client.call('plugin.disable', { id: 'quirky.missing' })
    expect(await s.ids()).toEqual([missing])
    expect(messages(await s.info('acme.sidebar'))).toEqual([])
  })
})

describe('disabling', () => {
  test('SC-16: a contribution can be disabled and re-enabled by ID, it persists across a restart, and each change emits plugin.changed', async () => {
    const s = await boot((kit) => {
      kit.installed({ id: 'acme.base' })
      kit.installed(toolsManifest)
    })
    const { events } = await s.harness.connectWithEvents()
    const changes = () => events.filter((event) => event.type === 'plugin.changed').length

    await s.client.call('plugin.disable', { id: COMMAND })
    await waitFor(() => changes() >= 1)
    expect(await s.ids({ kind: 'command' })).toEqual([])
    const declared = (await s.client.call('plugin.contributions', { all: true })).find((c) => c.id === COMMAND)
    expect(declared).toMatchObject({ status: 'disabled', disabledBy: 'user' })

    await s.harness.daemon.stop()
    const second = await startDaemon({
      home: s.home,
      port: 0,
      shell: '/bin/zsh',
      notifier: () => {},
      uiDir: '/none',
      builtinPluginsDir: s.builtinDir
    })
    cleanups.push(() => second.stop())
    const next = await QuirkyClient.connect(rpcUrl(second.runtime), { role: 'cli' })
    cleanups.push(() => next.close())
    const nextEvents: string[] = []
    next.onEvent((event) => nextEvents.push(event.type))
    await next.call('events.subscribe', {})
    expect((await next.call('plugin.contributions', { kind: 'command' })).map((c) => c.id)).toEqual([])

    await next.call('plugin.enable', { id: COMMAND })
    await waitFor(() => nextEvents.includes('plugin.changed'))
    expect((await next.call('plugin.contributions', { kind: 'command' })).map((c) => c.id)).toEqual([COMMAND])

    await second.stop()
    const store = new Store(join(s.home, 'quirky.db'))
    expect(store.listDisabledIds()).toEqual([])
    store.close()
  })

  test('SC-18: disabling a plugin removes its contributions and disables its dependents; enabling restores both', async () => {
    const s = await boot((kit) => {
      kit.installed({ id: 'acme.base' })
      kit.installed(toolsManifest)
    })
    await s.client.call('plugin.activate', { pluginId: 'acme.tools' })
    await s.client.call('plugin.disable', { id: 'acme.base' })

    const base = await s.info('acme.base')
    const tools = await s.info('acme.tools')
    expect([base.state, tools.state]).toEqual(['disabled', 'disabled'])
    expect(tools.diagnostics).toContainEqual({ level: 'error', message: 'dependency acme.base is disabled' })
    expect(await s.ids()).toEqual([])
    expect(s.lines().slice(-2)).toEqual(['deactivate acme.tools', 'deactivate acme.base'])

    await s.client.call('plugin.enable', { id: 'acme.base' })
    expect((await s.info('acme.base')).state).toBe('inactive')
    expect((await s.info('acme.tools')).state).toBe('inactive')
    expect(await s.ids()).toEqual([COMMAND, 'view:acme.tools/panel'])
  })

  test('SC-18: a deactivate that throws or times out still completes the disable and leaves a warning', async () => {
    const s = await boot(
      (kit) => {
        kit.installed({ id: 'acme.throws' }, { deactivate: "throw new Error('nope')" })
        kit.installed({ id: 'acme.hangs' }, { deactivate: 'await new Promise(() => {})' })
      },
      { pluginActivationTimeoutMs: 200 }
    )
    await s.client.call('plugin.activate', { pluginId: 'acme.throws' })
    await s.client.call('plugin.activate', { pluginId: 'acme.hangs' })
    await s.client.call('plugin.disable', { id: 'acme.throws' })
    await s.client.call('plugin.disable', { id: 'acme.hangs' })
    const throws = await s.info('acme.throws')
    const hangs = await s.info('acme.hangs')
    expect(throws.state).toBe('disabled')
    expect(throws.diagnostics).toContainEqual({ level: 'warning', message: 'deactivate failed: nope' })
    expect(hangs.state).toBe('disabled')
    expect(hangs.diagnostics).toContainEqual({ level: 'warning', message: 'deactivate timed out after 200 ms' })
  })

  test("SC-19: a plugin's own disables apply only while it is enabled", async () => {
    const scm = 'view:quirky.sample/scm'
    const s = await boot((kit) => {
      kit.builtin({ id: 'quirky.sample', contributes: { view: [{ id: 'scm' }] } })
      kit.installed({ id: 'acme.minimal', disables: [scm] })
    })
    const find = async () => (await s.client.call('plugin.contributions', { all: true })).find((c) => c.id === scm)
    expect(await find()).toMatchObject({ status: 'disabled', disabledBy: 'plugin', disablingPlugin: 'acme.minimal' })
    await s.client.call('plugin.disable', { id: 'acme.minimal' })
    expect(await find()).toMatchObject({ status: 'effective' })
    expect(await s.ids()).toEqual([scm])
  })

  test('SC-20: disabled beats override', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.installed(override('acme.sidebar'))
    })
    await s.client.call('plugin.disable', { id: SIDEBAR })
    expect(await s.ids()).toEqual([])
    const all = await s.client.call('plugin.contributions', { all: true })
    expect(all.map((c) => [c.plugin, c.status, c.disabledBy])).toEqual([
      ['acme.sidebar', 'disabled', 'user'],
      ['quirky.sample', 'disabled', 'user']
    ])
  })

  test('SC-21: unknown IDs are refused with not-found and the disabled list is unchanged', async () => {
    const s = await boot((kit) => kit.installed({ id: 'acme.base' }))
    await expect(s.client.call('plugin.disable', { id: 'acme.nope' })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
    await expect(s.client.call('plugin.enable', { id: 'acme.nope' })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
    await expect(s.client.call('plugin.disable', { id: 'command:acme.nope/x' })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
    await expect(s.client.call('plugin.disable', { id: 'Not Valid' })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    await expect(s.client.call('plugin.disable', {} as { id: string })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect((await s.info('acme.base')).state).toBe('inactive')
    await s.harness.daemon.stop()
    const store = new Store(join(s.home, 'quirky.db'))
    expect(store.listDisabledIds()).toEqual([])
    store.close()
  })

  test('SC-25: disabling a plugin while it activates waits, then deactivates; the activate call reports it was disabled', async () => {
    const s = await boot((kit) =>
      kit.installed(
        { id: 'acme.slowstart', contributes: { command: [{ id: 'go' }] } },
        { activate: `${waitForFile(kit.gate)}\n  context.provide('command:acme.slowstart/go', 1)` }
      )
    )
    const activation = s.client
      .call('plugin.activate', { pluginId: 'acme.slowstart' })
      .then(() => null, (error: unknown) => error)
    await until(() => s.lines().includes('activate acme.slowstart'))

    let disabled = false
    const disabling = s.client.call('plugin.disable', { id: 'acme.slowstart' }).then(() => (disabled = true))
    await Bun.sleep(60)
    expect(disabled).toBe(false)
    s.release()
    await disabling

    expect(await activation).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.slowstart was disabled during activation'
    })
    expect((await s.info('acme.slowstart')).state).toBe('disabled')
    expect(s.lines()).toEqual(['import acme.slowstart', 'activate acme.slowstart', 'deactivate acme.slowstart'])
    await expect(s.harness.daemon.plugins.resolve('command:acme.slowstart/go')).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
  })

  test('SC-26: enabling a startup plugin activates it before the command returns', async () => {
    const s = await boot((kit) => kit.installed({ id: 'acme.watch', activation: 'startup' }))
    await s.client.call('plugin.disable', { id: 'acme.watch' })
    expect((await s.info('acme.watch')).state).toBe('disabled')
    await s.client.call('plugin.enable', { id: 'acme.watch' })
    expect((await s.info('acme.watch')).state).toBe('active')
  })
})

describe('bad plugins', () => {
  test('SC-22: an invalid plugin is reported and skipped while valid plugins work normally', async () => {
    const s = await boot((kit) => {
      kit.builtin(sampleSidebar)
      kit.installed({ id: 'acme.ok', contributes: { command: [{ id: 'go' }] } })
      writePlugin(kit.installedDir, '{not json', {}, { dirName: 'acme.notjson' })
      writePlugin(kit.installedDir, { id: 'acme.unknown', name: 'x', version: '1.0.0', contribute: {} })
      writePlugin(kit.installedDir, { id: 'acme.x', name: 'x', version: '1.0.0' }, {}, { dirName: 'acme-x' })
      writePlugin(kit.installedDir, { id: 'quirky.fake', name: 'x', version: '1.0.0' })
      writePlugin(kit.installedDir, { id: 'quirky.sample', name: 'x', version: '1.0.0' })
      writePlugin(kit.installedDir, {
        id: 'acme.orphan',
        name: 'x',
        version: '1.0.0',
        dependencies: ['acme.ghost'],
        contributes: { command: [{ id: 'lost' }] }
      })
      writePlugin(kit.installedDir, { id: 'acme.a', name: 'x', version: '1.0.0', dependencies: ['acme.b'] })
      writePlugin(kit.installedDir, { id: 'acme.b', name: 'x', version: '1.0.0', dependencies: ['acme.a'] })
      writePlugin(kit.installedDir, { id: 'acme.c', name: 'x', version: '1.0.0', dependencies: ['acme.a'] })
    })
    const plugins = await s.list()
    const byId = (id: string, source?: string) => plugins.find((p) => p.id === id && (!source || p.source === source))!
    const reasons = (info: PluginInfo) => messages(info).join('\n')

    expect(reasons(byId('acme.notjson'))).toContain("can't be parsed")
    expect(reasons(byId('acme.unknown'))).toContain("unknown field 'contribute'")
    expect(reasons(byId('acme-x'))).toContain("directory name doesn't match the ID")
    expect(reasons(byId('quirky.fake'))).toContain('the quirky. prefix is reserved for built-ins')
    expect(reasons(byId('quirky.sample', 'installed'))).toContain('duplicates the built-in plugin quirky.sample')
    expect(reasons(byId('acme.orphan'))).toContain('dependency acme.ghost is not installed')
    expect(reasons(byId('acme.a'))).toContain('dependency cycle: acme.a, acme.b')
    expect(reasons(byId('acme.b'))).toContain('dependency cycle: acme.a, acme.b')
    expect(reasons(byId('acme.c'))).toContain('dependency acme.a is invalid')
    for (const id of ['acme.notjson', 'acme.unknown', 'acme-x', 'quirky.fake', 'acme.orphan', 'acme.a', 'acme.b', 'acme.c']) {
      expect(byId(id).state).toBe('invalid')
    }
    expect(byId('quirky.sample', 'installed').state).toBe('invalid')
    expect(plugins.filter((p) => p.id === 'quirky.sample').map((p) => [p.source, p.state])).toEqual([
      ['builtin', 'inactive'],
      ['installed', 'invalid']
    ])

    expect(await s.ids({ all: true })).toEqual(['command:acme.ok/go', SIDEBAR])
    expect((await s.client.call('plugin.activate', { pluginId: 'acme.ok' })).state).toBe('active')
    await expect(s.client.call('plugin.activate', { pluginId: 'acme.a' })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.a is invalid'
    })
  })

  test('SC-23: a failing activation is contained, and the daemon keeps answering', async () => {
    const s = await boot(
      (kit) => {
        kit.installed(
          { id: 'acme.broken' },
          { activate: `if (!existsSync(${JSON.stringify(kit.gate)})) throw new Error('boom')` }
        )
        kit.installed({ id: 'acme.slow' }, { activate: 'await new Promise(() => {})' })
        kit.installed({ id: 'acme.after', dependencies: ['acme.broken'] })
      },
      { pluginActivationTimeoutMs: 200 }
    )
    await expect(s.client.call('plugin.activate', { pluginId: 'acme.broken' })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict
    })
    expect(await s.client.call('status.get', {})).toMatchObject({ daemonVersion: expect.any(String) })
    await expect(s.client.call('plugin.activate', { pluginId: 'acme.slow' })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict
    })
    await expect(s.client.call('plugin.activate', { pluginId: 'acme.after' })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict
    })
    expect(await s.client.call('status.get', {})).toMatchObject({ daemonVersion: expect.any(String) })

    const broken = await s.info('acme.broken')
    const slow = await s.info('acme.slow')
    const after = await s.info('acme.after')
    expect([broken.state, slow.state, after.state]).toEqual(['failed', 'failed', 'failed'])
    expect(messages(broken)).toContain('boom')
    expect(messages(slow)).toContain('activation timed out after 200 ms')
    expect(messages(after)).toContain('dependency acme.broken failed to activate')

    const attempts = () => s.lines().filter((line) => line === 'activate acme.broken').length
    const before = attempts()
    s.release()
    expect((await s.client.call('plugin.activate', { pluginId: 'acme.broken' })).state).toBe('active')
    expect(attempts()).toBe(before + 1)
  })
})

describe('daemon lifecycle', () => {
  test('SC-24: stopping the daemon deactivates plugins in reverse order, and a throwing deactivate does not stop the other', async () => {
    const s = await boot((kit) => {
      kit.installed({ id: 'acme.base' }, { deactivate: "throw new Error('nope')" })
      kit.installed(toolsManifest, { deactivate: "throw new Error('also nope')" })
    })
    await s.client.call('plugin.activate', { pluginId: 'acme.tools' })
    await s.harness.daemon.stop()
    expect(s.lines().slice(-2)).toEqual(['deactivate acme.tools', 'deactivate acme.base'])
  })

  test('the installed plugins directory is created private, and the handle exposes the host', async () => {
    const home = makeTempHome()
    h = await startHarness({ home, builtinPluginsDir: null })
    expect(statSync(join(home, 'plugins')).mode & 0o777).toBe(0o700)
    expect(h.daemon.plugins.list()).toEqual([])
  })

  test('a built-in plugins directory of null lists only installed plugins', async () => {
    const home = makeTempHome()
    mkdirSync(join(home, 'plugins'))
    writePlugin(join(home, 'plugins'), { id: 'acme.base', name: 'x', version: '1.0.0' })
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    expect((await client.call('plugin.list', {})).map((plugin) => plugin.id)).toEqual(['acme.base'])
  })
})
