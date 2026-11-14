import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'
import { clearOverlayRequests } from '../src/window/overlayState'

let activate: typeof Activate
let deactivate: typeof Deactivate
const cleanups: (() => void)[] = []
type Handler = (...args: unknown[]) => unknown
type Address = { surface: string; target: string; generation: string; actions: string[] }
type Report = {
  uiControls?: Address[]
  requestId?: number | null
  busy?: boolean
  error?: string | null
  saveAs?: { open: boolean; requestId?: number | null; bufferId: string | null; busy: boolean; error: string | null }
  worktreeId?: string | null
  loading?: boolean
  resultCount?: number
  truncated?: boolean
}
type TestEvent = { type: string; id?: string; data?: unknown }

beforeAll(async () => {
  GlobalRegistrator.register()
  const reactGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = true
  // Editor engines initialize browser APIs at import time.
  ;({ activate, deactivate } = await import('../src/ui'))
})
afterEach(async () => {
  await act(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); deactivate() })
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

async function fixture(
  respond: (method: string, params: Record<string, unknown>) => unknown,
  surface = 'overlay:quirky.editor/quick-open',
  layoutWorktree: string | null = 'w1'
) {
  const handlers = new Map<string, Handler>()
  const listeners = new Set<(event: TestEvent) => void>()
  const settings = new Map<string, unknown>([
    ['editorAutoSave', false], ['editorAutoSaveDelayMs', 1000], ['editorWordWrap', false],
    ['editorFontFamily', 'monospace'], ['editorPreviewTabsEnabled', true],
    ['richMarkdownSpellcheckEnabled', false], ['markdownReviewToolsEnabled', false],
    ['showGitIgnoredFiles', false], ['followSymlinkedDirectories', false],
    ['editorFontZoomLevel', 0], ['editorMinimapEnabled', false], ['editorSidebarWidth', 320]
  ])
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const bridge: { error: Error | null } = { error: null }
  let report: Report = {}
  const context = {
    pluginId: 'quirky.editor',
    provide: (id: string, handler: Handler) => handlers.set(id, handler),
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') {
        if (bridge.error) throw bridge.error
        return { connId: 22 }
      }
      if (method === 'ui.window.command.run') {
        if (params.connId !== 22) throw new Error('The control must stay in this window.')
        const handler = handlers.get(String(params.id))
        if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
        return { result: await handler(params.args) }
      }
      return respond(method, params)
    },
    subscribe: (listener: (event: TestEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection: () => () => {},
    onLayout: () => () => {},
    getLayout: () => layoutWorktree === null ? { panel: null } : { worktree: layoutWorktree, panel: null },
    getSetting: (name: string) => settings.get(name),
    setPanelSize() {}, toast() {}, log() {},
    executeCommand: () => { throw new Error('Owner-window dispatch is forbidden') },
  } as unknown as UiPluginContext
  activate(context)
  const element = document.createElement('div')
  document.body.append(element)
  await act(async () => { const cleanup = handlers.get(surface)!(element, { report: (value: unknown) => { report = value as Report } }); cleanups.push(cleanup as () => void) })
  const command = async (name: string, args?: unknown) => {
    let result: unknown
    await act(async () => { result = await handlers.get(`command:quirky.editor/${name}`)!(args) })
    return result
  }
  const control = async (action: string, data?: Record<string, unknown>, targetPrefix?: string) => {
    const address = (report.uiControls as Address[] | undefined)?.find((entry) => entry.actions.includes(action) && (!targetPrefix || entry.target.startsWith(targetPrefix)))
    expect(address).toBeDefined()
    return command('ui-control', { surface: address!.surface, target: address!.target, generation: address!.generation, action, ...(data ? { data } : {}) })
  }
  const start = (name: string, args?: unknown) => Promise.resolve(handlers.get(`command:quirky.editor/${name}`)!(args))
  const emit = (event: TestEvent) => { for (const listener of listeners) listener(event) }
  return { element, calls, context, command, control, start, settings, emit, bridge, get report() { return report } }
}

async function tick(ms = 0) {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  await act(async () => { await promise })
}

test('Quick Open distinguishes unresolved reads from a completed ordinary empty result', async () => {
  const pending = Promise.withResolvers<unknown>()
  const ui = await fixture((method) => method === 'quirky.editor/quickOpen' ? pending.promise : {})
  await ui.command('quick-open', { worktree: 'w1' })
  await tick()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Searching files…')
  expect(ui.element.textContent).not.toContain('No matching files.')
  await act(async () => { pending.resolve({ results: [], history: [], truncated: false }) })
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No matching files.')
})

test('empty template inventory is an empty state while blank Markdown remains available', async () => {
  const pending = Promise.withResolvers<unknown>()
  const ui = await fixture((method) => method === 'quirky.editor/markdown' ? pending.promise : {})
  await ui.command('new-markdown', { worktree: 'w1' })
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Loading Markdown templates…')
  expect(ui.element.textContent).not.toContain('No matching templates.')
  await act(async () => { pending.resolve({ templates: [] }) })
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No matching templates.')
  expect(ui.element.textContent).toContain('Blank Markdown')
})

test('Quick Open reports addresses and rejects an old dialog after replacement', async () => {
  const ui = await fixture(() => ({ results: [{ path: 'a.md', name: 'a.md', score: 1 }], history: [], truncated: false }))
  await ui.command('quick-open', { worktree: 'w1' })
  await tick()
  const old = ui.report.uiControls?.[0]
  expect(old?.target).toBe(`quick-open:${ui.report.requestId}`)
  await ui.command('quick-open', { worktree: 'w1' })
  expect(await ui.command('ui-control', { surface: old!.surface, target: old!.target, generation: old!.generation, action: 'cancel' })).toEqual({ delivered: false })
  expect(ui.element.querySelector('[role="dialog"]')).not.toBeNull()
  expect(await ui.control('cancel')).toEqual({ delivered: true })
  expect(ui.element.querySelector('[role="dialog"]')).toBeNull()
})

test('dirty close preserves its request and renders the actual save failure', async () => {
  const ui = await fixture((method) => {
    if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
    if (method === 'quirky.editor/state') return { buffers: [{ id: 'b1', tabId: 't1', name: 'notes.md', dirty: true }] }
    if (method === 'quirky.editor/read') return { buffer: { id: 'b1', untitled: false } }
    return {}
  }, 'overlay:quirky.editor/close')
  let closing!: Promise<unknown>
  await act(async () => { closing = ui.start('close', { bufferId: 'b1', tabId: 't1' }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  const requestId = ui.report.requestId
  expect(requestId).toBeNumber()
  await ui.control('choose', { choice: 'save' })
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('The file still has unsaved changes.')
  expect(ui.report.requestId).toBe(requestId)
  await ui.control('choose', { choice: 'cancel' })
  expect(await closing).toBe(false)
})

test('Save As reports separately, retains its failed path, and submits the captured revision', async () => {
  const ui = await fixture((method) => {
    if (method === 'quirky.editor/read') return { buffer: { id: 'b1', relativePath: 'untitled.md', contentRevision: 7, untitled: true } }
    if (method === 'quirky.editor/saveAs') throw new Error('Destination already exists.')
    return {}
  }, 'overlay:quirky.editor/close')
  let saving!: Promise<unknown>
  await act(async () => { saving = ui.start('save', { bufferId: 'b1' }).catch((reason: unknown) => reason); await Promise.resolve(); await Promise.resolve() })
  expect(ui.report.saveAs).toMatchObject({ open: true, bufferId: 'b1', busy: false, error: null })
  await ui.control('submit', { path: 'notes/plan.md' }, 'save-as:')
  expect(ui.calls.filter(({ method }) => method === 'quirky.editor/saveAs')).toEqual([{ method: 'quirky.editor/saveAs', params: { bufferId: 'b1', path: 'notes/plan.md', expectedRevision: 7 } }])
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Destination already exists.')
  expect(ui.element.querySelector<HTMLInputElement>('#qe-saveas-path')?.value).toBe('notes/plan.md')
  await ui.control('cancel', undefined, 'save-as:')
  expect(await saving).toBeInstanceOf(Error)
})

test('Quick Open bridge failure stays visible without closing or locally opening a result', async () => {
  const ui = await fixture(() => ({ results: [{ path: 'a.md', name: 'a.md', score: 1 }], history: [], truncated: false }))
  await ui.command('quick-open', { worktree: 'w1' })
  await tick()
  const original = ui.context.call.bind(ui.context)
  ui.context.call = async (method, params) => {
    if (method === 'ui.window.command.run') throw new Error('Window bridge disconnected.')
    return original(method, params)
  }
  await act(async () => { ui.element.querySelector<HTMLButtonElement>('[role="option"]')!.click() })
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Window bridge disconnected.')
  expect(ui.calls.filter(({ method }) => method === 'quirky.editor/open')).toEqual([])
  expect(ui.element.querySelector('[role="dialog"]')).not.toBeNull()
})

test('an old Quick Open completion cannot record or close its replacement', async () => {
  const pending = Promise.withResolvers<unknown>()
  const ui = await fixture((method) => method === 'quirky.editor/open' ? pending.promise : { results: [{ path: 'a.md', name: 'a.md', score: 1 }], history: [], truncated: false })
  await ui.command('quick-open', { worktree: 'w1' })
  await tick()
  const old = ui.report.uiControls?.[0]
  expect(old).toBeDefined()
  let opening!: Promise<unknown>
  await act(async () => {
    opening = ui.start('ui-control', { surface: old!.surface, target: old!.target, generation: old!.generation, action: 'open', data: { path: 'a.md' } })
    await Promise.resolve()
  })
  await ui.command('quick-open', { worktree: 'w1' })
  const requestId = ui.report.requestId
  await act(async () => { pending.resolve({}); await opening })
  expect(ui.report.requestId).toBe(requestId)
  expect(ui.report.uiControls?.[0]?.target).toBe(`quick-open:${requestId}`)
  expect(ui.calls.filter(({ method, params }) => method === 'quirky.editor/quickOpen' && params.action === 'record')).toEqual([])
  expect(ui.element.querySelector('[role="dialog"]')).not.toBeNull()
})

test('Save As busy submission refuses a duplicate and preserves the captured revision', async () => {
  const pending = Promise.withResolvers<unknown>()
  const ui = await fixture((method) => {
    if (method === 'quirky.editor/read') return { buffer: { id: 'b1', relativePath: 'untitled.md', contentRevision: 7, untitled: true } }
    if (method === 'quirky.editor/saveAs') return pending.promise
    return {}
  }, 'overlay:quirky.editor/close')
  let saving!: Promise<unknown>
  await act(async () => { saving = ui.start('save', { bufferId: 'b1' }).catch((reason: unknown) => reason); await Promise.resolve(); await Promise.resolve() })
  const address = ui.report.uiControls?.find(({ target }) => target.startsWith('save-as:'))
  expect(address).toBeDefined()
  const args = { surface: address!.surface, target: address!.target, generation: address!.generation, action: 'submit', data: { path: 'notes/plan.md' } }
  let submitting!: Promise<unknown>
  await act(async () => { submitting = ui.start('ui-control', args); await Promise.resolve() })
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Saving Markdown…')
  expect(await ui.command('ui-control', args)).toEqual({ delivered: false })
  expect(ui.calls.filter(({ method }) => method === 'quirky.editor/saveAs')).toHaveLength(1)
  await act(async () => { pending.resolve({ saved: true }); await submitting; await saving })
  expect(ui.element.querySelector('[role="dialog"]')).toBeNull()
})
test('Quick Open keeps the pending query distinct from the previous empty result', async () => {
  const ui = await fixture(() => ({ results: [], history: [], truncated: false }))
  await ui.command('quick-open', { worktree: 'w1' })
  await tick()
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No matching files.')

  const address = ui.report.uiControls?.[0]
  const input = ui.element.querySelector<HTMLInputElement>('input[aria-label="Go to file"]')!
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, 'missing')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(ui.report.uiControls?.[0]?.generation).toBe(address?.generation)
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Searching files…')
  expect(ui.element.querySelector('.ui-empty-state')).toBeNull()
  await tick(120)
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No matching files.')
})

test('dirty close refuses a duplicate while saving and ignores a stale completion', async () => {
  const pending = Promise.withResolvers<unknown>()
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/close' && params.choice === 'save') return pending.promise
    if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
    if (method === 'quirky.editor/state') {
      const bufferId = params.bufferId === 'b2' ? 'b2' : 'b1'
      return { buffers: [{ id: bufferId, tabId: `${bufferId}-tab`, name: `${bufferId}.md`, dirty: true }] }
    }
    return {}
  }, 'overlay:quirky.editor/close')

  let first!: Promise<unknown>
  await act(async () => {
    first = ui.start('close', { bufferId: 'b1', tabId: 'b1-tab' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  const firstRequestId = ui.report.requestId
  const firstAddress = ui.report.uiControls?.find(({ target }) => target === `close:${firstRequestId}`)
  expect(firstAddress).toBeDefined()
  const args = {
    surface: firstAddress!.surface,
    target: firstAddress!.target,
    generation: firstAddress!.generation,
    action: 'choose',
    data: { choice: 'save' }
  }
  let saving!: Promise<unknown>
  await act(async () => {
    saving = ui.start('ui-control', args)
    await Promise.resolve()
  })
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Saving Markdown…')
  expect(await ui.command('ui-control', args)).toEqual({ delivered: false })
  expect(ui.calls.filter(({ method, params }) => method === 'quirky.editor/close' && params.choice === 'save')).toHaveLength(1)

  let second!: Promise<unknown>
  await act(async () => {
    second = ui.start('close', { bufferId: 'b2', tabId: 'b2-tab' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  const replacementId = ui.report.requestId
  expect(replacementId).toBeNumber()
  expect(replacementId).not.toBe(firstRequestId)
  await act(async () => { pending.resolve({ closed: true }); await saving })
  expect(ui.report.requestId).toBe(replacementId)
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
  expect(await first).toBe(false)
  await ui.control('choose', { choice: 'cancel' })
  expect(await second).toBe(false)
})

test('Quick Open validates public payloads and permits a blank Markdown command', async () => {
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/quickOpen') {
      return { results: [{ path: 'current.ts', name: 'current.ts', score: 1 }], history: [], truncated: false }
    }
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return { templates: [] }
    if (method === 'quirky.editor/markdown' && params.action === 'new') return { path: 'notes/new.md' }
    return {}
  })
  await ui.command('quick-open', { worktree: 'w1' })
  await tick()
  const fileAddress = ui.report.uiControls?.find(({ actions }) => actions.includes('open'))
  expect(fileAddress).toBeDefined()
  for (const data of [{ path: 'outside.ts' }, { path: 7 }, { path: 'current.ts', unexpected: true }]) {
    expect(await ui.command('ui-control', {
      surface: fileAddress!.surface,
      target: fileAddress!.target,
      generation: fileAddress!.generation,
      action: 'open',
      data
    })).toEqual({ delivered: false })
  }
  expect(ui.calls.filter(({ method }) => method === 'quirky.editor/open')).toEqual([])

  await ui.command('new-markdown', { worktree: 'w1' })
  await tick()
  const templateAddress = ui.report.uiControls?.find(({ actions }) => actions.includes('create-markdown'))
  expect(templateAddress).toBeDefined()
  expect(await ui.command('ui-control', {
    surface: templateAddress!.surface,
    target: templateAddress!.target,
    generation: templateAddress!.generation,
    action: 'create-markdown'
  })).toEqual({ delivered: true })
  expect(ui.calls.find(({ method, params }) => method === 'quirky.editor/markdown' && params.action === 'new')?.params).toEqual({
    action: 'new',
    worktree: 'w1',
    title: ''
  })
  expect(ui.calls.find(({ method }) => method === 'quirky.editor/open')?.params).toMatchObject({
    path: 'notes/new.md',
    mode: 'rich',
    focus: true,
    preview: false
  })
})

test('dirty close can retry after a failed choice without changing its request identity', async () => {
  let saveAttempts = 0
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/close' && params.choice === 'save') {
      saveAttempts++
      return saveAttempts === 1
        ? { closed: false, needsDecision: true }
        : { closed: true }
    }
    if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
    if (method === 'quirky.editor/state') {
      return { buffers: [{ id: 'b1', tabId: 't1', name: 'notes.md', dirty: true }] }
    }
    return {}
  }, 'overlay:quirky.editor/close')

  let closing!: Promise<unknown>
  await act(async () => {
    closing = ui.start('close', { bufferId: 'b1', tabId: 't1' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  const requestId = ui.report.requestId
  await ui.control('choose', { choice: 'save' })
  expect(ui.report.requestId).toBe(requestId)
  expect(ui.report.busy).toBe(false)
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('The file still has unsaved changes.')
  await ui.control('choose', { choice: 'save' })
  expect(saveAttempts).toBe(2)
  expect(await closing).toBe(true)
  expect(ui.element.querySelector('[role="dialog"]')).toBeNull()
})

test('stale close-state reads cannot replace a newer dialog or reopen after clear', async () => {
  const staleRead = Promise.withResolvers<unknown>()
  const clearedRead = Promise.withResolvers<unknown>()
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
    if (method === 'quirky.editor/state' && params.bufferId === 'b1') return staleRead.promise
    if (method === 'quirky.editor/state' && params.bufferId === 'b3') return clearedRead.promise
    if (method === 'quirky.editor/state') {
      const bufferId = String(params.bufferId)
      return { buffers: [{ id: bufferId, tabId: `${bufferId}-tab`, name: `${bufferId}.md`, dirty: true }] }
    }
    return {}
  }, 'overlay:quirky.editor/close')

  let first!: Promise<unknown>
  await act(async () => {
    first = ui.start('close', { bufferId: 'b1', tabId: 'b1-tab' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  let second!: Promise<unknown>
  await act(async () => {
    second = ui.start('close', { bufferId: 'b2', tabId: 'b2-tab' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  const currentRequestId = ui.report.requestId
  expect(ui.report.uiControls?.some(({ target }) => target === `close:${currentRequestId}`)).toBe(true)
  await act(async () => { staleRead.resolve({ buffers: [{ id: 'b1', tabId: 'b1-tab', name: 'b1.md', dirty: true }] }); await first })
  expect(ui.report.requestId).toBe(currentRequestId)
  expect(await first).toBe(false)
  await ui.control('choose', { choice: 'cancel' })
  expect(await second).toBe(false)

  let cleared!: Promise<unknown>
  await act(async () => {
    cleared = ui.start('close', { bufferId: 'b3', tabId: 'b3-tab' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    clearOverlayRequests()
    clearedRead.resolve({ buffers: [{ id: 'b3', tabId: 'b3-tab', name: 'b3.md', dirty: true }] })
    await cleared
  })
  expect(ui.report.requestId).toBeNull()
  expect(ui.report.uiControls?.some(({ target }) => target.startsWith('close:'))).toBe(false)
  expect(ui.element.querySelector('[role="dialog"]')).toBeNull()
})

test.each([
  'panel:quirky.editor/explorer',
  'sidebar-section:quirky.editor/explorer'
])('Explorer %s distinguishes pending and empty roots and routes local controls', async (surface) => {
  const rootRead = Promise.withResolvers<unknown>()
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/state') return {
      buffers: [], tabs: [], explorer: { worktreeId: 'w1', showDotfiles: true, expanded: [], selectedPaths: [], focusedPath: null },
      search: null, quickOpenHistory: [], closeRequests: []
    }
    if (method === 'quirky.editor/documentRoot') return { id: 'w1', path: '/repo' }
    if (method === 'quirky.git/status') return { files: [] }
    if (method === 'quirky.editor/explorer' && params.action === 'list') return rootRead.promise
    return {}
  }, surface)
  await tick()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Loading files…')
  expect(ui.element.querySelector('.ui-empty-state')).toBeNull()

  await act(async () => rootRead.resolve({
    root: '/repo', entries: [], truncated: false, showDotfiles: true, showIgnored: false, followSymlinkedDirectories: false
  }))
  await tick()
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No files in this folder.')

  const address = ui.report.uiControls?.find((entry) => entry.actions.includes('new-file'))
  expect(address).toMatchObject({
    surface, target: 'explorer:w1',
    actions: expect.arrayContaining([
      'new-file', 'new-folder', 'create', 'cancel-create', 'rename-start', 'rename', 'cancel-rename',
      'menu', 'menu-close', 'clear-filter', 'mode', 'choose-worktree', 'search-in-files', 'copy-path'
    ])
  })
  ui.calls.length = 0
  await act(async () => ui.element.querySelector<HTMLButtonElement>('button[title="New File"]')!.click())
  await tick()
  expect(ui.calls.some(({ method }) => method === 'ui.window.self')).toBe(true)
  const bridge = ui.calls.find(({ method }) => method === 'ui.window.command.run')
  expect(bridge?.params).toMatchObject({
    connId: 22, id: 'command:quirky.editor/ui-control',
    args: { surface, target: address?.target, generation: address?.generation, action: 'new-file' }
  })

  const current = ui.report.uiControls?.find((entry) => entry.actions.includes('create'))
  expect(current).toBeDefined()
  expect(current?.generation).not.toBe(address?.generation)
  expect(await ui.command('ui-control', {
    surface: current!.surface, target: current!.target, generation: current!.generation,
    action: 'create', data: { name: 7 }
  })).toEqual({ delivered: false })
  expect(ui.calls.filter(({ method }) => method === 'quirky.editor/mutate')).toEqual([])
  expect(ui.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input')?.value).toBe('')
})

test('Explorer ignores an empty Names response from the previous worktree while the current query is pending', async () => {
  const firstFilter = Promise.withResolvers<unknown>()
  const secondFilter = Promise.withResolvers<unknown>()
  let firstStarted = 0
  let secondStarted = 0
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/state') return {
      buffers: [], tabs: [], explorer: { worktreeId: String(params.worktree ?? 'w1'), showDotfiles: true, expanded: [], selectedPaths: [], focusedPath: null },
      search: null, quickOpenHistory: [], closeRequests: []
    }
    if (method === 'quirky.worktree/list') return [
      { id: 'w1', path: '/repo/one', name: 'one' }, { id: 'w2', path: '/repo/two', name: 'two' }
    ]
    if (method === 'quirky.editor/documentRoot') return { id: params.worktree, path: `/repo/${params.worktree}` }
    if (method === 'quirky.git/status') return { files: [] }
    if (method === 'quirky.editor/explorer' && params.action === 'list') {
      return { root: `/repo/${params.worktree}`, entries: [], truncated: false, showDotfiles: true, showIgnored: false, followSymlinkedDirectories: false }
    }
    if (method === 'quirky.editor/explorer' && params.action === 'filter') {
      if (params.worktree === 'w1') { firstStarted++; return firstFilter.promise }
      if (params.worktree === 'w2') { secondStarted++; return secondFilter.promise }
    }
    return {}
  }, 'panel:quirky.editor/explorer', null)
  await tick()
  await ui.control('choose-worktree', { worktree: 'w1' }, 'explorer:unselected')
  await tick()
  const firstAddress = ui.report.uiControls?.find((entry) => entry.target === 'explorer:w1')
  const query = ui.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(query, 'missing-worktree')
    query.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await tick(140)
  expect(firstStarted).toBe(1)
  expect(ui.report.uiControls?.find((entry) => entry.target === 'explorer:w1')?.generation).toBe(firstAddress?.generation)

  await ui.control('choose-worktree', { worktree: 'w2' }, 'explorer:w1')
  await tick(140)
  expect(secondStarted).toBe(1)
  const secondAddress = ui.report.uiControls?.find((entry) => entry.target === 'explorer:w2')
  expect(secondAddress).toBeDefined()
  expect(secondAddress?.generation).not.toBe(firstAddress?.generation)

  await act(async () => firstFilter.resolve({
    root: '/repo/one', entries: [], truncated: false, showDotfiles: true, showIgnored: false, followSymlinkedDirectories: false
  }))
  await tick()
  expect(ui.element.querySelector('.ui-empty-state')).toBeNull()
  expect(ui.element.querySelector('.qe-explorer-filter-empty')).toBeNull()

  await act(async () => secondFilter.resolve({
    root: '/repo/two', entries: [], truncated: false, showDotfiles: true, showIgnored: false, followSymlinkedDirectories: false
  }))
  await tick()
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No files match “missing-worktree”.')
})

test('a delayed Explorer blur cannot submit a replacement create form', async () => {
  const ui = await fixture((method) => {
    if (method === 'quirky.editor/state') return { buffers: [], tabs: [], explorer: { worktreeId: 'w1', expanded: [], selectedPaths: [], focusedPath: null }, search: null }
    if (method === 'quirky.editor/documentRoot') return { id: 'w1', path: '/repo' }
    if (method === 'quirky.git/status') return { files: [] }
    if (method === 'quirky.editor/explorer') return { root: '/repo', entries: [] }
    return {}
  }, 'panel:quirky.editor/explorer')
  await tick()
  await ui.control('new-file')
  await tick(210)
  const first = ui.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input')!
  await act(async () => {
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await ui.control('new-file')
  const replacement = ui.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(replacement, 'replacement.txt')
    replacement.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await tick(180)
  expect(ui.calls.filter(({ method }) => method === 'quirky.editor/mutate')).toEqual([])
  expect(replacement.value).toBe('replacement.txt')
  expect(ui.element.querySelector('.qe-explorer-inline-row')).not.toBeNull()
})

test('a busy dirty-close dialog still displays an exact-window bridge failure', async () => {
  const pending = Promise.withResolvers<unknown>()
  const ui = await fixture((method, params) => {
    if (method === 'quirky.editor/close') return params.choice === 'save' ? pending.promise : { closed: false, needsDecision: true }
    if (method === 'quirky.editor/read') return { buffer: { id: 'b1', untitled: false } }
    if (method === 'quirky.editor/state') return { buffers: [{ id: 'b1', tabId: 't1', name: 'notes.md', dirty: true }] }
    return {}
  }, 'overlay:quirky.editor/close')
  let closing!: Promise<unknown>
  let saving!: Promise<unknown>
  try {
    await act(async () => { closing = ui.start('close', { bufferId: 'b1', tabId: 't1' }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    const address = ui.report.uiControls![0]!
    await act(async () => { saving = ui.start('ui-control', { surface: address.surface, target: address.target, generation: address.generation, action: 'choose', data: { choice: 'save' } }); await Promise.resolve() })
    ui.bridge.error = new Error('Window disconnected.')
    await act(async () => {
      ui.element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Window disconnected.')
    expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Saving Markdown…')
  } finally {
    ui.bridge.error = null
    await act(async () => { pending.resolve({ closed: false, needsDecision: true }); await saving })
    await ui.control('choose', { choice: 'cancel' })
    await closing
  }
})
