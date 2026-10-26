import { expect, test } from 'bun:test'
import {
  DEFAULT_THEME,
  type QuirkyEvent,
  type SettingInfo,
  type ThemeInfo,
  type UiCommandEntry,
  type UiKeybinding,
  type UiLayout,
  type UiModel,
  type UiPluginContext,
  type UiPluginModule,
  type UiSlotEntry
} from '@quirky/protocol'
import { WindowPluginHost, type HostState } from '../src/plugins/host'

type Fake = { text?: string }
type ModuleFactory = () => unknown

const hang = (): Promise<never> => new Promise(() => {})
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const element = (): HTMLElement => ({}) as unknown as HTMLElement

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await tick()
  }
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

function slot(kind: UiSlotEntry['kind'], plugin: string, name: string, extra: Partial<UiSlotEntry> = {}): UiSlotEntry {
  return { id: `${kind}:${plugin}/${name}`, kind, plugin, title: name, order: 100, module: `/plugins/${plugin}/ui.js`, ...extra }
}
const section = (plugin: string, name: string, extra?: Partial<UiSlotEntry>) =>
  slot('sidebar-section', plugin, name, extra)
const panel = (plugin: string, name: string) => slot('panel', plugin, name)
const view = (plugin: string, name: string) => slot('view', plugin, name)
const command = (plugin: string, name: string, title = name): UiCommandEntry => ({
  id: `command:${plugin}/${name}`,
  plugin,
  title,
  module: `/plugins/${plugin}/ui.js`
})
const binding = (plugin: string, name: string, key: string, cmd: string, status: UiKeybinding['status'] = 'active') =>
  ({ id: `keybinding:${plugin}/${name}`, plugin, key, command: cmd, status }) satisfies UiKeybinding

const urlOf = (plugin: string) => `/plugins/${plugin}/ui.js`

/** A model whose `modules` lets every plugin provide each code-backed entry it owns, unless overridden. */
function makeModel(parts: Partial<UiModel> = {}): UiModel {
  const model: UiModel = {
    sidebarSections: [],
    panels: [],
    views: [],
    commands: [],
    keybindings: [],
    settings: [],
    themes: [DEFAULT_THEME],
    theme: { chosen: 'default', active: 'default' },
    modules: {},
    ...parts
  }
  if (parts.modules) return model
  const entries = [...model.sidebarSections, ...model.panels, ...model.views, ...model.commands]
  for (const entry of entries) {
    const module = (model.modules[entry.plugin] ??= { url: urlOf(entry.plugin), provides: [] })
    module.provides.push(entry.id)
  }
  return model
}

function setting(id: string, value: SettingInfo['value'], plugin = 'acme.notes'): SettingInfo {
  return { id, plugin, type: 'number', title: id, default: 13, value }
}

type WindowFocus = NonNullable<ConstructorParameters<typeof WindowPluginHost>[0]['windowFocus']>

function setup(
  initial: UiModel,
  options: { settings?: SettingInfo[]; activationTimeoutMs?: number; windowFocus?: WindowFocus } = {}
) {
  let model = initial
  let settings = options.settings ?? []
  let layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const emitEvent = (event: QuirkyEvent) => listeners.forEach((listener) => listener(event))
  /** What the daemon would answer: a view or panel the model no longer has is dropped. */
  const effective = (): UiLayout => ({
    ...layout,
    view: layout.view && model.views.some((v) => v.id === layout.view!.id) ? layout.view : null,
    panel: layout.panel && model.panels.some((p) => p.id === layout.panel) ? layout.panel : null
  })
  let held: QuirkyEvent[] | null = null
  const changeLayout = (update: Partial<UiLayout>) => {
    layout = { ...effective(), ...update }
    const event: QuirkyEvent = { type: 'ui.state.changed', layout: effective() }
    if (held) held.push(event)
    else emitEvent(event)
    return effective()
  }
  const streams = new Map<number, Set<(bytes: Uint8Array) => void>>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const confirms: { title: string; body?: string; confirmLabel?: string }[] = []
  let confirmAnswer = true
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const imports: string[] = []
  const modules = new Map<string, ModuleFactory>()
  const toasts: [string, string][] = []
  const toastKinds: string[] = []
  const logs: string[] = []
  const refused = new Map<string, string>()
  const holds = new Map<string, Promise<void>>()

  const host = new WindowPluginHost({
    call: async (method, params) => {
      calls.push({ method, params })
      switch (method) {
        case 'ui.contributions':
          return model
        case 'ui.state':
          return { windows: [], layout: effective(), slots: [] }
        case 'ui.view.open':
          if (!model.views.some((v) => v.id === params.id)) throw new Error(`no view ${params.id}`)
          return changeLayout({ view: { id: params.id as string, ...(params.input !== undefined ? { input: params.input } : {}) } })
        case 'ui.view.close':
          return changeLayout({ view: null })
        case 'ui.panel.open':
          if (!model.panels.some((p) => p.id === params.id)) throw new Error(`no panel ${params.id}`)
          return changeLayout({ panel: params.id as string })
        case 'ui.panel.close':
          return changeLayout({ panel: null })
        case 'ui.focus':
          return changeLayout({ focus: params.target as UiLayout['focus'] })
        case 'ui.report':
          if (refused.has('ui.report')) throw new Error(refused.get('ui.report'))
          return { ok: true }
        case 'ui.window.focused':
        case 'ui.command.reply':
          return { ok: true }
        case 'setting.list': {
          const snapshot = settings
          await holds.get(method)
          return snapshot
        }
        case 'setting.set':
        case 'theme.set': {
          const key = method === 'theme.set' ? 'theme' : (params.id as string)
          if (refused.has(key)) throw new Error(refused.get(key))
          return {}
        }
        case 'repo.list':
          return [{ id: 'r1' }]
        default:
          throw new Error(`unknown method ${method}`)
      }
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    importModule: async (url) => {
      imports.push(url)
      const factory = modules.get(url.split('?')[0])
      if (!factory) throw new Error(`no module ${url}`)
      return factory()
    },
    onStream: (streamId, listener) => {
      const set = streams.get(streamId) ?? new Set()
      set.add(listener)
      streams.set(streamId, set)
      return () => set.delete(listener)
    },
    onConnection: (listener) => {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    confirm: async (confirmOptions) => {
      confirms.push(confirmOptions)
      return confirmAnswer
    },
    toast: (title, body, kind) => {
      toasts.push([title, body])
      toastKinds.push(kind)
    },
    log: (message) => logs.push(message),
    activationTimeoutMs: options.activationTimeoutMs,
    windowFocus: options.windowFocus
  })

  return {
    host,
    calls,
    confirms,
    answerConfirm: (answer: boolean) => (confirmAnswer = answer),
    pushStream: (streamId: number, bytes: Uint8Array) => streams.get(streamId)?.forEach((listener) => listener(bytes)),
    setConnection: (status: 'connected' | 'reconnecting') => connectionListeners.forEach((listener) => listener(status)),
    streamListeners: (streamId: number) => streams.get(streamId)?.size ?? 0,
    connectionListenerCount: () => connectionListeners.size,
    /** The layout the daemon holds; the host only learns of a change through the broadcast. */
    daemonLayout: () => effective(),
    changeLayout,
    /** Keeps the daemon's `ui.state.changed` broadcasts back until `releaseBroadcasts`. */
    holdBroadcasts: () => (held = []),
    releaseBroadcasts: () => {
      const events = held ?? []
      held = null
      events.forEach(emitEvent)
    },
    toastKinds,
    imports,
    modules,
    toasts,
    logs,
    refused,
    holds,
    listenerCount: () => listeners.size,
    setModel: (next: UiModel) => (model = next),
    setSettings: (next: SettingInfo[]) => (settings = next),
    emit: emitEvent,
    methodCalls: (method: string) => calls.filter((call) => call.method === method),
    useModule: (plugin: string, module: UiPluginModule | ModuleFactory) =>
      modules.set(urlOf(plugin), typeof module === 'function' ? module : () => module)
  }
}
type Harness = ReturnType<typeof setup>

const state = (t: Harness): HostState => t.host.getState()
const settled = (t: Harness, id: string) => until(() => state(t).slots[id]?.status !== 'loading')

/** A module that provides `implementation` for each of `ids`, and records its activations and deactivations. */
function recording(ids: string[], implementation: (id: string) => unknown = () => () => {}) {
  const record = { activations: 0, deactivations: 0, contexts: [] as UiPluginContext[] }
  const module: UiPluginModule = {
    activate(context) {
      record.activations++
      record.contexts.push(context)
      for (const id of ids) context.provide(id, implementation(id))
    },
    deactivate() {
      record.deactivations++
    }
  }
  return { module, record }
}

const NOTES = 'acme.notes'
const LIST = 'sidebar-section:acme.notes/list'
const PAGE = 'view:acme.notes/page'
const OPEN = 'command:acme.notes/open'
const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: code.replace('Key', ''),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

test('SC-7: mounting a section loads its module once and mounts with only the element and props', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const calls: unknown[][] = []
  let cleanups = 0
  const { module, record } = recording([LIST], () => (...args: unknown[]) => {
    calls.push(args)
    ;(args[0] as Fake).text = '3 notes'
    return () => cleanups++
  })
  t.useModule(NOTES, module)
  await t.host.refresh()
  expect(t.imports).toEqual([])

  const el = element()
  t.host.mount(LIST, el)
  expect(state(t).slots[LIST]).toEqual({ status: 'loading' })
  await settled(t, LIST)

  expect(state(t).slots[LIST]).toEqual({ status: 'mounted' })
  expect(t.imports).toEqual([urlOf(NOTES)])
  expect(record.activations).toBe(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toHaveLength(2)
  expect(calls[0][0]).toBe(el)
  expect(calls[0][1]).toEqual({ report: expect.any(Function) })
  expect((el as Fake).text).toBe('3 notes')
  expect(state(t).plugins[NOTES]).toEqual({ state: 'active' })
  expect(cleanups).toBe(0)
})

test('SC-7: concurrent mounts and commands share one import and one activation', async () => {
  const t = setup(
    makeModel({ sidebarSections: [section(NOTES, 'list'), section(NOTES, 'other')], commands: [command(NOTES, 'open')] })
  )
  const release = gate()
  const { module, record } = recording([LIST, 'sidebar-section:acme.notes/other', OPEN])
  t.useModule(NOTES, async () => {
    await release.opened
    return module
  })
  await t.host.refresh()

  t.host.mount(LIST, element())
  t.host.mount('sidebar-section:acme.notes/other', element())
  const run = t.host.runCommand(OPEN)
  await tick()
  release.open()
  await run
  await settled(t, LIST)

  expect(t.imports).toHaveLength(1)
  expect(record.activations).toBe(1)
})

test('SC-8: refreshing and rendering toggles, with nothing shown or run, imports no module', async () => {
  const t = setup(makeModel({ panels: [panel('acme.outline', 'outline')], views: [view('acme.outline', 'page')] }))
  await t.host.refresh()
  t.host.togglePanel('panel:acme.outline/outline', false)
  expect(t.imports).toEqual([])
  expect(state(t).plugins).toEqual({})
  expect(state(t).model?.panels.map((p) => p.title)).toEqual(['outline'])
})

test('SC-9: opening a panel closes the other one, and toggling closes it', async () => {
  const t = setup(makeModel({ panels: [panel('acme.outline', 'outline'), panel(NOTES, 'side')] }))
  await t.host.refresh()
  const outline = 'panel:acme.outline/outline'
  const side = 'panel:acme.notes/side'

  t.host.togglePanel(outline)
  expect(state(t).openPanel).toBe(outline)
  t.host.togglePanel(side)
  expect(state(t).openPanel).toBe(side)
  t.host.togglePanel(side)
  expect(state(t).openPanel).toBeNull()
  t.host.togglePanel(side, true)
  t.host.togglePanel(side, true)
  expect(state(t).openPanel).toBe(side)
  t.host.togglePanel(outline, false)
  expect(state(t).openPanel).toBe(side)
  t.host.togglePanel(side, false)
  expect(state(t).openPanel).toBeNull()
})

test('SC-9: a panel mounts with only a report function and its cleanup runs when it is disposed', async () => {
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')] }))
  const side = 'panel:acme.notes/side'
  let received: unknown
  let cleanups = 0
  t.useModule(NOTES, recording([side], () => (_el: unknown, props: unknown) => {
    received = props
    return () => cleanups++
  }).module)
  await t.host.refresh()

  const dispose = t.host.mount(side, element(), { input: 'ignored' })
  await settled(t, side)
  expect(received).toEqual({ report: expect.any(Function) })
  dispose()
  dispose()
  expect(cleanups).toBe(1)
  expect(state(t).slots[side]).toBeUndefined()
})

test('SC-10: a command opens a view with an input and a second view replaces it', async () => {
  const t = setup(
    makeModel({ commands: [command(NOTES, 'open')], views: [view(NOTES, 'page'), view(NOTES, 'other')] })
  )
  const other = 'view:acme.notes/other'
  const props: unknown[] = []
  const { module } = recording([OPEN, PAGE, other], (id) => {
    if (id === OPEN) return () => (contexts[0] as UiPluginContext).openView(PAGE, { noteId: 'n1' })
    return (_el: unknown, p: unknown) => props.push(p)
  })
  const contexts: UiPluginContext[] = []
  t.useModule(NOTES, {
    activate(context) {
      contexts.push(context)
      return module.activate(context)
    }
  })
  await t.host.refresh()

  await t.host.runCommand(OPEN)
  expect(state(t).openView).toEqual({ id: PAGE, input: { noteId: 'n1' } })

  t.host.mount(PAGE, element(), { input: state(t).openView?.input })
  await settled(t, PAGE)
  expect(props).toEqual([{ input: { noteId: 'n1' }, report: expect.any(Function) }])

  t.host.openView(other)
  expect(state(t).openView?.id).toBe(other)
  contexts[0].closeView()
  expect(state(t).openView).toBeNull()
})

test('SC-11: a plugin calls the daemon through its context and receives events on a later task', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const received: QuirkyEvent[] = []
  let repos: unknown
  t.useModule(NOTES, {
    async activate(context) {
      context.subscribe((event) => {
        received.push(event)
      })
      repos = await context.call('repo.list')
      context.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  expect(repos).toEqual([{ id: 'r1' }])
  expect(t.methodCalls('repo.list')[0].params).toEqual({})

  t.emit({ type: 'acme.notes/changed', data: null })
  expect(received).toEqual([])
  await tick()
  expect(received).toEqual([{ type: 'acme.notes/changed', data: null }])
})

test('SC-11: a listener that throws or rejects is logged with its plugin ID and does not stop the others', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const received: string[] = []
  t.useModule(NOTES, {
    activate(context) {
      context.subscribe(() => {
        throw new Error('sync boom')
      })
      context.subscribe(async () => {
        throw new Error('async boom')
      })
      context.subscribe((event) => {
        received.push(event.type)
      })
      context.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  t.emit({ type: 'acme.notes/changed', data: null })
  await tick()
  await tick()
  expect(received).toEqual(['acme.notes/changed'])
  expect(t.logs).toContain('acme.notes: event listener failed: sync boom')
  expect(t.logs).toContain('acme.notes: event listener failed: async boom')
})

test('SC-11: an unsubscribed listener gets nothing, and after deactivation the context is revoked', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')], commands: [command(NOTES, 'open')] }))
  const received: string[] = []
  const { module, record } = recording([LIST, OPEN])
  t.useModule(NOTES, {
    activate(context) {
      module.activate(context)
      const off = context.subscribe((event) => {
        received.push(`off:${event.type}`)
      })
      off()
      context.subscribe((event) => {
        received.push(event.type)
      })
    },
    deactivate: module.deactivate
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  t.emit({ type: 'acme.notes/changed', data: null })
  await tick()
  expect(received).toEqual(['acme.notes/changed'])

  t.setModel(makeModel({ modules: {} }))
  await t.host.refresh()
  const context = record.contexts[0]
  expect(record.deactivations).toBe(1)
  t.emit({ type: 'acme.notes/changed', data: null })
  await tick()
  expect(received).toEqual(['acme.notes/changed'])
  const revoked = 'acme.notes is not active'
  expect(() => context.call('repo.list')).toThrow(revoked)
  expect(() => context.provide(LIST, () => {})).toThrow(revoked)
  expect(() => context.subscribe(() => {})).toThrow(revoked)
  expect(() => context.executeCommand(OPEN)).toThrow(revoked)
  expect(() => context.getSetting('x')).toThrow(revoked)
  expect(() => context.openView(PAGE)).toThrow(revoked)
  expect(() => context.closeView()).toThrow(revoked)
  expect(() => context.togglePanel('panel:acme.notes/side')).toThrow(revoked)
})

test('SC-12: providing an undeclared ID fails the load and the slots show the ID, even if the plugin catches the throw', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  t.useModule(NOTES, {
    activate(context) {
      try {
        context.provide('command:acme.notes/undeclared', () => {})
      } catch {}
      context.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  const message = 'acme.notes does not declare command:acme.notes/undeclared'
  expect(state(t).slots[LIST]).toEqual({ status: 'error', message })
  expect(state(t).plugins[NOTES]).toEqual({ state: 'failed', error: message })
})

test('SC-12: a plugin that activates without providing its section gets a did-not-provide error', async () => {
  const t = setup(makeModel({ sidebarSections: [section('acme.lazy', 'list')] }))
  t.useModule('acme.lazy', { activate() {} })
  await t.host.refresh()
  const id = 'sidebar-section:acme.lazy/list'
  t.host.mount(id, element())
  await settled(t, id)

  expect(state(t).slots[id]).toEqual({ status: 'error', message: `acme.lazy did not provide ${id}` })
  expect(state(t).plugins['acme.lazy'].state).toBe('active')
})

test('SC-12: an implementation that is not a function fails the load', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  t.useModule(NOTES, { activate: (context) => context.provide(LIST, { mount: true }) })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  expect(state(t).plugins[NOTES]).toEqual({
    state: 'failed',
    error: `acme.notes must provide a function for ${LIST}`
  })
})

test('SC-12: the provide whitelist is the one captured when the load started', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const release = gate()
  t.useModule(NOTES, {
    async activate(context) {
      await release.opened
      context.provide(LIST, () => {})
      context.provide('command:acme.notes/later', () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await tick()

  t.setModel(makeModel({ sidebarSections: [section(NOTES, 'list')], commands: [command(NOTES, 'later')] }))
  await t.host.refresh()
  release.open()
  await settled(t, LIST)

  expect(state(t).plugins[NOTES].error).toBe('acme.notes does not declare command:acme.notes/later')
})

test('SC-12: a plugin may provide an override under the overridden ID', async () => {
  const baseId = 'sidebar-section:acme.base/list'
  const t = setup(makeModel({ sidebarSections: [section('acme.over', 'list', { id: baseId })] }))
  t.useModule('acme.over', recording([baseId]).module)
  await t.host.refresh()
  expect(state(t).model?.modules['acme.over'].provides).toEqual([baseId])
  t.host.mount(baseId, element())
  await settled(t, baseId)
  expect(state(t).slots[baseId]).toEqual({ status: 'mounted' })
})

test('SC-6: a plugin without a ui module fails with a message in its slot and a toast for its command', async () => {
  const t = setup(makeModel({ sidebarSections: [section('acme.bare', 'list')], commands: [command('acme.bare', 'go')], modules: {} }))
  await t.host.refresh()
  const id = 'sidebar-section:acme.bare/list'
  t.host.mount(id, element())
  await settled(t, id)
  expect(state(t).slots[id]).toEqual({ status: 'error', message: 'acme.bare has no ui module' })

  await t.host.runCommand('command:acme.bare/go')
  expect(t.toasts).toEqual([['command:acme.bare/go failed: acme.bare has no ui module', 'acme.bare has no ui module']])
  expect(t.imports).toEqual([])
})

test('SC-13: failures stay in their slot and the other plugins still mount', async () => {
  const t = setup(
    makeModel({
      sidebarSections: [section('acme.broken', 'a'), section('acme.throws', 'b'), section('acme.badact', 'c'), section(NOTES, 'list')]
    })
  )
  t.useModule('acme.broken', () => {
    throw new Error('Unexpected token')
  })
  t.useModule('acme.throws', recording(['sidebar-section:acme.throws/b'], () => () => {
    throw new Error('boom')
  }).module)
  t.useModule('acme.badact', {
    activate() {
      throw new Error('bad')
    }
  })
  t.useModule(NOTES, recording([LIST]).module)
  await t.host.refresh()
  const ids = ['sidebar-section:acme.broken/a', 'sidebar-section:acme.throws/b', 'sidebar-section:acme.badact/c', LIST]
  for (const id of ids) t.host.mount(id, element())
  for (const id of ids) await settled(t, id)

  expect(state(t).slots[ids[0]]).toEqual({ status: 'error', message: 'acme.broken failed to load: Unexpected token' })
  expect(state(t).slots[ids[1]]).toEqual({ status: 'error', message: 'acme.throws: boom' })
  expect(state(t).slots[ids[2]]).toEqual({ status: 'error', message: 'acme.badact failed to activate: bad' })
  expect(state(t).slots[ids[3]]).toEqual({ status: 'mounted' })
  expect(state(t).plugins['acme.broken']).toEqual({ state: 'failed', error: 'acme.broken failed to load: Unexpected token' })
})

test('SC-13: a module without an activate function fails to load', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  t.useModule(NOTES, () => ({ nothing: true }))
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  expect(state(t).plugins[NOTES].error).toBe('acme.notes failed to load: module does not export activate')
})

test('SC-13: a command that throws or rejects raises a toast titled with the command ID', async () => {
  const t = setup(makeModel({ commands: [command('acme.cmd', 'go'), command('acme.cmd', 'later')] }))
  t.useModule(
    'acme.cmd',
    recording(['command:acme.cmd/go', 'command:acme.cmd/later'], (id) =>
      id.endsWith('/go')
        ? () => {
            throw new Error('nope')
          }
        : async () => {
            throw new Error('eventually')
          }
    ).module
  )
  await t.host.refresh()

  await t.host.runCommand('command:acme.cmd/go')
  await t.host.runCommand('command:acme.cmd/later')
  expect(t.toasts).toEqual([
    ['command:acme.cmd/go failed: nope', 'nope'],
    ['command:acme.cmd/later failed: eventually', 'eventually']
  ])
})

test('SC-13: showing a slot again retries a failed mount', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let attempts = 0
  t.useModule(NOTES, recording([LIST], () => () => {
    if (++attempts === 1) throw new Error('boom')
  }).module)
  await t.host.refresh()

  t.host.mount(LIST, element())
  await settled(t, LIST)
  expect(state(t).slots[LIST]).toEqual({ status: 'error', message: 'acme.notes: boom' })
  t.host.mount(LIST, element())
  await until(() => state(t).slots[LIST]?.status === 'mounted')
  expect(t.imports).toHaveLength(1)
})

test('SC-13: a retried import appends an attempt number, and a successful one is not repeated', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let imports = 0
  const { module } = recording([LIST])
  t.useModule(NOTES, () => {
    if (++imports < 3) throw new Error(`fail ${imports}`)
    return module
  })
  await t.host.refresh()

  for (const expected of ['failed to load: fail 1', 'failed to load: fail 2']) {
    t.host.mount(LIST, element())
    await until(() => state(t).plugins[NOTES]?.error === `acme.notes ${expected}`)
  }
  t.host.mount(LIST, element())
  await until(() => state(t).slots[LIST]?.status === 'mounted')
  expect(t.imports).toEqual([urlOf(NOTES), `${urlOf(NOTES)}?attempt=1`, `${urlOf(NOTES)}?attempt=2`])
})

test('SC-13: a module that imported but failed to activate is activated again without importing again', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let activations = 0
  t.useModule(NOTES, {
    activate(context) {
      if (++activations === 1) throw new Error('bad')
      context.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  expect(state(t).plugins[NOTES].error).toBe('acme.notes failed to activate: bad')

  t.host.mount(LIST, element())
  await until(() => state(t).slots[LIST]?.status === 'mounted')
  expect(t.imports).toHaveLength(1)
  expect(activations).toBe(2)
  expect(state(t).plugins[NOTES]).toEqual({ state: 'active' })
})

test('SC-13: a failed attempt revokes its context at once and never calls deactivate', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const received: string[] = []
  let context!: UiPluginContext
  let deactivations = 0
  t.useModule(NOTES, {
    activate(ctx) {
      context = ctx
      ctx.subscribe((event) => {
        received.push(event.type)
      })
      ctx.provide(LIST, () => {})
      throw new Error('bad')
    },
    deactivate() {
      deactivations++
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  t.emit({ type: 'acme.notes/changed', data: null })
  await tick()
  expect(received).toEqual([])
  expect(() => context.call('repo.list')).toThrow('acme.notes is not active')
  expect(deactivations).toBe(0)
  expect(state(t).slots[LIST].status).toBe('error')
})

test('SC-13: activation that outlives the timeout fails, and its late settling is ignored', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), { activationTimeoutMs: 30 })
  const release = gate()
  let deactivations = 0
  let lateOutcome = ''
  t.useModule(NOTES, {
    async activate(context) {
      await release.opened
      try {
        context.provide(LIST, () => {})
        lateOutcome = 'provided'
      } catch (error) {
        lateOutcome = (error as Error).message
      }
    },
    deactivate() {
      deactivations++
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  const message = 'acme.notes failed to activate: activation timed out'
  expect(state(t).slots[LIST]).toEqual({ status: 'error', message })
  release.open()
  await tick()
  expect(lateOutcome).toBe('acme.notes is not active')
  expect(state(t).plugins[NOTES]).toEqual({ state: 'failed', error: message })
  expect(deactivations).toBe(0)
})

test('SC-13: a hanging import times out, and the retry imports again with an attempt number', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), { activationTimeoutMs: 30 })
  let imports = 0
  const { module } = recording([LIST])
  t.useModule(NOTES, () => (++imports === 1 ? hang() : module))
  await t.host.refresh()

  t.host.mount(LIST, element())
  await settled(t, LIST)
  expect(state(t).plugins[NOTES].error).toBe('acme.notes failed to activate: activation timed out')
  t.host.mount(LIST, element())
  await until(() => state(t).slots[LIST]?.status === 'mounted')
  expect(t.imports).toEqual([urlOf(NOTES), `${urlOf(NOTES)}?attempt=1`])
})

test('SC-4: a section that leaves is cleaned up and dropped, its plugin deactivated and the context revoked', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let cleanups = 0
  const { module, record } = recording([LIST], () => () => () => cleanups++)
  t.useModule(NOTES, module)
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  t.setModel(makeModel())
  await t.host.refresh()

  expect(cleanups).toBe(1)
  expect(state(t).slots[LIST]).toBeUndefined()
  expect(record.deactivations).toBe(1)
  expect(state(t).plugins[NOTES]).toEqual({ state: 'idle' })
  expect(() => record.contexts[0].call('repo.list')).toThrow('acme.notes is not active')
})

test('SC-4: re-enabling mounts the section again without importing the module again', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const { module, record } = recording([LIST])
  t.useModule(NOTES, module)
  await t.host.refresh()
  const first = t.host.mount(LIST, element())
  await settled(t, LIST)

  t.setModel(makeModel())
  await t.host.refresh()
  first()
  t.setModel(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  await t.host.refresh()
  t.host.mount(LIST, element())
  await until(() => state(t).slots[LIST]?.status === 'mounted')

  expect(t.imports).toHaveLength(1)
  expect(record.activations).toBe(2)
  expect(record.contexts[1]).not.toBe(record.contexts[0])
})

test('SC-4: a plugin that still owns another contribution stays active when one leaves', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')], commands: [command(NOTES, 'open')] }))
  let cleanups = 0
  const { module, record } = recording([LIST, OPEN], (id) => (id === LIST ? () => () => cleanups++ : () => {}))
  t.useModule(NOTES, module)
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  t.setModel(makeModel({ commands: [command(NOTES, 'open')] }))
  await t.host.refresh()

  expect(cleanups).toBe(1)
  expect(record.deactivations).toBe(0)
  expect(state(t).plugins[NOTES].state).toBe('active')
})

test('SC-4: a contribution that leaves while its module loads is never mounted and the plugin is deactivated', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const release = gate()
  let mounted = 0
  const { module, record } = recording([LIST], () => () => {
    mounted++
  })
  t.useModule(NOTES, async () => {
    await release.opened
    return module
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await tick()

  t.setModel(makeModel())
  await t.host.refresh()
  release.open()
  await until(() => record.deactivations === 1)

  expect(mounted).toBe(0)
  expect(state(t).slots[LIST]).toBeUndefined()
  expect(state(t).plugins[NOTES]).toEqual({ state: 'idle' })
  expect(() => record.contexts[0].call('repo.list')).toThrow('acme.notes is not active')
})

test('C1: re-enabling a contribution while the orphaned load awaits deactivate reactivates the plugin', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), { activationTimeoutMs: 5000 })
  const importGate = gate()
  const deactivateGate = gate()
  const record = { activations: 0, deactivations: 0 }
  const module: UiPluginModule = {
    activate(context) {
      record.activations++
      context.provide(LIST, (el: unknown) => {
        ;(el as Fake).text = `mounted ${record.activations}`
      })
    },
    async deactivate() {
      record.deactivations++
      await deactivateGate.opened
    }
  }
  t.useModule(NOTES, async () => {
    await importGate.opened
    return module
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await tick()

  t.setModel(makeModel())
  await t.host.refresh()
  importGate.open()
  await until(() => record.deactivations === 1)

  t.setModel(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  await t.host.refresh()
  const el = element()
  t.host.mount(LIST, el)
  await tick()
  expect(state(t).slots[LIST]).toEqual({ status: 'loading' })
  expect(record.activations).toBe(1)

  deactivateGate.open()
  await settled(t, LIST)

  expect(state(t).slots[LIST]).toEqual({ status: 'mounted' })
  expect((el as Fake).text).toBe('mounted 2')
  expect(record.activations).toBe(2)
  expect(record.deactivations).toBe(1)
  expect(state(t).plugins[NOTES]).toEqual({ state: 'active' })
  expect(t.imports).toEqual([urlOf(NOTES)])
})

test('C1: a command arriving during the orphaned deactivate waits for it and then runs', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'open')] }), { activationTimeoutMs: 5000 })
  const importGate = gate()
  const deactivateGate = gate()
  const ran: unknown[] = []
  let deactivations = 0
  t.useModule(NOTES, async () => {
    await importGate.opened
    return {
      activate(context: UiPluginContext) {
        context.provide(OPEN, (args: unknown) => ran.push(args))
      },
      async deactivate() {
        deactivations++
        await deactivateGate.opened
      }
    }
  })
  await t.host.refresh()
  const first = t.host.runCommand(OPEN, 'first')
  await tick()
  t.setModel(makeModel())
  await t.host.refresh()
  t.setModel(makeModel({ commands: [command(NOTES, 'open')] }))
  importGate.open()
  await until(() => deactivations === 1)
  await t.host.refresh()

  const second = t.host.runCommand(OPEN, 'second')
  await tick()
  deactivateGate.open()
  await Promise.all([first, second])
  expect(ran).toContain('second')
  expect(t.toasts).toEqual([])
})

test('C2: a provide breach inside a mount function keeps its error and runs the returned cleanup', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let cleanups = 0
  t.useModule(NOTES, {
    activate(context) {
      context.provide(LIST, () => {
        try {
          context.provide('command:acme.notes/undeclared', () => {})
        } catch {}
        return () => cleanups++
      })
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  await tick()

  const message = 'acme.notes does not declare command:acme.notes/undeclared'
  expect(state(t).slots[LIST]).toEqual({ status: 'error', message })
  expect(state(t).plugins[NOTES]).toEqual({ state: 'failed', error: message })
  expect(cleanups).toBe(1)
})

test('C2: a cleanup that throws after a breach inside a mount function is logged', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  t.useModule(NOTES, {
    activate(context) {
      context.provide(LIST, () => {
        try {
          context.provide('command:acme.notes/undeclared', () => {})
        } catch {}
        return () => {
          throw new Error('boom')
        }
      })
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  await tick()

  expect(state(t).slots[LIST]?.status).toBe('error')
  expect(t.logs).toContain('acme.notes: cleanup failed: boom')
})

test('S3: slot import, activation, did-not-provide and mount failures are logged with the plugin ID once', async () => {
  const t = setup(
    makeModel({
      sidebarSections: [section('acme.imp', 'list'), section('acme.act', 'list'), section('acme.none', 'list'), section('acme.mnt', 'list')]
    })
  )
  t.useModule('acme.act', {
    activate() {
      throw new Error('bad activate')
    }
  })
  t.useModule('acme.none', { activate() {} })
  t.useModule('acme.mnt', {
    activate(context) {
      context.provide('sidebar-section:acme.mnt/list', () => {
        throw new Error('bad mount')
      })
    }
  })
  await t.host.refresh()
  const ids = ['acme.imp', 'acme.act', 'acme.none', 'acme.mnt'].map((plugin) => `sidebar-section:${plugin}/list`)
  for (const id of ids) t.host.mount(id, element())
  for (const id of ids) await settled(t, id)

  expect([...t.logs].sort()).toEqual([
    'acme.imp failed to load: no module /plugins/acme.imp/ui.js',
    'acme.act failed to activate: bad activate',
    'acme.none did not provide sidebar-section:acme.none/list',
    'acme.mnt: bad mount'
  ].sort())
})

test('SC-4: a mount disposed while its module loads is never mounted', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const release = gate()
  let mounted = 0
  t.useModule(NOTES, async () => {
    await release.opened
    return recording([LIST], () => () => {
      mounted++
    }).module
  })
  await t.host.refresh()
  const dispose = t.host.mount(LIST, element())
  await tick()
  dispose()
  release.open()
  await until(() => state(t).plugins[NOTES]?.state === 'active')
  await tick()
  expect(mounted).toBe(0)
  expect(state(t).slots[LIST]).toBeUndefined()
})

test('SC-4: a contribution that changes owner is cleaned up under the old owner and mounts under the new one', async () => {
  const t = setup(makeModel({ sidebarSections: [section('acme.base', 'list')] }))
  const id = 'sidebar-section:acme.base/list'
  const base = recording([id], () => () => () => cleanups.push('base'))
  const cleanups: string[] = []
  t.useModule('acme.base', base.module)
  t.useModule('acme.over', recording([id], () => () => () => cleanups.push('over')).module)
  await t.host.refresh()
  t.host.mount(id, element())
  await settled(t, id)

  t.setModel(makeModel({ sidebarSections: [section('acme.over', 'list', { id })] }))
  await t.host.refresh()
  expect(cleanups).toEqual(['base'])
  expect(state(t).slots[id]).toBeUndefined()
  expect(base.record.deactivations).toBe(1)

  t.host.mount(id, element())
  await settled(t, id)
  expect(state(t).slots[id]).toEqual({ status: 'mounted' })
  expect(t.imports).toEqual([urlOf('acme.base'), urlOf('acme.over')])
})

test('SC-4: a cleanup or deactivate that throws is logged and teardown continues', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list'), section(NOTES, 'b')] }))
  const second = 'sidebar-section:acme.notes/b'
  let secondCleaned = false
  let context!: UiPluginContext
  t.useModule(NOTES, {
    activate(ctx) {
      context = ctx
      ctx.provide(LIST, () => () => {
        throw new Error('cleanup boom')
      })
      ctx.provide(second, () => () => {
        secondCleaned = true
      })
    },
    deactivate() {
      throw new Error('deactivate boom')
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  t.host.mount(second, element())
  await settled(t, LIST)
  await settled(t, second)

  t.setModel(makeModel())
  await t.host.refresh()

  expect(secondCleaned).toBe(true)
  expect(t.logs).toEqual(['acme.notes: cleanup failed: cleanup boom', 'acme.notes: deactivate failed: deactivate boom'])
  expect(state(t).slots).toEqual({})
  expect(() => context.call('repo.list')).toThrow('acme.notes is not active')
})

test('SC-4: an open view or panel that leaves the model is gone from the layout after the refresh', async () => {
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')], views: [view(NOTES, 'page')] }))
  await t.host.refresh()
  t.host.togglePanel('panel:acme.notes/side')
  t.host.openView(PAGE, { a: 1 })
  expect(state(t).openPanel).not.toBeNull()

  t.setModel(makeModel({ panels: [panel(NOTES, 'side')] }))
  await t.host.refresh()
  expect(state(t).openView).toBeNull()
  expect(state(t).openPanel).toBe('panel:acme.notes/side')

  t.setModel(makeModel())
  await t.host.refresh()
  expect(state(t).openPanel).toBeNull()
})

test('SC-9: opening a view or panel the daemon refuses changes nothing and is logged', async () => {
  const t = setup(makeModel())
  await t.host.refresh()
  t.host.openView(PAGE)
  t.host.togglePanel('panel:acme.notes/side')
  await tick()
  expect(state(t).openView).toBeNull()
  expect(state(t).openPanel).toBeNull()
  expect(t.logs).toEqual([`ui.view.open failed: no view ${PAGE}`, 'ui.panel.open failed: no panel panel:acme.notes/side'])
})

test('SC-14: running a command loads its plugin lazily and passes the arguments', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'open')] }))
  const args: unknown[] = []
  t.useModule(NOTES, recording([OPEN], () => (a: unknown) => args.push(a)).module)
  await t.host.refresh()
  expect(t.imports).toEqual([])

  await t.host.runCommand(OPEN, { id: 1 })
  await t.host.runCommand(OPEN)
  expect(args).toEqual([{ id: 1 }, undefined])
  expect(t.imports).toHaveLength(1)
})

test('SC-14: a command that is not in the model is rejected', async () => {
  const t = setup(makeModel())
  await t.host.refresh()
  await expect(t.host.runCommand('command:acme.files/open')).rejects.toThrow('no command command:acme.files/open')
  expect(t.toasts).toEqual([])
})

test('SC-14: a plugin command can run another through executeCommand', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'open'), command(NOTES, 'inner')] }))
  const inner = 'command:acme.notes/inner'
  const ran: string[] = []
  t.useModule(NOTES, {
    activate(context) {
      context.provide(OPEN, () => context.executeCommand(inner, 'x'))
      context.provide(inner, (arg: unknown) => ran.push(String(arg)))
    }
  })
  await t.host.refresh()
  await t.host.runCommand(OPEN)
  expect(ran).toEqual(['x'])
})

test('SC-14: the palette filters by title case-insensitively in model order', async () => {
  const commands = [command(NOTES, 'new', 'New note'), command('acme.files', 'open', 'Open file')]
  const t = setup(makeModel({ commands }))
  expect(t.host.paletteCommands('')).toEqual([])
  await t.host.refresh()

  expect(t.host.paletteCommands('NOTE').map((c) => c.id)).toEqual(['command:acme.notes/new'])
  expect(t.host.paletteCommands('').map((c) => c.id)).toEqual(['command:acme.notes/new', 'command:acme.files/open'])
  expect(t.host.paletteCommands('zzz')).toEqual([])
})

const NEW = 'command:acme.notes/new'
const NEW_KEY = binding(NOTES, 'new-key', 'mod+shift+n', NEW)

test('SC-15: Cmd+Shift+N runs the bound command and is consumed, every time', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [NEW_KEY] }))
  let runs = 0
  t.useModule(NOTES, recording([NEW], () => () => runs++).module)
  await t.host.refresh()

  const press = key('KeyN', { metaKey: true, shiftKey: true })
  expect(t.host.handleKey(press)).toBe(true)
  expect(t.host.handleKey(press)).toBe(true)
  await until(() => runs === 2)
})

test('SC-15: Cmd+N without Shift runs nothing and is not consumed', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [NEW_KEY] }))
  await t.host.refresh()
  expect(t.host.handleKey(key('KeyN', { metaKey: true }))).toBe(false)
  expect(t.host.handleKey(key('KeyN', { shiftKey: true }))).toBe(false)
  await tick()
  expect(t.imports).toEqual([])
})

test('SC-15: handleKey does not wait for the command', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [NEW_KEY] }))
  let started = false
  t.useModule(NOTES, recording([NEW], () => () => {
    started = true
    return hang()
  }).module)
  await t.host.refresh()
  expect(t.host.handleKey(key('KeyN', { metaKey: true, shiftKey: true }))).toBe(true)
  await until(() => started)
})

test('SC-15: a command that fails from a keybinding raises its toast', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [NEW_KEY] }))
  t.useModule(NOTES, recording([NEW], () => () => {
    throw new Error('nope')
  }).module)
  await t.host.refresh()
  t.host.handleKey(key('KeyN', { metaKey: true, shiftKey: true }))
  await until(() => t.toasts.length === 1)
  expect(t.toasts[0]).toEqual([`${NEW} failed: nope`, 'nope'])
})

test('SC-16: only the active keybinding on a chord fires, and shadowed ones are ignored', async () => {
  const keys = [
    binding('quirky.sample', 'k', 'mod+k', 'command:quirky.sample/run', 'shadowed'),
    binding('acme.keys', 'k', 'mod+k', 'command:acme.keys/run')
  ]
  const t = setup(makeModel({ commands: [command('quirky.sample', 'run'), command('acme.keys', 'run')], keybindings: keys }))
  const ran: string[] = []
  t.useModule('quirky.sample', recording(['command:quirky.sample/run'], () => () => ran.push('sample')).module)
  t.useModule('acme.keys', recording(['command:acme.keys/run'], () => () => ran.push('keys')).module)
  await t.host.refresh()

  expect(t.host.handleKey(key('KeyK', { metaKey: true }))).toBe(true)
  await until(() => ran.length === 1)
  expect(ran).toEqual(['keys'])

  t.setModel(
    makeModel({
      commands: [command('quirky.sample', 'run')],
      keybindings: [binding('quirky.sample', 'k', 'mod+k', 'command:quirky.sample/run')]
    })
  )
  await t.host.refresh()
  expect(t.host.handleKey(key('KeyK', { metaKey: true }))).toBe(true)
  await until(() => ran.length === 2)
  expect(ran).toEqual(['keys', 'sample'])
})

test('SC-17: the palette chord is never handled, even for an active keybinding', async () => {
  const keys = [binding(NOTES, 'p', 'mod+shift+p', NEW)]
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: keys }))
  await t.host.refresh()
  expect(t.host.handleKey(key('KeyP', { metaKey: true, shiftKey: true }))).toBe(false)
  await tick()
  expect(t.imports).toEqual([])
})

test('G1: a plugin keybinding on the palette chord is reported shadowed by the kernel, and the chord runs nothing', async () => {
  const shadowed: UiKeybinding = { ...binding(NOTES, 'p', 'mod+shift+p', NEW, 'shadowed'), shadowedBy: 'kernel' }
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [shadowed] }))
  await t.host.refresh()
  expect(state(t).model!.keybindings).toEqual([shadowed])

  expect(t.host.handleKey(key('KeyP', { metaKey: true, shiftKey: true }))).toBe(false)
  expect(t.host.handleKey(key('KeyP', { ctrlKey: true, shiftKey: true }))).toBe(false)
  await tick()
  expect(t.imports).toEqual([])
  expect(t.toasts).toEqual([])
})

test('SC-18: an unbound keybinding runs nothing and is not consumed, while a lower one that is active runs', async () => {
  const keys = [
    binding(NOTES, 'new-key', 'mod+shift+n', NEW, 'unbound'),
    binding('acme.other', 'n', 'mod+shift+n', 'command:acme.other/go')
  ]
  const t = setup(makeModel({ commands: [command('acme.other', 'go')], keybindings: [keys[0]] }))
  await t.host.refresh()
  expect(t.host.handleKey(key('KeyN', { metaKey: true, shiftKey: true }))).toBe(false)

  const ran: string[] = []
  t.useModule('acme.other', recording(['command:acme.other/go'], () => () => ran.push('other')).module)
  t.setModel(makeModel({ commands: [command('acme.other', 'go')], keybindings: [keys[1]] }))
  await t.host.refresh()
  expect(t.host.handleKey(key('KeyN', { metaKey: true, shiftKey: true }))).toBe(true)
  await until(() => ran.length === 1)
})

test('SC-15: a bare modifier or an unknown key is not a chord', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [NEW_KEY] }))
  await t.host.refresh()
  expect(t.host.handleKey({ ...key('MetaLeft', { metaKey: true }), key: 'Meta' })).toBe(false)
  expect(t.host.handleKey({ ...key('Unidentified', { metaKey: true }), key: 'Unidentified' })).toBe(false)
})

test('SC-15: a function key chord with no modifier fires', async () => {
  const f5 = binding(NOTES, 'f5', 'f5', NEW)
  const t = setup(makeModel({ commands: [command(NOTES, 'new')], keybindings: [f5] }))
  let runs = 0
  t.useModule(NOTES, recording([NEW], () => () => runs++).module)
  await t.host.refresh()
  expect(t.host.handleKey({ ...key('F5'), key: 'F5' })).toBe(true)
  await until(() => runs === 1)
})

test('SC-23: setting.changed updates the cached setting before plugin listeners run', async () => {
  const size = 'setting:acme.notes/fontSize'
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), { settings: [setting(size, 13)] })
  const seen: unknown[] = []
  t.useModule(NOTES, {
    activate(context) {
      context.subscribe((event) => {
        if (event.type === 'setting.changed') seen.push(context.getSetting('fontSize'))
      })
      context.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  t.emit({ type: 'setting.changed', id: size, value: 20 })
  expect(state(t).settings[0].value).toBe(20)
  await tick()
  expect(seen).toEqual([20])
})

test('SC-23: getSetting resolves a short name in the plugin namespace and a full ID anywhere, and unknown throws', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), {
    settings: [setting('setting:acme.notes/fontSize', 13), setting('setting:acme.files/hidden', 7, 'acme.files')]
  })
  let context!: UiPluginContext
  t.useModule(NOTES, {
    activate(ctx) {
      context = ctx
      ctx.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  expect(context.getSetting('fontSize')).toBe(13)
  expect(context.getSetting('setting:acme.notes/fontSize')).toBe(13)
  expect(context.getSetting('setting:acme.files/hidden')).toBe(7)
  expect(() => context.getSetting('hidden')).toThrow('no setting setting:acme.notes/hidden')
  expect(() => context.getSetting('setting:acme.notes/ghost')).toThrow('no setting setting:acme.notes/ghost')
})

test('SC-23: a setting.changed for a setting not in the cache leaves settings alone', async () => {
  const t = setup(makeModel(), { settings: [setting('setting:acme.notes/fontSize', 13)] })
  await t.host.refresh()
  const before = state(t)
  t.emit({ type: 'setting.changed', id: 'setting:acme.notes/ghost', value: 1 })
  expect(state(t)).toBe(before)
})

test('SC-4: plugin.changed refetches the model and reconciles', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  await t.host.refresh()
  expect(t.methodCalls('ui.contributions')).toHaveLength(1)

  t.setModel(makeModel())
  t.emit({ type: 'plugin.changed' })
  await until(() => state(t).model?.sidebarSections.length === 0)
  expect(t.methodCalls('ui.contributions')).toHaveLength(2)
  expect(t.methodCalls('setting.list')).toHaveLength(2)
})

test('SC-25: theme.changed refreshes and the theme variables cover every token of the active theme', async () => {
  const solar: ThemeInfo = {
    id: 'theme:acme.solar/solar',
    plugin: 'acme.solar',
    title: 'Solar',
    appearance: 'light',
    colors: { ...DEFAULT_THEME.colors, bg: '#fdf6e3', text: '#657b83' }
  }
  const t = setup(makeModel())
  await t.host.refresh()
  expect(state(t).themeVariables['--bg']).toBe('#16181d')
  expect(Object.keys(state(t).themeVariables)).toHaveLength(Object.keys(DEFAULT_THEME.colors).length)

  t.setModel(makeModel({ themes: [DEFAULT_THEME, solar], theme: { chosen: solar.id, active: solar.id } }))
  t.emit({ type: 'theme.changed', chosen: solar.id, active: solar.id })
  await until(() => state(t).themeVariables['--bg'] === '#fdf6e3')
  expect(state(t).themeVariables['--text']).toBe('#657b83')
  expect(state(t).themeVariables['--accent']).toBe(DEFAULT_THEME.colors.accent)
  expect(state(t).themeVariables['--terminal-cursor']).toBe(DEFAULT_THEME.colors['terminal-cursor'])
})

test('SC-26: when the chosen theme is gone the default colors apply, and a missing color falls back to the default', async () => {
  const sparse = { id: 'theme:acme.sparse/s', plugin: 'acme.sparse', title: 'S', appearance: 'dark', colors: { bg: '#000000' } } as unknown as ThemeInfo
  const t = setup(makeModel({ themes: [DEFAULT_THEME, sparse], theme: { chosen: sparse.id, active: sparse.id } }))
  await t.host.refresh()
  expect(state(t).themeVariables['--bg']).toBe('#000000')
  expect(state(t).themeVariables['--text']).toBe(DEFAULT_THEME.colors.text)

  t.setModel(makeModel({ theme: { chosen: sparse.id, active: 'default' } }))
  await t.host.refresh()
  expect(state(t).themeVariables['--bg']).toBe(DEFAULT_THEME.colors.bg)
})

test('SC-24: saveSettings sets every setting and the theme, and returns each refusal by ID', async () => {
  const t = setup(makeModel())
  t.refused.set('setting:acme.notes/fontSize', 'setting:acme.notes/fontSize must be at most 32')
  t.refused.set('theme', 'no theme theme:acme.gone/x')

  const result = await t.host.saveSettings({
    settings: { 'setting:acme.notes/fontSize': 40, 'setting:acme.notes/mode': 'grid' },
    theme: 'theme:acme.gone/x'
  })

  expect(result).toEqual({
    errors: {
      'setting:acme.notes/fontSize': 'setting:acme.notes/fontSize must be at most 32',
      theme: 'no theme theme:acme.gone/x'
    }
  })
  expect(t.methodCalls('setting.set').map((c) => c.params)).toEqual([
    { id: 'setting:acme.notes/fontSize', value: 40 },
    { id: 'setting:acme.notes/mode', value: 'grid' }
  ])
  expect(t.methodCalls('theme.set').map((c) => c.params)).toEqual([{ id: 'theme:acme.gone/x' }])
})

test('SC-24: saveSettings without a theme change does not call theme.set and reports no errors', async () => {
  const t = setup(makeModel())
  expect(await t.host.saveSettings({ settings: { 'setting:acme.notes/fontSize': 18 } })).toEqual({ errors: {} })
  expect(t.methodCalls('theme.set')).toEqual([])
})

test('the state object changes when state changes, and subscribers are told until they unsubscribe', async () => {
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')] }))
  let notified = 0
  const off = t.host.subscribe(() => notified++)
  const initial = state(t)
  expect(initial.model).toBeNull()

  await t.host.refresh()
  const loaded = state(t)
  expect(loaded).not.toBe(initial)
  expect(notified).toBeGreaterThan(0)
  expect(state(t)).toBe(loaded)

  const before = notified
  t.host.togglePanel('panel:acme.notes/side')
  expect(state(t)).not.toBe(loaded)
  expect(notified).toBe(before + 1)

  off()
  t.host.togglePanel('panel:acme.notes/side')
  expect(notified).toBe(before + 1)
})

test('refresh rejects when the daemon call fails, and the next refresh still works', async () => {
  const t = setup(makeModel())
  const original = t.setModel
  t.setModel(undefined as unknown as UiModel)
  await t.host.refresh().catch(() => {})
  original(makeModel())
  await t.host.refresh()
  expect(state(t).model).not.toBeNull()
})

test('stop cleans up mounts, deactivates plugins and stops listening to events', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let cleanups = 0
  const { module, record } = recording([LIST], () => () => () => cleanups++)
  t.useModule(NOTES, module)
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  expect(t.listenerCount()).toBe(1)

  t.host.stop()
  await tick()
  expect(cleanups).toBe(1)
  expect(record.deactivations).toBe(1)
  expect(t.listenerCount()).toBe(0)
})

test('C1: stop while a module is loading deactivates the plugin when the load completes and mounts nothing', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const release = gate()
  let mounted = 0
  const { module, record } = recording([LIST], () => () => {
    mounted++
  })
  t.useModule(NOTES, async () => {
    await release.opened
    return module
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await tick()

  t.host.stop()
  release.open()
  await until(() => record.deactivations === 1)

  expect(mounted).toBe(0)
  expect(state(t).plugins[NOTES].state).not.toBe('active')
  expect(() => record.contexts[0].call('repo.list')).toThrow('acme.notes is not active')
})

test('C2: a deactivate that never settles is cut off at the timeout, logged, and the context is revoked', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), { activationTimeoutMs: 40 })
  const contexts: UiPluginContext[] = []
  let usableDuring = false
  t.useModule(NOTES, {
    activate(context) {
      contexts.push(context)
      context.provide(LIST, () => {})
    },
    deactivate() {
      usableDuring = typeof contexts[0].getSetting === 'function' && !!contexts[0].call('repo.list')
      return hang()
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  t.setModel(makeModel())
  const started = Date.now()
  await t.host.refresh()

  expect(Date.now() - started).toBeLessThan(1000)
  expect(usableDuring).toBe(true)
  expect(t.logs).toContain('acme.notes: deactivate failed: deactivate timed out')
  expect(() => contexts[0].call('repo.list')).toThrow('acme.notes is not active')
  expect(state(t).plugins[NOTES]).toEqual({ state: 'idle' })
})

test('C2: a deactivate that throws still revokes the context', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const contexts: UiPluginContext[] = []
  t.useModule(NOTES, {
    activate(context) {
      contexts.push(context)
      context.provide(LIST, () => {})
    },
    deactivate() {
      throw new Error('bad')
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  t.setModel(makeModel())
  await t.host.refresh()

  expect(t.logs).toContain('acme.notes: deactivate failed: bad')
  expect(() => contexts[0].call('repo.list')).toThrow('acme.notes is not active')
})

test('C3: a setting.changed that arrives during a refresh wins over that refresh\'s older snapshot', async () => {
  const size = 'setting:acme.notes/fontSize'
  const t = setup(makeModel(), { settings: [setting(size, 13)] })
  await t.host.refresh()

  const release = gate()
  t.holds.set('setting.list', release.opened)
  const refreshing = t.host.refresh()
  await tick()
  t.emit({ type: 'setting.changed', id: size, value: 20 })
  release.open()
  await refreshing

  expect(state(t).settings[0].value).toBe(20)
})

test('C4: a subscriber registered during activate receives events before activation finishes', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }), { activationTimeoutMs: 1000 })
  let subscribed = false
  t.useModule(NOTES, {
    async activate(context) {
      await new Promise<void>((resolve) => {
        context.subscribe((event) => {
          if (event.type === 'acme.notes/changed') resolve()
        })
        subscribed = true
      })
      context.provide(LIST, () => {})
    }
  })
  await t.host.refresh()
  t.host.mount(LIST, element())
  await until(() => subscribed)

  t.emit({ type: 'acme.notes/changed', data: null })
  await until(() => state(t).slots[LIST]?.status === 'mounted')
})

test('S1: an undeclared provide after activate fails the plugin, cleans up its mounts and retries on the next mount', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  let cleanups = 0
  const { module, record } = recording([LIST], () => () => () => cleanups++)
  t.useModule(NOTES, module)
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)
  expect(state(t).plugins[NOTES]).toEqual({ state: 'active' })

  const message = 'acme.notes does not declare view:acme.notes/other'
  expect(() => record.contexts[0].provide('view:acme.notes/other', () => {})).toThrow(message)

  expect(state(t).plugins[NOTES]).toEqual({ state: 'failed', error: message })
  expect(state(t).slots[LIST]).toEqual({ status: 'error', message })
  expect(cleanups).toBe(1)
  expect(record.deactivations).toBe(0)
  expect(() => record.contexts[0].call('repo.list')).toThrow('acme.notes is not active')

  t.host.mount(LIST, element())
  await until(() => state(t).slots[LIST]?.status === 'mounted')
  expect(record.activations).toBe(2)
  expect(state(t).plugins[NOTES]).toEqual({ state: 'active' })
})

test('S1: a non-function provide after activate fails the plugin', async () => {
  const t = setup(makeModel({ sidebarSections: [section(NOTES, 'list')] }))
  const { module, record } = recording([LIST])
  t.useModule(NOTES, module)
  await t.host.refresh()
  t.host.mount(LIST, element())
  await settled(t, LIST)

  const message = `acme.notes must provide a function for ${LIST}`
  expect(() => record.contexts[0].provide(LIST, 'nope')).toThrow(message)
  expect(state(t).plugins[NOTES]).toEqual({ state: 'failed', error: message })
  expect(record.deactivations).toBe(0)
})

test('S3: a failing command is logged with its owner and command ID as well as toasted', async () => {
  const t = setup(makeModel({ commands: [command('acme.cmd', 'go')] }))
  t.useModule(
    'acme.cmd',
    recording(['command:acme.cmd/go'], () => () => {
      throw new Error('nope')
    }).module
  )
  await t.host.refresh()

  await t.host.runCommand('command:acme.cmd/go')
  expect(t.logs).toContain('acme.cmd: command:acme.cmd/go failed: nope')
  expect(t.toasts).toEqual([['command:acme.cmd/go failed: nope', 'nope']])
})

const SIDE = 'panel:acme.notes/side'
const OUTLINE = 'panel:acme.outline/outline'
const OTHER = 'view:acme.notes/other'

/** A booted harness with a notes plugin that owns two views, a panel, a section and a command; acme.outline owns a second panel. */
async function booted(options: Parameters<typeof setup>[1] = {}) {
  const t = setup(
    makeModel({
      views: [view(NOTES, 'page'), view(NOTES, 'other')],
      panels: [panel(NOTES, 'side'), panel('acme.outline', 'outline')],
      sidebarSections: [section(NOTES, 'list')],
      commands: [command(NOTES, 'open')]
    }),
    options
  )
  const { module, record } = recording([PAGE, OTHER, SIDE, LIST, OPEN], () => () => {})
  t.useModule(NOTES, module)
  await t.host.refresh()
  await t.host.runCommand(OPEN)
  return { t, record, context: () => record.contexts[0]! }
}

test('D21: refresh loads the daemon layout, and the host never changes it before the broadcast', async () => {
  const { t } = await booted()
  t.changeLayout({ view: { id: PAGE, input: { a: 1 } }, panel: SIDE, focus: 'view' })
  await t.host.refresh()
  expect(state(t).layout).toEqual({ view: { id: PAGE, input: { a: 1 } }, panel: SIDE, sidebar: true, focus: 'view' })
  expect(state(t).openView).toEqual({ id: PAGE, input: { a: 1 } })
  expect(state(t).openPanel).toBe(SIDE)

  t.holdBroadcasts()
  t.host.openView(OTHER, { b: 2 })
  t.host.togglePanel(SIDE)
  await tick()
  expect(t.methodCalls('ui.view.open')).toEqual([{ method: 'ui.view.open', params: { id: OTHER, input: { b: 2 } } }])
  expect(t.methodCalls('ui.panel.close')).toHaveLength(1)
  expect(state(t).openView?.id).toBe(PAGE)
  expect(state(t).openPanel).toBe(SIDE)

  t.releaseBroadcasts()
  expect(state(t).openView).toEqual({ id: OTHER, input: { b: 2 } })
  expect(state(t).openPanel).toBeNull()
})

test('D21: view, panel and focus calls name the daemon methods and skip what is already so', async () => {
  const { t } = await booted()
  t.host.openView(PAGE)
  await tick()
  expect(t.methodCalls('ui.view.open')[0]!.params).toEqual({ id: PAGE })

  t.host.togglePanel(SIDE, true)
  t.host.togglePanel(OUTLINE, false)
  t.host.closeView()
  t.host.focus('panel')
  await tick()
  expect(t.methodCalls('ui.panel.open')).toHaveLength(1)
  expect(t.methodCalls('ui.panel.close')).toHaveLength(0)
  expect(t.methodCalls('ui.view.close')).toHaveLength(1)
  expect(t.methodCalls('ui.focus')).toEqual([{ method: 'ui.focus', params: { target: 'panel' } }])

  t.host.closeView()
  t.host.focus('panel')
  await tick()
  expect(t.methodCalls('ui.view.close')).toHaveLength(1)
  expect(t.methodCalls('ui.focus')).toHaveLength(1)
})

test('D21: a broadcast layout equal to the current one changes nothing, and an equal view keeps its identity', async () => {
  const { t } = await booted()
  t.changeLayout({ view: { id: PAGE, input: { a: 1 } } })
  const before = state(t)
  const view = state(t).openView
  let notified = 0
  t.host.subscribe(() => notified++)

  t.emit({ type: 'ui.state.changed', layout: { ...t.daemonLayout(), view: { id: PAGE, input: { a: 1 } } } })
  expect(state(t)).toBe(before)
  expect(notified).toBe(0)

  t.emit({ type: 'ui.state.changed', layout: { ...t.daemonLayout(), view: { id: PAGE, input: { a: 1 } }, focus: 'panel' } })
  expect(state(t).layout.focus).toBe('panel')
  expect(state(t).openView).toBe(view)
})

test('D21: an event that arrives while the layout is being fetched is not overwritten by the older snapshot', async () => {
  const t = setup(makeModel({ views: [view(NOTES, 'page'), view(NOTES, 'other')] }))
  await t.host.refresh()
  const refreshing = t.host.refresh()
  t.changeLayout({ view: { id: OTHER } })
  await refreshing
  expect(state(t).openView?.id).toBe(OTHER)
})

test('D21: context.getLayout and onLayout follow the daemon, and the listener ends with the plugin', async () => {
  const { t, context } = await booted()
  const seen: (string | null)[] = []
  const stop = context().onLayout((layout) => seen.push(layout.view?.id ?? null))
  expect(context().getLayout()).toEqual({ view: null, panel: null, sidebar: true, focus: null })

  t.changeLayout({ view: { id: PAGE } })
  t.changeLayout({ view: { id: PAGE } })
  t.changeLayout({ view: { id: OTHER } })
  expect(seen).toEqual([PAGE, OTHER])
  expect(context().getLayout().view?.id).toBe(OTHER)

  stop()
  t.changeLayout({ view: null })
  expect(seen).toEqual([PAGE, OTHER])
  context().onLayout(() => seen.push('again'))
  t.setModel(makeModel())
  await t.host.refresh()
  t.changeLayout({ focus: 'view' })
  expect(seen).toEqual([PAGE, OTHER])
})

test('D21: a layout listener that throws is logged and does not stop the others', async () => {
  const { t, context } = await booted()
  const seen: string[] = []
  context().onLayout(() => {
    throw new Error('listener bug')
  })
  context().onLayout(() => seen.push('ok'))
  t.changeLayout({ focus: 'view' })
  expect(seen).toEqual(['ok'])
  expect(t.logs).toContain('layout listener failed: listener bug')
})

test('D21: onStream hands a plugin its stream frames until it unsubscribes or the plugin is gone', async () => {
  const { t, context } = await booted()
  const received: number[][] = []
  const stop = context().onStream(7, (bytes) => received.push([...bytes]))
  context().onStream(8, () => {})
  t.pushStream(7, new Uint8Array([1, 2]))
  expect(received).toEqual([[1, 2]])

  stop()
  t.pushStream(7, new Uint8Array([3]))
  expect(received).toEqual([[1, 2]])
  expect(t.streamListeners(7)).toBe(0)
  expect(t.streamListeners(8)).toBe(1)

  t.setModel(makeModel())
  await t.host.refresh()
  expect(t.streamListeners(8)).toBe(0)
})

test('D21: onConnection reports connected and reconnecting, and is removed with the plugin', async () => {
  const { t, context } = await booted()
  const seen: string[] = []
  context().onConnection((status) => seen.push(status))
  t.setConnection('reconnecting')
  t.setConnection('connected')
  expect(seen).toEqual(['reconnecting', 'connected'])

  t.setModel(makeModel())
  await t.host.refresh()
  expect(t.connectionListenerCount()).toBe(0)
})

test('D21: context.confirm goes to the shell dialog and returns its answer', async () => {
  const { t, context } = await booted()
  expect(await context().confirm({ title: 'Remove', body: 'Sure?', confirmLabel: 'Remove' })).toBe(true)
  t.answerConfirm(false)
  expect(await context().confirm({ title: 'Again' })).toBe(false)
  expect(t.confirms).toEqual([{ title: 'Remove', body: 'Sure?', confirmLabel: 'Remove' }, { title: 'Again' }])
})

test('D21: context.toast shows an info toast', async () => {
  const { t, context } = await booted()
  context().toast('Saved', 'notes saved')
  expect(t.toasts).toEqual([['Saved', 'notes saved']])
  expect(t.toastKinds).toEqual(['info'])
})

test("D21: setPanelBadge shows a count on the plugin's own panel, and null or deactivation clears it", async () => {
  const { t, context } = await booted()
  context().setPanelBadge(SIDE, 3)
  expect(state(t).badges).toEqual({ [SIDE]: 3 })
  context().setPanelBadge(SIDE, 4)
  expect(state(t).badges).toEqual({ [SIDE]: 4 })
  context().setPanelBadge(SIDE, null)
  expect(state(t).badges).toEqual({})

  expect(() => context().setPanelBadge(OUTLINE, 1)).toThrow(`${OUTLINE} is not a panel of ${NOTES}`)
  expect(() => context().setPanelBadge('panel:acme.notes/missing', 1)).toThrow('is not a panel of')

  context().setPanelBadge(SIDE, 2)
  t.setModel(makeModel())
  await t.host.refresh()
  expect(state(t).badges).toEqual({})
})

test("D22: a mounted slot's report goes to the daemon, and unmounting clears it", async () => {
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')] }))
  const reports: ((state: unknown) => void)[] = []
  t.useModule(NOTES, recording([SIDE], () => (_el: unknown, props: { report(state: unknown): void }) => reports.push(props.report)).module)
  await t.host.refresh()

  const dispose = t.host.mount(SIDE, element())
  await settled(t, SIDE)
  reports[0]!({ count: 2 })
  reports[0]!({ count: 3 })
  expect(t.methodCalls('ui.report').map((call) => call.params)).toEqual([
    { slot: SIDE, state: { count: 2 } },
    { slot: SIDE, state: { count: 3 } }
  ])

  dispose()
  expect(t.methodCalls('ui.report').at(-1)!.params).toEqual({ slot: SIDE, state: null })
  reports[0]!({ late: true })
  expect(t.methodCalls('ui.report')).toHaveLength(3)
})

test('D22: a refused report is logged with the plugin and does not throw into the slot', async () => {
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')] }))
  let report!: (state: unknown) => void
  t.useModule(NOTES, recording([SIDE], () => (_el: unknown, props: { report(state: unknown): void }) => (report = props.report)).module)
  await t.host.refresh()
  t.host.mount(SIDE, element())
  await settled(t, SIDE)

  t.refused.set('ui.report', 'report is over 64 KiB')
  expect(() => report('big')).not.toThrow()
  await tick()
  expect(t.logs).toEqual([`${NOTES}: report for ${SIDE} failed: report is over 64 KiB`])
})

test('D22: a slot that never reported sends nothing when it unmounts', async () => {
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')] }))
  t.useModule(NOTES, recording([SIDE]).module)
  await t.host.refresh()
  t.host.mount(SIDE, element())()
  await tick()
  expect(t.methodCalls('ui.report')).toEqual([])
})

test('D22: after a reconnect the host sends the window focus and each mounted slot\'s last report again', async () => {
  const focus: WindowFocus = { hasFocus: () => true, subscribe: () => () => {} }
  const t = setup(makeModel({ panels: [panel(NOTES, 'side')] }), { windowFocus: focus })
  let report!: (state: unknown) => void
  t.useModule(NOTES, recording([SIDE], () => (_el: unknown, props: { report(state: unknown): void }) => (report = props.report)).module)
  await t.host.refresh()
  t.host.mount(SIDE, element())
  await settled(t, SIDE)
  report({ n: 1 })
  report({ n: 2 })
  const before = t.methodCalls('ui.report').length

  await t.host.connected()
  expect(t.methodCalls('ui.window.focused')).toEqual([{ method: 'ui.window.focused', params: { focused: true } }])
  expect(t.methodCalls('ui.report').slice(before)).toEqual([{ method: 'ui.report', params: { slot: SIDE, state: { n: 2 } } }])
})

test('D23: the host reports window focus gained and lost, and nothing on connect when it has no focus', async () => {
  const listeners = new Set<(focused: boolean) => void>()
  const t = setup(makeModel(), {
    windowFocus: { hasFocus: () => false, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }
  })
  await t.host.connected()
  expect(t.methodCalls('ui.window.focused')).toEqual([])

  listeners.forEach((l) => l(true))
  listeners.forEach((l) => l(false))
  expect(t.methodCalls('ui.window.focused').map((call) => call.params)).toEqual([{ focused: true }, { focused: false }])

  t.host.stop()
  expect(listeners.size).toBe(0)
})

test('D23: a routed command runs in the window and the host replies with its value', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'open')] }))
  t.useModule(NOTES, recording([OPEN], () => (args: unknown) => `opened ${JSON.stringify(args)}`).module)
  await t.host.refresh()

  t.emit({ type: 'ui.command.request', requestId: 'r1', id: OPEN, args: { n: 1 } })
  await until(() => t.methodCalls('ui.command.reply').length === 1)
  expect(t.methodCalls('ui.command.reply')[0]!.params).toEqual({ requestId: 'r1', result: 'opened {"n":1}' })
  expect(t.toasts).toEqual([])
})

test('D23: a routed command that throws, is unknown or returns something unserializable replies with an error', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'open'), command(NOTES, 'loop')] }))
  const loop: Record<string, unknown> = {}
  loop.self = loop
  t.useModule(
    NOTES,
    recording([OPEN, 'command:acme.notes/loop'], (id) => () => {
      if (id === OPEN) throw new Error('kaboom')
      return loop
    }).module
  )
  await t.host.refresh()

  t.emit({ type: 'ui.command.request', requestId: 'r1', id: OPEN, args: {} })
  t.emit({ type: 'ui.command.request', requestId: 'r2', id: 'command:acme.notes/missing', args: {} })
  t.emit({ type: 'ui.command.request', requestId: 'r3', id: 'command:acme.notes/loop', args: {} })
  await until(() => t.methodCalls('ui.command.reply').length === 3)
  const replies = Object.fromEntries(t.methodCalls('ui.command.reply').map((call) => [call.params.requestId, call.params]))
  expect(replies.r1).toEqual({ requestId: 'r1', error: { message: 'kaboom' } })
  expect(replies.r2).toEqual({ requestId: 'r2', error: { message: 'no command command:acme.notes/missing' } })
  expect((replies.r3 as { error: { message: string } }).error.message).toContain('cyclic')
  expect(t.toasts).toEqual([])
})

test('D23: runCommandForResult returns the value, rejects with the error and never toasts', async () => {
  const t = setup(makeModel({ commands: [command(NOTES, 'open')] }))
  let fail = false
  t.useModule(
    NOTES,
    recording([OPEN], () => () => {
      if (fail) throw new Error('nope')
      return { ok: true }
    }).module
  )
  await t.host.refresh()
  expect(await t.host.runCommandForResult(OPEN)).toEqual({ ok: true })
  fail = true
  await expect(t.host.runCommandForResult(OPEN)).rejects.toThrow('nope')
  expect(t.toasts).toEqual([])
})
