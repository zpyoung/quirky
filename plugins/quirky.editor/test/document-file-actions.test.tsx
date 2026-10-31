import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { DocumentSurface as DocumentSurfaceComponent } from '../src/window/DocumentSurface'
import type { EditorBufferInfo } from '../src/types'

type SettingWrite = { id: string; value: unknown }
type Mounted = {
  element: HTMLElement
  settingWrites: SettingWrite[]
  unmount(): Promise<void>
}

const BUFFER_ID = 'buffer-file-actions'
const TAB_ID = 'tab-file-actions'
const WORKTREE_ID = 'wt-editor-file-actions'
const CONTENT = 'File actions regression fixture\n'
const SETTINGS = new Map<string, unknown>([
  ['editorAutoSave', false],
  ['editorAutoSaveDelayMs', 1000],
  ['editorWordWrap', false],
  ['editorFontFamily', 'monospace'],
  ['editorPreviewTabsEnabled', true],
  ['richMarkdownSpellcheckEnabled', false],
  ['markdownReviewToolsEnabled', false],
  ['showGitIgnoredFiles', false],
  ['followSymlinkedDirectories', false],
  ['editorFontZoomLevel', 0],
  ['editorMinimapEnabled', false],
  ['editorSidebarWidth', 300]
])

let createRoot: (container: HTMLElement) => Root
let DocumentSurface: typeof DocumentSurfaceComponent
let mounted: Mounted[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // DocumentSurface initializes editor browser APIs, so load it after Happy DOM is registered.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ DocumentSurface } = await import('../src/window/DocumentSurface'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => { mounted = [] })
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  document.body.replaceChildren()
})

function makeBufferInfo(): EditorBufferInfo {
  return {
    id: BUFFER_ID,
    worktreeId: WORKTREE_ID,
    root: '/tmp/file-actions-worktree',
    path: '/tmp/file-actions-worktree/README.txt',
    relativePath: 'README.txt',
    name: 'README.txt',
    kind: 'text',
    content: CONTENT,
    draft: null,
    baseline: null,
    size: CONTENT.length,
    readOnly: false,
    diskWritable: true,
    dirty: false,
    external: null,
    mode: 'source',
    tabId: TAB_ID,
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    contentLength: CONTENT.length,
    draftLength: null,
    diskContentLength: null,
    contentBytes: new TextEncoder().encode(CONTENT).byteLength,
    draftBytes: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function renderDocument(): Promise<Mounted> {
  const info = makeBufferInfo()
  const state = {
    buffers: [info],
    tabs: [{ tabId: TAB_ID, bufferId: BUFFER_ID, mode: 'edit' as const }],
    explorer: { worktreeId: WORKTREE_ID, showDotfiles: false, expanded: [] },
    search: null,
    quickOpenHistory: [],
    closeRequests: []
  }
  const settingWrites: SettingWrite[] = []
  const settings = new Map(SETTINGS)
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.editor/state') return state
      if (method === 'setting.set') {
        const id = typeof params.id === 'string' ? params.id : ''
        settingWrites.push({ id, value: params.value })
        settings.set(id.replace(/^setting:quirky\.editor\//, ''), params.value)
      }
      return {}
    },
    subscribe: () => () => {},
    onConnection: () => () => {},
    getSetting: (name: string) => settings.get(name),
    getLayout: () => ({ worktree: WORKTREE_ID, view: null, panel: null, sidebar: true, focus: 'view' }),
    setContext() {},
    toast() {},
    togglePanel() {},
  } as unknown as UiPluginContext
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let unmounted = false
  const surface: Mounted = {
    element,
    settingWrites,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
    }
  }
  mounted.push(surface)
  await act(async () => {
    root.render(<DocumentSurface context={context} input={{ bufferId: BUFFER_ID, tabId: TAB_ID }} />)
  })
  await flushReact()
  return surface
}

async function flushReact(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}

function fileActions(element: HTMLElement): HTMLDetailsElement {
  const details = element.querySelector<HTMLDetailsElement>('details.qe-file-actions')
  if (!details) throw new Error('DocumentSurface did not render File actions.')
  return details
}

function fileActionsTrigger(element: HTMLElement): HTMLElement {
  const trigger = fileActions(element).querySelector<HTMLElement>('summary')
  if (!trigger) throw new Error('File actions trigger is missing.')
  return trigger
}

function buttonByText(element: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(element.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}
function outsideSourceControl(): HTMLButtonElement {
  const button = document.createElement('button')
  button.textContent = 'Source Control'
  document.body.append(button)
  return button
}


async function openFileActions(surface: Mounted): Promise<void> {
  const details = fileActions(surface.element)
  await act(async () => {
    fileActionsTrigger(surface.element).click()
    details.open = true
  })
  expect(details.open).toBe(true)
}

async function pressEscape(target: HTMLElement): Promise<{ event: KeyboardEvent; reachedWindow: boolean }> {
  let reachedWindow = false
  const onWindowKeydown = () => { reachedWindow = true }
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  window.addEventListener('keydown', onWindowKeydown)
  try {
    await act(async () => { target.dispatchEvent(event) })
  } finally {
    window.removeEventListener('keydown', onWindowKeydown)
  }
  return { event, reachedWindow }
}

test('Escape from the File actions trigger closes it and keeps focus on the trigger', async () => {
  const surface = await renderDocument()
  await openFileActions(surface)
  const details = fileActions(surface.element)
  const trigger = fileActionsTrigger(surface.element)
  await act(async () => trigger.focus())

  const { event, reachedWindow } = await pressEscape(trigger)

  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(event.defaultPrevented).toBe(true)
  expect(reachedWindow).toBe(false)
})

test('Escape from a File actions item closes it and restores trigger focus', async () => {
  const surface = await renderDocument()
  await openFileActions(surface)
  const details = fileActions(surface.element)
  const trigger = fileActionsTrigger(surface.element)
  const item = buttonByText(details, 'Copy Path')
  await act(async () => item.focus())

  const { event, reachedWindow } = await pressEscape(item)

  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(event.defaultPrevented).toBe(true)
  expect(reachedWindow).toBe(false)
})

test('a click-only Source Control activation dismisses File actions', async () => {
  const surface = await renderDocument()
  await openFileActions(surface)
  const details = fileActions(surface.element)
  const trigger = fileActionsTrigger(surface.element)
  const sourceControl = outsideSourceControl()
  await act(async () => trigger.focus())

  await act(async () => {
    sourceControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
})

test('outside pointer activation dismisses File actions', async () => {
  const surface = await renderDocument()
  await openFileActions(surface)
  const details = fileActions(surface.element)
  const sourceControl = outsideSourceControl()

  await act(async () => {
    sourceControl.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
  })

  expect(details.open).toBe(false)
})

test('moving focus outside dismisses File actions', async () => {
  const surface = await renderDocument()
  await openFileActions(surface)
  const details = fileActions(surface.element)
  const sourceControl = outsideSourceControl()

  await act(async () => sourceControl.focus())

  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(sourceControl)
})

test('File actions stay open while interacting with native settings controls', async () => {
  const surface = await renderDocument()
  await openFileActions(surface)
  const details = fileActions(surface.element)
  const wordWrap = details.querySelector<HTMLInputElement>('input[type="checkbox"]')
  const delay = details.querySelector<HTMLInputElement>('input[type="range"]')
  expect(wordWrap).not.toBeNull()
  expect(delay).not.toBeNull()

  await act(async () => {
    wordWrap!.focus()
    wordWrap!.click()
  })

  expect(details.open).toBe(true)
  expect(surface.settingWrites).toContainEqual({ id: 'setting:quirky.editor/editorWordWrap', value: true })

  await act(async () => {
    delay!.focus()
    delay!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    delay!.click()
  })

  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(delay)
})

