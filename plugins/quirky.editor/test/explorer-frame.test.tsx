import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ExplorerPanel as ExplorerPanelComponent } from '../src/window/ExplorerPanel'

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

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ExplorerPanel } = await import('../src/window/ExplorerPanel'))
  ;({ ToolPanelFrame } = await import('@quirky/ui') as unknown as { ToolPanelFrame: typeof ToolPanelFrame })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  calls = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
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
    toast() {}
  } as unknown as UiPluginContext
}

async function mountInHostFrame(): Promise<void> {
  await act(async () => {
    root!.render(<ToolPanelFrame title="Explorer"><ExplorerPanel context={makeContext()} /></ToolPanelFrame>)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
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

test('without a host frame the panel still shows its tools', async () => {
  await act(async () => { root!.render(<ExplorerPanel context={makeContext()} />) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
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
