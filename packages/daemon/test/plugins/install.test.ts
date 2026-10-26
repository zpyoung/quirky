import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type PluginInspection } from '@quirky/protocol'
import { inspectPlugin, installPlugin, renderInspection, uninstallPlugin } from '../../src/plugins/install'
import { PluginHost } from '../../src/plugins/host'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, writePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

async function codeOf(work: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await work
  } catch (error) {
    if (error instanceof RpcError) return { code: error.code, message: error.message }
    const daemonError = error as { code: number; message: string }
    return { code: daemonError.code, message: daemonError.message }
  }
  throw new Error('expected the call to fail')
}

function acmeManifest(extra: Record<string, unknown> = {}, version = '1.0.0') {
  return {
    id: 'acme.tools',
    name: 'Acme tools',
    version,
    main: 'main.ts',
    contributes: {
      method: [{ id: 'greet' }],
      panel: [{ id: 'notes', title: 'Notes' }],
      keybinding: [{ id: 'open', key: 'mod+shift+n', command: 'command:acme.tools/open' }]
    },
    overrides: [{ id: 'panel:quirky.git/source-control', title: 'Acme source control' }],
    ...extra
  }
}

/** A built-in `quirky.git` fixture that owns the panel the sample plugin overrides. */
function writeBuiltinGit(builtinDir: string, marker: string) {
  writeModulePlugin(builtinDir, marker, {
    id: 'quirky.git',
    contributes: { panel: [{ id: 'source-control', title: 'Source control' }] }
  })
}

describe('plugin install', () => {
  test('SC-49: inspect lists every contribution and runs no plugin code', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const builtinDir = join(scratch, 'builtin')
    mkdirSync(builtinDir)
    writeBuiltinGit(builtinDir, join(scratch, 'builtin-marker.log'))
    const source = writeModulePlugin(join(scratch, 'src'), marker, acmeManifest())
    h = await startHarness({ home, builtinPluginsDir: builtinDir })
    const client = await h.connect()

    const inspection = await client.call('plugin.inspect', { path: source })

    expect(inspection).toMatchObject({ id: 'acme.tools', name: 'Acme tools', version: '1.0.0' })
    expect(inspection.contributions.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: 'method', id: 'method:acme.tools/greet' },
      { kind: 'panel', id: 'panel:acme.tools/notes' },
      { kind: 'keybinding', id: 'keybinding:acme.tools/open' }
    ])
    expect(inspection.contributions[2].data).toEqual({ key: 'mod+shift+n', command: 'command:acme.tools/open' })
    expect(inspection.overrides).toEqual([{ id: 'panel:quirky.git/source-control', replaces: 'quirky.git' }])
    expect(inspection.installed).toBeUndefined()
    expect(renderInspection(inspection)).toBe(
      [
        'acme.tools 1.0.0 (Acme tools)',
        'method     method:acme.tools/greet',
        'panel      panel:acme.tools/notes',
        'keybinding keybinding:acme.tools/open  mod+shift+n',
        "override   panel:quirky.git/source-control (replaces quirky.git's)"
      ].join('\n')
    )
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(home, 'plugins', 'acme.tools'))).toBe(false)
  })

  test('inspect names the plugin that owns an override target, lists disables, and refuses an invalid manifest', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    writePlugin(join(h.home, 'plugins'), {
      id: 'acme.base',
      name: 'Base',
      version: '1.0.0',
      contributes: { panel: [{ id: 'main', title: 'Main' }] }
    })
    await h.daemon.plugins.rescan()
    const source = writePlugin(join(scratch, 'src'), {
      id: 'acme.over',
      name: 'Over',
      version: '1.0.0',
      overrides: [{ id: 'panel:acme.base/main', title: 'Mine' }],
      disables: ['panel:acme.base/other']
    })

    const inspection = await client.call('plugin.inspect', { path: source })
    expect(inspection.overrides).toEqual([{ id: 'panel:acme.base/main', replaces: 'acme.base' }])
    expect(inspection.disables).toEqual(['panel:acme.base/other'])
    expect(renderInspection(inspection)).toContain('disables   panel:acme.base/other')

    const broken = writePlugin(join(scratch, 'src'), { id: 'acme.bad', name: 'Bad', version: 1, extra: true })
    const refused = await codeOf(client.call('plugin.inspect', { path: broken }))
    expect(refused.code).toBe(RpcErrorCode.InvalidParams)
    expect(refused.message).toContain("unknown field 'extra'")
    expect(refused.message).toContain("field 'version' must be a non-empty string")

    expect((await codeOf(client.call('plugin.inspect', { path: join(scratch, 'missing') }))).code).toBe(RpcErrorCode.NotFound)
    const empty = join(scratch, 'empty')
    mkdirSync(empty)
    expect((await codeOf(client.call('plugin.inspect', { path: empty }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('SC-50: installing copies the plugin into the home and takes effect without a restart', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const source = writeModulePlugin(join(scratch, 'src'), marker, acmeManifest({ overrides: undefined }), {
      activate: "context.provide('method:acme.tools/greet', () => 'hello')"
    })
    h = await startHarness({ home, builtinPluginsDir: null })
    const { client, events } = await h.connectWithEvents()

    const info = await client.call('plugin.install', { path: source, yes: true })

    expect(info).toMatchObject({ id: 'acme.tools', source: 'installed', version: '1.0.0' })
    expect(info.dir).toBe(join(home, 'plugins', 'acme.tools'))
    expect(existsSync(join(home, 'plugins', 'acme.tools', 'quirky-plugin.json'))).toBe(true)
    expect(existsSync(join(home, 'plugins', '.tmp-acme.tools'))).toBe(false)
    expect((await client.call('plugin.list', {})).map((plugin) => plugin.id)).toContain('acme.tools')
    expect(events.some((event) => event.type === 'plugin.changed')).toBe(true)
    expect((await client.call('plugin.contributions', { kind: 'method' })).map((item) => item.id)).toContain('method:acme.tools/greet')
    expect(readMarker(marker)).toEqual([])
  })

  test('install refuses an invalid manifest, a built-in ID and a plugin owned by the distro', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const builtinDir = join(scratch, 'builtin')
    mkdirSync(builtinDir)
    writeBuiltinGit(builtinDir, join(scratch, 'm.log'))
    h = await startHarness({ home, builtinPluginsDir: builtinDir })
    const client = await h.connect()

    const invalid = writePlugin(join(scratch, 'src'), { id: 'acme.bad', name: 'Bad' })
    const invalidError = await codeOf(client.call('plugin.install', { path: invalid, yes: true }))
    expect(invalidError.code).toBe(RpcErrorCode.InvalidParams)
    expect(invalidError.message).toContain("missing required field 'version'")

    const builtin = writePlugin(join(scratch, 'src'), { id: 'quirky.git', name: 'Mine', version: '9.0.0' })
    expect((await codeOf(client.call('plugin.install', { path: builtin, yes: true }))).code).toBe(RpcErrorCode.Conflict)

    const owned = writePlugin(join(scratch, 'src'), { id: 'night.extras', name: 'Extras', version: '1.0.0' })
    const deps = { home, plugins: h.daemon.plugins, log: () => {}, distroOf: (id: string) => (id === 'night.extras' ? 'night' : null) }
    const ownedError = await codeOf(installPlugin(deps, owned))
    expect(ownedError.code).toBe(RpcErrorCode.Conflict)
    expect(ownedError.message).toContain('night')
    expect(existsSync(join(home, 'plugins', 'night.extras'))).toBe(false)
    expect(existsSync(join(home, 'plugins', 'acme.bad'))).toBe(false)
  })

  test('SC-51: reinstalling shows the version change and what was added and removed, and replaces the running code', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const v1 = writeModulePlugin(join(scratch, 'v1'), marker, acmeManifest({ overrides: undefined, activation: 'startup' }))
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    await client.call('plugin.install', { path: v1, yes: true })
    await waitFor(() => readMarker(marker).includes('activate acme.tools'))

    const v2 = writeModulePlugin(
      join(scratch, 'v2'),
      marker,
      acmeManifest(
        {
          activation: 'startup',
          overrides: undefined,
          contributes: {
            method: [{ id: 'greet' }, { id: 'wave' }],
            keybinding: [{ id: 'open', key: 'mod+shift+n', command: 'command:acme.tools/open' }]
          }
        },
        '1.1.0'
      )
    )
    const inspection = await client.call('plugin.inspect', { path: v2 })
    expect(inspection.installed).toEqual({
      version: '1.0.0',
      added: ['method:acme.tools/wave'],
      removed: ['panel:acme.tools/notes']
    })
    const listing = renderInspection(inspection)
    expect(listing.split('\n')[0]).toBe('acme.tools 1.0.0 → 1.1.0 (Acme tools)')
    expect(listing).toContain('+ method:acme.tools/wave')
    expect(listing).toContain('- panel:acme.tools/notes')
    expect((await client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.tools')?.version).toBe('1.0.0')

    await client.call('plugin.install', { path: v2, yes: true })

    const reinstalled = (await client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.tools')!
    expect(reinstalled.version).toBe('1.1.0')
    await waitFor(() => readMarker(marker).filter((line) => line === 'activate acme.tools').length === 2)
    expect(readMarker(marker)).toContain('deactivate acme.tools')
    expect((await client.call('plugin.contributions', { kind: 'panel' })).map((item) => item.id)).not.toContain('panel:acme.tools/notes')
  })

  test('SC-52: changing or deleting the source directory after install changes nothing, across a restart', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const source = writeModulePlugin(join(scratch, 'src'), marker, acmeManifest({ overrides: undefined, activation: 'startup' }))
    h = await startHarness({ home, builtinPluginsDir: null })
    await (await h.connect()).call('plugin.install', { path: source, yes: true })
    await waitFor(() => readMarker(marker).includes('activate acme.tools'))
    const installedMain = readFileSync(join(home, 'plugins', 'acme.tools', 'main.ts'), 'utf8')

    writeFileSync(join(source, 'main.ts'), installedMain.replace(/acme\.tools/g, 'acme.changed'))
    writeFileSync(join(source, 'quirky-plugin.json'), JSON.stringify(acmeManifest({}, '2.0.0')))
    for (const client of h.clients) client.close()
    await h.daemon.stop()
    h.pty.stop()
    writeFileSync(marker, '')

    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    await waitFor(() => readMarker(marker).includes('activate acme.tools'))
    expect(readFileSync(join(home, 'plugins', 'acme.tools', 'main.ts'), 'utf8')).toBe(installedMain)
    expect((await client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.tools')).toMatchObject({
      version: '1.0.0',
      state: 'active'
    })
    expect(readMarker(marker)).toContain('activate acme.tools')
    expect(readMarker(marker).filter((line) => line.includes('acme.changed'))).toEqual([])
  })

  test('install refuses a symlink that resolves outside the source directory and leaves nothing behind', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const outside = join(scratch, 'outside.txt')
    writeFileSync(outside, 'secret')
    const source = writePlugin(join(scratch, 'src'), { id: 'acme.link', name: 'Link', version: '1.0.0' })
    symlinkSync(outside, join(source, 'leak.txt'))
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()

    const refused = await codeOf(client.call('plugin.install', { path: source, yes: true }))

    expect(refused.code).toBe(RpcErrorCode.InvalidParams)
    expect(refused.message).toContain('leak.txt')
    expect(existsSync(join(home, 'plugins', 'acme.link'))).toBe(false)
    expect(existsSync(join(home, 'plugins', '.tmp-acme.link'))).toBe(false)
  })

  test('install copies a symlink that stays inside the source directory as its target content', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const source = writePlugin(join(scratch, 'src'), { id: 'acme.link', name: 'Link', version: '1.0.0' }, { 'data/real.txt': 'inside' })
    symlinkSync(join(source, 'data', 'real.txt'), join(source, 'alias.txt'))
    h = await startHarness({ home, builtinPluginsDir: null })

    await (await h.connect()).call('plugin.install', { path: source, yes: true })

    expect(readFileSync(join(home, 'plugins', 'acme.link', 'alias.txt'), 'utf8')).toBe('inside')
  })

  test('SC-53: uninstall removes the plugin, its data and its contributions; built-ins and unknown IDs are refused', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const builtinDir = join(scratch, 'builtin')
    mkdirSync(builtinDir)
    writeBuiltinGit(builtinDir, join(scratch, 'm.log'))
    const source = writeModulePlugin(join(scratch, 'src'), marker, acmeManifest({ overrides: undefined, activation: 'startup' }))
    h = await startHarness({ home, builtinPluginsDir: builtinDir })
    const client = await h.connect()
    await client.call('plugin.install', { path: source, yes: true })
    await waitFor(() => readMarker(marker).includes('activate acme.tools'))
    mkdirSync(join(home, 'plugin-data', 'acme.tools'), { recursive: true })
    writeFileSync(join(home, 'plugin-data', 'acme.tools', 'note.txt'), 'data')

    expect(await client.call('plugin.uninstall', { id: 'acme.tools', yes: true })).toEqual({ ok: true })

    expect(existsSync(join(home, 'plugins', 'acme.tools'))).toBe(false)
    expect(existsSync(join(home, 'plugin-data', 'acme.tools'))).toBe(false)
    expect((await client.call('plugin.list', {})).map((plugin) => plugin.id)).not.toContain('acme.tools')
    expect((await client.call('plugin.contributions', {})).map((item) => item.plugin)).not.toContain('acme.tools')
    expect(readMarker(marker)).toContain('deactivate acme.tools')

    const builtin = await codeOf(client.call('plugin.uninstall', { id: 'quirky.git', yes: true }))
    expect(builtin.code).toBe(RpcErrorCode.InvalidParams)
    expect(builtin.message).toBe('built-in plugins can be disabled but not removed')
    expect((await codeOf(client.call('plugin.uninstall', { id: 'acme.tools', yes: true }))).code).toBe(RpcErrorCode.NotFound)
    expect((await codeOf(client.call('plugin.uninstall', { id: '../etc', yes: true }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('uninstall refuses a plugin the distro owns', async () => {
    const home = makeTempHome()
    h = await startHarness({ home, builtinPluginsDir: null })
    writePlugin(join(home, 'plugins'), { id: 'night.extras', name: 'Extras', version: '1.0.0' })
    h.daemon.plugins.load()
    const deps = { home, plugins: h.daemon.plugins, log: () => {}, distroOf: () => 'night' }

    const refused = await codeOf(uninstallPlugin(deps, 'night.extras'))

    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.message).toContain('night')
    expect(existsSync(join(home, 'plugins', 'night.extras'))).toBe(true)
  })

  test('inspectPlugin is usable directly and reports the installed copy when reinstalling', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    h = await startHarness({ home, builtinPluginsDir: null })
    const deps = { home, plugins: h.daemon.plugins, log: () => {} }
    const source = writePlugin(join(scratch, 'whatever-name'), { id: 'acme.tools', name: 'Acme', version: '1.0.0' }, {}, { dirName: 'dir-differs' })

    const inspection: PluginInspection = inspectPlugin(deps, source)

    expect(inspection.id).toBe('acme.tools')
    await installPlugin(deps, source)
    expect(inspectPlugin(deps, source).installed).toEqual({ version: '1.0.0', added: [], removed: [] })
  })
})

describe('reinstalling an activated plugin', () => {
  /** A method plugin whose main module and helper both return `n`, so a stale cache of either shows. */
  function writeCounter(root: string, n: number, version: string): string {
    return writePlugin(
      root,
      { id: 'acme.counter', name: 'Counter', version, main: 'main.ts', contributes: { method: [{ id: 'get' }] } },
      {
        'main.ts': [
          "import { helper } from './lib/helper'",
          'export function activate(context: any) {',
          `  context.provide('method:acme.counter/get', () => ({ main: ${n}, helper: helper() }))`,
          '}',
          ''
        ].join('\n'),
        'lib/helper.ts': `export const helper = () => ${n}\n`
      }
    )
  }

  test('the next activation runs the newly installed code, not the module Bun cached', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const host = new PluginHost({
      builtinDir: null,
      installedDir: join(home, 'plugins'),
      store: { listDisabledIds: () => [], setDisabledId: () => {} },
      emit: () => {},
      log: () => {}
    })
    host.load()
    const deps = { home, plugins: host, log: () => {} }
    const call = async () => ((await host.resolveImplementation('method:acme.counter/get')) as () => unknown)()

    await installPlugin(deps, writeCounter(join(scratch, 'v1'), 1, '1.0.0'))
    expect(await call()).toEqual({ main: 1, helper: 1 })

    await installPlugin(deps, writeCounter(join(scratch, 'v2'), 2, '1.0.0'))
    expect(await call()).toEqual({ main: 2, helper: 2 })

    await installPlugin(deps, writeCounter(join(scratch, 'v3'), 3, '1.0.0'))
    expect(await call()).toEqual({ main: 3, helper: 3 })
    await host.stop()
  })
})

describe('host rescan', () => {
  test('a plugin that vanished or changed version is deactivated, and plugin.changed is broadcast', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const pluginsDir = join(home, 'plugins')
    writeModulePlugin(pluginsDir, marker, { id: 'acme.gone', activation: 'startup' })
    writeModulePlugin(pluginsDir, marker, { id: 'acme.bump', activation: 'startup' })
    writeModulePlugin(pluginsDir, marker, { id: 'acme.stay', activation: 'startup' })
    h = await startHarness({ home, builtinPluginsDir: null })
    const { client, events } = await h.connectWithEvents()
    const states = async () =>
      Object.fromEntries((await client.call('plugin.list', {})).map((plugin) => [plugin.id, plugin.state]))
    expect(await states()).toEqual({ 'acme.bump': 'active', 'acme.gone': 'active', 'acme.stay': 'active' })

    rmSync(join(pluginsDir, 'acme.gone'), { recursive: true })
    writeModulePlugin(pluginsDir, marker, { id: 'acme.bump', activation: 'startup', version: '2.0.0' })
    events.length = 0
    await h.daemon.plugins.rescan()

    await waitFor(() => events.some((event) => event.type === 'plugin.changed'))
    expect(await states()).toEqual({ 'acme.bump': 'active', 'acme.stay': 'active' })
    const lines = readMarker(marker)
    expect(lines.filter((line) => line === 'deactivate acme.gone')).toHaveLength(1)
    expect(lines.filter((line) => line === 'deactivate acme.bump')).toHaveLength(1)
    expect(lines.filter((line) => line === 'activate acme.bump')).toHaveLength(2)
    expect(lines).not.toContain('deactivate acme.stay')
  })

  test('a plugin that depends on a reinstalled plugin is deactivated with it', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const pluginsDir = join(home, 'plugins')
    writeModulePlugin(pluginsDir, marker, { id: 'acme.base', activation: 'startup' })
    writeModulePlugin(pluginsDir, marker, { id: 'acme.child', activation: 'lazy', dependencies: ['acme.base'] })
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    await client.call('plugin.activate', { pluginId: 'acme.child' })
    const source = writeModulePlugin(join(scratch, 'src'), marker, { id: 'acme.base', activation: 'startup' })

    await client.call('plugin.install', { path: source, yes: true })

    const plugins = await client.call('plugin.list', {})
    expect(plugins.find((plugin) => plugin.id === 'acme.child')?.state).toBe('inactive')
    expect(readMarker(marker)).toContain('deactivate acme.child')
  })
})
