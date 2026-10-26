import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PluginHost } from '../../src/plugins/host'
import { Store } from '../../src/store'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

function seedDisabled(home: string, ids: string[]): void {
  const store = new Store(join(home, 'quirky.db'))
  for (const id of ids) store.setDisabledId(id, true)
  store.close()
}

function storedDisables(home: string): string[] {
  const store = new Store(join(home, 'quirky.db'))
  const ids = store.listDisabledIds()
  store.close()
  return ids
}

describe('safe mode', () => {
  test('SC-58: installed plugins and stored disables are off for the run, and nothing is written', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const builtinDir = join(scratch, 'builtin')
    mkdirSync(builtinDir)
    writeModulePlugin(builtinDir, marker, {
      id: 'quirky.structured',
      activation: 'startup',
      contributes: { method: [{ id: 'chat' }] }
    })
    writeModulePlugin(join(home, 'plugins'), marker, {
      id: 'acme.tools',
      activation: 'startup',
      contributes: { method: [{ id: 'greet' }] }
    })
    seedDisabled(home, ['quirky.structured'])

    h = await startHarness({ home, builtinPluginsDir: builtinDir, safeMode: true })
    let client = await h.connect()

    expect((await client.call('status.get', {})).safeMode).toBe(true)
    const plugins = await client.call('plugin.list', {})
    expect(plugins.find((plugin) => plugin.id === 'quirky.structured')).toMatchObject({ state: 'active' })
    expect(plugins.find((plugin) => plugin.id === 'quirky.structured')?.disabledReason).toBeUndefined()
    expect(plugins.find((plugin) => plugin.id === 'acme.tools')).toMatchObject({
      source: 'installed',
      state: 'disabled',
      disabledReason: 'safe-mode'
    })
    const effective = (await client.call('plugin.contributions', {})).map((item) => item.id)
    expect(effective).toContain('method:quirky.structured/chat')
    expect(effective).not.toContain('method:acme.tools/greet')
    expect(readMarker(marker)).toEqual(['import quirky.structured', 'activate quirky.structured'])
    expect(storedDisables(home)).toEqual(['quirky.structured'])

    for (const connected of h.clients) connected.close()
    await h.daemon.stop()
    h.pty.stop()
    h = await startHarness({ home, builtinPluginsDir: builtinDir })
    client = await h.connect()

    expect((await client.call('status.get', {})).safeMode).toBe(false)
    const restored = await client.call('plugin.list', {})
    expect(restored.find((plugin) => plugin.id === 'quirky.structured')).toMatchObject({ state: 'disabled', disabledReason: 'user' })
    expect(restored.find((plugin) => plugin.id === 'acme.tools')).toMatchObject({ state: 'active' })
  })

  test('a disable made during a safe-mode run is stored like any other', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const builtinDir = join(scratch, 'builtin')
    mkdirSync(builtinDir)
    writeModulePlugin(builtinDir, join(scratch, 'm.log'), { id: 'quirky.sample' })
    h = await startHarness({ home, builtinPluginsDir: builtinDir, safeMode: true })
    const client = await h.connect()

    await client.call('plugin.disable', { id: 'quirky.sample' })

    expect(storedDisables(home)).toEqual(['quirky.sample'])
  })
})

describe('disabled reasons', () => {
  function hostWith(options: { safeMode?: boolean; user?: string[]; distro?: string[] }) {
    const root = makeTempDir()
    const builtinDir = join(root, 'builtin')
    const installedDir = join(root, 'installed')
    mkdirSync(builtinDir)
    mkdirSync(installedDir)
    const marker = join(root, 'marker.log')
    writeModulePlugin(builtinDir, marker, { id: 'quirky.base' })
    writeModulePlugin(builtinDir, marker, { id: 'quirky.child', dependencies: ['quirky.base'] })
    writeModulePlugin(builtinDir, marker, { id: 'quirky.other' })
    writeModulePlugin(installedDir, marker, { id: 'acme.tools' })
    let distroCalls = 0
    const writes: string[] = []
    const host = new PluginHost({
      builtinDir,
      installedDir,
      store: {
        listDisabledIds: () => options.user ?? [],
        setDisabledId: (id) => void writes.push(id)
      },
      emit: () => {},
      log: () => {},
      safeMode: options.safeMode,
      distroDisabled: () => {
        distroCalls += 1
        return options.distro ?? []
      }
    })
    host.load()
    const reasonOf = (id: string) => host.list().find((plugin) => plugin.id === id)?.disabledReason
    return { host, reasonOf, writes, distroCalls: () => distroCalls }
  }

  test('user, distro and dependency disables are told apart; the user wins when both disable one plugin', () => {
    const { host, reasonOf } = hostWith({ user: ['quirky.base', 'quirky.other'], distro: ['quirky.other', 'acme.tools'] })

    expect(reasonOf('quirky.base')).toBe('user')
    expect(reasonOf('quirky.child')).toBe('dependency')
    expect(reasonOf('quirky.other')).toBe('user')
    expect(reasonOf('acme.tools')).toBe('distro')
    expect(host.list().find((plugin) => plugin.id === 'quirky.child')?.state).toBe('disabled')
  })

  test('safe mode ignores the user set and never consults the distro', () => {
    const { host, reasonOf, distroCalls, writes } = hostWith({
      safeMode: true,
      user: ['quirky.base'],
      distro: ['quirky.other']
    })

    expect(host.list().filter((plugin) => plugin.source === 'builtin').map((plugin) => plugin.state)).toEqual([
      'inactive',
      'inactive',
      'inactive'
    ])
    expect(reasonOf('acme.tools')).toBe('safe-mode')
    expect(host.list().find((plugin) => plugin.id === 'acme.tools')?.diagnostics.map((item) => item.message)).toContain(
      'disabled by safe mode'
    )
    expect(distroCalls()).toBe(0)
    expect(writes).toEqual([])
  })

  test('safe mode keeps an invalid installed plugin invalid', () => {
    const root = makeTempDir()
    const installedDir = join(root, 'installed')
    mkdirSync(installedDir)
    mkdirSync(join(installedDir, 'broken'))
    const host = new PluginHost({
      builtinDir: null,
      installedDir,
      store: { listDisabledIds: () => [], setDisabledId: () => {} },
      emit: () => {},
      log: () => {},
      safeMode: true
    })
    host.load()

    expect(host.list().find((plugin) => plugin.id === 'broken')).toMatchObject({ state: 'invalid' })
  })
})
