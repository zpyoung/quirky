import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ExplorerPanel as ExplorerPanelComponent } from '../src/window/ExplorerPanel'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'
import type {
  createEditorUiControlReportScope as CreateEditorUiControlReportScope,
  EditorUiControlProvider as EditorUiControlProviderComponent
} from '../src/window/uiControl'

type Call = { method: string; params: Record<string, unknown> }

const SETTINGS: Record<string, unknown> = {
  editorAutoSave: false,
  editorAutoSaveDelayMs: 1000,
  editorWordWrap: false,
  editorFontFamily: 'monospace',
  editorPreviewTabsEnabled: true,
  richMarkdownSpellcheckEnabled: false,
  markdownReviewToolsEnabled: false,
  showGitIgnoredFiles: false,
  followSymlinkedDirectories: false,
  editorFontZoomLevel: 0,
  editorMinimapEnabled: false,
  editorSidebarWidth: 320
}

const LISTING = {
  root: '/repo',
  entries: [{ path: '/repo/a.txt', name: 'a.txt', isDirectory: false, isSymlink: false }],
  showDotfiles: true,
  showIgnored: false,
  followSymlinkedDirectories: false
}

const css = readFileSync(join(import.meta.dir, '../../../packages/ui/src/design-system/editor-window.css'), 'utf8')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }))

let createRoot: (container: HTMLElement) => Root
let ExplorerPanel: typeof ExplorerPanelComponent
let ToolPanelFrame: (props: { title: string; children?: ReactNode }) => ReactNode
let root: Root | null = null
let container: HTMLDivElement
let calls: Call[] = []
type UiControlAddress = { surface: string; target: string; generation: string; actions: string[] }
type UiControlReport = { uiControls?: UiControlAddress[] }
type CommandHandler = (args?: unknown) => unknown

let activate: typeof Activate
let deactivate: typeof Deactivate
let createEditorUiControlReportScope: typeof CreateEditorUiControlReportScope
let EditorUiControlProvider: typeof EditorUiControlProviderComponent
let report: UiControlReport = {}
let disposeControlScope: (() => void) | undefined
let disposeActivatedContext: (() => void) | undefined

function tick(ms = 0): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ExplorerPanel } = await import('../src/window/ExplorerPanel'))
  ;({ ToolPanelFrame } = await import('@quirky/ui') as unknown as { ToolPanelFrame: typeof ToolPanelFrame })
  ;({ activate, deactivate } = await import('../src/ui'))
  ;({ createEditorUiControlReportScope, EditorUiControlProvider } = await import('../src/window/uiControl'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  calls = []
  report = {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  disposeControlScope?.()
  disposeControlScope = undefined
  disposeActivatedContext?.()
  disposeActivatedContext = undefined
  document.body.replaceChildren()
})

function makeContext(): UiPluginContext {
  const respond = (method: string): unknown => {
    if (method === 'quirky.editor/state') {
      return { buffers: [], tabs: [], explorer: { worktreeId: 'w1', showDotfiles: true, expanded: [] }, search: null, quickOpenHistory: [], closeRequests: [] }
    }
    if (method === 'quirky.editor/documentRoot') return { id: 'w1', path: '/repo' }
    if (method === 'quirky.editor/explorer') return LISTING
    if (method === 'quirky.git/status') return { files: [] }
    return {}
  }
  return {
    pluginId: 'quirky.editor',
    log() {},
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return respond(method)
    },
    subscribe: () => () => {},
    getSetting: (name: string) => SETTINGS[name],
    getLayout: () => ({ worktree: 'w1', view: null, panel: null, sidebar: true, focus: 'view' }),
    onLayout: () => () => {},
    onConnection: () => () => {},
    toast() {},
    async executeCommand() { throw new Error('Owner-window dispatch is forbidden') }
  } as unknown as UiPluginContext
}

function activateControlBridge(context: UiPluginContext): void {
  const handlers = new Map<string, CommandHandler>()
  const originalCall = context.call.bind(context)
  context.provide = ((id: string, handler: CommandHandler) => { handlers.set(id, handler) }) as typeof context.provide
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'ui.window.self') {
      calls.push({ method, params })
      return { connId: 22 }
    }
    if (method === 'ui.window.command.run') {
      calls.push({ method, params })
      if (params.connId !== 22) throw new Error('The control must stay in this window.')
      const handler = handlers.get(String(params.id))
      if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
      return { result: await handler(params.args) }
    }
    return originalCall(method, params)
  }) as typeof context.call
  activate(context)
  disposeActivatedContext = () => deactivate()
}

async function mountExplorer(
  surface = 'panel:quirky.editor/explorer',
  withFrame = true,
  context = makeContext()
): Promise<void> {
  activateControlBridge(context)
  const scope = createEditorUiControlReportScope((value) => { report = value as UiControlReport }, { surface })
  disposeControlScope = () => scope.dispose()
  const explorer = <ExplorerPanel context={context} report={scope.report} />
  await act(async () => {
    root!.render(
      <EditorUiControlProvider scope={scope}>
        {withFrame ? <ToolPanelFrame title="Explorer">{explorer}</ToolPanelFrame> : explorer}
      </EditorUiControlProvider>
    )
  })
  await act(async () => { await tick(20) })
}

async function mountInHostFrame(surface = 'panel:quirky.editor/explorer'): Promise<void> {
  await mountExplorer(surface)
}

const control = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"], button[title="${label}"]`)

const RAIL_CONTROLS = ['New File', 'New Folder', 'Collapse All', 'Refresh Explorer', 'Undo file operation', 'Redo file operation', 'Source Control']

test('the panel draws no header of its own under the host frame', async () => {
  await mountInHostFrame()
  expect(container.querySelectorAll('header').length).toBe(1)
  expect(container.querySelector('.qe-explorer header')).toBeNull()
  expect(container.querySelector('.qe-explorer-toolbar')).toBeNull()
  expect(container.querySelectorAll('h2').length).toBe(1)
})

test('row tools sit in the frame rail and the panel menu sits in the header actions', async () => {
  await mountInHostFrame()
  for (const label of RAIL_CONTROLS) {
    const button = control(label)
    expect(button, label).not.toBeNull()
    expect(button!.closest('.ui-tool-panel-frame__rail'), label).not.toBeNull()
  }
  const more = container.querySelector('[aria-label="More Explorer Actions"]')
  expect(more).not.toBeNull()
  expect(more!.closest('.ui-tool-panel-frame__actions')).not.toBeNull()
})

test('the moved tools still act on the Explorer', async () => {
  await mountInHostFrame()
  const click = async (label: string) => { await act(async () => control(label)!.click()) }

  calls = []
  await click('Refresh Explorer')
  expect(calls.some((call) => call.method === 'quirky.editor/explorer' && call.params.action === 'refresh')).toBe(true)

  calls = []
  await click('Collapse All')
  expect(calls.some((call) => call.method === 'quirky.editor/explorer' && call.params.action === 'preferences' && Array.isArray(call.params.expanded))).toBe(true)

  calls = []
  await click('Undo file operation')
  expect(calls.some((call) => call.method === 'quirky.editor/history' && call.params.action === 'undo')).toBe(true)

  await click('New File')
  expect(container.querySelector('input[aria-label="New file name"], .qe-explorer-inline-row input')).not.toBeNull()
})

test.each([
  'panel:quirky.editor/explorer',
  'sidebar-section:quirky.editor/explorer'
])('New File uses the activated exact-window control route for %s', async (surface) => {
  await mountInHostFrame(surface)
  calls = []
  const clickedAddress = report.uiControls?.find((entry) => entry.actions.includes('new-file'))
  await act(async () => {
    control('New File')!.click()
    await tick()
  })
  const address = report.uiControls?.find((entry) => entry.actions.includes('new-file'))
  expect(address).toMatchObject({
    surface,
    target: 'explorer:w1',
    actions: expect.arrayContaining(['new-file', 'create', 'cancel-create', 'clear-filter', 'mode', 'copy-path'])
  })
  expect(address?.generation).not.toBe(clickedAddress?.generation)
  expect(calls.find((entry) => entry.method === 'ui.window.self')).toBeDefined()
  const bridge = calls.find((entry) => entry.method === 'ui.window.command.run')
  expect(bridge?.params.connId).toBe(22)
  expect(bridge?.params.id).toBe('command:quirky.editor/ui-control')
  expect(bridge?.params.args).toMatchObject({
    surface,
    target: clickedAddress?.target,
    generation: clickedAddress?.generation,
    action: 'new-file'
  })
  expect(container.querySelector('.qe-explorer-inline-row')).not.toBeNull()
})

test('Explorer shared loading and empty states keep polite status semantics inside the host frame', async () => {
  const context = makeContext()
  const listing = Promise.withResolvers<typeof LISTING>()
  const originalCall = context.call.bind(context)
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/explorer' && params.action === 'list') return await listing.promise
    return await originalCall(method, params)
  }) as typeof context.call
  await mountExplorer('panel:quirky.editor/explorer', true, context)

  const loadingStatus = container.querySelector<HTMLElement>('[role="status"]')
  expect(loadingStatus?.getAttribute('aria-live')).toBe('polite')
  expect(loadingStatus?.querySelector('.ui-notice-line')?.textContent).toBe('Loading files…')
  expect(container.querySelector('.ui-empty-state')).toBeNull()

  await act(async () => {
    listing.resolve({ ...LISTING, entries: [] })
    await tick()
  })
  const emptyStatus = container.querySelector<HTMLElement>('[role="status"]')
  expect(emptyStatus?.getAttribute('aria-live')).toBe('polite')
  expect(emptyStatus?.querySelector('.ui-empty-state')?.textContent).toContain('No files in this folder.')
})

test('without a host frame the panel still shows its tools', async () => {
  await mountExplorer('panel:quirky.editor/explorer', false)
  expect(control('Refresh Explorer')).not.toBeNull()
})

test('a selected row is accent only while its panel is focused', () => {
  const selected = rules.filter((rule) => rule.selector.includes('.qe-explorer-row.selected'))
  expect(selected.length).toBeGreaterThan(0)
  for (const rule of selected) {
    if (rule.body.includes('var(--ui-accent)')) expect(rule.selector).toContain('[data-panel-focused]')
  }
  const focused = selected.find((rule) => rule.selector.includes('[data-panel-focused]'))
  expect(focused?.body).toContain('background: var(--ui-accent)')
  expect(focused?.body).toContain('color: var(--ui-rail)')
  const unfocused = selected.find((rule) => !rule.selector.includes('[data-panel-focused]'))
  expect(unfocused?.body).toContain('background: var(--ui-selected)')
})

test('no stylesheet rule remains for the removed toolbar', () => {
  expect(css).not.toContain('qe-explorer-toolbar')
})
