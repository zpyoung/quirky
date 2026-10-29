import { afterEach, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLUGIN_API_VERSION, type QuirkyClient, type UiPluginContext, type UiPluginModule } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../daemon/test/helpers'
import { makeTempDir, removeTempDirs, writePlugin } from '../../daemon/test/plugins/fixtures'
import { WindowPluginHost } from '../src/plugins/host'
import { activate as activatePalette } from '../../../plugins/quirky.palette/src/ui'

const PALETTE_COMMAND = 'command:quirky.palette/toggle'
const DOCK_COMMAND = 'command:acme.dock/passthrough'
const OVERRIDE_COMMAND = 'command:acme.override/open'
const CHORD = 'mod+shift+p'
const DOCK_WHEN = 'terminalDockMounted && terminalFocus || terminalDockMounted && terminalDockFocus'

const harnesses: Harness[] = []
const hosts: WindowPluginHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop()
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

function keyPress() {
  return { key: 'P', code: 'KeyP', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
}

async function boot(options: { dock?: boolean; override?: boolean } = {}) {
  const home = makeTempHome('qd-palette-window-')
  const builtins = makeTempDir('qd-palette-builtin-')
  symlinkSync(resolve(import.meta.dir, '../../../plugins/quirky.palette'), join(builtins, 'quirky.palette'))
  if (options.dock) {
    writePlugin(
      join(home, 'plugins'),
      {
        id: 'acme.dock',
        name: 'Dock fixture',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        ui: 'ui.js',
        contributes: {
          command: [{ id: 'passthrough', title: 'Terminal passthrough' }],
          keybinding: [{ id: 'passthrough', key: CHORD, command: 'passthrough', when: DOCK_WHEN }]
        }
      },
      { 'ui.js': '' }
    )
  }
  if (options.override) {
    writePlugin(
      join(home, 'plugins'),
      {
        id: 'acme.override',
        name: 'Palette override fixture',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        ui: 'ui.js',
        contributes: {
          command: [{ id: 'open', title: 'Replacement shortcut' }],
          keybinding: [{ id: 'p', key: CHORD, command: 'open' }]
        }
      },
      { 'ui.js': '' }
    )
  }

  const harness = await startHarness({ home, builtinPluginsDir: builtins })
  harnesses.push(harness)
  const window = await harness.connect('ui', 'palette window')
  await window.call('events.subscribe', {})
  const caller = await harness.connect('cli')
  let paletteContext: UiPluginContext | undefined
  let dockContext: UiPluginContext | undefined
  let dockRuns = 0
  let overrideRuns = 0

  const paletteModule: UiPluginModule = {
    activate(context) {
      paletteContext = context
      activatePalette(context)
    }
  }
  const dockModule: UiPluginModule = {
    activate(context) {
      dockContext = context
      context.provide(DOCK_COMMAND, () => {
        dockRuns++
      })
    }
  }
  const overrideModule: UiPluginModule = {
    activate(context) {
      context.provide(OVERRIDE_COMMAND, () => {
        overrideRuns++
      })
    }
  }
  const modules = new Map<string, UiPluginModule>([
    ['quirky.palette', paletteModule],
    ['acme.dock', dockModule],
    ['acme.override', overrideModule]
  ])
  const host = new WindowPluginHost({
    call: (method, params) => window.callAny(method, params),
    onEvent: (listener) => window.onEvent(listener),
    importModule: async (url) => {
      const plugin = [...modules.keys()].find((id) => url.includes(`/plugins/${id}/`))
      const module = plugin === undefined ? undefined : modules.get(plugin)
      if (!module) throw new Error(`unexpected UI module ${url}`)
      return module
    },
    onStream: (streamId, listener) => window.onTerminalOutput(streamId, listener),
    onConnection: () => () => {},
    confirm: async () => true,
    toast: () => {},
    log: () => {}
  })
  hosts.push(host)
  await host.refresh()

  return {
    caller,
    host,
    paletteContext: () => paletteContext,
    dockContext: () => dockContext,
    dockRuns: () => dockRuns,
    overrideRuns: () => overrideRuns,
    window
  }
}

async function waitForPalette(caller: QuirkyClient, open: boolean): Promise<void> {
  await waitForAsync(async () => {
    const state = await caller.call('ui.state', {})
    return (state.layout.palette === true) === open ? true : undefined
  })
}

test('conditional dock bindings win from terminal and composer focus; palette routes, opens and closes canonically', async () => {
  const t = await boot({ dock: true })
  const context = t.dockContext()!
  context.setContext('terminalKeysFirst', true)
  context.setContext('terminalFocus', true)
  context.setContext('terminalDockMounted', true)

  expect(t.host.handleKey(keyPress())).toBe(true)
  await waitFor(() => t.dockRuns() === 1)
  await waitForPalette(t.caller, false)

  context.setContext('terminalFocus', false)
  context.setContext('terminalDockFocus', true)
  expect(t.host.handleKey(keyPress())).toBe(true)
  await waitFor(() => t.dockRuns() === 2)
  await waitForPalette(t.caller, false)

  context.setContext('terminalDockMounted', false)
  context.setContext('terminalDockFocus', false)
  expect(t.host.handleKey(keyPress())).toBe(true)
  await waitForPalette(t.caller, true)

  await t.caller.call('ui.command.run', { id: PALETTE_COMMAND })
  await waitForPalette(t.caller, false)
  t.paletteContext()!.setPalette(true)
  await waitForPalette(t.caller, true)
  t.paletteContext()!.setPalette(false)
  await waitForPalette(t.caller, false)
})

test('an installed replacement owns Mod+Shift+P without a palette fallback', async () => {
  const t = await boot({ override: true })
  const bindings = t.host.getState().model!.keybindings
  expect(bindings.find((binding) => binding.id === 'keybinding:quirky.palette/toggle')).toMatchObject({
    status: 'shadowed',
    shadowedBy: 'keybinding:acme.override/p'
  })
  expect(bindings.find((binding) => binding.id === 'keybinding:acme.override/p')).toMatchObject({ status: 'active' })

  expect(t.host.handleKey(keyPress())).toBe(true)
  await waitFor(() => t.overrideRuns() === 1)
  await waitForPalette(t.caller, false)
})

test('disabling the palette contribution leaves no hidden shortcut handler', async () => {
  const t = await boot()
  await t.caller.call('plugin.disable', { id: 'quirky.palette' })
  await t.host.refresh()

  expect(t.host.getState().model!.commands.some((command) => command.id === PALETTE_COMMAND)).toBe(false)
  expect(t.host.getState().model!.keybindings.some((binding) => binding.id === 'keybinding:quirky.palette/toggle')).toBe(false)
  expect(t.host.handleKey(keyPress())).toBe(false)
  await waitForPalette(t.caller, false)
})
