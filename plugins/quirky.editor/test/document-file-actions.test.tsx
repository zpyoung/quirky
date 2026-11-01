import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { DocumentSurface as DocumentSurfaceComponent } from '../src/window/DocumentSurface'
import { CloseOverlay } from '../src/window/CloseOverlay'
import type { EditorBuffer, EditorBufferInfo, EditorServices } from '../src/types'
import { createViewerMethods } from '../src/viewers/service'
import { activeDocument } from '../src/window/activeDocument'
import type { EditorView as EditorViewType } from '@codemirror/view'
import { undo as undoMarkdown } from '@tiptap/pm/history'
import type { EditorView as ProseMirrorView } from '@tiptap/pm/view'

type SettingWrite = { id: string; value: unknown }
type SettingChange = { type: 'setting.changed'; id: string; value: unknown }
type ContextEvent = SettingChange | { type: 'quirky.editor/changed' }
type PanelToggle = { panel: string; open: boolean }
type DraftRequest = { content: string; expectedRevision: number; release(): void }
type RichDraftUpdate = { changed: boolean; buffer: EditorBufferInfo }
type RichAcknowledgementOrder = 'subscription-first' | 'response-first'
type RichApplyRequest = {
  text: string
  expectedRevision: number
  stage(): void
  respond(): void
  release(order?: RichAcknowledgementOrder): void
  publishSubscription(): void
}
type Mounted = {
  element: HTMLElement
  settingWrites: SettingWrite[]
  panelToggles: PanelToggle[]
  saveCalls: Record<string, unknown>[]
  saveStarted: Promise<void>
  buffer: EditorBufferInfo
  completeSave(): void
  draftRequests: DraftRequest[]
  richApplyRequests: RichApplyRequest[]
  currentBuffer(): EditorBufferInfo
  savedContents: string[]
  viewerMutationResponses: EditorBufferInfo[]
  publishCompetitorDraft(content: string): void
  publishPendingCsvChange(): void
  unmount(): Promise<void>
}

const BUFFER_ID = 'buffer-file-actions'
const TAB_ID = 'tab-file-actions'
const WORKTREE_ID = 'wt-editor-file-actions'
const CONTENT = 'File actions regression fixture\n'
const RICH_FRONTMATTER = '---\ntitle: File actions regression fixture\n---\n\n'
const RICH_BODY = '# File actions regression fixture\n'
const RICH_CONTENT = `${RICH_FRONTMATTER}${RICH_BODY}`
const CSV_CONTENT = 'name,value\nalpha,1\n'
const CSV_SAVED_CONTENT = 'name,value\nalpha,2\n'
const LARGE_CSV_VALUE = 'x'.repeat(200 * 1024 - 'name,value\nalpha,\n'.length)
const LARGE_CSV_CONTENT = `name,value\nalpha,${LARGE_CSV_VALUE}\n`
const RICH_RELOADED_CONTENT = `${RICH_FRONTMATTER}# Reloaded from disk\n`
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
  // DocumentSurface and ViewerSurface initialize browser APIs, so load them after Happy DOM is registered.
  ;({ createRoot } = await import('react-dom/client'))
  await import('../src/viewers/ViewerSurface')
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

function makeBufferInfo(options: {
  dirty?: boolean
  mode?: 'source' | 'rich'
  kind?: EditorBufferInfo['kind']
  content?: string
  external?: EditorBufferInfo['external']
  draft?: string
  diskWritable?: boolean
} = {}): EditorBufferInfo {
  const content = options.content ?? (options.mode === 'rich' ? RICH_CONTENT : CONTENT)
  const draft = options.draft ?? null
  const kind = options.kind ?? (options.mode === 'rich' ? 'markdown' : 'text')
  const filename = kind === 'csv' ? 'table.csv' : 'README.txt'
  return {
    id: BUFFER_ID,
    worktreeId: WORKTREE_ID,
    root: '/tmp/file-actions-worktree',
    path: `/tmp/file-actions-worktree/${filename}`,
    relativePath: filename,
    name: filename,
    kind,
    content,
    draft,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: options.diskWritable ?? true,
    dirty: options.dirty ?? false,
    external: options.external ?? null,
    mode: options.mode ?? 'source',
    tabId: TAB_ID,
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    contentLength: content.length,
    draftLength: draft?.length ?? null,
    diskContentLength: null,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
    diskContentBytes: null,
    diskSignature: null
  }
}

/** Mirrors the daemon's 256 KiB cumulative inline-text budget for a viewer result. */
function projectViewerResponse(value: unknown): { result: unknown; buffer?: EditorBufferInfo } {
  if (typeof value !== 'object' || value === null) return { result: value }
  const response = value as { buffer?: EditorBufferInfo }
  const buffer = response.buffer
  if (!buffer) return { result: value }

  const projected: EditorBufferInfo = { ...buffer }
  delete projected.content
  delete projected.draft
  delete projected.diskContent
  let remaining = 256 * 1024
  if (typeof buffer.content === 'string' && buffer.contentBytes <= remaining) {
    projected.content = buffer.content
    remaining -= buffer.contentBytes
  }
  if (buffer.draft === null) {
    projected.draft = null
  } else if (
    typeof buffer.draft === 'string' &&
    buffer.draftBytes !== null &&
    buffer.draftBytes <= remaining
  ) {
    projected.draft = buffer.draft
    remaining -= buffer.draftBytes
  }
  if (buffer.diskContent === null) {
    projected.diskContent = null
  } else if (
    typeof buffer.diskContent === 'string' &&
    buffer.diskContentBytes !== null &&
    buffer.diskContentBytes <= remaining
  ) {
    projected.diskContent = buffer.diskContent
  }
  return { result: { ...response, buffer: projected }, buffer: projected }
}

async function renderDocument(options: {
  dirty?: boolean
  withCloseOverlay?: boolean
  mode?: 'source' | 'rich'
  kind?: EditorBufferInfo['kind']
  content?: string
  csvResponseFirst?: boolean
  deferSave?: boolean
  delayDraftWrites?: boolean
  delayRichApply?: boolean
  diskWritable?: boolean
  external?: EditorBufferInfo['external']
  draft?: string
} = {}): Promise<Mounted> {
  let info = makeBufferInfo(options)
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
  const richApplyRequests: RichApplyRequest[] = []
  const draftRequests: DraftRequest[] = []
  const savedContents: string[] = []
  const viewerMutationResponses: EditorBufferInfo[] = []
  let pendingCsvChange = false
  const settings = new Map(SETTINGS)
  const savedInfo = (): EditorBufferInfo => {
    const content = options.kind === 'csv' ? info.draft ?? info.content ?? '' : undefined
    const saved = {
      ...info,
      ...(content === undefined ? {} : {
        content,
        size: content.length,
        contentLength: content.length,
        contentBytes: new TextEncoder().encode(content).byteLength
      }),
      dirty: false,
      external: null,
      draft: null,
      revision: info.revision + 1,
      contentRevision: info.contentRevision + 1,
      draftLength: null,
      draftBytes: null
    }
    state.buffers[0] = saved
    info = saved
    if (content !== undefined) savedContents.push(content)
    if (options.kind === 'csv') publishDraftChange()
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
    state.buffers[0] = info
    publishDraftChange()
  }
  const publishDraftChange = () => {
    for (const listener of settingListeners) listener({ type: 'quirky.editor/changed' })
  }
  const publishPendingCsvChange = () => {
    if (!pendingCsvChange) throw new Error('No delayed CSV draft subscription is pending.')
    pendingCsvChange = false
    publishDraftChange()
  }
  const viewerHost: Partial<EditorServices> = {
    context: { error: (_kind: string, message: string) => new Error(message) } as EditorServices['context'],
    store: {} as EditorServices['store'],
    get(bufferId) {
      if (bufferId !== BUFFER_ID) throw new Error(`Unknown buffer ${bufferId}`)
      return info as unknown as EditorBuffer
    },
    async path() {
      return info.path
    },
    async draft(bufferId, content, expectedRevision) {
      if (bufferId !== BUFFER_ID) throw new Error(`Unknown buffer ${bufferId}`)
      if (expectedRevision !== info.contentRevision) throw new Error('stale editor content revision')
      const changed = (info.draft ?? info.content) !== content
      const draft = content === info.content ? null : content
      info = {
        ...info,
        draft,
        draftLength: draft?.length ?? null,
        draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
        dirty: draft !== null,
        revision: info.revision + 1,
        contentRevision: info.contentRevision + (changed ? 1 : 0)
      }
      state.buffers[0] = info
      if (options.csvResponseFirst) pendingCsvChange = true
      else publishDraftChange()
      return info as unknown as EditorBuffer
    },
    async save() {
      return savedInfo() as unknown as EditorBuffer
    },
    async updateView(_bufferId, patch) {
      info = { ...info, view: { ...info.view, ...patch }, revision: info.revision + 1 }
      state.buffers[0] = info
      return info as unknown as EditorBuffer
    },
    emit: publishDraftChange,
    onClose: () => () => {}
  }
  const viewerFeature = options.kind === 'csv'
    ? createViewerMethods(viewerHost as EditorServices)
    : null
  const writeRichDraft = (text: string): RichDraftUpdate => {
    const source = info.content
    if (typeof source !== 'string') throw new Error('The rich fixture requires hydrated source text.')
    const prefix = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/.exec(source)?.[0] ?? ''
    const originalBody = source.slice(prefix.length)
    const content = text.trimEnd() === originalBody.trimEnd() ? source : `${prefix}${text}`
    const previous = info.draft ?? source
    const draft = content === source ? null : content
    const changed = previous !== content
    info = {
      ...info,
      draft,
      draftLength: draft?.length ?? null,
      draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
      dirty: draft !== null,
      revision: info.revision + 1,
      contentRevision: info.contentRevision + (changed ? 1 : 0)
    }
    state.buffers[0] = info
    return { changed, buffer: { ...info } }
  }
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.editor/viewer' && viewerFeature) {
        const projected = projectViewerResponse(await viewerFeature.methods.viewer(params, {} as never))
        if (projected.buffer) viewerMutationResponses.push(projected.buffer)
        return projected.result
      }
      if (method === 'quirky.editor/read' && params.action === 'text') {
        const revision = typeof params.contentRevision === 'number' ? params.contentRevision : -1
        if (revision !== info.contentRevision) throw new Error(`stale editor content revision: expected ${revision}, current ${info.contentRevision}`)
        const source = params.kind === 'draft' ? info.draft ?? '' : info.content ?? ''
        const offset = typeof params.offset === 'number' ? params.offset : 0
        const length = typeof params.length === 'number' ? params.length : source.length - offset
        const nextOffset = Math.min(source.length, offset + length)
        return {
          text: source.slice(offset, nextOffset),
          offset,
          nextOffset,
          eof: nextOffset >= source.length,
          contentRevision: info.contentRevision
        }
      }
      if (method === 'quirky.editor/state') {
        return options.kind === 'csv' || options.delayDraftWrites || options.delayRichApply
          ? { ...state, buffers: [{ ...info }] }
          : state
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
      if (method === 'quirky.editor/view') {
        if (params.action === 'pin') return { ...info, pinned: true }
        if (params.action === 'reload') {
          const content = options.mode === 'rich' ? RICH_RELOADED_CONTENT : CONTENT
          info = {
            ...info,
            content,
            draft: null,
            dirty: false,
            external: null,
            revision: info.revision + 1,
            contentRevision: info.contentRevision + 1,
            size: content.length,
            contentLength: content.length,
            draftLength: null,
            contentBytes: new TextEncoder().encode(content).byteLength,
            draftBytes: null
          }
          state.buffers[0] = info
          publishDraftChange()
        }
        return { ...info }
      }
      if (method === 'quirky.editor/markdown') {
        if (params.action === 'apply' && options.delayRichApply) {
          const text = typeof params.text === 'string' ? params.text : ''
          const expectedRevision = typeof params.expectedRevision === 'number' ? params.expectedRevision : info.contentRevision
          const pending = Promise.withResolvers<{ buffer: EditorBufferInfo; changed: boolean; sourcePreserved: true }>()
          let staged = false
          let responded = false
          let subscriptionPublished = false
          let stageError: Error | null = null
          let stagedResult: RichDraftUpdate | null = null
          const stage = () => {
            if (staged) throw new Error('This rich Markdown apply is already staged.')
            staged = true
            if (expectedRevision !== info.contentRevision) {
              stageError = new Error(`stale editor content revision: expected ${expectedRevision}, current ${info.contentRevision}`)
              return
            }
            stagedResult = writeRichDraft(text)
          }
          const respond = () => {
            if (!staged) throw new Error('The rich Markdown apply must be staged before responding.')
            if (responded) throw new Error('This rich Markdown apply is already answered.')
            responded = true
            if (stageError) {
              pending.reject(stageError)
              return
            }
            if (!stagedResult) {
              pending.reject(new Error('The rich Markdown apply produced no buffer.'))
              return
            }
            pending.resolve({ ...stagedResult, sourcePreserved: true })
          }
          const publishSubscription = () => {
            if (!staged) throw new Error('The rich Markdown apply must be staged before publishing its subscription.')
            if (subscriptionPublished) return
            subscriptionPublished = true
            publishDraftChange()
          }
          richApplyRequests.push({
            text,
            expectedRevision,
            stage,
            respond,
            release(order = 'subscription-first') {
              stage()
              if (order === 'subscription-first') publishSubscription()
              respond()
            },
            publishSubscription
          })
          return await pending.promise
        }
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
    richApplyRequests,
    currentBuffer: () => info,
    publishCompetitorDraft,
    publishPendingCsvChange,
    savedContents,
    viewerMutationResponses,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
      await viewerFeature?.dispose()
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
async function csvCellInput(surface: Mounted): Promise<HTMLInputElement> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const input = surface.element.querySelector<HTMLInputElement>('input[aria-label="Row 2, column 2"]')
    if (input) return input
    await flushReact()
  }
  throw new Error('The CSV cell input did not mount.')
}

async function changeCsvCell(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('The input value setter is unavailable.')
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function csvSaveButton(element: HTMLElement): HTMLButtonElement {
  const viewer = element.querySelector<HTMLElement>('.viewer-csv')
  if (!viewer) throw new Error('The CSV table viewer did not render.')
  return buttonByText(viewer, 'Save')
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

for (const dirty of [false, true]) {
  test(`a deleted ${dirty ? 'dirty' : 'clean'} file offers recreation without claiming a permissions restriction`, async () => {
    const surface = await renderDocument({ dirty, diskWritable: false, external: 'deleted' })

    expect(surface.element.textContent).toContain('deleted on disk')
    expect(surface.element.textContent).toContain('save can recreate')
    expect(surface.element.textContent).not.toContain('OS permissions')
    expect(buttonByText(surface.element, 'Save').disabled).toBe(false)
  })
}

for (const external of [null, 'changed'] as const) {
  test(`an existing unwritable file ${external ? 'with external changes' : 'without external changes'} explains the permissions restriction`, async () => {
    const surface = await renderDocument({ dirty: true, diskWritable: false, external })

    expect(surface.element.textContent).toContain('not writable')
    expect(surface.element.textContent).toContain('OS permissions')
    expect(surface.element.textContent).not.toContain('deleted on disk')
  })
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

function richEditorView(element: HTMLElement): ProseMirrorView {
  const editor = element.querySelector<HTMLElement>('.ProseMirror')
  if (!editor) throw new Error('DocumentSurface did not render the rich Markdown editor.')
  const dom = editor as HTMLElement & {
    editor?: { view?: ProseMirrorView }
    pmViewDesc?: { view?: ProseMirrorView }
  }
  const view = dom.editor?.view ?? dom.pmViewDesc?.view
  if (!view) throw new Error('The rich Markdown editor has no ProseMirror view.')
  return view
}

async function flushRichApply(
  surface: Mounted,
  order: RichAcknowledgementOrder
): Promise<{ request: RichApplyRequest; error: unknown }> {
  const active = activeDocument()
  if (!active) throw new Error('The active document was not registered.')
  const requestIndex = surface.richApplyRequests.length
  let flush: Promise<void> = Promise.resolve()
  await act(async () => { flush = active.flush() })
  await flushReact()
  const request = surface.richApplyRequests[requestIndex]
  if (!request) throw new Error('The rich Markdown flush did not issue an apply action.')
  let error: unknown
  await act(async () => {
    request.release(order)
    try {
      await flush
    } catch (reason) {
      error = reason
    }
  })
  if (order === 'response-first') {
    await act(async () => request.publishSubscription())
  }
  await flushReact()
  return { request, error }
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

for (const [editOrder, undoOrder] of [
  ['subscription-first', 'response-first'],
  ['response-first', 'subscription-first']
] as const) {
  test(`Rich Markdown undo to baseline is acknowledged in ${editOrder}/${undoOrder} order and closes cleanly`, async () => {
    const surface = await renderDocument({ mode: 'rich', delayRichApply: true })
    const editor = await editorTarget(surface, 'rich')
    const view = richEditorView(surface.element)
    await act(async () => editor.focus())
    const baseline = view.state.doc

    await act(async () => {
      const position = view.state.doc.content.size - 1
      view.dispatch(view.state.tr.insertText(' rich edit', position))
    })
    expect(view.state.doc.eq(baseline)).toBe(false)
    await flushReact()

    const edit = await flushRichApply(surface, editOrder)
    expect(edit.error).toBeUndefined()
    expect(edit.request.expectedRevision).toBe(1)
    expect(edit.request.text).not.toContain('title: File actions regression fixture')
    expect(surface.currentBuffer()).toMatchObject({ dirty: true, contentRevision: 2 })
    expect(surface.currentBuffer().draft).toContain(RICH_FRONTMATTER)

    await act(async () => {
      expect(undoMarkdown(view.state, transaction => view.dispatch(transaction))).toBe(true)
    })
    expect(view.state.doc.eq(baseline)).toBe(true)
    await flushReact()

    const undo = await flushRichApply(surface, undoOrder)
    expect(undo.error).toBeUndefined()
    expect(undo.request.expectedRevision).toBe(2)
    expect(surface.currentBuffer()).toMatchObject({ draft: null, dirty: false, contentRevision: 3 })
    expect(surface.element.textContent).not.toContain('A newer shared draft arrived.')

    const current = activeDocument()
    if (!current) throw new Error('The active document was not registered.')
    let closed = false
    await act(async () => { closed = await current.close() })
    expect(closed).toBe(true)
  })
}

test('Rich Markdown preserves a local source draft and Compare for a newer competing draft', async () => {
  const surface = await renderDocument({ mode: 'rich', delayRichApply: true })
  const editor = await editorTarget(surface, 'rich')
  const view = richEditorView(surface.element)
  await act(async () => editor.focus())

  await act(async () => {
    const position = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.insertText(' rich edit', position))
  })
  await flushReact()
  const ownWrite = await flushRichApply(surface, 'response-first')
  expect(ownWrite.error).toBeUndefined()
  const localText = surface.currentBuffer().draft
  if (typeof localText !== 'string') throw new Error('The rich edit did not produce a source draft.')

  const sharedText = `${RICH_FRONTMATTER}# Competing shared version\n`
  await act(async () => surface.publishCompetitorDraft(sharedText))
  await flushReact()

  expect(surface.element.textContent).toContain('A newer shared draft arrived.')
  await act(async () => buttonByText(surface.element, 'Compare local text').click())
  await flushReact()

  const comparedVersions = [...surface.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')]
  expect(comparedVersions.map((textarea) => textarea.value)).toEqual([sharedText, localText])
})

test('Rich Markdown detects a competitor published while its apply response is pending', async () => {
  const surface = await renderDocument({ mode: 'rich', delayRichApply: true })
  const editor = await editorTarget(surface, 'rich')
  const view = richEditorView(surface.element)
  await act(async () => editor.focus())

  await act(async () => {
    const position = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.insertText(' rich edit', position))
  })
  await flushReact()

  const active = activeDocument()
  if (!active) throw new Error('The active document was not registered.')
  const requestIndex = surface.richApplyRequests.length
  let flush: Promise<void> = Promise.resolve()
  await act(async () => { flush = active.flush() })
  await flushReact()
  const request = surface.richApplyRequests[requestIndex]
  if (!request) throw new Error('The rich Markdown flush did not issue an apply action.')

  await act(async () => request.stage())
  const localText = surface.currentBuffer().draft
  if (typeof localText !== 'string') throw new Error('The rich edit did not produce a source draft.')
  const sharedText = `${RICH_FRONTMATTER}# Competing shared version\n`
  await act(async () => surface.publishCompetitorDraft(sharedText))
  await flushReact()

  let flushError: unknown
  await act(async () => {
    request.respond()
    try {
      await flush
    } catch (reason) {
      flushError = reason
    }
  })
  await flushReact()

  expect(flushError).toBeDefined()
  expect(surface.element.textContent).toContain('A newer shared draft arrived.')
  await act(async () => buttonByText(surface.element, 'Compare local text').click())
  await flushReact()

  const comparedVersions = [...surface.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')]
  expect(comparedVersions.map((textarea) => textarea.value)).toEqual([sharedText, localText])
})

test('Rich undo keeps the baseline for Compare when a competitor arrives before its response', async () => {
  const surface = await renderDocument({ mode: 'rich', delayRichApply: true })
  const editor = await editorTarget(surface, 'rich')
  const view = richEditorView(surface.element)
  await act(async () => editor.focus())

  await act(async () => {
    const position = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.insertText(' rich edit', position))
  })
  await flushReact()
  const edit = await flushRichApply(surface, 'response-first')
  expect(edit.error).toBeUndefined()
  await act(async () => {
    expect(undoMarkdown(view.state, transaction => view.dispatch(transaction))).toBe(true)
  })
  await flushReact()

  const active = activeDocument()
  if (!active) throw new Error('The active document was not registered.')
  const requestIndex = surface.richApplyRequests.length
  let flush: Promise<void> = Promise.resolve()
  await act(async () => { flush = active.flush() })
  await flushReact()
  const undo = surface.richApplyRequests[requestIndex]
  if (!undo) throw new Error('The undo flush did not issue an apply action.')
  await act(async () => undo.stage())
  expect(surface.currentBuffer()).toMatchObject({ draft: null, dirty: false, contentRevision: 3 })

  const sharedText = `${RICH_FRONTMATTER}# Competing shared version\n`
  await act(async () => surface.publishCompetitorDraft(sharedText))
  await flushReact()

  let flushError: unknown
  await act(async () => {
    undo.respond()
    try {
      await flush
    } catch (reason) {
      flushError = reason
    }
  })
  await flushReact()

  expect(flushError).toBeDefined()
  expect(surface.element.textContent).toContain('A newer shared draft arrived.')
  await act(async () => buttonByText(surface.element, 'Compare local text').click())
  await flushReact()

  const comparedVersions = [...surface.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')]
  expect(comparedVersions.map((textarea) => textarea.value)).toEqual([sharedText, RICH_CONTENT])
})

test('Reload from Disk discards a Rich edit whose apply response arrives later', async () => {
  const surface = await renderDocument({ mode: 'rich', external: 'changed', delayRichApply: true })
  const editor = await editorTarget(surface, 'rich')
  const view = richEditorView(surface.element)
  await act(async () => editor.focus())

  await act(async () => {
    const position = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.insertText(' discarded rich edit', position))
  })
  await flushReact()

  const active = activeDocument()
  if (!active) throw new Error('The active document was not registered.')
  const requestIndex = surface.richApplyRequests.length
  let flush: Promise<void> = Promise.resolve()
  await act(async () => { flush = active.flush() })
  await flushReact()
  const request = surface.richApplyRequests[requestIndex]
  if (!request) throw new Error('The rich Markdown flush did not issue an apply action.')
  await act(async () => request.stage())

  await act(async () => buttonByText(surface.element, 'Reload from Disk').click())
  await flushReact()
  expect(surface.currentBuffer()).toMatchObject({
    content: RICH_RELOADED_CONTENT,
    draft: null,
    dirty: false,
    contentRevision: 3
  })
  await editorTarget(surface, 'rich')
  await flushReact()
  expect(richEditorView(surface.element).state.doc.textContent).toContain('Reloaded from disk')

  let flushError: unknown
  await act(async () => {
    request.respond()
    try {
      await flush
    } catch (reason) {
      flushError = reason
    }
  })
  await flushReact()

  expect(flushError).toBeUndefined()
  expect(surface.currentBuffer()).toMatchObject({ content: RICH_RELOADED_CONTENT, draft: null, dirty: false })
  const sharedText = `${RICH_FRONTMATTER}# Newer shared version\n`
  await act(async () => surface.publishCompetitorDraft(sharedText))
  await flushReact()

  expect(surface.element.textContent).not.toContain('A newer shared draft arrived.')
  expect(richEditorView(surface.element).state.doc.textContent).toContain('Newer shared version')
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

for (const responseFirst of [false, true]) {
  test(`CSV table Save acknowledges its own edit when the ${responseFirst ? 'response' : 'subscription'} arrives first`, async () => {
    const surface = await renderDocument({
      mode: 'rich',
      kind: 'csv',
      content: CSV_CONTENT,
      csvResponseFirst: responseFirst
    })
    const cell = await csvCellInput(surface)
    await changeCsvCell(cell, '2')
    await act(async () => {
      cell.focus()
      cell.blur()
    })
    await flushReact()
    expect(surface.currentBuffer().draft).toBe(CSV_SAVED_CONTENT)
    if (responseFirst) {
      await act(async () => surface.publishPendingCsvChange())
      await flushReact()
    }

    await act(async () => csvSaveButton(surface.element).click())
    await flushReact()

    expect(surface.savedContents).toEqual([CSV_SAVED_CONTENT])
    expect(surface.currentBuffer()).toMatchObject({
      content: CSV_SAVED_CONTENT,
      draft: null,
      dirty: false
    })
    expect(surface.element.textContent).not.toContain('A newer shared draft arrived.')

    const active = activeDocument()
    if (!active) throw new Error('The active document was not registered.')
    let closed = false
    await act(async () => { closed = await active.close() })
    expect(closed).toBe(true)
  })
}
test('CSV table edits keep 200 KiB projected draft acknowledgments through a later save and close', async () => {
  const initialValue = `${LARGE_CSV_VALUE.slice(0, -1)}p`
  const firstValue = `${LARGE_CSV_VALUE.slice(0, -1)}a`
  const secondValue = `${LARGE_CSV_VALUE.slice(0, -1)}b`
  const initialDraft = `name,value\nalpha,${initialValue}\n`
  const firstDraft = `name,value\nalpha,${firstValue}\n`
  const secondDraft = `name,value\nalpha,${secondValue}\n`
  expect(new TextEncoder().encode(LARGE_CSV_CONTENT).byteLength).toBe(200 * 1024)
  const surface = await renderDocument({
    mode: 'rich',
    kind: 'csv',
    content: LARGE_CSV_CONTENT,
    draft: initialDraft,
    dirty: true
  })

  const firstCell = await csvCellInput(surface)
  await changeCsvCell(firstCell, firstValue)
  await act(async () => {
    firstCell.focus()
    firstCell.blur()
  })
  await flushReact()
  expect(surface.viewerMutationResponses).toHaveLength(1)
  expect(surface.viewerMutationResponses[0]?.content).toBe(LARGE_CSV_CONTENT)
  expect(surface.viewerMutationResponses[0]?.draft).toBeUndefined()
  expect(surface.viewerMutationResponses[0]?.draftLength).toBe(firstDraft.length)

  const secondCell = await csvCellInput(surface)
  await changeCsvCell(secondCell, secondValue)
  await act(async () => {
    secondCell.focus()
    secondCell.blur()
  })
  await flushReact()
  expect(surface.viewerMutationResponses).toHaveLength(2)
  expect(surface.viewerMutationResponses[1]?.draft).toBeUndefined()
  expect(surface.viewerMutationResponses[1]?.draftLength).toBe(secondDraft.length)
  expect(surface.currentBuffer().draft).toBe(secondDraft)
  const conflictedAfterSecondEdit = surface.element.textContent?.includes('A newer shared draft arrived.') ?? false

  await act(async () => csvSaveButton(surface.element).click())
  await flushReact()
  const active = activeDocument()
  if (!active) throw new Error('The active document was not registered.')
  let closed = false
  await act(async () => { closed = await active.close() })

  expect(conflictedAfterSecondEdit).toBe(false)
  expect(surface.savedContents).toEqual([secondDraft])
  expect(surface.currentBuffer()).toMatchObject({ content: secondDraft, draft: null, dirty: false })
  expect(surface.element.querySelector('.viewer-error')).toBeNull()
  expect(closed).toBe(true)
}, 20_000)


test('CSV table Save still rejects a newer competing draft', async () => {
  const surface = await renderDocument({ mode: 'rich', kind: 'csv', content: CSV_CONTENT })
  const cell = await csvCellInput(surface)
  await changeCsvCell(cell, '2')
  await act(async () => {
    cell.focus()
    cell.blur()
  })
  await flushReact()
  expect(surface.currentBuffer().draft).toBe(CSV_SAVED_CONTENT)

  await act(async () => surface.publishCompetitorDraft('name,value\nbeta,3\n'))
  await flushReact()
  expect(surface.element.textContent).toContain('A newer shared draft arrived.')

  await act(async () => csvSaveButton(surface.element).click())
  await flushReact()

  expect(surface.savedContents).toEqual([])
  expect(surface.element.querySelector('.viewer-error')?.textContent).toContain('A newer shared draft arrived.')
})

test('deleted-file banner keeps the editable draft and explicit recovery actions', async () => {
  const draft = `${CONTENT}my unsaved draft\n`
  const surface = await renderDocument({ dirty: true, external: 'deleted', draft })
  const banner = surface.element.querySelector<HTMLElement>('.qe-external-change-banner')
  if (!banner) throw new Error('The deleted-file banner did not render.')
  const editor = sourceEditorView(surface.element)
  const bannerButtons = Array.from(banner.querySelectorAll('button'), (button) => button.textContent?.trim())

  expect(editor.state.doc.toString()).toBe(draft)
  expect(editor.contentDOM.getAttribute('contenteditable')).toBe('true')
  expect(bannerButtons).not.toContain('Compare')
  expect(bannerButtons).not.toContain('Reload from Disk')
  expect(bannerButtons).not.toContain('Keep My Edits')
  expect(buttonByText(banner, 'Overwrite').disabled).toBe(false)
  expect(buttonByText(surface.element, 'Save').disabled).toBe(false)
})

test('changed-file banner keeps disk comparison and recovery actions', async () => {
  const surface = await renderDocument({ dirty: true, external: 'changed', draft: `${CONTENT}my unsaved draft\n` })
  const banner = surface.element.querySelector<HTMLElement>('.qe-external-change-banner')
  if (!banner) throw new Error('The changed-file banner did not render.')

  expect(buttonByText(banner, 'Compare')).toBeDefined()
  expect(buttonByText(banner, 'Reload from Disk')).toBeDefined()
  expect(buttonByText(banner, 'Keep My Edits')).toBeDefined()
  expect(buttonByText(banner, 'Overwrite')).toBeDefined()
})
