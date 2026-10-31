import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'
import { PLUGIN_API_VERSION, type QuirkyClient, type QuirkyEvent, type UiCommandEntry, type UiModel, type UiPluginContext, type UiPluginModule, type UiToolEntry } from '@quirky/protocol'
import type { Connection } from '../src/connection'
import { AppContext, type AppContextValue } from '../src/context'
import { WindowPluginHost, type HostState } from '../src/plugins/host'
import { CommandPalette } from '../src/plugins/CommandPalette'
import { activate as activatePalette } from '../../../plugins/quirky.palette/src/ui'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../daemon/test/helpers'
import { makeTempDir, removeTempDirs, writePlugin } from '../../daemon/test/plugins/fixtures'


const PALETTE_COMMAND = 'command:quirky.palette/toggle'
const DOCK_COMMAND = 'command:acme.dock/passthrough'
const OVERRIDE_COMMAND = 'command:acme.override/open'
const CHORD = 'mod+shift+p'
const DOCK_WHEN = 'terminalDockMounted && terminalFocus || terminalDockMounted && terminalDockFocus'

const harnesses: Harness[] = []
const hosts: WindowPluginHost[] = []

let createRoot: (container: HTMLElement) => Root
let root: Root | null = null
let container: HTMLElement | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // ReactDOM captures the test DOM at initialization, so load it after happy-dom registration.
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
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

test('the window host carries the daemon-saved palette recents', async () => {
  const t = await boot()
  expect(t.host.getState().layout.paletteRecents).toBeUndefined()
  await t.caller.call('ui.palette.recent', { id: 'command:one' })
  await t.caller.call('ui.palette.recent', { id: 'worktree:two' })
  await waitFor(() => t.host.getState().layout.paletteRecents?.length === 2)
  expect(t.host.getState().layout.paletteRecents).toEqual(['worktree:two', 'command:one'])
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

type ListedAgent = { id: string; installed: boolean; enabled: boolean }

function paletteCommand(id: string, title: string, plugin = 'quirky.agents'): UiCommandEntry {
  return { id: `command:${plugin}/${id}`, plugin, title, module: null }
}

const displayedCommands: UiCommandEntry[] = [
  paletteCommand('new-agent-tab', 'New agent tab (default agent)'),
  paletteCommand('new-claude-tab', 'New Claude tab'),
  paletteCommand('new-claude-agent-teams-tab', 'New Claude Agent Teams tab'),
  paletteCommand('new-codex-tab', 'New Codex tab'),
  paletteCommand('new-gemini-tab', 'New Gemini tab'),
  paletteCommand('open-settings', 'Open agent settings'),
  paletteCommand('lookup', 'Unrelated action', 'acme.other')
]

function agentListing(agents: ListedAgent[]) {
  return {
    defaultAgent: 'claude',
    workspaceTrust: true,
    permissions: { summary: [], nonAuto: 'manual' },
    agents
  }
}

async function mountCommandPalette(loadAgents: () => Promise<unknown>, commands: UiCommandEntry[] = displayedCommands, tools: UiToolEntry[] = []) {
  const eventListeners = new Set<(event: QuirkyEvent) => void>()
  const connectedListeners = new Set<() => void>()
  const hostListeners = new Set<() => void>()
  const runCommands: string[] = []
  const openTools: string[] = []
  const state = {
    model: { commands, tools, views: [] } as unknown as UiModel,
    layout: { view: null },
    windowRoute: null
  } as HostState
  const plugins = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      hostListeners.add(listener)
      return () => {
        hostListeners.delete(listener)
      }
    },
    async runCommand(id: string) {
      runCommands.push(id)
    },
    openTool(id: string) {
      openTools.push(id)
    }
  } as unknown as WindowPluginHost
  const connection = {
    callAny(method: string) {
      if (method === 'quirky.agents/list') return loadAgents()
      if (['quirky.repo/list', 'quirky.worktree/list', 'quirky.session/list', 'quirky.ask/list'].includes(method)) {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`Unexpected daemon request: ${method}`))
    },
    onEvent(listener: (event: QuirkyEvent) => void) {
      eventListeners.add(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    onConnected(listener: () => void) {
      connectedListeners.add(listener)
      return () => {
        connectedListeners.delete(listener)
      }
    }
  } as unknown as Connection
  const value = {
    store: { dispatch: () => {} },
    connection,
    plugins
  } as unknown as AppContextValue

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(h(AppContext.Provider, { value }, h(CommandPalette, { onClose: () => {} })))
  })

  return {
    has(title: string) {
      return [...container!.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(title))
    },
    titles() {
      return [...container!.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
        option.querySelector('.ui-list-row__title')?.textContent ?? ''
      )
    },
    async search(query: string) {
      await act(async () => {
        const input = container!.querySelector<HTMLInputElement>('input')!
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    async keyDown(key: string) {
      await act(async () => {
        const input = container!.querySelector<HTMLInputElement>('input')!
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    },
    get runCommands() {
      return runCommands
    },
    get openTools() {
      return openTools
    },
    async agentsChanged() {
      await act(async () => {
        const event = { type: 'quirky.agents/changed', data: {} } as unknown as QuirkyEvent
        for (const listener of [...eventListeners]) listener(event)
        await Promise.resolve()
        await Promise.resolve()
      })
    },
    async reconnected() {
      await act(async () => {
        for (const listener of [...connectedListeners]) listener()
        await Promise.resolve()
        await Promise.resolve()
      })
    }
  }
}

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

test('mounted command palette tracks installed and enabled agent launches while staying open', async () => {
  let agents: ListedAgent[] = [
    { id: 'claude', installed: true, enabled: true },
    { id: 'claude-agent-teams', installed: true, enabled: true },
    { id: 'codex', installed: true, enabled: false },
    { id: 'gemini', installed: false, enabled: true }
  ]
  const palette = await mountCommandPalette(async () => agentListing(agents))

  expect(palette.has('New Claude tab')).toBe(true)
  expect(palette.has('New Claude Agent Teams tab')).toBe(true)
  expect(palette.has('New Codex tab')).toBe(false)
  expect(palette.has('New Gemini tab')).toBe(false)
  expect(palette.has('New agent tab')).toBe(true)
  expect(palette.has('Open agent settings')).toBe(true)
  expect(palette.has('Unrelated action')).toBe(true)

  agents = [
    { id: 'claude', installed: true, enabled: false },
    { id: 'claude-agent-teams', installed: true, enabled: true },
    { id: 'codex', installed: true, enabled: false },
    { id: 'gemini', installed: false, enabled: true }
  ]
  await palette.agentsChanged()
  expect(palette.has('New Claude tab')).toBe(false)
  expect(palette.has('New Claude Agent Teams tab')).toBe(true)
  expect(palette.has('New agent tab')).toBe(true)
  expect(palette.has('Unrelated action')).toBe(true)

  agents = [
    { id: 'claude', installed: true, enabled: true },
    { id: 'claude-agent-teams', installed: true, enabled: true },
    { id: 'codex', installed: true, enabled: true },
    { id: 'gemini', installed: false, enabled: true }
  ]
  await palette.agentsChanged()
  expect(palette.has('New Claude tab')).toBe(true)
  expect(palette.has('New Codex tab')).toBe(true)
  expect(palette.has('New Gemini tab')).toBe(false)
})

test('command palette ignores an older agent listing after a changed event refresh', async () => {
  const older = deferred<unknown>()
  const newer = deferred<unknown>()
  let requests = 0
  const palette = await mountCommandPalette(() => requests++ === 0 ? older.promise : newer.promise)

  expect(requests).toBe(1)
  expect(palette.has('New Claude tab')).toBe(false)
  expect(palette.has('New agent tab')).toBe(true)
  await palette.agentsChanged()
  expect(requests).toBe(2)

  await act(async () => {
    newer.resolve(agentListing([{ id: 'claude', installed: true, enabled: false }]))
    await newer.promise
  })
  expect(palette.has('New Claude tab')).toBe(false)

  await act(async () => {
    older.resolve(agentListing([{ id: 'claude', installed: true, enabled: true }]))
    await older.promise
  })
  expect(palette.has('New Claude tab')).toBe(false)
})

test('command palette keeps explicit launches hidden when the agent listing fails', async () => {
  const palette = await mountCommandPalette(() => Promise.reject(new Error('listing unavailable')))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(palette.has('New Claude tab')).toBe(false)
  expect(palette.has('New agent tab')).toBe(true)
  expect(palette.has('Unrelated action')).toBe(true)
})

test('palette Enter keeps the selected agent when an earlier launch disappears', async () => {
  let agents: ListedAgent[] = [
    { id: 'claude', installed: true, enabled: true },
    { id: 'codex', installed: true, enabled: true },
    { id: 'gemini', installed: true, enabled: true }
  ]
  const commands = [
    paletteCommand('new-agent-tab', 'New agent tab (default agent)'),
    paletteCommand('new-claude-tab', 'New Claude tab'),
    paletteCommand('new-codex-tab', 'New Codex tab'),
    paletteCommand('new-gemini-tab', 'New Gemini tab')
  ]
  const palette = await mountCommandPalette(async () => agentListing(agents), commands)
  await palette.search('new-')
  await palette.keyDown('ArrowDown')
  await palette.keyDown('ArrowDown')

  agents = [
    { id: 'claude', installed: true, enabled: false },
    { id: 'codex', installed: true, enabled: true },
    { id: 'gemini', installed: true, enabled: true }
  ]
  await palette.agentsChanged()
  await palette.keyDown('Enter')

  expect(palette.runCommands).toEqual(['command:quirky.agents/new-codex-tab'])
})

test('palette prioritizes exact title matches while preserving result order and Enter opens the tool', async () => {
  const commands = [
    paletteCommand('collapse', 'Collapse', 'acme.files'),
    paletteCommand('filter-changed', 'Filter Changed', 'acme.files'),
    paletteCommand('search', 'Search', 'acme.files'),
    paletteCommand('select', 'Select', 'acme.files')
  ]
  const tool: UiToolEntry = {
    id: 'tool:acme.files/files',
    title: 'Files',
    icon: 'folders',
    hue: 'sand',
    defaultSlot: 'right-top',
    contributionId: 'acme.files',
    aliases: []
  }
  const palette = await mountCommandPalette(async () => agentListing([]), commands, [tool])

  await palette.search('  fIlEs  ')
  expect(palette.titles()).toEqual(['Files', 'Collapse', 'Filter Changed', 'Search', 'Select'])

  await palette.search('file')
  expect(palette.titles()).toEqual(['Collapse', 'Filter Changed', 'Search', 'Select', 'Files'])

  await palette.search('')
  expect(palette.titles()).toEqual(['Collapse', 'Filter Changed', 'Search', 'Select', 'Files'])

  await palette.search(' fIlEs ')
  await palette.keyDown('Enter')
  expect(palette.openTools).toEqual([tool.id])
  expect(palette.runCommands).toEqual([])
})

test('palette reloads the agent list after the connection reconnects', async () => {
  let requests = 0
  const palette = await mountCommandPalette(() => {
    requests++
    return requests === 1
      ? Promise.reject(new Error('Not connected'))
      : Promise.resolve(agentListing([{ id: 'claude', installed: true, enabled: true }]))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(palette.has('New Claude tab')).toBe(false)

  await palette.reconnected()
  expect(requests).toBe(2)
  expect(palette.has('New Claude tab')).toBe(true)
})
