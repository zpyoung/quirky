import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { DocumentSurface as DocumentSurfaceComponent } from '../src/window/DocumentSurface'
import { CloseOverlay } from '../src/window/CloseOverlay'
import type { EditorBufferInfo } from '../src/types'
import { activeDocument } from '../src/window/activeDocument'
import type { EditorView as EditorViewType } from '@codemirror/view'

type SettingWrite = { id: string; value: unknown }
type SettingChange = { type: 'setting.changed'; id: string; value: unknown }
type ContextEvent = SettingChange | { type: 'quirky.editor/changed' }
type PanelToggle = { panel: string; open: boolean }
type DraftRequest = { content: string; expectedRevision: number; release(): void }
type Mounted = {
  element: HTMLElement
  settingWrites: SettingWrite[]
  panelToggles: PanelToggle[]
  saveCalls: Record<string, unknown>[]
  saveStarted: Promise<void>
  buffer: EditorBufferInfo
  completeSave(): void
  draftRequests: DraftRequest[]
  savedContents: string[]
  publishCompetitorDraft(content: string): void
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
let findEditorView: (node: HTMLElement) => EditorViewType | null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // DocumentSurface initializes editor browser APIs, so load it after Happy DOM is registered.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ DocumentSurface } = await import('../src/window/DocumentSurface'))
  const { EditorView } = await import('@codemirror/view')
  findEditorView = (node) => EditorView.findFromDOM(node)
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

function makeBufferInfo(dirty = false, mode: 'source' | 'rich' = 'source'): EditorBufferInfo {
  const content = mode === 'rich' ? '# File actions regression fixture\n' : CONTENT
  return {
    id: BUFFER_ID,
    worktreeId: WORKTREE_ID,
    root: '/tmp/file-actions-worktree',
    path: '/tmp/file-actions-worktree/README.txt',
    relativePath: 'README.txt',
    name: 'README.txt',
    kind: mode === 'rich' ? 'markdown' : 'text',
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty,
    external: null,
    mode,
    tabId: TAB_ID,
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    contentLength: content.length,
    draftLength: null,
    diskContentLength: null,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftBytes: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function renderDocument(options: {
  dirty?: boolean
  withCloseOverlay?: boolean
  mode?: 'source' | 'rich'
  deferSave?: boolean
  delayDraftWrites?: boolean
} = {}): Promise<Mounted> {
  let info = makeBufferInfo(options.dirty ?? false, options.mode)
  const state = {
    buffers: [info],
    tabs: [{ tabId: TAB_ID, bufferId: BUFFER_ID, mode: 'edit' as const }],
    explorer: { worktreeId: WORKTREE_ID, showDotfiles: false, expanded: [] },
    search: null,
    quickOpenHistory: [],
    closeRequests: []
  }
  const settingListeners = new Set<(event: ContextEvent) => void>()
  const panelToggles: PanelToggle[] = []
  const settingWrites: SettingWrite[] = []
  const saveCalls: Record<string, unknown>[] = []
  const { promise: saveStarted, resolve: announceSaveStarted } = Promise.withResolvers<void>()
  let releaseSave: (() => void) | undefined
  const draftRequests: DraftRequest[] = []
  const savedContents: string[] = []
  const settings = new Map(SETTINGS)
  const savedInfo = (): EditorBufferInfo => {
    const saved = {
      ...info,
      dirty: false,
      external: null,
      draft: null,
      revision: info.revision + 1,
      contentRevision: info.contentRevision + 1,
      draftLength: null,
      draftBytes: null
    }
    state.buffers[0] = saved
    return saved
  }
  const publishCompetitorDraft = (content: string) => {
    info = {
      ...info,
      draft: content,
      draftLength: content.length,
      draftBytes: new TextEncoder().encode(content).byteLength,
      dirty: content !== info.content,
      revision: info.revision + 1,
      contentRevision: info.contentRevision + 1
    }
    publishDraftChange()
  }
  const publishDraftChange = () => {
    for (const listener of settingListeners) listener({ type: 'quirky.editor/changed' })
  }
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.editor/state') {
        return options.delayDraftWrites ? { ...state, buffers: [{ ...info }] } : state
      }
      if (method === 'quirky.editor/draft' && options.delayDraftWrites) {
        const content = typeof params.content === 'string' ? params.content : ''
        const expectedRevision = typeof params.expectedRevision === 'number' ? params.expectedRevision : info.contentRevision
        const pending = Promise.withResolvers<EditorBufferInfo>()
        draftRequests.push({
          content,
          expectedRevision,
          release() {
            info = {
              ...info,
              draft: content,
              draftLength: content.length,
              draftBytes: new TextEncoder().encode(content).byteLength,
              dirty: content !== info.content,
              revision: info.revision + 1,
              contentRevision: expectedRevision + 1
            }
            publishDraftChange()
            pending.resolve({ ...info })
          }
        })
        return await pending.promise
      }
      if (method === 'quirky.editor/save' && options.delayDraftWrites) {
        const content = info.draft ?? info.content ?? ''
        savedContents.push(content)
        info = {
          ...info,
          content,
          draft: null,
          dirty: false,
          revision: info.revision + 1,
          contentRevision: info.contentRevision + 1,
          contentLength: content.length,
          draftLength: null,
          contentBytes: new TextEncoder().encode(content).byteLength,
          draftBytes: null
        }
        publishDraftChange()
        return { ...info }
      }
      if (method === 'quirky.editor/close') {
        if (info.dirty && params.choice === undefined) return { closed: false, needsDecision: true }
        return { closed: true }
      }
      if (method === 'quirky.editor/save') {
        saveCalls.push(params)
        if (options.deferSave) {
          const pending = Promise.withResolvers<EditorBufferInfo>()
          releaseSave = () => pending.resolve(savedInfo())
          announceSaveStarted()
          return pending.promise
        }
        const saved = savedInfo()
        announceSaveStarted()
        return saved
      }
      if (method === 'setting.set') {
        const id = typeof params.id === 'string' ? params.id : ''
        settingWrites.push({ id, value: params.value })
        settings.set(id.replace(/^setting:quirky\.editor\//, ''), params.value)
        const event: SettingChange = { type: 'setting.changed', id, value: params.value }
        settingListeners.forEach((listener) => listener(event))
      }
      if (method === 'quirky.editor/view') return params.action === 'pin' ? { ...info, pinned: true } : info
      if (method === 'quirky.editor/markdown') {
        if (params.action === 'capabilities') return { richEligible: true, openAnywayAvailable: false }
        if (params.action === 'toc') return { headings: [] }
      }
      if (method === 'quirky.editor/notes') return { notes: [] }
      return {}
    },
    subscribe: (listener: (event: ContextEvent) => void) => {
      settingListeners.add(listener)
      return () => settingListeners.delete(listener)
    },
    onConnection: () => () => {},
    getSetting: (name: string) => settings.get(name),
    getLayout: () => ({ worktree: WORKTREE_ID, view: null, panel: null, sidebar: true, focus: 'view' }),
    setContext() {},
    toast() {},
    togglePanel: (panel: string, open: boolean) => { panelToggles.push({ panel, open }) },
  } as unknown as UiPluginContext
  const group = document.createElement('div')
  group.className = 'qt-group qt-active'
  const hostedView = document.createElement('div')
  hostedView.className = 'qt-hosted-view'
  hostedView.dataset.hostedView = TAB_ID
  const element = document.createElement('div')
  hostedView.append(element)
  group.append(hostedView)
  document.body.append(group)
  const root = createRoot(element)
  let unmounted = false
  const surface: Mounted = {
    element,
    settingWrites,
    panelToggles,
    saveCalls,
    saveStarted,
    buffer: info,
    completeSave() {
      if (!releaseSave) throw new Error('No deferred save is waiting to complete.')
      releaseSave()
      releaseSave = undefined
    },
    draftRequests,
    publishCompetitorDraft,
    savedContents,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
    }
  }
  mounted.push(surface)
  await act(async () => {
    root.render(
      <>
        <DocumentSurface context={context} input={{ bufferId: BUFFER_ID, tabId: TAB_ID, mode: options.mode }} />
        {options.withCloseOverlay && <CloseOverlay />}
      </>
    )
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

async function editorTarget(surface: Mounted, mode: 'source' | 'rich'): Promise<HTMLElement> {
  const selector = mode === 'source'
    ? '.cm-content[contenteditable="true"]'
    : '[contenteditable="true"][aria-label="Rich Markdown editor"]'
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const editor = surface.element.querySelector<HTMLElement>(selector)
    if (editor) return editor
    await flushReact()
  }
  throw new Error(`The ${mode} editor did not mount.`)
}

async function clickSave(surface: Mounted): Promise<HTMLButtonElement> {
  const save = buttonByText(surface.element, 'Save')
  await act(async () => {
    save.focus()
    save.click()
  })
  await surface.saveStarted
  return save
}

async function expectSaveRestoresFocus(mode: 'source' | 'rich'): Promise<void> {
  const surface = await renderDocument({ dirty: true, mode })
  const editor = await editorTarget(surface, mode)
  const save = await clickSave(surface)
  await flushReact()

  expect(surface.saveCalls).toHaveLength(1)
  expect(save.disabled).toBe(true)
  expect(document.activeElement === editor).toBe(true)
}

test('button Save restores focus to the source editor after saving', async () => {
  await expectSaveRestoresFocus('source')
})

test('button Save restores focus to the rich Markdown editor after saving', async () => {
  await expectSaveRestoresFocus('rich')
})

test('later pointer focus wins over a pending button Save focus handoff', async () => {
  const surface = await renderDocument({ dirty: true, deferSave: true })
  const save = await clickSave(surface)
  const sourceControl = outsideSourceControl()

  await act(async () => {
    sourceControl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    sourceControl.focus()
  })
  surface.completeSave()
  await flushReact()

  expect(save.disabled).toBe(true)
  expect(document.activeElement === sourceControl).toBe(true)
})

test('Tab navigation wins over a pending button Save focus handoff', async () => {
  const surface = await renderDocument({ dirty: true, deferSave: true })
  const save = await clickSave(surface)
  const sourceControl = outsideSourceControl()

  await act(async () => {
    save.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    sourceControl.focus()
  })
  surface.completeSave()
  await flushReact()

  expect(save.disabled).toBe(true)
  expect(document.activeElement === sourceControl).toBe(true)
})

test('active-document command saves do not steal focus from another control', async () => {
  const surface = await renderDocument({ dirty: true })
  const sourceControl = outsideSourceControl()
  await act(async () => sourceControl.focus())
  const active = activeDocument()
  if (!active) throw new Error('The active document was not registered.')

  await act(async () => active.save())
  await flushReact()

  expect(surface.saveCalls).toHaveLength(1)
  expect(buttonByText(surface.element, 'Save').disabled).toBe(true)
  expect(document.activeElement === sourceControl).toBe(true)
})

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
function sourceEditorView(element: HTMLElement): EditorViewType {
  const editor = element.querySelector<HTMLElement>('.cm-editor')
  if (!editor) throw new Error('DocumentSurface did not render the source editor.')
  const view = findEditorView(editor)
  if (!view) throw new Error('The source editor has no CodeMirror view.')
  return view
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

test('File actions keep secondary controls usable and their settings persistent', async () => {
  const surface = await renderDocument()
  const details = fileActions(surface.element)
  await openFileActions(surface)
  const menu = details.querySelector('.qe-file-actions-menu')
  const pin = buttonByText(details, 'Pin')
  const explorer = buttonByText(details, 'Explorer')
  const sourceControl = buttonByText(details, 'Source Control')
  const closeTab = buttonByText(details, 'Close tab')
  const zoomIn = details.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
  const zoomLabel = details.querySelector('.qe-zoom-controls > span')

  expect(menu?.contains(pin)).toBe(true)
  expect(menu?.contains(explorer)).toBe(true)
  expect(menu?.contains(sourceControl)).toBe(true)
  expect(menu?.contains(closeTab)).toBe(true)
  expect(menu?.contains(zoomIn)).toBe(true)

  await act(async () => pin.click())
  await flushReact()
  expect(buttonByText(details, 'Unpin').textContent?.trim()).toBe('Unpin')

  await act(async () => explorer.click())
  await flushReact()
  expect(surface.panelToggles).toContainEqual({
    panel: 'panel:quirky.editor/explorer',
    open: true
  })

  const trigger = fileActionsTrigger(surface.element)
  await act(async () => {
    zoomIn!.focus()
    zoomIn!.click()
  })
  await flushReact()
  expect(zoomLabel?.textContent).toBe('14 px')
  expect(surface.settingWrites).toContainEqual({
    id: 'setting:quirky.editor/editorFontZoomLevel',
    value: 1
  })

  const { event, reachedWindow } = await pressEscape(zoomIn!)
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(event.defaultPrevented).toBe(true)
  expect(reachedWindow).toBe(false)

  await openFileActions(surface)
  const reset = details.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')
  expect(reset).not.toBeNull()
  await act(async () => reset!.click())
  await flushReact()
  expect(zoomLabel?.textContent).toBe('13 px')
  expect(surface.settingWrites).toContainEqual({
    id: 'setting:quirky.editor/editorFontZoomLevel',
    value: 0
  })
})

test('cancelling a keyboard-activated dirty Close tab returns focus to the visible File actions trigger', async () => {
  const surface = await renderDocument({ dirty: true, withCloseOverlay: true })
  const details = fileActions(surface.element)
  const trigger = fileActionsTrigger(surface.element)
  const closeTab = buttonByText(details, 'Close tab')

  const activateCloseTabWithEnter = async () => {
    await act(async () => {
      closeTab.focus()
      closeTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      closeTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
    })
    await flushReact()
  }

  await openFileActions(surface)
  await activateCloseTabWithEnter()

  expect(surface.element.querySelector('[role="dialog"] h2')?.textContent).toBe('Unsaved Changes')
  const cancel = buttonByText(surface.element, 'Cancel')
  await act(async () => cancel.click())
  await flushReact()

  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(surface.buffer.dirty).toBe(true)

  await openFileActions(surface)
  await activateCloseTabWithEnter()
  const dialog = surface.element.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('The dirty-close dialog did not open.')
  await pressEscape(dialog)
  await flushReact()

  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(trigger)
  expect(surface.buffer.dirty).toBe(true)
})

test('Source keeps the latest local text when an earlier draft acknowledgment arrives, then saves it without a conflict alert', async () => {
  const surface = await renderDocument({ delayDraftWrites: true })
  const editor = sourceEditorView(surface.element)
  const firstText = `${CONTENT}first edit\n`
  const latestText = `${firstText}second edit\n`

  await act(async () => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: firstText } })
  })
  await flushReact()
  expect(surface.draftRequests).toHaveLength(1)

  await act(async () => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: latestText } })
  })
  await flushReact()
  expect(surface.draftRequests).toHaveLength(1)
  expect(editor.state.doc.toString()).toBe(latestText)

  await act(async () => surface.draftRequests[0]!.release())
  await flushReact()

  expect(editor.state.doc.toString()).toBe(latestText)
  expect(surface.element.textContent).not.toContain('A newer shared draft arrived.')
  expect(surface.draftRequests).toHaveLength(2)
  expect(surface.draftRequests[1]).toMatchObject({ content: latestText, expectedRevision: 2 })

  await act(async () => surface.draftRequests[1]!.release())
  await flushReact()
  await act(async () => buttonByText(surface.element, 'Save').click())
  await flushReact()

  expect(surface.savedContents).toEqual([latestText])
  expect(editor.state.doc.toString()).toBe(latestText)
  expect(surface.element.textContent).not.toContain('A newer shared draft arrived.')
})

test('Source preserves local edits and opens Compare for a newer competing draft', async () => {
  const surface = await renderDocument({ delayDraftWrites: true })
  const editor = sourceEditorView(surface.element)
  const localText = `${CONTENT}local draft\n`
  const sharedText = `${CONTENT}shared draft\n`

  await act(async () => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: localText } })
  })
  await flushReact()
  expect(surface.draftRequests).toHaveLength(1)
  await act(async () => surface.draftRequests[0]!.release())
  await flushReact()

  expect(editor.state.doc.toString()).toBe(localText)
  expect(surface.element.textContent).not.toContain('A newer shared draft arrived.')

  await act(async () => surface.publishCompetitorDraft(sharedText))
  await flushReact()

  expect(editor.state.doc.toString()).toBe(localText)
  expect(surface.element.textContent).toContain('A newer shared draft arrived.')
  await act(async () => buttonByText(surface.element, 'Compare local text').click())
  await flushReact()

  const comparedVersions = [...surface.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')]
  expect(comparedVersions.map((textarea) => textarea.value)).toEqual([sharedText, localText])
})
