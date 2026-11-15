import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType, ReactNode } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import type { EditorUiControlAddress, EditorUiControlReportScope } from '../src/window/uiControl'

type ControlHandler = (...args: unknown[]) => unknown
type ControlReport = { mounted?: boolean; bufferId?: string; tabId?: string; uiControls?: EditorUiControlAddress[] }
type PdfTask = { promise: Promise<unknown>; destroy(): Promise<void> }
type PdfFixturePage = {
  getViewport(options: { scale: number }): { width: number; height: number }
  render(options: Record<string, unknown>): { promise: Promise<void>; cancel(): void }
  getTextContent(): Promise<{ items: { str: string }[] }>
}
type Fixture = {
  context: UiPluginContext
  calls: { method: string; params?: Record<string, unknown> }[]
  scopes: EditorUiControlReportScope[]
  reports: ControlReport[]
  provided: Map<string, ControlHandler>
  api(method: string, params: Record<string, unknown>): Promise<unknown>
  control(action: string, data?: Record<string, unknown>, targetPrefix?: string, reportIndex?: number): Promise<unknown>
  bridge: { self?: unknown; reply?: unknown; error?: string }
}
type Mounted = {
  element: HTMLElement
  views: Record<string, unknown>[]
  report(): ControlReport
  commands(): Parameters<SurfaceProps['registerCommandHandlers']>[0] | undefined
  update(buffer: EditorSurfaceBuffer): Promise<void>
  unmount(): Promise<void>
}

let createRoot: (container: HTMLElement) => Root
let ViewerSurface: ComponentType<SurfaceProps>
let activate: (context: UiPluginContext) => void
let deactivate: () => void
let EditorUiControlProvider: ComponentType<{ scope: EditorUiControlReportScope; children: ReactNode }>
let createEditorUiControlReportScope: (onReport: (value: unknown) => void, options: { surface: string }) => EditorUiControlReportScope
let pdfLoader: (options: unknown) => PdfTask
let pdfRequests: unknown[]
let diagramRender: (id: string, source: string) => Promise<{ svg: string }>
let diagramCalls: string[]
let diagramInitializations: Record<string, unknown>[]
let mounted: Mounted[]
let fixtures: Fixture[]

mock.module('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument(options: unknown) {
    pdfRequests.push(options)
    return pdfLoader(options)
  }
}))
mock.module('mermaid', () => ({
  default: {
    initialize(options: Record<string, unknown>) { diagramInitializations.push(options) },
    render(id: string, source: string) {
      diagramCalls.push(source)
      return diagramRender(id, source)
    }
  }
}))

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ViewerSurface } = await import('../src/viewers/ViewerSurface'))
  ;({ activate, deactivate } = await import('../src/ui'))
  ;({ EditorUiControlProvider, createEditorUiControlReportScope } = await import('../src/window/uiControl'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  mounted = []
  fixtures = []
  pdfRequests = []
  pdfLoader = () => ({ promise: Promise.reject(new Error('unexpected PDF load')), destroy: async () => {} })
  diagramCalls = []
  diagramInitializations = []
  diagramRender = async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>' })
})
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  for (const fixture of fixtures) for (const scope of fixture.scopes) scope.dispose()
  deactivate()
  document.body.replaceChildren()
})

function deferred<T>() {
  const pending = Promise.withResolvers<T>()
  return pending
}

function makeBuffer(
  kind: EditorSurfaceBuffer['kind'],
  content = kind === 'csv' ? 'name,value\nalpha,1\n' : 'graph TD\n  A --> B',
  overrides: Partial<EditorSurfaceBuffer> = {}
): EditorSurfaceBuffer {
  const extension: Record<EditorSurfaceBuffer['kind'], string> = {
    text: 'txt', markdown: 'md', notebook: 'ipynb', csv: 'csv', image: 'png', pdf: 'pdf',
    audio: 'mp3', video: 'mp4', mermaid: 'mmd', binary: 'dat'
  }
  return {
    id: 'b1', worktreeId: 'wt1', root: '/tmp/viewer-worktree',
    path: `/tmp/viewer-worktree/sample.${extension[kind]}`, relativePath: `sample.${extension[kind]}`,
    name: `sample.${extension[kind]}`, kind, content, draft: null, baseline: null, size: content.length,
    readOnly: false, diskWritable: true, dirty: false, external: null, mode: 'rich', tabId: 't1',
    preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null,
    diskContentLength: null, diskContentBytes: null, diskSignature: null, ...overrides
  }
}

function makeFixture(delegate: SurfaceProps['onAction']): Fixture {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const scopes: EditorUiControlReportScope[] = []
  const reports: ControlReport[] = []
  const provided = new Map<string, ControlHandler>()
  const bridge: Fixture['bridge'] = {}
  const api = (method: string, params: Record<string, unknown>) => delegate(method, params)
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') return Object.hasOwn(bridge, 'self') ? bridge.self : { connId: 22 }
      if (method === 'ui.window.command.run') {
        if (bridge.error) throw new Error(bridge.error)
        if (Object.hasOwn(bridge, 'reply')) return bridge.reply
        if (params.connId !== 22) throw new Error('The owner window must not receive this control.')
        const handler = provided.get(typeof params.id === 'string' ? params.id : '')
        if (!handler) throw new Error('The activated UI control handler is missing.')
        return { result: await handler(params.args) }
      }
      return api(method, params)
    },
    provide(id: string, handler: unknown) {
      if (typeof handler === 'function') provided.set(id, handler as ControlHandler)
    },
    subscribe: () => () => {},
    getSetting: (name: string) => name === 'editorSidebarWidth' ? 300 : undefined,
    getLayout: () => ({ worktree: 'wt1', view: null, panel: null }),
    executeCommand: async () => {},
    toast: () => {}
  } as unknown as UiPluginContext
  activate(context)
  const fixture: Fixture = {
    context, calls, scopes, reports, provided, api, bridge,
    async control(action, data, targetPrefix, reportIndex = 0) {
      const address = reports[reportIndex]?.uiControls?.find((item) =>
        targetPrefix === undefined ? item.actions.includes(action) : item.target.startsWith(targetPrefix)
      )
      if (!address) throw new Error(`No current UI control advertises ${action}.`)
      const handler = provided.get('command:quirky.editor/ui-control')
      if (!handler) throw new Error('The activated UI control handler is missing.')
      return await handler({
        surface: address.surface, target: address.target, generation: address.generation, action,
        ...(data === undefined ? {} : { data })
      })
    }
  }
  fixtures.push(fixture)
  return fixture
}

async function mountViewer(fixture: Fixture, buffer: EditorSurfaceBuffer): Promise<Mounted> {
  let report: ControlReport = {}
  let reportIndex = -1
  const scope = createEditorUiControlReportScope((value) => {
    report = value as ControlReport
    if (reportIndex < 0) {
      reportIndex = fixture.reports.length
      fixture.reports.push(report)
    } else {
      fixture.reports[reportIndex] = report
    }
  }, { surface: 'view:quirky.editor/document' })
  fixture.scopes.push(scope)
  scope.report({ mounted: true, bufferId: buffer.id, tabId: buffer.tabId, mode: buffer.mode })
  let commands: Parameters<SurfaceProps['registerCommandHandlers']>[0] | undefined
  const views: Record<string, unknown>[] = []
  let props: SurfaceProps = {
    context: fixture.context, buffer, fontSize: 13, onDraft() {}, onAction: fixture.api,
    onView(patch) { views.push(patch) },
    registerCommandHandlers(handlers) { commands = handlers; return () => { if (commands === handlers) commands = undefined } }
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(<EditorUiControlProvider scope={scope}><ViewerSurface {...props} /></EditorUiControlProvider>))
  let unmounted = false
  const surface: Mounted = {
    element,
    views,
    report: () => report,
    commands: () => commands,
    async update(buffer) {
      props = { ...props, buffer }
      await act(async () => root.render(<EditorUiControlProvider scope={scope}><ViewerSurface {...props} /></EditorUiControlProvider>))
    },
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
      scope.dispose()
    }
  }
  mounted.push(surface)
  return surface
}

async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}

function statusWith(element: HTMLElement, text: string): HTMLElement | null {
  return [...element.querySelectorAll<HTMLElement>('[role="status"]')].find((node) => node.textContent?.includes(text)) ?? null
}

function errorWith(element: HTMLElement, text: string): HTMLElement | null {
  return [...element.querySelectorAll<HTMLElement>('[role="alert"]')].find((node) => node.textContent?.includes(text)) ?? null
}

test('pending CSV metadata and page reads show accessible loading before any empty outcome', async () => {
  const metadata = deferred<unknown>()
  const page = deferred<unknown>()
  const fixture = makeFixture(async (_method, params) => {
    if (params.action === 'metadata') return metadata.promise
    if (params.action === 'page') return page.promise
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv'))
  await flush()
  expect(statusWith(surface.element, 'Loading CSV page…')).not.toBeNull()
  expect(surface.element.querySelector('.ui-empty-state')).toBeNull()

  metadata.resolve({ paged: false, rows: 0, columns: 0 })
  await flush()
  expect(statusWith(surface.element, 'Loading CSV page…')).not.toBeNull()
  expect(surface.element.querySelector('.ui-empty-state')).toBeNull()

  page.resolve({ rows: [], nextPage: null, delimiter: ',' })
  await flush()
  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No CSV rows.')
})

test('CSV distinguishes settled empty, filtered-empty and retryable page errors', async () => {
  let filtered = false
  let pageFailures = 0
  const apiCalls: { action: unknown; params: Record<string, unknown> }[] = []
  const fixture = makeFixture(async (method, params) => {
    if (method !== 'quirky.editor/viewer') return {}
    apiCalls.push({ action: params.action, params })
    if (params.action === 'metadata') return { paged: false, rows: filtered ? 1 : 0, columns: 2 }
    if (params.action === 'page') {
      if (pageFailures > 0) {
        pageFailures--
        throw new Error('fixture page failed')
      }
      return {
        rows: filtered ? [{ index: 0, cells: ['name', 'value'] }] : [],
        nextPage: null,
        delimiter: ','
      }
    }
    if (params.action === 'filter') {
      filtered = true
      return {}
    }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv'))
  await flush()

  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No CSV rows.')
  expect(surface.element.querySelector('table thead')).toBeNull()
  await routed(fixture, 'filter', { query: 'missing' })
  await flush()
  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No rows match “missing”.')
  expect(surface.element.querySelector('table thead')?.textContent).toContain('name')
  const metadataReads = apiCalls.filter(({ action }) => action === 'metadata').length

  pageFailures = 1
  await expect(routed(fixture, 'retry')).rejects.toThrow('fixture page failed')
  await flush()
  expect(errorWith(surface.element, 'fixture page failed')).not.toBeNull()
  const pageReads = apiCalls.filter(({ action }) => action === 'page').length
  await routed(fixture, 'retry')
  await flush()
  expect(apiCalls.filter(({ action }) => action === 'metadata')).toHaveLength(metadataReads)
  expect(apiCalls.filter(({ action }) => action === 'page')).toHaveLength(pageReads + 1)
  expect(apiCalls.filter(({ action }) => action === 'page').at(-1)?.params.page).toBe(0)
  expect(errorWith(surface.element, 'fixture page failed')).toBeNull()
})

test('viewer child controls are reported and dispatched by the activate-provided handler', async () => {
  const apiCalls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    apiCalls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }], nextPage: null }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv'))
  await flush()
  // bun's nested asymmetric matcher mutates its input; never hand it the live report.
  expect(structuredClone(surface.report())).toMatchObject({
    mounted: true,
    bufferId: 'b1',
    tabId: 't1',
    uiControls: expect.arrayContaining([
      expect.objectContaining({
        surface: 'view:quirky.editor/document',
        target: 'csv:[\"b1\",\"t1\"]',
        actions: expect.arrayContaining(['filter', 'save', 'add-row'])
      })
    ])
  })
  expect(await routed(fixture, 'filter', { query: 'alpha' })).toEqual({ delivered: true })
  expect(apiCalls.filter(({ action }) => action === 'filter')).toHaveLength(1)
})

test('image waits for acquisition and decode, then Retry replaces only its own live resource', async () => {
  const acquisition = deferred<unknown>()
  let mediaCalls = 0
  const fixture = makeFixture(async (_method, params) => {
    if (params.action === 'metadata') return { previewable: true, width: 24, height: 18, bytes: 64 }
    if (params.action === 'media') {
      mediaCalls++
      return mediaCalls === 1 ? acquisition.promise : { url: 'blob:second-image' }
    }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('image'))
  await flush()
  expect(statusWith(surface.element, 'Loading preview…')).not.toBeNull()
  expect(surface.element.querySelector('[role="alert"]')).toBeNull()

  acquisition.resolve({ url: 'blob:first-image' })
  await flush()
  const firstImage = surface.element.querySelector<HTMLImageElement>('img')!
  expect(statusWith(surface.element, 'Loading image…')).not.toBeNull()
  await act(async () => firstImage.dispatchEvent(new Event('error')))
  expect(errorWith(surface.element, 'Failed to load file preview.')).not.toBeNull()

  await routed(fixture, 'retry', undefined, 'viewer:')
  await flush()
  const secondImage = surface.element.querySelector<HTMLImageElement>('img')!
  expect(mediaCalls).toBe(2)
  await act(async () => firstImage.dispatchEvent(new Event('error')))
  expect(errorWith(surface.element, 'Failed to load file preview.')).toBeNull()
  await act(async () => secondImage.dispatchEvent(new Event('load')))
  expect(statusWith(surface.element, 'Loading image…')).toBeNull()
  expect(surface.element.textContent).toContain('24 × 18')
})

test('PDF loading remains pending until PDF.js resolves and reports search outcomes', async () => {
  const documentLoad = deferred<unknown>()
  let renderGate: PromiseWithResolvers<void> | null = deferred<void>()
  const pageCalls: number[] = []
  const pdfPage = (index: number): PdfFixturePage => ({
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: renderGate ? renderGate.promise : Promise.resolve(), cancel() {} }),
    async getTextContent() {
      pageCalls.push(index)
      return { items: [{ str: index === 2 ? 'a needle is here' : 'unrelated page' }] }
    }
  })
  const pdfDocument = {
    numPages: 3,
    async getPage(index: number) { return pdfPage(index) }
  }
  pdfLoader = () => ({ promise: documentLoad.promise, destroy: async () => {} })
  const apiCalls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    apiCalls.push(params)
    if (params.action === 'metadata') return { kind: 'pdf' }
    if (params.action === 'media') return { url: 'blob:pdf' }
    return {}
  })
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({}) })
  try {
    const surface = await mountViewer(fixture, makeBuffer('pdf'))
    await flush()
    expect(statusWith(surface.element, 'Loading PDF…')).not.toBeNull()
    expect(pdfRequests).toHaveLength(1)
    expect(pdfRequests[0]).toMatchObject({ rangeChunkSize: 256 * 1024, enableXfa: false })

    documentLoad.resolve(pdfDocument)
    await flush()
    expect(statusWith(surface.element, 'Loading PDF…')).not.toBeNull()
    renderGate.resolve()
    renderGate = null
    await flush()
    expect(statusWith(surface.element, 'Loading PDF…')).toBeNull()

    const result = await routed(fixture, 'find', { query: 'needle' }, 'pdf:')
    expect(result).toEqual({ delivered: true })
    await flush()
    expect(surface.element.textContent).toContain('Found on page 2 of 3.')
    expect(pageCalls).toContain(2)

    const none = await routed(fixture, 'find', { query: 'missing' }, 'pdf:')
    expect(none).toEqual({ delivered: true })
    await flush()
    expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No results')
    expect(surface.element.querySelector('canvas')).not.toBeNull()
  } finally {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: originalGetContext })
  }
})

test('PDF acquisition and search failures render InlineError with recovery controls', async () => {
  const load = deferred<unknown>()
  pdfLoader = () => ({ promise: load.promise, destroy: async () => {} })
  const fixture = makeFixture(async (_method, params) => {
    if (params.action === 'metadata') return { kind: 'pdf' }
    if (params.action === 'media') return { url: 'blob:pdf-error' }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('pdf'))
  await flush()
  load.reject(new Error('fixture PDF failed'))
  await flush()
  expect(errorWith(surface.element, 'fixture PDF failed')).not.toBeNull()
  expect(surface.element.querySelector('.ui-inline-error')).not.toBeNull()
  expect([...surface.element.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Retry')).toBe(true)
  expect([...surface.element.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Open in Default App')).toBe(true)

  await routed(fixture, 'retry', undefined, 'viewer:')
  await flush()
})

test('media retains native controls, recovers codec errors, and exposes validated element transport', async () => {
  let acquisitions = 0
  const fixture = makeFixture(async (_method, params) => {
    if (params.action === 'metadata') return { kind: 'audio', contentType: 'audio/mpeg' }
    if (params.action === 'media') {
      acquisitions++
      return { url: `blob:audio-${acquisitions}` }
    }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('audio'))
  await flush()
  const audio = surface.element.querySelector<HTMLAudioElement>('audio')!
  expect(audio.controls).toBe(true)
  expect(audio.preload).toBe('metadata')
  expect(statusWith(surface.element, 'Loading media…')).toBeNull()

  Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
  Object.defineProperty(audio, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 120 } })
  let time = 0
  Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => time, set: (value: number) => { time = value } })
  const play = mock(async () => {})
  const pause = mock(() => {})
  Object.defineProperty(audio, 'play', { configurable: true, value: play })
  Object.defineProperty(audio, 'pause', { configurable: true, value: pause })
  await act(async () => audio.dispatchEvent(new Event('loadedmetadata')))

  expect(await routed(fixture, 'play', undefined, 'media:')).toEqual({ delivered: true })
  expect(await routed(fixture, 'pause', undefined, 'media:')).toEqual({ delivered: true })
  expect(await routed(fixture, 'seek', { time: 30 }, 'media:')).toEqual({ delivered: true })
  expect(await routed(fixture, 'volume', { value: 0.4 }, 'media:')).toEqual({ delivered: true })
  expect(await routed(fixture, 'muted', { value: true }, 'media:')).toEqual({ delivered: true })
  expect(await routed(fixture, 'playback-rate', { value: 1.5 }, 'media:')).toEqual({ delivered: true })
  expect(time).toBe(30)
  expect(audio.volume).toBe(0.4)
  expect(audio.muted).toBe(true)
  expect(audio.playbackRate).toBe(1.5)
  expect(play).toHaveBeenCalledTimes(1)
  expect(pause).toHaveBeenCalledTimes(1)

  const mediaCallsBeforeInvalid = fixture.calls.filter(({ method }) => method === 'ui.window.command.run').length
  for (const [action, data] of [
    ['seek', { time: -1 }], ['seek', { time: 121 }], ['seek', { time: Number.NaN }],
    ['volume', { value: 1.1 }], ['volume', { value: '0.5' }], ['muted', { value: 'yes' }],
    ['playback-rate', { value: 0 }], ['playback-rate', { value: Infinity }], ['fullscreen', { open: true }],
    ['play', { unexpected: true }]
  ] as [string, Record<string, unknown>][]) {
    await expect(routed(fixture, action, data, 'media:')).resolves.toEqual({ delivered: false })
  }
  expect(fixture.calls.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(mediaCallsBeforeInvalid)

  await act(async () => audio.dispatchEvent(new Event('error')))
  expect(errorWith(surface.element, 'Unable to play this media file. The file may be unavailable or use an unsupported codec.')).not.toBeNull()
  await routed(fixture, 'retry', undefined, 'viewer:')
  await flush()
  expect(acquisitions).toBe(2)
  expect(errorWith(surface.element, 'Unable to play this media file.')).toBeNull()
  const replacement = surface.element.querySelector('audio')
  expect(replacement).not.toBe(audio)
  await act(async () => audio.dispatchEvent(new Event('error')))
  expect(errorWith(surface.element, 'Unable to play this media file.')).toBeNull()
})

test('Mermaid renders pending and failed states, sanitizes SVG, and enforces UTF-8 boundaries', async () => {
  const renderGate = deferred<{ svg: string }>()
  diagramRender = () => renderGate.promise
  const fixture = makeFixture(async () => ({}))
  const surface = await mountViewer(fixture, makeBuffer('mermaid'))
  await flush()
  expect(statusWith(surface.element, 'Rendering diagram…')).not.toBeNull()
  renderGate.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>attack()</script><foreignObject><div>unsafe</div></foreignObject><circle cx="1" cy="1" r="1"/></svg>' })
  await flush()
  expect(surface.element.querySelector('.viewer-mermaid__diagram script')).toBeNull()
  expect(surface.element.querySelector('.viewer-mermaid__diagram foreignObject')).toBeNull()
  expect(diagramInitializations[0]).toMatchObject({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false })

  const failedGate = deferred<{ svg: string }>()
  diagramRender = () => failedGate.promise
  const failing = await mountViewer(fixture, makeBuffer('mermaid', 'graph TD\n  X --> Y', { id: 'b2', tabId: 't2' }))
  await flush()
  failedGate.reject(new Error('fixture diagram failed'))
  await flush()
  expect(errorWith(failing.element, 'fixture diagram failed')).not.toBeNull()
  expect(failing.element.querySelector('.ui-inline-error')).not.toBeNull()
  expect([...failing.element.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Source')).toBe(true)

  const oneMiB = 'é'.repeat(512 * 1024)
  const exact = await mountViewer(fixture, makeBuffer('mermaid', oneMiB, { id: 'b3', tabId: 't3', size: oneMiB.length }))
  await flush()
  expect(errorWith(exact.element, 'Diagram source exceeds the safe rendering limit.')).toBeNull()
  expect(diagramCalls).toContain(oneMiB)
  const tooLarge = oneMiB + 'é'
  const oversized = await mountViewer(fixture, makeBuffer('mermaid', tooLarge, { id: 'b4', tabId: 't4', size: tooLarge.length }))
  await flush()
  expect(errorWith(oversized.element, 'Diagram source exceeds the safe rendering limit.')).not.toBeNull()
  expect(diagramCalls).not.toContain(tooLarge)
})

test('preview byte limit avoids acquisition while exactly 50 MiB remains eligible', async () => {
  let acquisitions = 0
  const fixture = makeFixture(async (_method, params) => {
    if (params.action === 'metadata') return { previewable: true }
    if (params.action === 'media') {
      acquisitions++
      return { url: 'blob:boundary' }
    }
    return {}
  })
  const over = await mountViewer(fixture, makeBuffer('image', '', { id: 'large', size: 50 * 1024 * 1024 + 1 }))
  await flush()
  expect(errorWith(over.element, 'File is too large to preview.')).not.toBeNull()
  expect(acquisitions).toBe(0)

  const exact = await mountViewer(fixture, makeBuffer('image', '', { id: 'boundary', tabId: 't2', size: 50 * 1024 * 1024 }))
  await flush()
  expect(errorWith(exact.element, 'File is too large to preview.')).toBeNull()
  expect(acquisitions).toBe(1)
})

test('binary and unsupported viewer outcomes use shared errors, not empty states', async () => {
  const fixture = makeFixture(async () => ({}))
  const binary = await mountViewer(fixture, makeBuffer('binary'))
  const unsupported = await mountViewer(fixture, makeBuffer('text', '', { id: 'text1', tabId: 't2' }))
  await flush()
  expect(errorWith(binary.element, 'Binary file — cannot display.')).not.toBeNull()
  expect(errorWith(unsupported.element, 'Unsupported file viewer.')).not.toBeNull()
  expect(binary.element.querySelector('.ui-empty-state')).toBeNull()
  expect(unsupported.element.querySelector('.ui-empty-state')).toBeNull()
})

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function routed(fixture: Fixture, action: string, data?: Record<string, unknown>, prefix = 'csv:', index = 0) {
  let result: unknown
  let failure: { reason: unknown } | undefined
  await act(async () => {
    try { result = await fixture.control(action, data, prefix, index) }
    catch (reason) { failure = { reason } }
  })
  if (failure) throw failure.reason
  return result
}

const CSV_ROWS = [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }]

test('CSV addressed edits, structural controls, commits and daemon TSV use source coordinates', async () => {
  const calls: Record<string, unknown>[] = []
  const writes: string[] = []
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    if (params.action === 'copy') return { text: 'alpha\t1' }
    return {}
  })
  try {
    const surface = await mountViewer(fixture, makeBuffer('csv'))
    await flush()
    for (const [action, data, expected] of [
      ['edit', { row: 1, column: 1, value: '2' }, { action: 'edit', row: 1, column: 1, value: '2' }],
      ['add-row', undefined, { action: 'insertRow', index: 2, count: 1 }],
      ['add-column', undefined, { action: 'insertColumn', index: 2, value: 'Column 3' }],
      ['delete-row', { row: 1 }, { action: 'deleteRow', row: 1 }],
      ['delete-column', { column: 1 }, { action: 'deleteColumn', index: 1 }],
      ['delimiter', { delimiter: ';' }, { action: 'delimiter', delimiter: ';' }],
      ['filter', { query: 'alpha' }, { action: 'filter', query: 'alpha' }],
      ['sort', { column: 1, order: 'desc' }, { action: 'sort', column: 1, order: 'desc' }],
      ['paste', { row: 1, column: 0, text: 'bravo\t3' }, { action: 'paste', row: 1, column: 0, text: 'bravo\t3' }],
      ['copy', { row: 1, column: 0 }, { action: 'copy', row: 1, column: 0 }],
      ['copy', { row: 1 }, { action: 'copy', row: 1 }],
      ['copy', { column: 1 }, { action: 'copy', column: 1 }],
      ['copy-range', { row: 0, column: 0, endRow: 1, endColumn: 1 }, { action: 'copy', row: 0, column: 0, endRow: 1, endColumn: 1 }]
    ] as [string, Record<string, unknown> | undefined, Record<string, unknown>][]) {
      expect(await routed(fixture, action, data)).toEqual({ delivered: true })
      expect(calls).toContainEqual({ bufferId: 'b1', ...expected })
    }
    expect(writes).toEqual(['alpha\t1', 'alpha\t1', 'alpha\t1', 'alpha\t1'])
    const before = calls.filter(({ action }) => action === 'edit').length
    const cell = surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')!
    await inputValue(cell, '3')
    expect(calls.filter(({ action }) => action === 'edit')).toHaveLength(before)
    await act(async () => cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()
    expect(calls.filter(({ action }) => action === 'edit')).toHaveLength(before + 1)
    expect(calls).toContainEqual({ bufferId: 'b1', action: 'edit', row: 1, column: 1, value: '3' })
    expect(fixture.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)?.params).toMatchObject({ connId: 22, id: 'command:quirky.editor/ui-control' })
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('CSV Save waits for one pending blur edit and retains a failed unapplied draft', async () => {
  const gate = deferred<unknown>()
  const calls: Record<string, unknown>[] = []
  let fail = true
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    if (params.action === 'edit' && fail) return gate.promise
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv'))
  await flush()
  const cell = surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')!
  await inputValue(cell, '2')
  let save!: Promise<unknown>
  await act(async () => {
    cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    save = fixture.control('save', undefined, 'csv:')
  })
  expect(calls.filter(({ action }) => action === 'edit')).toHaveLength(1)
  expect(calls.some(({ action }) => action === 'save')).toBe(false)
  await act(async () => { gate.reject(new Error('fixture edit failed')); await expect(save).rejects.toThrow('fixture edit failed') })
  await flush()
  expect(surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')?.value).toBe('2')
  expect(errorWith(surface.element, 'fixture edit failed')).not.toBeNull()
  fail = false
  expect(await routed(fixture, 'save')).toEqual({ delivered: true })
  expect(calls.filter(({ action }) => action === 'edit')).toHaveLength(2)
  expect(calls.filter(({ action }) => action === 'save')).toHaveLength(1)
})

test('CSV rejects malformed data without calls and enforces query and UTF-8 paste limits', async () => {
  const calls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv'))
  await flush()
  for (const [action, data] of [
    ['edit', { row: -1, column: 0, value: 'x' }], ['edit', { row: 1, column: 0.1, value: 'x' }],
    ['edit', { row: 1, column: 0, value: 2 }], ['delete-row', { row: Infinity }],
    ['delete-column', { column: Number.MAX_SAFE_INTEGER + 1 }], ['sort', { column: 0, order: 'up' }],
    ['filter', { query: 'x'.repeat(8193) }], ['filter', { query: 'x', bufferId: 'other' }],
    ['delimiter', { delimiter: ':' }], ['copy', { endRow: 1 }], ['copy-range', { row: 0, column: 0 }],
    ['copy', { row: 1, column: 1, endRow: 0, endColumn: 0 }], ['paste', { row: 0, column: 0, text: 'é'.repeat(512 * 1024) }],
    ['save', { unknown: true }]
  ] as [string, Record<string, unknown>][]) {
    const before = calls.length
    const text = surface.element.textContent
    expect(await routed(fixture, action, data)).toEqual({ delivered: false })
    expect(calls).toHaveLength(before)
    expect(surface.element.textContent).toBe(text)
  }
  expect(await routed(fixture, 'filter', { query: 'x'.repeat(8192) })).toEqual({ delivered: true })
  expect(await routed(fixture, 'paste', { row: 0, column: 0, text: 'é'.repeat(512 * 1024 - 1) + 'x' })).toEqual({ delivered: true })
})

test('paged CSV retains bounded paging, precise empty-page state and ordered Reload', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let changed = false
  const fixture = makeFixture(async (method, params) => {
    calls.push({ method, params })
    if (params.action === 'metadata') return { paged: true, rows: null, columns: 2 }
    if (method === 'quirky.editor/view' && params.action === 'reload') { changed = false; return {} }
    if (params.action === 'page') return changed ? { changedOnDisk: true, rows: CSV_ROWS, nextPage: 9 }
      : { rows: params.page === 0 ? CSV_ROWS : [], nextPage: params.page === 0 ? 1 : 2, offset: Number(params.page) * 99 }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv', '', { size: 1024 * 1024 }))
  await flush()
  expect(await routed(fixture, 'next-page')).toEqual({ delivered: true })
  expect(calls).toContainEqual({ method: 'quirky.editor/viewer', params: { bufferId: 'b1', action: 'page', page: 1 } })
  expect(calls).toContainEqual({ method: 'quirky.editor/viewer', params: { bufferId: 'b1', action: 'position', page: 2, offset: 99 } })
  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No rows on this page.')
  expect([...surface.element.querySelectorAll('button')].find((button) => button.textContent === 'Next page')?.disabled).toBe(false)
  expect(await routed(fixture, 'previous-page')).toEqual({ delivered: true })
  const before = calls.length
  for (const action of ['save', 'add-row', 'add-column', 'sort', 'copy', 'paste']) expect(await routed(fixture, action, { row: 1, column: 0 })).toEqual({ delivered: false })
  expect(calls).toHaveLength(before)
  await expect(surface.commands()!.find!({ query: 'alpha' })).rejects.toThrow('Find is unavailable in read-only paged CSV previews.')
  changed = true
  await routed(fixture, 'retry')
  expect(surface.element.querySelector('tbody')?.textContent).not.toContain('alpha')
  expect(surface.element.textContent).toContain('CSV changed on disk.')
  const start = calls.length
  expect(await routed(fixture, 'reload')).toEqual({ delivered: true })
  expect(calls.slice(start)[0]).toEqual({ method: 'quirky.editor/view', params: { bufferId: 'b1', action: 'reload' } })
  expect(calls.slice(start)).toContainEqual({ method: 'quirky.editor/viewer', params: { bufferId: 'b1', action: 'page', page: 0 } })
})

test('tab-scoped viewer addresses reject stale remounts, modes and disposed generations', async () => {
  const calls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    return {}
  })
  const buffer = makeBuffer('csv')
  const first = await mountViewer(fixture, buffer)
  const second = await mountViewer(fixture, { ...buffer, tabId: 't2' })
  await flush()
  const address = first.report().uiControls!.find(({ target }) => target.startsWith('csv:'))!
  const other = second.report().uiControls!.find(({ target }) => target.startsWith('csv:'))!
  expect(address.target).not.toBe(other.target)
  await inputValue(first.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')!, 'pending-cell')
  await first.update({ ...buffer, revision: 2, contentRevision: 2, draft: 'acknowledged draft' })
  await flush()
  expect(first.report().uiControls!.find(({ target }) => target === address.target)?.generation).toBe(address.generation)
  expect(first.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')?.value).toBe('pending-cell')
  const handler = fixture.provided.get('command:quirky.editor/ui-control')!
  const stale = { ...address, actions: undefined, action: 'filter', data: { query: 'old' } }
  const request = { surface: address.surface, target: address.target, generation: address.generation, action: 'filter', data: { query: 'old' } }
  await first.update({ ...buffer, mode: 'source' })
  let before = calls.length
  expect(await handler(request)).toEqual({ delivered: false })
  expect(calls).toHaveLength(before)
  await first.update(buffer)
  await flush()
  expect(first.report().uiControls!.find(({ target }) => target === address.target)?.generation).not.toBe(address.generation)
  await first.unmount()
  before = calls.length
  expect(await handler(request)).toEqual({ delivered: false })
  expect(await handler({ ...request, target: 'unknown' })).toEqual({ delivered: false })
  expect(await handler(stale)).toEqual({ delivered: false })
  expect(calls).toHaveLength(before)
})

test.each([
  [{ self: {} }, 'The daemon did not identify this window.'],
  [{ error: 'fixture bridge failed' }, 'fixture bridge failed'],
  [{ reply: {} }, 'The editor control bridge returned an invalid response.'],
  [{ reply: { result: { delivered: false } } }, 'The editor control is no longer available.']
] as [Fixture['bridge'], string][])('viewer pointer bridge failure %j has no local mutation fallback', async (bridge, message) => {
  const calls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('csv'))
  await flush()
  await inputValue(surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')!, 'draft')
  Object.assign(fixture.bridge, bridge)
  const before = calls.length
  const button = [...surface.element.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Save')!
  await act(async () => button.click())
  await flush()
  expect(calls).toHaveLength(before)
  expect(surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')?.value).toBe('draft')
  expect(errorWith(surface.element, message)).not.toBeNull()
})

test('a newer CSV filter wins over a delayed read and replacement Save cannot write the next document', async () => {
  const delayedPage = deferred<unknown>()
  const delayedSave = deferred<unknown>()
  let filter = ''
  const calls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'filter') { filter = String(params.query); return {} }
    if (params.action === 'save') return delayedSave.promise
    if (params.action === 'page') return filter === 'old' ? delayedPage.promise
      : { rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: [filter || 'alpha', '1'] }], nextPage: null }
    return {}
  })
  const buffer = makeBuffer('csv')
  const surface = await mountViewer(fixture, buffer)
  await flush()
  let old!: Promise<unknown>
  let newer!: Promise<unknown>
  try {
    await act(async () => { old = fixture.control('filter', { query: 'old' }, 'csv:') })
    await flush()
    await act(async () => { newer = fixture.control('filter', { query: 'new' }, 'csv:') })
    await flush()
    expect(surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 1"]')?.value).toBe('new')
    await act(async () => {
      delayedPage.resolve({ rows: [{ index: 1, cells: ['obsolete', '9'] }], nextPage: null })
      expect(await newer).toEqual({ delivered: true })
      await old
    })
    await flush()
    expect(surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 1"]')?.value).toBe('new')
    let save!: Promise<unknown>
    await act(async () => { save = fixture.control('save', undefined, 'csv:') })
    await surface.update({ ...buffer, id: 'replacement', tabId: 'new-tab', path: '/tmp/viewer-worktree/other.csv', relativePath: 'other.csv' })
    await flush()
    const before = calls.length
    await act(async () => { delayedSave.resolve({}); await save })
    await flush()
    expect(calls).toHaveLength(before)
    expect(surface.element.querySelector('[role="alert"]')).toBeNull()
  } finally {
    delayedPage.resolve({ rows: [], nextPage: null })
    delayedSave.resolve({})
    await Promise.allSettled([old, newer])
  }
})

test('pending CSV cells block copy and clipboard failure is rendered once at its live origin', async () => {
  const calls: Record<string, unknown>[] = []
  const writes = mock(async () => { throw new Error('fixture clipboard failed') })
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writes } })
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    if (params.action === 'copy') return { text: 'alpha\t1' }
    return {}
  })
  try {
    const surface = await mountViewer(fixture, makeBuffer('csv'))
    await flush()
    await inputValue(surface.element.querySelector<HTMLInputElement>('[aria-label="Row 2, column 2"]')!, 'draft')
    const before = calls.length
    await expect(routed(fixture, 'copy', { row: 1 })).rejects.toThrow('Apply or save pending cell edits before copying.')
    expect(calls).toHaveLength(before)
    expect(writes).not.toHaveBeenCalled()
    await routed(fixture, 'save')
    await expect(routed(fixture, 'copy', { row: 1 })).rejects.toThrow('fixture clipboard failed')
    await flush()
    expect([...surface.element.querySelectorAll('.ui-inline-error')].filter((node) => node.textContent?.includes('fixture clipboard failed'))).toHaveLength(1)
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('two image acquisitions retain independent leases and a late disposed acquisition releases its original lease', async () => {
  const late = deferred<unknown>()
  const calls: Record<string, unknown>[] = []
  let acquireCount = 0
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { previewable: true }
    if (params.action === 'media') return ++acquireCount === 3 ? late.promise : { url: `blob:image-${acquireCount}` }
    return {}
  })
  const first = await mountViewer(fixture, makeBuffer('image'))
  const second = await mountViewer(fixture, makeBuffer('image', '', { tabId: 't2' }))
  await flush()
  const leases = calls.filter(({ action }) => action === 'media')
  expect(leases).toHaveLength(2)
  expect(first.report().uiControls!.some(({ target }) => target.startsWith('viewer:'))).toBe(true)
  await routed(fixture, 'retry', undefined, 'viewer:', 0)
  await flush()
  const third = calls.filter(({ action }) => action === 'media')[2]!
  await first.unmount()
  await act(async () => late.resolve({ url: 'blob:late' }))
  await flush()
  const released = calls.filter(({ action }) => action === 'release')
  expect(released).toContainEqual({ bufferId: 'b1', action: 'release', leaseId: leases[0]!.leaseId })
  expect(released).toContainEqual({ bufferId: 'b1', action: 'release', leaseId: third.leaseId })
  expect(released.some(({ leaseId }) => leaseId === leases[1]!.leaseId)).toBe(false)
  expect(second.element.querySelector('img')?.getAttribute('src')).toBe('blob:image-2')
})

test('image addressed zoom clamps, rejects invalid payloads and keeps active-document return contracts', async () => {
  const calls: Record<string, unknown>[] = []
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { previewable: true, zoom: 1 }
    if (params.action === 'media') return { url: 'blob:zoom' }
    if (params.action === 'zoom') return { zoom: Math.min(8, Math.max(0.25, Number(params.scale))) }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('image'))
  await flush()
  await act(async () => surface.element.querySelector('img')!.dispatchEvent(new Event('load')))
  expect(await routed(fixture, 'zoom-in', undefined, 'image:')).toEqual({ delivered: true })
  expect(calls.at(-1)).toMatchObject({ action: 'zoom', scale: 1.25 })
  expect(await routed(fixture, 'reset-zoom', undefined, 'image:')).toEqual({ delivered: true })
  expect(calls.at(-1)).toMatchObject({ action: 'zoom', scale: 1 })
  expect(await routed(fixture, 'zoom', { scale: 100 }, 'image:')).toEqual({ delivered: true })
  expect(surface.element.textContent).toContain('800%')
  const before = calls.length
  expect(await routed(fixture, 'zoom', { scale: Infinity }, 'image:')).toEqual({ delivered: false })
  expect(await routed(fixture, 'zoom', { scale: 1, url: 'other' }, 'image:')).toEqual({ delivered: false })
  expect(calls).toHaveLength(before)
  await act(async () => { expect(await surface.commands()!['reset-zoom']!()).toEqual({ zoom: 1 }) })
  const image = surface.element.querySelector('section[aria-label="Image preview"]')!
  const wheel = new WheelEvent('wheel', { bubbles: true, deltaY: -1 })
  Object.defineProperty(wheel, 'ctrlKey', { value: true })
  await act(async () => image.dispatchEvent(wheel))
  await flush()
  expect(calls.at(-1)).toMatchObject({ action: 'zoom', scale: 1.25 })
})

test('video fullscreen and browser transport refusal affect only the captured native element', async () => {
  const fixture = makeFixture(async (method, params) => {
    if (method === 'quirky.terminal/openExternal') throw new Error('fixture open failed')
    if (params.action === 'metadata') return { kind: 'video' }
    if (params.action === 'media') return { url: 'blob:video' }
    return {}
  })
  const surface = await mountViewer(fixture, makeBuffer('video'))
  await flush()
  const video = surface.element.querySelector('video')!
  let full: Element | null = null
  const originalFull = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
  const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')
  const enter = mock(async () => { full = video })
  const exit = mock(async () => { full = null })
  Object.defineProperty(video, 'requestFullscreen', { configurable: true, value: enter })
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  Object.defineProperty(video, 'play', { configurable: true, value: async () => { throw new Error('fixture autoplay denied') } })
  try {
    expect(await routed(fixture, 'fullscreen', { open: true }, 'media:')).toEqual({ delivered: true })
    expect(document.fullscreenElement).toBe(video)
    expect(await routed(fixture, 'fullscreen', { open: false }, 'media:')).toEqual({ delivered: true })
    expect(full).toBeNull()
    expect(enter).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    await expect(routed(fixture, 'play', undefined, 'media:')).rejects.toThrow('fixture autoplay denied')
    expect(errorWith(surface.element, 'fixture autoplay denied')).not.toBeNull()
    await expect(routed(fixture, 'open-default', undefined, 'viewer:')).rejects.toThrow('fixture open failed')
    expect([...surface.element.querySelectorAll('.ui-inline-error')].filter((node) => node.textContent?.includes('fixture open failed'))).toHaveLength(1)
    expect(surface.report().uiControls!.find(({ target }) => target.startsWith('viewer:'))?.actions).toContain('retry')
  } finally {
    if (originalFull) Object.defineProperty(document, 'fullscreenElement', originalFull)
    else Reflect.deleteProperty(document, 'fullscreenElement')
    if (originalExit) Object.defineProperty(document, 'exitFullscreen', originalExit)
    else Reflect.deleteProperty(document, 'exitFullscreen')
  }
})

test('PDF addressed page, zoom and Find preserve active-command results and reject invalid inputs', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const pdf = { numPages: 3, async getPage(index: number) {
    return { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      getTextContent: async () => ({ items: [{ str: index === 2 ? 'needle' : 'none' }] }) }
  } }
  pdfLoader = () => ({ promise: Promise.resolve(pdf), destroy: async () => {} })
  const fixture = makeFixture(async (method, params) => {
    calls.push({ method, params })
    if (params.action === 'metadata') return { kind: 'pdf' }
    if (params.action === 'media') return { url: 'blob:pdf-contract' }
    return {}
  })
  const getContext = HTMLCanvasElement.prototype.getContext
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({}) })
  try {
    const surface = await mountViewer(fixture, makeBuffer('pdf'))
    await flush()
    const before = calls.length
    expect(await routed(fixture, 'previous-page', undefined, 'pdf:')).toEqual({ delivered: false })
    for (const [action, data] of [['page', { page: 0 }], ['page', { page: 4 }], ['page', { page: 1.2 }], ['zoom', { scale: NaN }], ['find', { query: 'x'.repeat(8193) }]] as [string, Record<string, unknown>][]) {
      expect(await routed(fixture, action, data, 'pdf:')).toEqual({ delivered: false })
    }
    expect(calls).toHaveLength(before)
    expect(await routed(fixture, 'next-page', undefined, 'pdf:')).toEqual({ delivered: true })
    expect(calls).toContainEqual({ method: 'quirky.editor/viewer', params: { bufferId: 'b1', action: 'page', page: 2 } })
    expect(await routed(fixture, 'zoom', { scale: 100 }, 'pdf:')).toEqual({ delivered: true })
    expect(calls).toContainEqual({ method: 'quirky.editor/viewer', params: { bufferId: 'b1', action: 'zoom', scale: 5 } })
    expect(await routed(fixture, 'reset-zoom', undefined, 'pdf:')).toEqual({ delivered: true })
    expect(calls).toContainEqual({ method: 'quirky.editor/view', params: { bufferId: 'b1', action: 'update', patch: { viewer: { zoom: 'page-width' } } } })
    await act(async () => { expect(await surface.commands()!.find!({ query: '' })).toEqual({ opened: true }) })
    await act(async () => { expect(await surface.commands()!.find!({ query: 'needle' })).toEqual({ found: true, page: 2, totalPages: 3 }) })
    await expect(routed(fixture, 'find', { query: '' }, 'pdf:')).rejects.toThrow('Enter text to find in the PDF.')
    expect(errorWith(surface.element, 'Enter text to find in the PDF.')).not.toBeNull()
  } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: getContext }) }
})

test('newer PDF search and resource replacement suppress obsolete page and error effects', async () => {
  const oldText = deferred<{ items: { str: string }[] }>()
  let textCalls = 0
  let destroyed = 0
  let cancelled = 0
  const calls: Record<string, unknown>[] = []
  const pdf = { numPages: 3, async getPage(index: number) {
    return { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel() { cancelled++ } }),
      getTextContent: async () => ++textCalls === 1 ? oldText.promise : { items: [{ str: index === 2 ? 'needle' : 'none' }] } }
  } }
  pdfLoader = () => ({ promise: Promise.resolve(pdf), destroy: async () => { destroyed++ } })
  const fixture = makeFixture(async (_method, params) => {
    calls.push(params)
    if (params.action === 'metadata') return { kind: 'pdf' }
    if (params.action === 'media') return { url: `blob:${params.bufferId}` }
    return {}
  })
  const getContext = HTMLCanvasElement.prototype.getContext
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({}) })
  try {
    const buffer = makeBuffer('pdf')
    const surface = await mountViewer(fixture, buffer)
    await flush()
    let old!: Promise<unknown>
    await act(async () => { old = fixture.control('find', { query: 'old' }, 'pdf:') })
    await flush()
    expect(await routed(fixture, 'find', { query: 'needle' }, 'pdf:')).toEqual({ delivered: true })
    await act(async () => { oldText.resolve({ items: [{ str: 'old' }] }); await old })
    await flush()
    expect(surface.element.textContent).toContain('Found on page 2 of 3.')
    expect(calls.filter(({ action }) => action === 'page').at(-1)?.page).toBe(2)
    await surface.update({ ...buffer, id: 'replacement', path: '/tmp/other.pdf', tabId: 't2' })
    await flush()
    expect(destroyed).toBeGreaterThan(0)
    expect(cancelled).toBeGreaterThan(0)
    expect(surface.element.textContent).not.toContain('Found on page 2 of 3.')
  } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: getContext }) }
})

test('an unmounted CSV copy cannot write late daemon text to the clipboard', async () => {
  const copied = deferred<unknown>()
  const writes = mock(async (_text: string) => {})
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writes } })
  const fixture = makeFixture(async (_method, params) => {
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: CSV_ROWS, nextPage: null }
    if (params.action === 'copy') return copied.promise
    return {}
  })
  let operation: Promise<unknown> | undefined
  try {
    const surface = await mountViewer(fixture, makeBuffer('csv'))
    await flush()
    expect(surface.report().uiControls!.find(({ target }) => target.startsWith('csv:'))?.actions).toContain('copy')
    await act(async () => { operation = fixture.control('copy', { row: 1 }, 'csv:') })
    await surface.unmount()
    await act(async () => { copied.resolve({ text: 'late secret' }); await operation })
    expect(writes).not.toHaveBeenCalled()
  } finally {
    copied.resolve({ text: 'late secret' })
    await Promise.allSettled([operation])
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
