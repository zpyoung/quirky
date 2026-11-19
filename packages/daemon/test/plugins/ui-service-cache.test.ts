import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { DistroManifest, QuirkyEvent } from '@quirky/protocol'
import { PluginHost } from '../../src/plugins/host'
import { buildUiModel } from '../../src/plugins/ui-model'
import { chosenThemeOf, resolveSetting, UiService } from '../../src/plugins/ui-service'
import { Store } from '../../src/store'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

afterEach(() => removeTempDirs())

const BOARD = 'acme.board'
const ENABLED = `setting:${BOARD}/board-enabled`
const DENSITY = `setting:${BOARD}/density`
const SECTION = `sidebar-section:${BOARD}/board`
const OPEN_KEY = `keybinding:${BOARD}/open-key`
const NIGHT = `theme:${BOARD}/night`

function makeStack() {
  const home = makeTempDir('qd-c-')
  const builtin = join(home, 'builtin')
  writePlugin(builtin, {
    id: BOARD,
    name: 'Board',
    version: '1.0.0',
    ui: 'ui.js',
    contributes: {
      setting: [
        { id: 'board-enabled', type: 'boolean', title: 'Board', default: true },
        { id: 'density', type: 'number', title: 'Density', default: 1, minimum: 1, maximum: 9 }
      ],
      'sidebar-section': [{ id: 'board', title: 'Board', whenSetting: 'board-enabled' }],
      command: [{ id: 'open', title: 'Open board' }],
      keybinding: [{ id: 'open-key', key: 'mod+shift+b', command: 'open' }],
      theme: [{ id: 'night', title: 'Night', appearance: 'dark', colors: { bg: '#000000' } }]
    }
  }, { 'ui.js': 'export function activate() {}\n' })
  const store = new Store(join(home, 'quirky.db'))
  const events: QuirkyEvent[] = []
  const host = new PluginHost({
    builtinDir: builtin,
    installedDir: join(home, 'plugins'),
    store,
    emit: (event) => events.push(event),
    log: () => {}
  })
  host.load()
  const layer: { distro: DistroManifest | null } = { distro: null }
  const ui = new UiService({ plugins: host, store, broadcast: (event) => events.push(event), distro: () => layer.distro })
  const fresh = () =>
    buildUiModel({
      declarations: host.contributions({ all: true }),
      plugins: host.list(),
      chosenTheme: chosenThemeOf(store.getUiState('theme'), layer.distro),
      distroKeybindings: Object.entries(layer.distro?.keybindings ?? {}).map(([key, command]) => ({ key, command })),
      distroId: layer.distro?.id ?? null,
      keybindingOverrides: (store.getUiState('keybindings') ?? {}) as Record<string, string | null>,
      settingValue: (entry) => resolveSetting(entry, store.getSettingValue(entry.id), layer.distro).value
    }).model
  return { home, builtin, store, host, ui, layer, fresh }
}

describe('the UI model is built once per set of inputs', () => {
  test('two reads with nothing changed return the same model', () => {
    const s = makeStack()
    const first = s.ui.contributions()
    expect(s.ui.contributions()).toBe(first)
    expect(first).toEqual(s.fresh())
    s.ui.listSettings()
    s.ui.listThemes()
    s.ui.listKeybindings()
    s.ui.valueFor(BOARD, 'density')
    expect(s.ui.contributions()).toBe(first)
  })

  test('a setting no contribution depends on changes its value and not the model', () => {
    const s = makeStack()
    const first = s.ui.contributions()
    s.ui.setSetting(DENSITY, 4)
    expect(s.ui.getSetting(DENSITY).value).toBe(4)
    expect(s.ui.valueFor(BOARD, 'density')).toBe(4)
    expect(s.ui.listSettings().find((entry) => entry.id === DENSITY)?.value).toBe(4)
    expect(s.ui.contributions()).toBe(first)
  })

  const sections = (s: ReturnType<typeof makeStack>) => s.ui.contributions().sidebarSections.map((entry) => entry.id)
  const key = (s: ReturnType<typeof makeStack>) => s.ui.contributions().keybindings.find((entry) => entry.id === OPEN_KEY)?.key

  test('a visibility setting, set through the service or straight into the store, rebuilds', () => {
    const s = makeStack()
    const first = s.ui.contributions()
    expect(sections(s)).toEqual([SECTION])
    s.ui.setSetting(ENABLED, false)
    expect(s.ui.contributions()).not.toBe(first)
    expect(sections(s)).toEqual([])
    s.store.setSettingValue(ENABLED, true)
    expect(sections(s)).toEqual([SECTION])
    s.store.deleteSettingValue(ENABLED)
    expect(sections(s)).toEqual([SECTION])
    expect(s.ui.contributions()).toEqual(s.fresh())
  })

  test('the theme, set through the service or straight into the store, rebuilds', () => {
    const s = makeStack()
    const first = s.ui.contributions()
    s.ui.setTheme(NIGHT)
    expect(s.ui.contributions()).not.toBe(first)
    expect(s.ui.contributions().theme).toEqual({ chosen: NIGHT, active: NIGHT })
    s.store.setUiState('theme', 'default')
    expect(s.ui.contributions().theme).toEqual({ chosen: 'default', active: 'default' })
  })

  test('a keybinding override, set through the service or straight into the store, rebuilds', () => {
    const s = makeStack()
    expect(key(s)).toBe('mod+shift+b')
    s.ui.setKeybinding(OPEN_KEY, 'mod+k')
    expect(key(s)).toBe('mod+k')
    s.ui.resetKeybinding(OPEN_KEY)
    expect(key(s)).toBe('mod+shift+b')
    s.store.setUiState('keybindings', { [OPEN_KEY]: 'mod+j' })
    expect(key(s)).toBe('mod+j')
    expect(s.ui.contributions()).toEqual(s.fresh())
  })

  test('a distro layer that appears, changes or goes away rebuilds', () => {
    const s = makeStack()
    const first = s.ui.contributions()
    s.layer.distro = { id: 'night', name: 'Night', version: '1.0.0', theme: NIGHT } as DistroManifest
    expect(s.ui.contributions()).not.toBe(first)
    expect(s.ui.contributions().theme.chosen).toBe(NIGHT)
    s.layer.distro = { id: 'night', name: 'Night', version: '1.0.0', settings: { [ENABLED]: false } } as DistroManifest
    expect(sections(s)).toEqual([])
    expect(s.ui.contributions().theme.chosen).toBe('default')
    s.layer.distro = null
    expect(sections(s)).toEqual([SECTION])
    expect(s.ui.contributions()).toEqual(s.fresh())
  })

  test('disabling, enabling and adding a plugin each rebuild', async () => {
    const s = makeStack()
    const first = s.ui.contributions()
    await s.host.setEnabled(BOARD, false)
    expect(s.ui.contributions()).not.toBe(first)
    expect(s.ui.contributions().commands).toEqual([])
    await s.host.setEnabled(BOARD, true)
    expect(s.ui.contributions().commands.map((entry) => entry.id)).toEqual([`command:${BOARD}/open`])
    const again = s.ui.contributions()
    writePlugin(join(s.home, 'plugins'), { id: 'acme.extra', name: 'Extra', version: '1.0.0', contributes: { command: [{ id: 'go', title: 'Go' }] } })
    await s.host.rescan()
    expect(s.ui.contributions()).not.toBe(again)
    expect(s.ui.contributions().commands.map((entry) => entry.id)).toEqual(['command:acme.extra/go', `command:${BOARD}/open`])
    expect(s.ui.contributions()).toEqual(s.fresh())
  })

  test('a plugin warning leaves the model as a fresh build would make it', () => {
    const s = makeStack()
    const first = s.ui.contributions()
    s.host.addWarning(BOARD, 'something odd')
    expect(s.ui.contributions()).toEqual(s.fresh())
    expect(s.ui.contributions()).toBe(first)
  })

  test('the model cannot be changed by a caller', () => {
    const s = makeStack()
    const model = s.ui.contributions()
    expect(() => { model.commands.push(model.commands[0]!) }).toThrow(TypeError)
    expect(() => { model.sidebarSections[0]!.title = 'Changed' }).toThrow(TypeError)
    expect(() => Object.assign(model, { theme: null })).toThrow(TypeError)
    expect(s.ui.contributions()).toEqual(s.fresh())
  })
})
