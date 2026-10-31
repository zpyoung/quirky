import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'
import type { QuirkyEvent, UiLayout, UiModel, Worktree } from '@quirky/protocol'
import type { Connection } from '../src/connection'
import { AppContext, type AppContextValue } from '../src/context'
import type { HostState, WindowPluginHost } from '../src/plugins/host'
import { CommandPalette } from '../src/plugins/CommandPalette'
import { encodeFileId } from '../src/plugins/palette'

type Call = { method: string; params: unknown }
type Handler = (params: unknown) => unknown

let createRoot: (container: HTMLElement) => Root
let root: Root | null = null
let container: HTMLElement | null = null
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

const worktree = (id: string, name: string): Worktree => ({ id, repoId: 'repo', name, branch: name, path: `/wt/${id}` }) as Worktree

const WORKTREES = [worktree('wt_a', 'alpha-tree'), worktree('wt_b', 'beta-tree')]
const MODEL = {
  commands: [
    { id: 'command:acme/build', plugin: 'acme', title: 'Build project', module: null },
    { id: 'command:acme/deploy', plugin: 'acme', title: 'Deploy project', module: null }
  ],
  tools: [{ id: 'tool:acme/term', title: 'Terminal', icon: 'terminal-window', hue: 'teal', defaultSlot: 'bottom-left', contributionId: null, aliases: [] }],
  views: [{ id: 'view:acme/page', kind: 'view', plugin: 'acme', title: 'Overview page', order: 0, module: null }]
} as unknown as UiModel

/** Replaces the 150ms debounce timer with one the test fires itself, passing every other timer through. */
function controlDebounce() {
  const pending = new Map<number, () => void>()
  const scheduled: number[] = []
  let next = 1
  globalThis.setTimeout = ((run: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 150) return realSetTimeout(run, delay, ...args)
    const id = next++
    pending.set(id, run)
    scheduled.push(id)
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (typeof id === 'number' && pending.has(id)) pending.delete(id)
    else realClearTimeout(id)
  }) as typeof clearTimeout
  return {
    get scheduled() {
      return scheduled.length
    },
    get live() {
      return pending.size
    },
    async fire() {
      const runs = [...pending.values()]
      pending.clear()
      await act(async () => {
        for (const run of runs) run()
        await Promise.resolve()
      })
    }
  }
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 6; turn++) await Promise.resolve()
  })
}

async function mount(options: {
  recents?: string[]
  selected?: string | null
  worktrees?: Worktree[]
  model?: UiModel
  handlers?: Record<string, Handler>
} = {}) {
  const calls: Call[] = []
  const toasts: unknown[] = []
  const handlers = options.handlers ?? {}
  const ran = { commands: [] as string[], tools: [] as string[], views: [] as string[] }
  const listeners = new Set<() => void>()
  let state = {
    model: options.model ?? MODEL,
    layout: {
      view: null,
      worktree: options.selected === undefined ? 'wt_a' : options.selected,
      ...(options.recents ? { paletteRecents: options.recents } : {})
    } as UiLayout,
    windowRoute: null
  } as HostState
  const plugins = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async runCommand(id: string) {
      ran.commands.push(id)
    },
    openTool(id: string) {
      ran.tools.push(id)
    },
    openView(id: string) {
      ran.views.push(id)
    }
  } as unknown as WindowPluginHost
  const store = { dispatch: (action: unknown) => toasts.push(action) }
  const connection = {
    store,
    callAny(method: string, params: unknown) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (handler) return Promise.resolve().then(() => handler(params))
      if (method === 'quirky.worktree/list') return Promise.resolve(options.worktrees ?? WORKTREES)
      if (['quirky.repo/list', 'quirky.session/list', 'quirky.ask/list'].includes(method)) return Promise.resolve([])
      if (method === 'quirky.agents/list') return Promise.resolve({ agents: [] })
      if (method === 'ui.palette.recent') return Promise.resolve({})
      return Promise.reject(new Error(`Unexpected daemon request: ${method}`))
    },
    onEvent: (_listener: (event: QuirkyEvent) => void) => () => {},
    onConnected: () => () => {}
  } as unknown as Connection
  const value = { store, connection, plugins } as unknown as AppContextValue
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const debounce = controlDebounce()
  await act(async () => {
    root!.render(h(AppContext.Provider, { value }, h(CommandPalette, { onClose: () => {} })))
  })
  await flush()

  const input = () => container!.querySelector<HTMLInputElement>('input')!
  const options$ = () => [...container!.querySelectorAll<HTMLElement>('[role="option"]')]
  const api = {
    calls,
    toasts,
    ran,
    debounce,
    input,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    titles: () => options$().map((option) => option.querySelector('.ui-list-row__title')?.textContent ?? ''),
    descriptions: () => options$().map((option) => option.querySelector('.ui-list-row__description')?.textContent ?? ''),
    headers: () => [...container!.querySelectorAll('.ui-section-header__title')].map((header) => header.textContent),
    selectedTitle: () => options$().find((option) => option.getAttribute('aria-selected') === 'true')?.querySelector('.ui-list-row__title')?.textContent,
    option: (title: string) => options$().find((option) => option.querySelector('.ui-list-row__title')?.textContent === title)!,
    emptyText: () => container!.querySelector('.ui-empty-state')?.textContent ?? null,
    scope: () => container!.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    tab: (label: string) => [...container!.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === label)!,
    setRecents: async (recents: string[]) => {
      state = { ...state, layout: { ...state.layout, paletteRecents: recents } }
      await act(async () => {
        for (const listener of listeners) listener()
      })
    },
    async chooseScope(label: string) {
      await act(async () => api.tab(label).click())
    },
    async search(query: string) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input(), query)
        input().dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    async key(key: string, init: { shiftKey?: boolean } = {}) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      await act(async () => {
        input().dispatchEvent(event)
      })
      return event
    },
    async click(title: string) {
      await act(async () => api.option(title).querySelector<HTMLElement>('.ui-list-row__main')!.click())
      await flush()
    }
  }
  return api
}

const quickOpen = (...paths: string[]) => ({ results: paths.map((path) => ({ path, name: path, score: 1 })), truncated: false, history: [] })
const searchCalls = (palette: Awaited<ReturnType<typeof mount>>) =>
  palette.callsTo('quirky.editor/quickOpen').filter((call) => (call.params as { action: string }).action === 'search')

test('each scope shows only its kinds', async () => {
  const palette = await mount({ handlers: { 'quirky.editor/quickOpen': () => quickOpen('src/main.ts') } })
  expect(palette.scope()).toBe('All')
  expect(palette.titles()).toEqual(['Build project', 'Deploy project', 'Terminal', 'Overview page', 'alpha-tree', 'beta-tree'])

  await palette.chooseScope('Worktrees')
  expect(palette.titles()).toEqual(['alpha-tree', 'beta-tree'])
  await palette.chooseScope('Commands')
  expect(palette.titles()).toEqual(['Build project', 'Deploy project'])

  await palette.search('main')
  await palette.chooseScope('All')
  await palette.debounce.fire()
  expect(palette.titles()).toContain('main.ts')
  await palette.chooseScope('Files')
  expect(palette.titles()).toEqual(['main.ts'])
  await palette.chooseScope('Worktrees')
  expect(palette.titles()).toEqual([])
})

test('ranks title prefixes first and selects and opens the matching worktree', async () => {
  const model = {
    commands: [
      { id: 'command:acme/cancel', plugin: 'acme', title: 'Cancel', module: null },
      { id: 'command:acme/terminal-dock', plugin: 'acme', title: 'Terminal Dock', module: null },
      { id: 'command:acme/send', plugin: 'acme', title: 'Send', module: null },
      { id: 'command:acme/copy-context', plugin: 'acme', title: 'Copy Context', description: 'Document path', module: null }
    ],
    tools: [],
    views: [{ id: 'view:acme/editor-document', kind: 'view', plugin: 'acme', title: 'Editor Document', order: 0, module: null }]
  } as unknown as UiModel
  const palette = await mount({
    model,
    worktrees: [worktree('wt_docs', 'DocsPass')],
    handlers: {
      'ui.window.self': () => ({ connId: 4 }),
      'quirky.worktree/navigate': () => ({})
    }
  })

  await palette.search('Doc')
  expect(palette.titles()).toEqual(['DocsPass', 'Terminal Dock', 'Editor Document', 'Copy Context'])
  expect(palette.selectedTitle()).toBe('DocsPass')
  await palette.key('Enter')
  await flush()
  expect(palette.calls.filter((call) => call.method === 'ui.window.self' || call.method === 'quirky.worktree/navigate')).toEqual([
    { method: 'ui.window.self', params: {} },
    { method: 'quirky.worktree/navigate', params: { worktree: 'wt_docs', window: 4 } }
  ])
})

test('Recent shows before typing, follows the scope, skips missing targets and is not repeated below', async () => {
  const file = `file:${encodeFileId('wt_b', 'docs/notes.md')}`
  const palette = await mount({
    recents: ['worktree:wt_b', 'command:command:acme/gone', 'command:command:acme/deploy', 'worktree:wt_removed', file, 'tool:tool:acme/term']
  })
  expect(palette.headers()).toEqual(['Recent', 'All'])
  expect(palette.titles()).toEqual([
    'beta-tree', 'Deploy project', 'notes.md', 'Terminal',
    'Build project', 'Overview page', 'alpha-tree'
  ])
  expect(palette.descriptions()[2]).toBe('docs/notes.md')

  await palette.chooseScope('Worktrees')
  expect(palette.headers()).toEqual(['Recent', 'Worktrees'])
  expect(palette.titles()).toEqual(['beta-tree', 'alpha-tree'])

  await palette.chooseScope('Files')
  expect(palette.headers()).toEqual(['Recent'])
  expect(palette.titles()).toEqual(['notes.md'])
})

test('a recent file disappears with its worktree and typing removes the Recent section', async () => {
  const file = `file:${encodeFileId('wt_gone', 'a.ts')}`
  const palette = await mount({ recents: [file, 'command:command:acme/build'] })
  expect(palette.titles()[0]).toBe('Build project')
  expect(palette.titles()).not.toContain('a.ts')

  await palette.search('project')
  expect(palette.headers()).toEqual([])
  expect(palette.titles()).toEqual(['Build project', 'Deploy project'])
})

test('with no recents the list has no headers', async () => {
  const palette = await mount()
  expect(palette.headers()).toEqual([])
})

test('arrow keys walk through both sections in order and wrap', async () => {
  const palette = await mount({ recents: ['worktree:wt_b', 'command:command:acme/deploy'] })
  const order = palette.titles()
  expect(order.slice(0, 2)).toEqual(['beta-tree', 'Deploy project'])
  expect(palette.selectedTitle()).toBe('beta-tree')
  const seen: (string | undefined)[] = []
  for (let step = 0; step < order.length; step++) {
    await palette.key('ArrowDown')
    seen.push(palette.selectedTitle())
  }
  expect(seen).toEqual([...order.slice(1), order[0]])
  await palette.key('ArrowUp')
  expect(palette.selectedTitle()).toBe(order.at(-1))
  expect(container!.querySelectorAll('[role="option"]')).toHaveLength(order.length)
  expect(container!.querySelectorAll('[role="option"] .ui-section-header')).toHaveLength(0)
})

test('Tab and Shift+Tab in the field cycle the scope, keep the query and the field focus', async () => {
  const palette = await mount()
  await palette.search('o')
  await palette.key('ArrowDown')
  const forward: (string | undefined)[] = []
  for (let step = 0; step < 4; step++) {
    const event = await palette.key('Tab')
    expect(event.defaultPrevented).toBe(true)
    forward.push(palette.scope())
  }
  expect(forward).toEqual(['Worktrees', 'Commands', 'Files', 'All'])
  const back = await palette.key('Tab', { shiftKey: true })
  expect(back.defaultPrevented).toBe(true)
  expect(palette.scope()).toBe('Files')
  expect(palette.input().value).toBe('o')
  expect(document.activeElement).toBe(palette.input())
})

test('switching scope resets the selection to the first row', async () => {
  const palette = await mount()
  await palette.key('ArrowDown')
  await palette.key('ArrowDown')
  expect(palette.selectedTitle()).toBe('Terminal')
  await palette.chooseScope('Commands')
  expect(palette.selectedTitle()).toBe('Build project')
})

test('clicking a tab returns focus to the field', async () => {
  const palette = await mount()
  const tab = palette.tab('Commands')
  await act(async () => {
    tab.focus()
    tab.click()
  })
  expect(palette.scope()).toBe('Commands')
  expect(document.activeElement).toBe(palette.input())
})

test('the search field says what is searched', async () => {
  const palette = await mount()
  const label = palette.input().getAttribute('aria-label') ?? ''
  for (const word of ['commands', 'tools', 'views', 'worktrees', 'files']) expect(label).toContain(word)
})

test('running any kind records it as a recent', async () => {
  const handlers = { 'quirky.worktree/navigate': () => ({}), 'ui.window.self': () => ({ connId: 4 }), 'quirky.editor/open': () => ({}), 'quirky.editor/quickOpen': () => quickOpen('src/main.ts') }
  const palette = await mount({ handlers })
  await palette.click('Build project')
  await palette.click('Terminal')
  await palette.click('Overview page')
  await palette.click('alpha-tree')
  await palette.search('main')
  await palette.debounce.fire()
  await palette.click('main.ts')

  expect(palette.ran).toMatchObject({ commands: ['command:acme/build'], tools: ['tool:acme/term'], views: ['view:acme/page'] })
  expect(palette.callsTo('ui.palette.recent').map((call) => (call.params as { id: string }).id)).toEqual([
    'command:command:acme/build',
    'tool:tool:acme/term',
    'view:view:acme/page',
    'worktree:wt_a',
    `file:${encodeFileId('wt_a', 'src/main.ts')}`
  ])
})

test('a lost recent is silent', async () => {
  const palette = await mount({ handlers: { 'ui.palette.recent': () => { throw new Error('down') } } })
  await palette.click('Build project')
  expect(palette.ran.commands).toEqual(['command:acme/build'])
  expect(palette.toasts).toEqual([])
})

test('Files debounces at 150ms, searches the selected worktree and caps the limit', async () => {
  const palette = await mount({ handlers: { 'quirky.editor/quickOpen': () => quickOpen('src/app.ts', 'lib/app.test.ts') } })
  await palette.search('a')
  await palette.search('ap')
  await palette.search('app')
  expect(palette.debounce.scheduled).toBe(3)
  expect(palette.debounce.live).toBe(1)
  expect(searchCalls(palette)).toHaveLength(0)

  await palette.debounce.fire()
  expect(searchCalls(palette)).toHaveLength(1)
  const params = searchCalls(palette)[0]!.params as { worktree: string; query: string; limit: number; action: string }
  expect(params).toMatchObject({ action: 'search', worktree: 'wt_a', query: 'app' })
  expect(params.limit).toBeGreaterThan(0)
  expect(params.limit).toBeLessThanOrEqual(50)
  expect(palette.titles()).toEqual(['app.ts', 'app.test.ts'])
  expect(palette.descriptions()).toEqual(['src/app.ts', 'lib/app.test.ts'])
})

test('no file search without a query, under Worktrees or Commands, or without a selected worktree', async () => {
  const palette = await mount({ handlers: { 'quirky.editor/quickOpen': () => quickOpen('x.ts') } })
  await palette.chooseScope('Worktrees')
  await palette.search('alpha')
  await palette.chooseScope('Commands')
  expect(palette.debounce.live).toBe(0)
  await palette.chooseScope('Files')
  await palette.search('')
  expect(palette.debounce.live).toBe(0)
  expect(palette.emptyText()).toContain('Type')
  expect(searchCalls(palette)).toHaveLength(0)

  const none = await mount({ selected: null })
  await none.chooseScope('Files')
  await none.search('x')
  expect(none.debounce.live).toBe(0)
  expect(none.emptyText()).not.toBeNull()
  expect(searchCalls(none)).toHaveLength(0)
})

test('an older reply never replaces a newer one', async () => {
  const replies: ((value: unknown) => void)[] = []
  const palette = await mount({
    handlers: { 'quirky.editor/quickOpen': () => new Promise((resolve) => replies.push(resolve)) }
  })
  await palette.chooseScope('Files')
  await palette.search('a')
  await palette.debounce.fire()
  await palette.search('ab')
  await palette.debounce.fire()
  expect(replies).toHaveLength(2)

  await act(async () => replies[1]!(quickOpen('new.ts')))
  expect(palette.titles()).toEqual(['new.ts'])
  await act(async () => replies[0]!(quickOpen('old.ts')))
  expect(palette.titles()).toEqual(['new.ts'])
})

test('a rejected file search shows the empty state and leaves the other entries alone', async () => {
  const palette = await mount({ handlers: { 'quirky.editor/quickOpen': () => { throw new Error('plugin missing') } } })
  await palette.search('build')
  await palette.debounce.fire()
  expect(palette.titles()).toEqual(['Build project'])
  expect(palette.toasts).toEqual([])

  await palette.chooseScope('Files')
  expect(palette.titles()).toEqual([])
  expect(palette.emptyText()).toContain('No results')
  expect(palette.toasts).toEqual([])
})

test('picking a file opens it, then records it', async () => {
  const palette = await mount({
    handlers: { 'quirky.editor/quickOpen': () => quickOpen('src/main.ts'), 'quirky.editor/open': () => ({}) }
  })
  await palette.search('main')
  await palette.debounce.fire()
  await palette.click('main.ts')

  const editorCalls = palette.calls.filter((call) => call.method.startsWith('quirky.editor/')).slice(1)
  expect(editorCalls).toEqual([
    { method: 'quirky.editor/open', params: { worktree: 'wt_a', path: 'src/main.ts', focus: true } },
    { method: 'quirky.editor/quickOpen', params: { worktree: 'wt_a', action: 'record', path: 'src/main.ts' } }
  ])
})

test('a failed open shows the command error toast and does not record', async () => {
  const palette = await mount({
    handlers: {
      'quirky.editor/quickOpen': () => quickOpen('src/main.ts'),
      'quirky.editor/open': () => { throw new Error('cannot open') }
    }
  })
  await palette.search('main')
  await palette.debounce.fire()
  await palette.click('main.ts')

  expect(palette.toasts).toEqual([
    { type: 'toast', toast: { kind: 'error', title: 'Could not open file: cannot open', body: 'cannot open' } }
  ])
  expect(palette.callsTo('quirky.editor/quickOpen').filter((call) => (call.params as { action: string }).action === 'record')).toEqual([])
})

test('a recent file reopens from its id in its own worktree without searching', async () => {
  const palette = await mount({
    selected: 'wt_a',
    recents: [`file:${encodeFileId('wt_b', 'docs/a b/notes.md')}`],
    handlers: { 'ui.window.self': () => ({ connId: 4 }), 'quirky.worktree/navigate': () => ({}), 'quirky.editor/open': () => ({}), 'quirky.editor/quickOpen': () => ({}) }
  })
  await palette.click('notes.md')
  expect(searchCalls(palette)).toEqual([])
  expect(palette.calls.filter((call) => call.method === 'quirky.worktree/navigate' || call.method.startsWith('quirky.editor/'))).toEqual([
    { method: 'quirky.worktree/navigate', params: { worktree: 'wt_b', window: 4 } },
    { method: 'quirky.editor/open', params: { worktree: 'wt_b', path: 'docs/a b/notes.md', focus: true } },
    { method: 'quirky.editor/quickOpen', params: { worktree: 'wt_b', action: 'record', path: 'docs/a b/notes.md' } }
  ])
})

test('a recent file in the selected worktree opens without navigating', async () => {
  const palette = await mount({
    selected: 'wt_a',
    recents: [`file:${encodeFileId('wt_a', 'notes.md')}`],
    handlers: { 'quirky.editor/open': () => ({}), 'quirky.editor/quickOpen': () => ({}) }
  })
  await palette.click('notes.md')
  expect(palette.calls.some((call) => call.method === 'quirky.worktree/navigate')).toBe(false)
})

test('a recent file whose worktree cannot be opened does not open in the background', async () => {
  const palette = await mount({
    selected: 'wt_a',
    recents: [`file:${encodeFileId('wt_b', 'notes.md')}`],
    handlers: { 'ui.window.self': () => ({ connId: 4 }), 'quirky.worktree/navigate': () => { throw new Error('gone') }, 'quirky.editor/open': () => ({}) }
  })
  await palette.click('notes.md')
  expect(palette.calls.some((call) => call.method === 'quirky.editor/open')).toBe(false)
})

test('each entry kind draws its icon', async () => {
  const palette = await mount({
    recents: [`file:${encodeFileId('wt_a', 'src/main.ts')}`],
    handlers: {}
  })
  const icon = (title: string) => palette.option(title).querySelector('.ui-list-row__title svg')
  expect(icon('main.ts')?.getAttribute('class')).toBe('ui-file-icon')
  expect(icon('main.ts')?.getAttribute('data-icon')).toBe('typescript')
  expect(icon('Terminal')?.getAttribute('class')).toBe('ui-tool-icon')
  expect(icon('Terminal')?.getAttribute('style')).toContain('--ui-hue-teal')
  expect(icon('alpha-tree')?.getAttribute('class')).toBe('ui-tool-icon')
  expect(icon('alpha-tree')?.getAttribute('style')).toContain('--ui-hue-blue')
  expect(icon('Build project')?.getAttribute('class')).toBe('ui-control-icon')
  expect(icon('Overview page')?.getAttribute('class')).toBe('ui-control-icon')
  expect(icon('Terminal')?.outerHTML).not.toBe(icon('alpha-tree')?.outerHTML)
})
