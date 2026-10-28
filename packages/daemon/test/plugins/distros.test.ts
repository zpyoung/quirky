import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RpcErrorCode,
  type DistroManifest,
  type QuirkyEvent
} from '@quirky/protocol'
import { discoverPlugins } from '../../src/plugins/discover'
import { DistroService, renderDistroInspection } from '../../src/plugins/distros'
import { PluginHost } from '../../src/plugins/host'
import { MANIFEST_FILE } from '../../src/plugins/manifest'
import { computeRegistry } from '../../src/plugins/registry'
import { UiService } from '../../src/plugins/ui-service'
import { Store } from '../../src/store'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

afterEach(removeTempDirs)

async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

const NIGHT: DistroManifest = {
  id: 'night',
  name: 'Night',
  version: '1.0.0',
  plugins: ['plugins/night.extras'],
  disable: ['quirky.git'],
  settings: { 'setting:quirky.terminal/scrollback': 6000 },
  theme: 'theme:night.extras/dusk',
  keybindings: { 'mod+shift+d': 'command:night.extras/palette' }
}

const SCROLLBACK = 'setting:quirky.terminal/scrollback'

/** Writes a distro directory with the plugins it bundles; `plugins` defaults to `night.extras`. */
function writeDistro(root: string, manifest: object = NIGHT, plugins: object[] = [nightExtras()]): string {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'quirky-distro.json'), JSON.stringify(manifest))
  for (const plugin of plugins) writePlugin(join(root, 'plugins'), plugin, { 'main.ts': '' })
  return root
}

function nightExtras(extra: object = {}) {
  return {
    id: 'night.extras',
    name: 'Night extras',
    version: '1.0.0',
    contributes: {
      theme: [{ id: 'dusk', title: 'Dusk', appearance: 'dark', colors: { bg: '#101020' } }],
      command: [{ id: 'palette', title: 'Night palette' }],
      panel: [{ id: 'notes', title: 'Notes' }]
    },
    ...extra
  }
}

/** A daemon-less stack: store, host over fixture built-ins, UI service and distro service. */
function makeLayer(options: { safeMode?: boolean } = {}) {
  const home = makeTempDir('qd-d-')
  const builtin = join(home, 'builtin')
  writePlugin(builtin, {
    id: 'quirky.git',
    name: 'Git',
    version: '1.0.0',
    contributes: { panel: [{ id: 'source-control', title: 'Source control' }] }
  })
  writePlugin(builtin, {
    id: 'quirky.terminal',
    name: 'Terminal',
    version: '1.0.0',
    contributes: {
      setting: [{ id: 'scrollback', type: 'number', title: 'Scrollback', default: 2000, minimum: 500, maximum: 100000 }],
      command: [{ id: 'clear', title: 'Clear' }],
      keybinding: [{ id: 'clear-key', key: 'mod+shift+d', command: 'clear' }]
    }
  })
  writePlugin(builtin, { id: 'base.tools', name: 'Base tools', version: '1.0.0' })
  const store = new Store(join(home, 'quirky.db'))
  const events: QuirkyEvent[] = []
  const log = () => {}
  let distroDisables = (): string[] => []
  const host: PluginHost = new PluginHost({
    builtinDir: builtin,
    installedDir: join(home, 'plugins'),
    store,
    emit: (event) => events.push(event),
    log,
    safeMode: options.safeMode,
    distroDisabled: () => distroDisables()
  })
  const distros = new DistroService({
    home,
    store,
    plugins: host,
    log,
    safeMode: options.safeMode ?? false,
    broadcast: (event) => events.push(event)
  })
  distroDisables = () => distros.active()?.disable ?? []
  host.load()
  const ui = new UiService({
    plugins: host,
    store,
    broadcast: (event) => events.push(event),
    distro: () => distros.active(),
    safeMode: options.safeMode
  })
  const installedIds = () =>
    existsSync(join(home, 'plugins')) ? readdirSync(join(home, 'plugins')).filter((name) => !name.startsWith('.')) : []
  const registry = () =>
    computeRegistry(discoverPlugins({ builtin, installed: join(home, 'plugins') }), new Set(), distros.active()?.disable ?? [])
  return { home, builtin, store, events, host, distros, ui, installedIds, registry }
}

type Layer = ReturnType<typeof makeLayer>

const scrollback = (layer: Layer) => layer.ui.getSetting(SCROLLBACK)
const keyOn = (layer: Layer, chord: string) =>
  layer.ui.contributions().keybindings.filter((binding) => binding.key === chord && binding.status === 'active')

describe('SC-54: installing a distro applies its layer', () => {
  test('SC-54: plugins, disables, settings, theme and keybinding take effect and the distro is listed', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'))
    expect(scrollback(layer)).toMatchObject({ value: 2000, source: 'default' })
    expect(layer.ui.listThemes()).toMatchObject({ chosen: 'default', active: 'default' })
    expect(keyOn(layer, 'mod+shift+d').map((binding) => binding.id)).toEqual(['keybinding:quirky.terminal/clear-key'])

    const info = await layer.distros.install(distro)

    expect(info).toMatchObject({ id: 'night', name: 'Night', version: '1.0.0', plugins: ['night.extras'] })
    expect(layer.distros.list()).toEqual([info])
    expect(layer.installedIds()).toEqual(['night.extras'])
    expect(layer.host.list().find((plugin) => plugin.id === 'night.extras')?.source).toBe('installed')
    expect(layer.registry().plugins.get('quirky.git')).toMatchObject({ status: 'disabled', disabledReason: 'distro' })
    expect(scrollback(layer)).toMatchObject({ value: 6000, source: 'distro' })
    expect(layer.ui.listThemes()).toMatchObject({ chosen: 'theme:night.extras/dusk', active: 'theme:night.extras/dusk' })
    const [active] = keyOn(layer, 'mod+shift+d')
    expect(active).toMatchObject({ id: 'keybinding:night/k1', plugin: 'night', command: 'command:night.extras/palette' })
    expect(layer.ui.contributions().keybindings.find((binding) => binding.id === 'keybinding:quirky.terminal/clear-key')).toMatchObject({
      status: 'shadowed',
      shadowedBy: 'keybinding:night/k1'
    })
  })

  test('SC-54: broadcasts plugin.changed, setting.changed for the layered setting and theme.changed', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    expect(layer.events).toContainEqual({ type: 'plugin.changed' })
    expect(layer.events).toContainEqual({ type: 'setting.changed', id: SCROLLBACK, value: 6000 })
    expect(layer.events).toContainEqual({
      type: 'theme.changed',
      chosen: 'theme:night.extras/dusk',
      active: 'theme:night.extras/dusk'
    })
  })

  test('SC-54: a setting written as <pluginId>/<name> layers like its full ID', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-'), { ...NIGHT, settings: { 'quirky.terminal/scrollback': 6000 } }))
    expect(scrollback(layer)).toMatchObject({ value: 6000, source: 'distro' })
    expect(layer.events).toContainEqual({ type: 'setting.changed', id: SCROLLBACK, value: 6000 })
  })

  test('SC-54: a user-chosen theme beats the distro theme', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    layer.ui.setTheme('default')
    expect(layer.ui.listThemes()).toMatchObject({ chosen: 'default', active: 'default' })
  })

  test('reinstalling the installed distro replaces its plugins and drops the ones it no longer bundles', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    const second = writeDistro(makeTempDir('qd-n-'), { ...NIGHT, version: '1.1.0', plugins: ['plugins/night.more'], theme: undefined, keybindings: undefined, settings: undefined }, [
      { id: 'night.more', name: 'More', version: '1.0.0' }
    ])
    const info = await layer.distros.install(second)
    expect(info).toMatchObject({ version: '1.1.0', plugins: ['night.more'] })
    expect(layer.installedIds()).toEqual(['night.more'])
    expect(layer.distros.list()).toHaveLength(1)
    expect(scrollback(layer)).toMatchObject({ value: 2000, source: 'default' })
  })
})

describe('reinstalling a distro whose plugin code changed', () => {
  const MODULE = (n: number) =>
    [
      'export function activate(context: any) {',
      `  context.provide('method:night.code/get', () => ${n})`,
      '}',
      ''
    ].join('\n')
  const codePlugin = { id: 'night.code', name: 'Code', version: '1.0.0', main: 'main.ts', contributes: { method: [{ id: 'get' }] } }
  const writeCodeDistro = (n: number) => {
    const root = makeTempDir('qd-c-')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'quirky-distro.json'), JSON.stringify({ id: 'code', name: 'Code', version: '1.0.0', plugins: ['plugins/night.code'] }))
    writePlugin(join(root, 'plugins'), codePlugin, { 'main.ts': MODULE(n) })
    return root
  }

  test('the plugin reloads on the new code although its version is unchanged', async () => {
    const layer = makeLayer()
    const get = async () => ((await layer.host.resolveImplementation('method:night.code/get')) as () => number)()
    await layer.distros.install(writeCodeDistro(1))
    expect(await get()).toBe(1)

    await layer.distros.install(writeCodeDistro(2))

    expect(await get()).toBe(2)
    await layer.host.stop()
  })

  test('removing the distro deactivates its running plugins', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeCodeDistro(1))
    await layer.host.activate('night.code')

    await layer.distros.remove('code')

    expect(layer.host.list().find((plugin) => plugin.id === 'night.code')).toBeUndefined()
    await layer.host.stop()
  })
})

describe('a failed swap leaves the previous install intact', () => {
  test('when a later plugin cannot be swapped, the earlier ones are put back and the distro row is unchanged', async () => {
    const layer = makeLayer()
    const bundle = (version: string) =>
      writeDistro(makeTempDir('qd-n-'), { ...NIGHT, version, plugins: ['plugins/night.extras', 'plugins/night.two'] }, [
        nightExtras({ version }),
        { id: 'night.two', name: 'Two', version }
      ])
    await layer.distros.install(bundle('1.0.0'))
    const pluginsDir = join(layer.home, 'plugins')
    const manifestOf = (id: string) => readFileSync(join(pluginsDir, id, MANIFEST_FILE), 'utf8')
    const before = { extras: manifestOf('night.extras'), two: manifestOf('night.two') }
    // an undeletable leftover at the second plugin's backup path makes its swap fail after the first succeeded
    const blocker = join(pluginsDir, '.old-night.two', 'sub')
    mkdirSync(blocker, { recursive: true })
    writeFileSync(join(blocker, 'file'), '')
    chmodSync(blocker, 0o555)

    let error: { code: number } | undefined
    try {
      await layer.distros.install(bundle('2.0.0')).catch((caught) => {
        error = caught
      })
    } finally {
      chmodSync(blocker, 0o755)
    }

    expect(error?.code).toBe(RpcErrorCode.Internal)
    expect(manifestOf('night.extras')).toBe(before.extras)
    expect(manifestOf('night.two')).toBe(before.two)
    expect(layer.distros.list()[0]?.version).toBe('1.0.0')
    expect(readdirSync(pluginsDir).filter((name) => name.startsWith('.tmp-') || name === '.old-night.extras')).toEqual([])
    expect(layer.host.list().filter((plugin) => plugin.source === 'installed').map((plugin) => plugin.version)).toEqual(['1.0.0', '1.0.0'])
  })

  test('a successful reinstall leaves no scratch directory either', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    await layer.distros.install(writeDistro(makeTempDir('qd-n-'), { ...NIGHT, version: '1.1.0' }, [nightExtras({ version: '2.0.0' })]))

    expect(readdirSync(join(layer.home, 'plugins'))).toEqual(['night.extras'])
    expect(layer.host.list().find((plugin) => plugin.id === 'night.extras')?.version).toBe('2.0.0')
  })
})

describe('SC-55: the user wins and removal restores', () => {
  test('SC-55: the user value wins while installed and stays after removal; everything else is restored', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    mkdirSync(join(layer.home, 'plugin-data', 'night.extras'), { recursive: true })
    writeFileSync(join(layer.home, 'plugin-data', 'night.extras', 'store.db'), 'x')

    layer.ui.setSetting(SCROLLBACK, 8000)
    expect(scrollback(layer)).toMatchObject({ value: 8000, source: 'user' })

    layer.events.length = 0
    await layer.distros.remove('night')

    expect(scrollback(layer)).toMatchObject({ value: 8000, source: 'user' })
    expect(layer.ui.listThemes()).toMatchObject({ chosen: 'default', active: 'default' })
    expect(layer.registry().plugins.get('quirky.git')?.status).toBe('enabled')
    expect(layer.installedIds()).toEqual([])
    expect(existsSync(join(layer.home, 'plugin-data', 'night.extras'))).toBe(false)
    expect(layer.distros.list()).toEqual([])
    expect(layer.distros.active()).toBeNull()
    expect(keyOn(layer, 'mod+shift+d').map((binding) => binding.id)).toEqual(['keybinding:quirky.terminal/clear-key'])
    expect(layer.events).toContainEqual({ type: 'plugin.changed' })
    expect(layer.events).toContainEqual({ type: 'setting.changed', id: SCROLLBACK, value: 8000 })
    expect(layer.events).toContainEqual({ type: 'theme.changed', chosen: 'default', active: 'default' })
  })

  test('SC-55: resetting removes only the user value, so the distro value shows again', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    layer.ui.setSetting(SCROLLBACK, 8000)
    expect(layer.ui.resetSetting(SCROLLBACK)).toMatchObject({ value: 6000, source: 'distro' })
  })

  test('a stored value the declaration refuses falls through to the distro value', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    layer.store.setSettingValue(SCROLLBACK, 'lots')
    expect(scrollback(layer)).toMatchObject({ value: 6000, source: 'distro', stored: { value: 'lots', valid: false } })
  })

  test('a distro value its declaration refuses is ignored', () => {
    const layer = makeLayer()
    layer.store.putDistro({
      id: 'odd',
      manifest: { id: 'odd', name: 'Odd', version: '1', settings: { [SCROLLBACK]: 3 } },
      plugins: [],
      installedAt: 1
    })
    expect(scrollback(layer)).toMatchObject({ value: 2000, source: 'default' })
  })

  test('removing an unknown distro is NotFound', async () => {
    const layer = makeLayer()
    expect((await failure(layer.distros.remove('night'))).code).toBe(RpcErrorCode.NotFound)
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    expect((await failure(layer.distros.remove('day'))).code).toBe(RpcErrorCode.NotFound)
    expect(layer.distros.list()).toHaveLength(1)
  })
})

describe('SC-56: refusals change nothing', () => {
  async function expectUntouched(layer: Layer, attempt: () => Promise<unknown>, code: number, message: RegExp) {
    const before = { rows: layer.distros.list(), dirs: layer.installedIds(), scrollback: scrollback(layer).value }
    layer.events.length = 0
    const error = await failure(attempt())
    expect(error.code).toBe(code)
    expect(error.message).toMatch(message)
    expect({ rows: layer.distros.list(), dirs: layer.installedIds(), scrollback: scrollback(layer).value }).toEqual(before)
    expect(layer.events).toEqual([])
    expect(readdirSync(join(layer.home))).not.toContain('plugin-data')
  }

  test('SC-56: another distro while one is installed is a Conflict', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    const day = writeDistro(makeTempDir('qd-d-'), { id: 'day', name: 'Day', version: '1.0.0', plugins: ['plugins/day.extras'] }, [
      { id: 'day.extras', name: 'Day', version: '1.0.0' }
    ])
    await expectUntouched(layer, () => layer.distros.install(day), RpcErrorCode.Conflict, /night is installed/)
  })

  test('two concurrent installs of different distros: the second is a Conflict and only one row persists', async () => {
    const layer = makeLayer()
    const night = writeDistro(makeTempDir('qd-n-'))
    const day = writeDistro(makeTempDir('qd-d-'), { id: 'day', name: 'Day', version: '1.0.0', plugins: ['plugins/day.extras'] }, [
      { id: 'day.extras', name: 'Day', version: '1.0.0' }
    ])

    const [first, second] = await Promise.allSettled([layer.distros.install(night), layer.distros.install(day)])

    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    expect((second as PromiseRejectedResult).reason).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(layer.distros.list().map((info) => info.id)).toEqual(['night'])
    expect(layer.installedIds()).toEqual(['night.extras'])
  })

  test('an install queued behind a remove of the installed distro sees it gone and succeeds', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    const day = writeDistro(makeTempDir('qd-d-'), { id: 'day', name: 'Day', version: '1.0.0', plugins: ['plugins/day.extras'] }, [
      { id: 'day.extras', name: 'Day', version: '1.0.0' }
    ])

    const [removed, installed] = await Promise.allSettled([layer.distros.remove('night'), layer.distros.install(day)])

    expect(removed.status).toBe('fulfilled')
    expect(installed.status).toBe('fulfilled')
    expect(layer.distros.list().map((info) => info.id)).toEqual(['day'])
    expect(layer.installedIds()).toEqual(['day.extras'])
  })

  test('an install ahead of a remove of the installed distro is refused and the remove still lands', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    const day = writeDistro(makeTempDir('qd-d-'), { id: 'day', name: 'Day', version: '1.0.0', plugins: ['plugins/day.extras'] }, [
      { id: 'day.extras', name: 'Day', version: '1.0.0' }
    ])

    const [installed, removed] = await Promise.allSettled([layer.distros.install(day), layer.distros.remove('night')])

    expect(installed.status).toBe('rejected')
    expect((installed as PromiseRejectedResult).reason).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(removed.status).toBe('fulfilled')
    expect(layer.distros.list()).toEqual([])
    expect(layer.installedIds()).toEqual([])
  })

  test('a remove queued behind an install of the same distro removes it', async () => {
    const layer = makeLayer()
    const night = writeDistro(makeTempDir('qd-n-'))

    const [installed, removed] = await Promise.allSettled([layer.distros.install(night), layer.distros.remove('night')])

    expect(installed.status).toBe('fulfilled')
    expect(removed.status).toBe('fulfilled')
    expect(layer.distros.list()).toEqual([])
    expect(layer.installedIds()).toEqual([])
  })

  test('SC-56: a plugin ID that is already installed on its own is a Conflict', async () => {
    const layer = makeLayer()
    writePlugin(join(layer.home, 'plugins'), nightExtras({ version: '0.1.0' }))
    layer.host.load()
    await expectUntouched(layer, () => layer.distros.install(writeDistro(makeTempDir('qd-n-'))), RpcErrorCode.Conflict, /night\.extras is already installed/)
    expect(JSON.parse(readFileSync(join(layer.home, 'plugins', 'night.extras', MANIFEST_FILE), 'utf8')).version).toBe('0.1.0')
  })

  test('SC-56: a built-in plugin ID is a Conflict', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'), { id: 'x', name: 'X', version: '1', plugins: ['plugins/base.tools'] }, [
      { id: 'base.tools', name: 'Base', version: '9' }
    ])
    await expectUntouched(layer, () => layer.distros.install(distro), RpcErrorCode.Conflict, /base\.tools is a built-in/)
  })

  test('a plugin under the reserved quirky. prefix is InvalidParams', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'), { id: 'x', name: 'X', version: '1', plugins: ['plugins/quirky.git'] }, [
      { id: 'quirky.git', name: 'Git', version: '9' }
    ])
    await expectUntouched(layer, () => layer.distros.install(distro), RpcErrorCode.InvalidParams, /quirky\.git/)
  })

  test('SC-56: a malformed manifest is InvalidParams naming each problem', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'), { id: 'Bad Id', name: 'X', extra: true })
    const error = await failure(layer.distros.install(distro))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toContain("id 'Bad Id' is not a valid plugin ID")
    expect(error.message).toContain("unknown field 'extra'")
    expect(error.message).toContain("missing required field 'version'")
    expect(layer.installedIds()).toEqual([])
  })

  test('SC-56: a directory with no quirky-distro.json is InvalidParams', async () => {
    const layer = makeLayer()
    const error = await failure(layer.distros.install(makeTempDir('qd-n-')))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toContain('quirky-distro.json')
  })

  test('SC-56: a setting value its declaration refuses is InvalidParams', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'), { ...NIGHT, settings: { [SCROLLBACK]: 3 } })
    await expectUntouched(layer, () => layer.distros.install(distro), RpcErrorCode.InvalidParams, new RegExp(`${SCROLLBACK} must be at least 500`))
  })

  test('SC-56: an unknown setting, an undeclared theme and a plugin that does not parse each name their problem', async () => {
    const layer = makeLayer()
    const distro = writeDistro(
      makeTempDir('qd-n-'),
      {
        ...NIGHT,
        plugins: ['plugins/night.extras', 'plugins/broken'],
        settings: { 'setting:quirky.terminal/ghost': 1 },
        theme: 'theme:night.extras/missing'
      },
      [nightExtras(), { id: 'broken', name: 'Broken', version: 1 }]
    )
    const error = await failure(layer.distros.install(distro))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toContain('plugin plugins/broken:')
    expect(error.message).toContain('settings: unknown setting setting:quirky.terminal/ghost')
    expect(error.message).toContain('theme: theme:night.extras/missing is not declared')
    expect(layer.installedIds()).toEqual([])
    expect(layer.distros.list()).toEqual([])
  })

  test('SC-56: a symlink that leaves a bundled plugin is refused', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'))
    const secret = join(makeTempDir('qd-s-'), 'secret.txt')
    writeFileSync(secret, 'secret')
    symlinkSync(secret, join(distro, 'plugins', 'night.extras', 'link.txt'))
    await expectUntouched(layer, () => layer.distros.install(distro), RpcErrorCode.InvalidParams, /links outside the plugin/)
  })

  test('a plugin directory that is a symlink out of the distro is refused', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'), { ...NIGHT, plugins: ['plugins/night.extras'] }, [])
    const elsewhere = writePlugin(makeTempDir('qd-e-'), nightExtras())
    mkdirSync(join(distro, 'plugins'), { recursive: true })
    symlinkSync(elsewhere, join(distro, 'plugins', 'night.extras'))
    await expectUntouched(layer, () => layer.distros.install(distro), RpcErrorCode.InvalidParams, /resolves outside the distro/)
  })
})

describe('SC-57: inspect lists everything and installs nothing', () => {
  test('SC-57: lists each plugin, the settings with current and new values, and writes nothing', async () => {
    const layer = makeLayer()
    layer.ui.setSetting('setting:quirky.terminal/scrollback', 3000)
    const distro = writeDistro(makeTempDir('qd-n-'), { ...NIGHT, settings: { [SCROLLBACK]: 6000 } })
    layer.events.length = 0

    const inspection = await layer.distros.inspect(distro)

    expect(inspection.manifest).toEqual(NIGHT)
    expect(inspection.plugins.map((plugin) => plugin.id)).toEqual(['night.extras'])
    expect(inspection.plugins[0].contributions.map((item) => item.id).sort()).toEqual([
      'command:night.extras/palette',
      'panel:night.extras/notes',
      'theme:night.extras/dusk'
    ])
    expect(inspection.settings).toEqual([{ id: SCROLLBACK, current: 3000, next: 3000 }])
    expect(layer.installedIds()).toEqual([])
    expect(layer.distros.list()).toEqual([])
    expect(layer.events.filter((event) => event.type !== 'setting.changed')).toEqual([])
  })

  test('SC-57: current and new differ when the user has no value of their own', async () => {
    const layer = makeLayer()
    const inspection = await layer.distros.inspect(writeDistro(makeTempDir('qd-n-')))
    expect(inspection.settings).toEqual([{ id: SCROLLBACK, current: 2000, next: 6000 }])
  })

  test('SC-57: the confirm listing shows the plugins, disables, setting change, theme and keybindings', async () => {
    const layer = makeLayer()
    const text = renderDistroInspection(await layer.distros.inspect(writeDistro(makeTempDir('qd-n-'))))
    expect(text.split('\n')).toEqual([
      'distro night 1.0.0 (Night)',
      '',
      'night.extras 1.0.0 (Night extras)',
      'theme      theme:night.extras/dusk',
      'command    command:night.extras/palette',
      'panel      panel:night.extras/notes',
      '',
      'disable    quirky.git',
      `setting    ${SCROLLBACK}  2000 → 6000`,
      'theme      theme:night.extras/dusk',
      'keybinding mod+shift+d  command:night.extras/palette'
    ])
  })

  test('a distro can bind Mod+Shift+P as an ordinary keybinding', async () => {
    const layer = makeLayer()
    const distro = writeDistro(makeTempDir('qd-n-'), { ...NIGHT, keybindings: { 'mod+shift+p': 'command:night.extras/palette' } })
    await layer.distros.install(distro)
    expect(layer.ui.contributions().keybindings.find((binding) => binding.id === 'keybinding:night/k1')).toMatchObject({
      key: 'mod+shift+p',
      status: 'active'
    })
  })

  test('inspecting while the distro is installed reports the values it already layers as current', async () => {
    const layer = makeLayer()
    await layer.distros.install(writeDistro(makeTempDir('qd-n-')))
    const inspection = await layer.distros.inspect(writeDistro(makeTempDir('qd-n-'), { ...NIGHT, version: '1.1.0' }))
    expect(inspection.manifest.version).toBe('1.1.0')
    expect(inspection.settings).toEqual([{ id: SCROLLBACK, current: 6000, next: 6000 }])
  })
})

describe('safe mode', () => {
  test('the stored distro is kept but not applied', () => {
    const layer = makeLayer({ safeMode: true })
    layer.store.putDistro({ id: 'night', manifest: NIGHT, plugins: ['night.extras'], installedAt: 1 })
    expect(layer.distros.active()).toBeNull()
    expect(layer.distros.list().map((info) => info.id)).toEqual(['night'])
    expect(scrollback(layer)).toMatchObject({ value: 2000, source: 'default' })
    expect(layer.ui.listThemes()).toMatchObject({ chosen: 'default', active: 'default' })
    expect(keyOn(layer, 'mod+shift+d').map((binding) => binding.id)).toEqual(['keybinding:quirky.terminal/clear-key'])
    expect(layer.store.getDistro()?.id).toBe('night')
  })
})
