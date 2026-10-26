import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { PluginHost, type ContextExtension } from '../../src/plugins/host'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin, type ModuleBehavior } from './fixtures'

afterEach(removeTempDirs)

type Setup = ReturnType<typeof setup>

function setup(options: { withExtension?: boolean; throwOnRevoke?: boolean } = {}) {
  const root = makeTempDir()
  const builtinDir = join(root, 'builtin')
  const installedDir = join(root, 'installed')
  mkdirSync(builtinDir)
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const gate = join(root, 'gate')
  const disabled = new Set<string>()
  const events: QuirkyEvent[] = []
  const logs: string[] = []
  const created: string[] = []
  const revoked: string[] = []
  const isRevokedByPlugin = new Map<string, () => boolean>()
  const extension: ContextExtension = {
    create: (plugin, isRevoked) => {
      created.push(plugin.id)
      appendFileSync(marker, `create ${plugin.id}\n`)
      isRevokedByPlugin.set(plugin.id, isRevoked)
      return {
        dataDir: `/data/${plugin.id}`,
        emit: () => true,
        subscribe: () => () => undefined,
        call: async () => null,
        openStore: () => {
          throw new Error('unused')
        },
        error: (_kind, message) => new Error(`ext:${message}`)
      }
    },
    revoke: (pluginId) => {
      revoked.push(pluginId)
      appendFileSync(marker, `revoke ${pluginId}\n`)
      if (options.throwOnRevoke) throw new Error('revoke blew up')
    }
  }
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
    activationTimeoutMs: 200,
    ...(options.withExtension === false ? {} : { extension })
  })
  const installed = (manifest: { id: string } & Record<string, unknown>, behavior?: ModuleBehavior) =>
    writeModulePlugin(installedDir, marker, manifest, behavior)
  const lines = () => readMarker(marker)
  const stateOf = (id: string) => host.list().find((plugin) => plugin.id === id)?.state
  const release = () => writeFileSync(gate, '')
  return { host, events, logs, created, revoked, isRevokedByPlugin, marker, gate, installed, lines, stateOf, release }
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until timed out')
    await Bun.sleep(5)
  }
}

const CAPTURE = `record('emit ' + typeof context.emit + ' data ' + context.dataDir + ' err ' + context.error('conflict', 'm').message)`
const withCommand = { contributes: { command: [{ id: 'go' }] } }

describe('context extension', () => {
  test('create runs before activate and its members reach the plugin context', async () => {
    const t = setup()
    t.installed({ id: 'acme.one' }, { activate: CAPTURE })
    t.host.load()
    await t.host.activate('acme.one')
    expect(t.lines()).toEqual([
      'create acme.one',
      'import acme.one',
      'activate acme.one',
      'emit function data /data/acme.one err ext:m'
    ])
  })

  test('without an extension the context members keep their defaults', async () => {
    const t = setup({ withExtension: false })
    t.installed(
      { id: 'acme.one' },
      {
        activate: [
          'let threw = ""',
          'try { context.emit("x") } catch (error) { threw = (error as Error).message }',
          "record('emit threw ' + threw + ' dataDir [' + context.dataDir + '] ' + context.error('conflict', 'm').message)"
        ].join('\n  ')
      }
    )
    t.host.load()
    await t.host.activate('acme.one')
    expect(t.lines()).toContain('emit threw acme.one: context.emit is not available dataDir [] m')
    expect(t.created).toEqual([])
  })

  test('isRevoked flips to true after deactivate', async () => {
    const t = setup()
    t.installed({ id: 'acme.one' })
    t.host.load()
    await t.host.activate('acme.one')
    const isRevoked = t.isRevokedByPlugin.get('acme.one')!
    expect(isRevoked()).toBe(false)
    await t.host.stop()
    expect(isRevoked()).toBe(true)
  })

  test('revoke runs once after a failed activate', async () => {
    const t = setup()
    t.installed({ id: 'acme.bad' }, { activate: "throw new Error('boom')" })
    t.host.load()
    await expect(t.host.activate('acme.bad')).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect(t.revoked).toEqual(['acme.bad'])
    expect(t.isRevokedByPlugin.get('acme.bad')!()).toBe(true)
    await t.host.stop()
    expect(t.revoked).toEqual(['acme.bad'])
  })

  test('revoke runs once after an activation timeout and after a missing activate export', async () => {
    const t = setup()
    t.installed({ id: 'acme.hang' }, { activate: 'await new Promise(() => {})' })
    t.installed({ id: 'acme.noactivate' }, { omitActivate: true })
    t.host.load()
    await expect(t.host.activate('acme.hang')).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    await expect(t.host.activate('acme.noactivate')).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect([...t.revoked].sort()).toEqual(['acme.hang', 'acme.noactivate'])
  })

  test('revoke runs once after the module deactivate, on a live disable', async () => {
    const t = setup()
    t.installed({ id: 'acme.one' })
    t.host.load()
    await t.host.activate('acme.one')
    expect(t.revoked).toEqual([])
    await t.host.setEnabled('acme.one', false)
    expect(t.lines()).toEqual(['create acme.one', 'import acme.one', 'activate acme.one', 'deactivate acme.one', 'revoke acme.one'])
    await t.host.stop()
    expect(t.revoked).toEqual(['acme.one'])
  })

  test('revoke runs once per plugin on stop, after each deactivate', async () => {
    const t = setup()
    t.installed({ id: 'acme.a' })
    t.installed({ id: 'acme.b' })
    t.host.load()
    await t.host.activate('acme.a')
    await t.host.activate('acme.b')
    await t.host.stop()
    expect(t.lines().slice(-4)).toEqual(['deactivate acme.b', 'revoke acme.b', 'deactivate acme.a', 'revoke acme.a'])
    expect(t.revoked).toEqual(['acme.b', 'acme.a'])
  })

  test('revoke runs right away for a module without deactivate', async () => {
    const t = setup()
    t.installed({ id: 'acme.one' }, { omitDeactivate: true })
    t.host.load()
    await t.host.activate('acme.one')
    await t.host.stop()
    expect(t.revoked).toEqual(['acme.one'])
  })

  test('revoke runs after a deactivate that throws, and after one that times out', async () => {
    const t = setup()
    t.installed({ id: 'acme.throws' }, { deactivate: "throw new Error('nope')" })
    t.installed({ id: 'acme.hangs' }, { deactivate: 'await new Promise(() => {})' })
    t.host.load()
    await t.host.activate('acme.throws')
    await t.host.activate('acme.hangs')
    await t.host.stop()
    expect([...t.revoked].sort()).toEqual(['acme.hangs', 'acme.throws'])
  })

  test('revoke runs once when the plugin is disabled during activation', async () => {
    const t = setup()
    t.installed({ id: 'acme.slow', ...withCommand }, { activate: `${waitForFile(t.gate)}\n  context.provide('command:acme.slow/go', 1)` })
    t.host.load()
    const outcome = t.host.activate('acme.slow').then(() => null, (error: unknown) => error)
    await until(() => t.lines().includes('activate acme.slow'))
    const disabling = t.host.setEnabled('acme.slow', false)
    await Bun.sleep(30)
    expect(t.revoked).toEqual([])
    t.release()
    expect(await outcome).toMatchObject({ code: RpcErrorCode.Conflict, message: 'acme.slow was disabled during activation' })
    await disabling
    expect(t.revoked).toEqual(['acme.slow'])
    expect(t.lines().slice(-2)).toEqual(['deactivate acme.slow', 'revoke acme.slow'])
  })

  test('revoke is not called for a plugin that never activated', async () => {
    const t = setup()
    t.installed({ id: 'acme.idle' })
    t.host.load()
    await t.host.activateStartup()
    await t.host.stop()
    expect(t.created).toEqual([])
    expect(t.revoked).toEqual([])
  })

  test('revoke is not called when no module is imported for the plugin', async () => {
    const t = setup()
    t.installed({ id: 'acme.nomain', main: undefined })
    t.host.load()
    await t.host.activate('acme.nomain')
    await t.host.stop()
    expect(t.created).toEqual([])
    expect(t.revoked).toEqual([])
  })

  test('a throw from revoke is logged with the plugin ID and swallowed', async () => {
    const t = setup({ throwOnRevoke: true })
    t.installed({ id: 'acme.one' })
    t.host.load()
    await t.host.activate('acme.one')
    await t.host.stop()
    expect(t.revoked).toEqual(['acme.one'])
    expect(t.logs.some((line) => line.includes('acme.one') && line.includes('revoke blew up'))).toBe(true)
  })

  test('a plugin that fails to activate again gets a fresh create and revoke each attempt', async () => {
    const t = setup()
    t.installed({ id: 'acme.bad' }, { activate: "throw new Error('boom')" })
    t.host.load()
    await expect(t.host.activate('acme.bad')).rejects.toBeDefined()
    await expect(t.host.activate('acme.bad')).rejects.toBeDefined()
    expect(t.created).toEqual(['acme.bad', 'acme.bad'])
    expect(t.revoked).toEqual(['acme.bad', 'acme.bad'])
  })
})

describe('provide checks function-valued kinds', () => {
  const cases: Array<[string, string]> = [
    ['method', 'method:acme.fn/ping'],
    ['job', 'job:acme.fn/tick'],
    ['launch-hook', 'launch-hook:acme.fn/patch']
  ]
  const manifest = {
    id: 'acme.fn',
    contributes: { method: [{ id: 'ping' }], job: [{ id: 'tick', interval: '1m' }], 'launch-hook': [{ id: 'patch' }], command: [{ id: 'go' }] }
  }

  for (const [kind, id] of cases) {
    test(`a non-function for ${kind}: fails activation with the exact message`, async () => {
      const t = setup()
      t.installed(manifest, { activate: `context.provide(${JSON.stringify(id)}, { not: 'a function' })` })
      t.host.load()
      await expect(t.host.activate('acme.fn')).rejects.toMatchObject({
        code: RpcErrorCode.Conflict,
        message: `acme.fn failed to activate: ${id} must be provided as a function`
      })
      expect(t.stateOf('acme.fn')).toBe('failed')
      expect(t.host.list()[0]!.diagnostics).toContainEqual({ level: 'error', message: `${id} must be provided as a function` })
    })

    test(`a function for ${kind} is accepted`, async () => {
      const t = setup()
      t.installed(manifest, { activate: `context.provide(${JSON.stringify(id)}, () => 'ok')` })
      t.host.load()
      await t.host.activate('acme.fn')
      expect(typeof (await t.host.resolveImplementation(id))).toBe('function')
    })
  }

  test('a non-function for command is accepted', async () => {
    const t = setup()
    t.installed(manifest, { activate: "context.provide('command:acme.fn/go', { run: 1 })" })
    t.host.load()
    await t.host.activate('acme.fn')
    expect(await t.host.resolveImplementation('command:acme.fn/go')).toEqual({ run: 1 })
  })
})

describe('addWarning', () => {
  const changes = (t: Setup) => t.events.filter((event) => event.type === 'plugin.changed').length

  test('shows in list diagnostics and emits plugin.changed', async () => {
    const t = setup()
    t.installed({ id: 'acme.one' })
    t.host.load()
    await t.host.activate('acme.one')
    const before = changes(t)
    t.host.addWarning('acme.one', 'something odd')
    expect(changes(t)).toBe(before + 1)
    expect(t.host.list()[0]!.diagnostics).toContainEqual({ level: 'warning', message: 'something odd' })
  })

  test('is ignored for an unknown plugin ID', () => {
    const t = setup()
    t.host.load()
    const before = changes(t)
    t.host.addWarning('acme.ghost', 'nobody home')
    expect(changes(t)).toBe(before)
    expect(t.host.list()).toEqual([])
  })

  test('is cleared by the next activation', async () => {
    const t = setup()
    t.installed({ id: 'acme.one' })
    t.host.load()
    await t.host.activate('acme.one')
    t.host.addWarning('acme.one', 'something odd')
    await t.host.setEnabled('acme.one', false)
    await t.host.setEnabled('acme.one', true)
    await t.host.activate('acme.one')
    expect(t.host.list()[0]!.diagnostics).toEqual([])
  })
})
