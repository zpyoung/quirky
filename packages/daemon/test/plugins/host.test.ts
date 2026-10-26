import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { PluginHost } from '../../src/plugins/host'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin, writePlugin, type ModuleBehavior } from './fixtures'

afterEach(removeTempDirs)

const COMMAND = 'command:acme.tools/refresh'
const SIDEBAR = 'view:quirky.sample/sidebar'

function setup(options: { disabled?: string[]; distroDisabled?: string[]; timeoutMs?: number } = {}) {
  const root = makeTempDir()
  const builtinDir = join(root, 'builtin')
  const installedDir = join(root, 'installed')
  mkdirSync(builtinDir)
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const gate = join(root, 'gate')
  const disabled = new Set(options.disabled ?? [])
  const events: QuirkyEvent[] = []
  const logs: string[] = []
  const host = new PluginHost({
    builtinDir,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled].sort(),
      setDisabledId: (id, isDisabled) => {
        if (isDisabled) disabled.add(id)
        else disabled.delete(id)
      }
    },
    emit: (event) => events.push(event),
    log: (message) => logs.push(message),
    activationTimeoutMs: options.timeoutMs,
    distroDisabled: () => options.distroDisabled ?? []
  })
  const installed = (manifest: { id: string } & Record<string, unknown>, behavior?: ModuleBehavior) =>
    writeModulePlugin(installedDir, marker, manifest, behavior)
  const builtin = (manifest: { id: string } & Record<string, unknown>, behavior?: ModuleBehavior) =>
    writeModulePlugin(builtinDir, marker, manifest, behavior)
  const lines = () => readMarker(marker)
  const stateOf = (id: string) => host.list().find((plugin) => plugin.id === id)?.state
  const release = () => writeFileSync(gate, '')
  return { root, host, events, logs, disabled, marker, gate, installed, builtin, lines, stateOf, release, installedDir }
}

/** A plugin whose module blocks at top level until the gate file exists, then records `import` and exports `activate`. */
function writeSlowImportPlugin(t: ReturnType<typeof setup>, id: string): void {
  writePlugin(
    t.installedDir,
    { id, name: id, version: '1.0.0', main: 'main.ts' },
    {
      'main.ts': [
        "import { appendFileSync, existsSync } from 'node:fs'",
        `while (!existsSync(${JSON.stringify(t.gate)})) await Bun.sleep(5)`,
        `appendFileSync(${JSON.stringify(t.marker)}, 'import ${id}\\n')`,
        'export async function activate() {',
        `  appendFileSync(${JSON.stringify(t.marker)}, 'activate ${id}\\n')`,
        '}',
        ''
      ].join('\n')
    }
  )
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true)
  )
  await Bun.sleep(40)
  return done
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until timed out')
    await Bun.sleep(5)
  }
}

const toolsManifest = {
  id: 'acme.tools',
  dependencies: ['acme.base'],
  contributes: { command: [{ id: 'refresh', title: 'Refresh' }] }
}
const provideRefresh = `context.provide(${JSON.stringify(COMMAND)}, { run: () => 'refreshed' })`

describe('loading and listing', () => {
  test('load and list import no plugin code, and enabling a lazy plugin imports nothing', async () => {
    const t = setup({ disabled: ['acme.tools'] })
    t.installed({ id: 'acme.base' })
    t.installed(toolsManifest)
    t.host.load()
    expect(t.host.list().map((plugin) => [plugin.id, plugin.state])).toEqual([
      ['acme.base', 'inactive'],
      ['acme.tools', 'disabled']
    ])
    await t.host.setEnabled('acme.tools', true)
    expect(t.stateOf('acme.tools')).toBe('inactive')
    expect(t.lines()).toEqual([])
  })

  test('a duplicate ID appears once per source, built-in first', () => {
    const t = setup()
    t.builtin({ id: 'quirky.sample' })
    writePlugin(t.installedDir, { id: 'quirky.sample', name: 'x', version: '1.0.0' })
    t.host.load()
    expect(t.host.list().map((plugin) => [plugin.id, plugin.source, plugin.state])).toEqual([
      ['quirky.sample', 'builtin', 'inactive'],
      ['quirky.sample', 'installed', 'invalid']
    ])
  })

  test('contributions lists effective entries, or every declaration with all, filtered by kind and plugin', () => {
    const t = setup()
    t.builtin({ id: 'quirky.sample', contributes: { view: [{ id: 'sidebar', title: 'Repos' }] } })
    t.installed({ id: 'acme.sidebar', overrides: [{ id: SIDEBAR, title: 'Acme' }] })
    t.installed({ id: 'acme.tools', contributes: { command: [{ id: 'refresh' }], view: [{ id: 'panel' }] } })
    t.host.load()
    expect(t.host.contributions().map((c) => [c.id, c.plugin])).toEqual([
      [COMMAND, 'acme.tools'],
      ['view:acme.tools/panel', 'acme.tools'],
      [SIDEBAR, 'acme.sidebar']
    ])
    expect(t.host.contributions({ kind: 'command' }).map((c) => c.id)).toEqual([COMMAND])
    expect(t.host.contributions({ pluginId: 'acme.sidebar' }).map((c) => c.id)).toEqual([SIDEBAR])
    expect(t.host.contributions({ all: true }).map((c) => [c.id, c.status])).toContainEqual([SIDEBAR, 'overridden'])
  })
})

describe('SC-5: resolving a contribution activates its owner, dependencies first', () => {
  test('SC-5: resolve activates acme.base, then acme.tools, and returns the data and implementation', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' })
    t.installed(toolsManifest, { activate: provideRefresh })
    t.host.load()
    expect(t.stateOf('acme.tools')).toBe('inactive')

    const { contribution, implementation } = await t.host.resolve(COMMAND)
    expect(contribution).toMatchObject({ id: COMMAND, plugin: 'acme.tools', data: { title: 'Refresh' } })
    expect((implementation as { run(): string }).run()).toBe('refreshed')
    expect(t.stateOf('acme.base')).toBe('active')
    expect(t.stateOf('acme.tools')).toBe('active')
    expect(t.lines()).toEqual(['import acme.base', 'activate acme.base', 'import acme.tools', 'activate acme.tools'])
    expect(await t.host.resolveImplementation(COMMAND)).toBe(implementation)
  })
})

describe('SC-9: providing', () => {
  test('SC-9: activate fails and the plugin is failed when it provides an undeclared ID', async () => {
    const t = setup()
    t.installed(
      { id: 'acme.tools', contributes: { command: [{ id: 'refresh' }] } },
      { activate: "context.provide('command:acme.tools/undeclared', 1)" }
    )
    t.host.load()
    await expect(t.host.activate('acme.tools')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.tools failed to activate: acme.tools does not declare command:acme.tools/undeclared'
    })
    const info = t.host.list()[0]
    expect(info.state).toBe('failed')
    expect(info.diagnostics).toContainEqual({
      level: 'error',
      message: 'acme.tools does not declare command:acme.tools/undeclared'
    })
  })

  test('SC-9: resolving a declared contribution the plugin did not provide names the plugin and the ID', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' })
    t.installed(toolsManifest)
    t.host.load()
    const resolved = await t.host.resolve(COMMAND)
    expect(resolved.implementation).toBeUndefined()
    expect(t.stateOf('acme.tools')).toBe('active')
    await expect(t.host.resolveImplementation(COMMAND)).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: `acme.tools did not provide ${COMMAND}`
    })
  })

  test('a plugin may provide an ID it overrides', async () => {
    const t = setup()
    t.builtin({ id: 'quirky.sample', contributes: { view: [{ id: 'sidebar' }] } })
    t.installed(
      { id: 'acme.sidebar', overrides: [{ id: SIDEBAR }] },
      { activate: `context.provide(${JSON.stringify(SIDEBAR)}, 'mine')` }
    )
    t.host.load()
    expect(await t.host.resolveImplementation(SIDEBAR)).toBe('mine')
  })

  test('provide throws once the activation failed or the plugin was deactivated', async () => {
    const t = setup()
    t.installed(
      { id: 'acme.tools', contributes: { command: [{ id: 'refresh' }] } },
      { activate: 'globalThis.__hostTestContext = context' }
    )
    t.host.load()
    await t.host.activate('acme.tools')
    const context = (globalThis as unknown as { __hostTestContext: { provide(id: string, value: unknown): void } })
      .__hostTestContext
    await t.host.setEnabled('acme.tools', false)
    expect(() => context.provide(COMMAND, 1)).toThrow('acme.tools is no longer active')
  })
})

describe('SC-11: resolving an overridden ID', () => {
  test('SC-11: loads only the overriding plugin', async () => {
    const t = setup()
    t.builtin({ id: 'quirky.sample', contributes: { view: [{ id: 'sidebar', title: 'Repos' }] } })
    t.installed({ id: 'acme.sidebar', overrides: [{ id: SIDEBAR, title: 'Acme' }] })
    t.host.load()
    const { contribution } = await t.host.resolve(SIDEBAR)
    expect(contribution).toMatchObject({ plugin: 'acme.sidebar', data: { title: 'Acme' } })
    expect(t.stateOf('acme.sidebar')).toBe('active')
    expect(t.stateOf('quirky.sample')).toBe('inactive')
    expect(t.lines()).toEqual(['import acme.sidebar', 'activate acme.sidebar'])
  })
})

describe('SC-17: a disabled contribution', () => {
  test('SC-17: cannot be resolved and its owner does not activate', async () => {
    const t = setup({ disabled: [COMMAND] })
    t.installed({ id: 'acme.base' })
    t.installed(toolsManifest)
    t.host.load()
    await expect(t.host.resolve(COMMAND)).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
      message: `no contribution ${COMMAND} is in effect`
    })
    await expect(t.host.resolveImplementation(COMMAND)).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    expect(t.stateOf('acme.tools')).toBe('inactive')
    expect(t.lines()).toEqual([])
  })

  test('resolving an ID nobody declares is not found', async () => {
    const t = setup()
    t.host.load()
    await expect(t.host.resolve('command:acme.nope/x')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
  })
})

describe('activation', () => {
  test('activate rejects unknown, disabled and invalid plugins with the contract errors', async () => {
    const t = setup({ disabled: ['acme.off'] })
    t.installed({ id: 'acme.off' })
    writePlugin(t.installedDir, '{not json', {}, { dirName: 'acme.bad' })
    t.host.load()
    await expect(t.host.activate('acme.nope')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await expect(t.host.activate('acme.off')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.off is disabled'
    })
    await expect(t.host.activate('acme.bad')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.bad is invalid'
    })
  })

  test('a plugin without main becomes active without importing anything', async () => {
    const t = setup()
    writePlugin(t.installedDir, { id: 'acme.data', name: 'Data', version: '1.0.0' })
    t.host.load()
    const info = await t.host.activate('acme.data')
    expect(info.state).toBe('active')
  })

  test('concurrent activations run activate once and share the result', async () => {
    const t = setup()
    t.installed({ id: 'acme.tools' }, { activate: waitForFile(t.gate) })
    t.host.load()
    const first = t.host.activate('acme.tools')
    const second = t.host.activate('acme.tools')
    await until(() => t.lines().includes('activate acme.tools'))
    expect(t.stateOf('acme.tools')).toBe('activating')
    t.release()
    expect((await Promise.all([first, second])).map((info) => info.state)).toEqual(['active', 'active'])
    expect(t.lines().filter((line) => line === 'activate acme.tools')).toHaveLength(1)
  })

  test('a throw, a missing export and a timeout each fail the plugin, and activate tries again', async () => {
    const t = setup({ timeoutMs: 100 })
    t.installed({ id: 'acme.broken' }, { activate: `if (!existsSync(${JSON.stringify(t.gate)})) throw new Error('boom')` })
    t.installed({ id: 'acme.noexport' }, { omitActivate: true })
    t.installed({ id: 'acme.slow' }, { activate: 'await new Promise(() => {})' })
    t.host.load()

    await expect(t.host.activate('acme.broken')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.broken failed to activate: boom'
    })
    await expect(t.host.activate('acme.noexport')).rejects.toThrow('main module has no activate export')
    await expect(t.host.activate('acme.slow')).rejects.toThrow('activation timed out after 100 ms')
    expect(t.host.list().map((plugin) => [plugin.id, plugin.state])).toEqual([
      ['acme.broken', 'failed'],
      ['acme.noexport', 'failed'],
      ['acme.slow', 'failed']
    ])

    t.release()
    expect((await t.host.activate('acme.broken')).state).toBe('active')
    expect(t.host.list().find((plugin) => plugin.id === 'acme.broken')?.diagnostics).toEqual([])
  })

  test('a plugin whose dependency failed is failed with that reason', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { activate: "throw new Error('boom')" })
    t.installed(toolsManifest)
    t.host.load()
    await expect(t.host.activate('acme.tools')).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    const tools = t.host.list().find((plugin) => plugin.id === 'acme.tools')!
    expect(tools.state).toBe('failed')
    expect(tools.diagnostics).toContainEqual({ level: 'error', message: 'dependency acme.base failed to activate' })
    expect(t.lines()).not.toContain('import acme.tools')
  })

  test('failed activations and state changes emit plugin.changed', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' })
    t.host.load()
    await t.host.activate('acme.base')
    expect(t.events.length).toBeGreaterThanOrEqual(2)
    expect(t.events.every((event) => event.type === 'plugin.changed')).toBe(true)
  })

  test('plugin log lines are prefixed with the plugin ID', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { activate: "context.log('hello')" })
    t.host.load()
    await t.host.activate('acme.base')
    expect(t.logs).toContain('acme.base: hello')
  })

  test('every line of a multi-line plugin log message is prefixed with the plugin ID', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { activate: "context.log('one\\ntwo\\r\\nthree\\rfour')" })
    t.host.load()
    await t.host.activate('acme.base')
    expect(t.logs).toEqual(['acme.base: one', 'acme.base: two', 'acme.base: three', 'acme.base: four'])
  })

  test('activateStartup activates enabled startup plugins and never rejects', async () => {
    const t = setup({ disabled: ['acme.off'] })
    t.installed({ id: 'acme.watch', activation: 'startup' })
    t.installed({ id: 'acme.broken', activation: 'startup' }, { activate: "throw new Error('boom')" })
    t.installed({ id: 'acme.off', activation: 'startup' })
    t.installed({ id: 'acme.lazy' })
    t.host.load()
    await t.host.activateStartup()
    expect(t.host.list().map((plugin) => [plugin.id, plugin.state])).toEqual([
      ['acme.broken', 'failed'],
      ['acme.lazy', 'inactive'],
      ['acme.off', 'disabled'],
      ['acme.watch', 'active']
    ])
  })
})

describe('setEnabled', () => {
  test('rejects malformed and unknown IDs, and enabling an ID only the stored list knows is allowed', async () => {
    const t = setup({ disabled: ['acme.gone'] })
    t.installed({ id: 'acme.base' })
    t.host.load()
    await expect(t.host.setEnabled('Not An ID', false)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    await expect(t.host.setEnabled('acme.nope', false)).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await expect(t.host.setEnabled('acme.nope', true)).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await expect(t.host.setEnabled('command:acme.base/nope', false)).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
    expect(t.disabled.has('acme.nope')).toBe(false)
    await t.host.setEnabled('acme.gone', true)
    expect(t.disabled.size).toBe(0)
  })

  test('SC-18: disabling a plugin deactivates it and its dependents in reverse order, and enabling restores both', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' })
    t.installed(toolsManifest)
    t.host.load()
    await t.host.activate('acme.tools')
    t.events.length = 0

    await t.host.setEnabled('acme.base', false)
    expect(t.lines().slice(-2)).toEqual(['deactivate acme.tools', 'deactivate acme.base'])
    expect(t.stateOf('acme.base')).toBe('disabled')
    expect(t.stateOf('acme.tools')).toBe('disabled')
    expect(t.host.list().find((plugin) => plugin.id === 'acme.tools')?.diagnostics).toContainEqual({
      level: 'error',
      message: 'dependency acme.base is disabled'
    })
    expect(t.host.contributions()).toEqual([])
    expect(t.events.at(-1)).toEqual({ type: 'plugin.changed' })

    await t.host.setEnabled('acme.base', false)
    await t.host.setEnabled('acme.base', true)
    expect(t.stateOf('acme.base')).toBe('inactive')
    expect(t.stateOf('acme.tools')).toBe('inactive')
    expect(t.host.contributions().map((c) => c.id)).toEqual([COMMAND])
  })

  test('SC-26: enabling a startup plugin activates it before returning', async () => {
    const t = setup({ disabled: ['acme.watch'] })
    t.installed({ id: 'acme.watch', activation: 'startup' })
    t.host.load()
    await t.host.activateStartup()
    expect(t.stateOf('acme.watch')).toBe('disabled')
    await t.host.setEnabled('acme.watch', true)
    expect(t.stateOf('acme.watch')).toBe('active')
  })

  test('a startup plugin that fails when enabled is recorded, not thrown', async () => {
    const t = setup({ disabled: ['acme.watch'] })
    t.installed({ id: 'acme.watch', activation: 'startup' }, { activate: "throw new Error('boom')" })
    t.host.load()
    await t.host.setEnabled('acme.watch', true)
    expect(t.stateOf('acme.watch')).toBe('failed')
  })

  test('SC-20: a disabled contribution ID is out of effect and enabling it brings it back', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' })
    t.installed(toolsManifest)
    t.host.load()
    await t.host.setEnabled(COMMAND, false)
    expect(t.host.contributions()).toEqual([])
    expect(t.disabled.has(COMMAND)).toBe(true)
    await t.host.setEnabled(COMMAND, true)
    expect(t.host.contributions().map((c) => c.id)).toEqual([COMMAND])
  })
})

describe('SC-25: disabling while a plugin activates', () => {
  test('SC-25: a disable during the module activate waits, then deactivates; the activation reports it was disabled', async () => {
    const t = setup()
    t.installed(
      { id: 'acme.slowstart', contributes: { command: [{ id: 'go' }] } },
      { activate: `${waitForFile(t.gate)}\n  context.provide('command:acme.slowstart/go', 1)` }
    )
    t.host.load()
    const activation = t.host.activate('acme.slowstart')
    const outcome = activation.then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.slowstart'))
    const disabling = t.host.setEnabled('acme.slowstart', false)
    expect(await settled(disabling)).toBe(false)
    expect(t.lines()).not.toContain('deactivate acme.slowstart')

    t.release()
    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.slowstart was disabled during activation' })
    await disabling
    expect(t.lines()).toEqual(['import acme.slowstart', 'activate acme.slowstart', 'deactivate acme.slowstart'])
    expect(t.stateOf('acme.slowstart')).toBe('disabled')
    await expect(t.host.resolve('command:acme.slowstart/go')).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await t.host.setEnabled('acme.slowstart', true)
    expect(t.stateOf('acme.slowstart')).toBe('inactive')
  })

  test('SC-25: disabling a dependent while its dependency activates stops it before its module is imported', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { activate: waitForFile(t.gate) })
    t.installed(toolsManifest)
    t.host.load()
    const activation = t.host.activate('acme.tools')
    const outcome = activation.then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.base'))

    const disabling = t.host.setEnabled('acme.tools', false)
    expect(await settled(disabling)).toBe(false)
    t.release()
    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.tools was disabled during activation' })
    await disabling
    expect(t.stateOf('acme.tools')).toBe('disabled')
    expect(t.stateOf('acme.base')).toBe('active')
    expect(t.lines()).toEqual(['import acme.base', 'activate acme.base'])
  })

  test('SC-25: disabling the dependency itself during its activation disables and unwinds both', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { activate: waitForFile(t.gate) })
    t.installed(toolsManifest)
    t.host.load()
    const activation = t.host.activate('acme.tools')
    const outcome = activation.then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.base'))

    const disabling = t.host.setEnabled('acme.base', false)
    t.release()
    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.tools was disabled during activation' })
    await disabling
    expect(t.stateOf('acme.base')).toBe('disabled')
    expect(t.stateOf('acme.tools')).toBe('disabled')
    expect(t.lines()).toEqual(['import acme.base', 'activate acme.base', 'deactivate acme.base'])
  })

  test('a disable during an activate that then rejects still calls deactivate and ends disabled', async () => {
    const t = setup()
    t.installed({ id: 'acme.slowfail' }, { activate: `${waitForFile(t.gate)}\n  throw new Error('boom')` })
    t.host.load()
    const outcome = t.host.activate('acme.slowfail').then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.slowfail'))
    const disabling = t.host.setEnabled('acme.slowfail', false)
    expect(await settled(disabling)).toBe(false)

    t.release()
    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.slowfail was disabled during activation' })
    await disabling
    expect(t.lines()).toEqual(['import acme.slowfail', 'activate acme.slowfail', 'deactivate acme.slowfail'])
    expect(t.stateOf('acme.slowfail')).toBe('disabled')
  })

  test('a disable during an activate that times out still calls deactivate and ends disabled', async () => {
    const t = setup({ timeoutMs: 100 })
    t.installed({ id: 'acme.hang' }, { activate: 'await new Promise(() => {})' })
    t.host.load()
    const outcome = t.host.activate('acme.hang').then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.hang'))
    const disabling = t.host.setEnabled('acme.hang', false)

    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.hang was disabled during activation' })
    await disabling
    expect(t.lines()).toEqual(['import acme.hang', 'activate acme.hang', 'deactivate acme.hang'])
    expect(t.stateOf('acme.hang')).toBe('disabled')
  })

  test('an import that outlives the activation timeout never calls activate', async () => {
    const t = setup({ timeoutMs: 100 })
    writeSlowImportPlugin(t, 'acme.slowimport')
    t.host.load()
    await expect(t.host.activate('acme.slowimport')).rejects.toThrow('activation timed out after 100 ms')
    expect(t.stateOf('acme.slowimport')).toBe('failed')

    t.release()
    await until(() => t.lines().includes('import acme.slowimport'))
    await Bun.sleep(40)
    expect(t.lines()).toEqual(['import acme.slowimport'])
    expect(t.stateOf('acme.slowimport')).toBe('failed')
  })

  test('an import that finishes after a disable and a timeout never calls activate, and the plugin ends disabled', async () => {
    const t = setup({ timeoutMs: 100 })
    writeSlowImportPlugin(t, 'acme.slowimport')
    t.host.load()
    const outcome = t.host.activate('acme.slowimport').then(() => null, (error: unknown) => error)
    await Bun.sleep(40)
    const disabling = t.host.setEnabled('acme.slowimport', false)

    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.slowimport was disabled during activation' })
    await disabling
    expect(t.stateOf('acme.slowimport')).toBe('disabled')

    t.release()
    await until(() => t.lines().includes('import acme.slowimport'))
    await Bun.sleep(40)
    expect(t.lines()).toEqual(['import acme.slowimport'])
    expect(t.stateOf('acme.slowimport')).toBe('disabled')
  })

  test('resolve is not found when the contribution is disabled while its owner activates', async () => {
    const t = setup()
    t.installed(
      { id: 'acme.tools', contributes: { command: [{ id: 'refresh' }] } },
      { activate: `${waitForFile(t.gate)}\n  ${provideRefresh}` }
    )
    t.host.load()
    const resolving = t.host.resolve(COMMAND).then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.tools'))
    await t.host.setEnabled(COMMAND, false)

    t.release()
    expect(await resolving).toMatchObject({ code: RpcErrorCode.NotFound, message: `no contribution ${COMMAND} is in effect` })
  })

  test('setEnabled calls run one at a time', async () => {
    const t = setup()
    t.installed({ id: 'acme.slow' }, { deactivate: waitForFile(t.gate) })
    t.installed({ id: 'acme.other' })
    t.host.load()
    await t.host.activate('acme.slow')

    const first = t.host.setEnabled('acme.slow', false)
    await until(() => t.lines().includes('deactivate acme.slow'))
    const second = t.host.setEnabled('acme.other', false)
    expect(await settled(second)).toBe(false)
    expect(t.disabled.has('acme.other')).toBe(false)
    t.release()
    await Promise.all([first, second])
    expect([...t.disabled].sort()).toEqual(['acme.other', 'acme.slow'])
  })
})

describe('deactivation failures', () => {
  test('SC-18: a deactivate that throws still completes the disable and leaves a warning', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { activate: "context.log('up')", deactivate: "throw new Error('nope')" })
    t.host.load()
    await t.host.activate('acme.base')
    await t.host.setEnabled('acme.base', false)
    const info = t.host.list()[0]
    expect(info.state).toBe('disabled')
    expect(info.diagnostics).toContainEqual({ level: 'warning', message: 'deactivate failed: nope' })
    expect(t.events.at(-1)).toEqual({ type: 'plugin.changed' })

    await t.host.setEnabled('acme.base', true)
    expect(t.stateOf('acme.base')).toBe('inactive')
    expect((await t.host.activate('acme.base')).diagnostics).toEqual([])
  })

  test('SC-18: a deactivate that never settles times out, drops implementations and leaves a warning', async () => {
    const t = setup({ timeoutMs: 100 })
    t.installed(
      { id: 'acme.tools', contributes: { command: [{ id: 'refresh' }] } },
      { activate: provideRefresh, deactivate: 'await new Promise(() => {})' }
    )
    t.host.load()
    await t.host.resolve(COMMAND)
    const started = Date.now()
    await t.host.setEnabled('acme.tools', false)
    expect(Date.now() - started).toBeLessThan(1500)
    const info = t.host.list()[0]
    expect(info.state).toBe('disabled')
    expect(info.diagnostics).toContainEqual({ level: 'warning', message: 'deactivate timed out after 100 ms' })
    await expect(t.host.resolve(COMMAND)).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
    await t.host.setEnabled('acme.tools', true)
    expect(await t.host.resolveImplementation(COMMAND)).toEqual({ run: expect.any(Function) })
  })
})

describe('who disabled a contribution', () => {
  const declares = { contributes: { command: [{ id: 'a' }, { id: 'b' }] } }

  test('a contribution only the distro disables reports the distro; one the user also disables reports the user', () => {
    const t = setup({ disabled: ['command:acme.tools/b'], distroDisabled: ['command:acme.tools/a', 'command:acme.tools/b'] })
    t.installed({ id: 'acme.tools', ...declares })
    t.host.load()

    const disabledBy = (id: string) => t.host.contributions({ all: true }).find((item) => item.id === id)?.disabledBy
    expect(disabledBy('command:acme.tools/a')).toBe('distro')
    expect(disabledBy('command:acme.tools/b')).toBe('user')
  })

  test('a plugin only the distro disables reports the distro', () => {
    const t = setup({ distroDisabled: ['acme.tools'] })
    t.installed({ id: 'acme.tools', ...declares })
    t.host.load()

    expect(t.host.list().find((plugin) => plugin.id === 'acme.tools')).toMatchObject({ state: 'disabled', disabledReason: 'distro' })
  })
})

describe('stop', () => {
  test('SC-24: stop deactivates active plugins in reverse activation order and survives a throwing deactivate', async () => {
    const t = setup()
    t.installed({ id: 'acme.base' }, { deactivate: "throw new Error('nope')" })
    t.installed(toolsManifest)
    t.host.load()
    await t.host.activate('acme.tools')
    await t.host.stop()
    expect(t.lines().slice(-2)).toEqual(['deactivate acme.tools', 'deactivate acme.base'])
  })

  test('stop waits for an in-flight activation, then deactivates it', async () => {
    const t = setup()
    t.installed({ id: 'acme.slow' }, { activate: waitForFile(t.gate) })
    t.host.load()
    const activation = t.host.activate('acme.slow')
    await until(() => t.lines().includes('activate acme.slow'))
    const stopping = t.host.stop()
    expect(await settled(stopping)).toBe(false)
    t.release()
    await activation
    await stopping
    expect(t.lines().slice(-2)).toEqual(['activate acme.slow', 'deactivate acme.slow'])
  })

  test('stop bounds a hung deactivate by the timeout', async () => {
    const t = setup({ timeoutMs: 100 })
    t.installed({ id: 'acme.hung' }, { deactivate: 'await new Promise(() => {})' })
    t.host.load()
    await t.host.activate('acme.hung')
    const started = Date.now()
    await t.host.stop()
    expect(Date.now() - started).toBeLessThan(1500)
  })
})
