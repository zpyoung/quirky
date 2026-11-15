import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer } from '../src/types'
import type { ChangesSurfaceProps } from '../src/window/ChangesSurface'
import {
  EDITOR_UI_CONTROL_COMMAND,
  EditorUiControlProvider,
  createEditorUiControlReportScope,
  type EditorUiControlAddress
} from '../src/window/uiControl'

const WORKTREE = 'wt-editor-changes'
type KeptSubscription = {
  listener: (event: { type: string; data?: unknown; worktreeId?: string }) => void | Promise<void>
  options?: { worktreeId?: string | null }
}
type ControlHandler = (args?: unknown) => Promise<{ delivered: boolean }> | { delivered: boolean }
type ActivatePlugin = (context: UiPluginContext) => void
type DeactivatePlugin = () => void
type ControlReport = { bufferId?: string; uiControls?: EditorUiControlAddress[]; [key: string]: unknown }
type Mounted = {
  element: HTMLElement
  isResourceLive(url: string): boolean
  liveResourceCount(): number
  pendingLeaseIds(): string[]
  pendingDiffCalls(): number[]
  resolvePending(leaseId: string): void
  resolveDiff(call: number): void
  controls(): EditorUiControlAddress[]
  report(): ControlReport
  bridgeCalls(): { method: string; params: Record<string, unknown> }[]
  invoke(address: EditorUiControlAddress, action: string, data?: Record<string, unknown>): Promise<{ delivered: boolean }>
  dispatch(address: EditorUiControlAddress, action: string, data?: Record<string, unknown>): Promise<{ delivered: boolean }>
  subscriptions: KeptSubscription[]
  diffCallCount(): number
  update(buffer: EditorSurfaceBuffer): Promise<void>
  unmount(): Promise<void>
}
type FixtureOptions = {
  deferFirstRender?: boolean
  malformedResponse?: boolean
  onDraft?: (content: string) => void
  tabId?: string | null
  deferDiffCalls?: number[]
  diffErrors?: string[]
  diffByPath?: Record<string, { original: string; modified: string }>
  previewMismatch?: 'worktree' | 'path'
  previewError?: string
  bridgeError?: string
}

let createRoot: (container: HTMLElement) => Root
let ChangesSurface: ComponentType<ChangesSurfaceProps>
let activatePlugin: ActivatePlugin
let deactivatePlugin: DeactivatePlugin
let activatedControlHandler: ControlHandler | undefined
let mounted: Mounted[]

beforeAll(async () => {
  // SourceEditor and CodeMirror inspect window at module initialization; load them after Happy DOM.
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ activate: activatePlugin, deactivate: deactivatePlugin } = await import('../src/ui'))
  ;({ ChangesSurface } = await import('../src/window/ChangesSurface'))
  const provided = new Map<string, ControlHandler>()
  const activationContext = {
    pluginId: 'quirky.editor',
    async call() { return {} },
    provide(id: string, handler: unknown) {
      if (typeof handler !== 'function') throw new Error(`Missing activated handler for ${id}.`)
      provided.set(id, handler as ControlHandler)
    },
    subscribe() { return () => {} },
    getSetting() { return 300 },
    getLayout() { return {} },
    async executeCommand() {},
    toast() {}
  } as unknown as UiPluginContext
  activatePlugin(activationContext)
  activatedControlHandler = provided.get(EDITOR_UI_CONTROL_COMMAND)
  if (!activatedControlHandler) throw new Error('The editor control command was not provided by activate.')
})
afterAll(async () => {
  deactivatePlugin()
  await GlobalRegistrator.unregister()
})
beforeEach(() => { mounted = [] })
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  document.body.innerHTML = ''
})

function makeBuffer(kind: 'text' | 'markdown', content: string, draft: string | null): EditorSurfaceBuffer {
  return {
    id: 'buffer-changes',
    worktreeId: WORKTREE,
    root: '/tmp/changes-worktree',
    path: `/tmp/changes-worktree/${kind === 'markdown' ? 'README.md' : 'src/app.ts'}`,
    relativePath: kind === 'markdown' ? 'README.md' : 'src/app.ts',
    name: kind === 'markdown' ? 'README.md' : 'app.ts',
    kind,
    content,
    draft,
    baseline: 'content-baseline',
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: draft !== null,
    external: null,
    mode: 'source',
    tabId: 'tab-changes',
    preview: false,
    pinned: false,
    untitled: false,
    revision: 2,
    contentRevision: draft === null ? 1 : 2,
    view: {},
    error: null,
    diskContentLength: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function renderChanges(
  buffer: EditorSurfaceBuffer,
  diff?: { original: string; modified: string },
  options: FixtureOptions = {}
): Promise<Mounted> {
  const subscriptions: KeptSubscription[] = []
  const bridgeRequests: { method: string; params: Record<string, unknown> }[] = []
  let report: ControlReport = {}
  let diffCalls = 0
  const activeLeases = new Set<string>()
  const resources = new Map<string, string>()
  const pending = new Map<string, () => void>()
  const pendingDiffs = new Map<number, () => void>()
  let renders = 0
  function resourceUrl(leaseId: string): string {
    return `https://images.invalid/${leaseId}`
  }
  function response(leaseId: string, text: string, worktreeId: string, path: string): Record<string, unknown> {
    const heading = text.split(/\r?\n/, 1)[0]?.replace(/^#\s*/, '') ?? ''
    return {
      leaseId: options.malformedResponse ? `${leaseId}-wrong` : leaseId,
      worktreeId: options.previewMismatch === 'worktree' ? `${worktreeId}-wrong` : worktreeId,
      path: options.previewMismatch === 'path' ? `${path}.wrong` : path,
      html: `<article><h1>${heading}</h1><img src="${resourceUrl(leaseId)}" alt="Preview image"></article>`
    }
  }
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'ui.window.self' || method === 'ui.window.command.run') {
        bridgeRequests.push({ method, params })
        if (options.bridgeError && method === 'ui.window.command.run') throw new Error(options.bridgeError)
        if (method === 'ui.window.self') return { connId: 22 }
        const handler = activatedControlHandler
        if (!handler) throw new Error('The activated editor control handler is unavailable.')
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.git/diff') {
        diffCalls += 1
        const currentPath = typeof params.path === 'string' ? params.path : buffer.relativePath
        const currentWorktree = typeof params.worktree === 'string' ? params.worktree.replace(/^id:/, '') : buffer.worktreeId
        const pathDiff = options.diffByPath?.[currentPath] ?? diff
        const value = {
          path: currentPath,
          source: 'unstaged',
          staged: false,
          original: pathDiff?.original ?? 'HEAD version\n',
          modified: pathDiff?.modified ?? 'Index version\n',
          binary: false,
          kind: 'text',
          modifiedHash: 'working-hash',
          modifiedDeleted: false,
          worktreeId: currentWorktree
        }
        const error = options.diffErrors?.[diffCalls - 1]
        if (error) throw new Error(error)
        if (options.deferDiffCalls?.includes(diffCalls)) {
          const deferred = Promise.withResolvers<Record<string, unknown>>()
          pendingDiffs.set(diffCalls, () => deferred.resolve(value))
          return deferred.promise
        }
        return value
      }
      if (method === 'quirky.editor/markdownPreview') {
        const leaseId = typeof params.leaseId === 'string' ? params.leaseId : ''
        if (params.action === 'render') {
          activeLeases.add(leaseId)
          if (options.previewError) throw new Error(options.previewError)
          const path = typeof params.path === 'string' ? params.path : buffer.relativePath
          const worktree = typeof params.worktree === 'string' ? params.worktree.replace(/^id:/, '') : buffer.worktreeId
          const value = response(leaseId, typeof params.text === 'string' ? params.text : '', worktree, path)
          const finish = () => {
            if (activeLeases.has(leaseId)) resources.set(resourceUrl(leaseId), leaseId)
            return value
          }
          if (options.deferFirstRender && renders === 0) {
            renders += 1
            const deferred = Promise.withResolvers<Record<string, unknown>>()
            pending.set(leaseId, () => deferred.resolve(finish()))
            return deferred.promise
          }
          renders += 1
          return finish()
        }
        if (params.action === 'release') {
          const released = activeLeases.delete(leaseId)
          for (const [url, owner] of resources) if (owner === leaseId) resources.delete(url)
          return { leaseId, released }
        }
      }
      return {}
    },
    subscribe(listener: KeptSubscription['listener'], options?: KeptSubscription['options']) {
      subscriptions.push({ listener, options })
      return () => {}
    },
    setContext() {},
    toast() {}
  } as unknown as UiPluginContext
  const props: ChangesSurfaceProps = {
    context,
    buffer,
    tabId: options.tabId ?? buffer.tabId,
    fontSize: 13,
    fontFamily: 'monospace',
    wrap: true,
    minimap: false,
    onDraft(content) { options.onDraft?.(content) },
    flushDraft: async () => {},
    onView() {},
    onEditorFocus() {},
    onSearchInFiles() {},
    error: null,
    onError() {},
    registerCommandHandlers: () => () => {}
  }
  const reportScope = createEditorUiControlReportScope((value) => {
    report = value as ControlReport
  }, { surface: 'view:quirky.editor/document' })
  reportScope.report({ bufferId: buffer.id, fixtureMarker: 'preserved' })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const render = (nextBuffer: EditorSurfaceBuffer) => (
    <EditorUiControlProvider scope={reportScope}>
      <ChangesSurface {...props} buffer={nextBuffer} tabId={options.tabId ?? nextBuffer.tabId} />
    </EditorUiControlProvider>
  )
  await act(async () => root.render(render(buffer)))
  let unmounted = false
  const surface: Mounted = {
    subscriptions,
    diffCallCount: () => diffCalls,
    element,
    isResourceLive: (url) => resources.has(url),
    liveResourceCount: () => resources.size,
    pendingLeaseIds: () => [...pending.keys()],
    pendingDiffCalls: () => [...pendingDiffs.keys()],
    resolvePending(leaseId) {
      const resolve = pending.get(leaseId)
      if (!resolve) throw new Error(`No pending preview render for ${leaseId}.`)
      pending.delete(leaseId)
      resolve()
    },
    resolveDiff(call) {
      const resolve = pendingDiffs.get(call)
      if (!resolve) throw new Error(`No pending diff request ${call}.`)
      pendingDiffs.delete(call)
      resolve()
    },
    controls: () => report.uiControls ?? [],
    report: () => report,
    bridgeCalls: () => [...bridgeRequests],
    async invoke(address, action, data) {
      const handler = activatedControlHandler
      if (!handler) throw new Error('The activated editor control handler is unavailable.')
      return await handler({
        surface: address.surface,
        target: address.target,
        generation: address.generation,
        action,
        ...(data === undefined ? {} : { data })
      })
    },
    async dispatch(address, action, data) {
      let result: { delivered: boolean } = { delivered: false }
      await act(async () => { result = await surface.invoke(address, action, data) })
      return result
    },
    async update(nextBuffer) {
      await act(async () => root.render(render(nextBuffer)))
    },
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
      reportScope.dispose()
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
type InlineRowExpectation = { kind: 'context' | 'added' | 'removed'; text: string }

function inlineRows(element: HTMLElement): InlineRowExpectation[] {
  return [...element.querySelectorAll<HTMLElement>('.qe-changes-inline-row')].map((row) => {
    const kind = row.classList.contains('added') ? 'added' : row.classList.contains('removed') ? 'removed' : 'context'
    const text = row.querySelector('code')?.textContent ?? ''
    return { kind, text: text === ' ' ? '' : text }
  })
}

test('Changes compares HEAD to the shared draft, not staged content, in the same editable tab', async () => {
  const surface = await renderChanges(makeBuffer('text', 'Working file\n', 'Shared draft\n'), {
    original: 'Committed HEAD\n',
    modified: 'Staged index\n'
  })
  await flush()
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).toContain('Committed HEAD')
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).not.toContain('Staged index')
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain('Shared draft')
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).not.toContain('Staged index')
  expect(surface.element.querySelector('[aria-pressed="true"][aria-label="Side by side"]')).not.toBeNull()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
  await flush()
  expect(surface.element.querySelector('.qe-changes-inline')).not.toBeNull()
  const rows = inlineRows(surface.element)
  expect(rows).toEqual([
    { kind: 'removed', text: 'Committed HEAD' },
    { kind: 'added', text: 'Shared draft' }
  ])
  expect(surface.element.querySelector('[aria-label="Next change"]')).not.toBeNull()
})

test.each([
  {
    name: 'mid-word insertion',
    original: 'keep\ncolor\nend\n',
    modified: 'keep\ncolXor\nend\n',
    rows: [
      { kind: 'context', text: 'keep' },
      { kind: 'removed', text: 'color' },
      { kind: 'added', text: 'colXor' },
      { kind: 'context', text: 'end' }
    ]
  },
  {
    name: 'mid-line deletion',
    original: 'keep\ncolor\nend\n',
    modified: 'keep\ncolo\nend\n',
    rows: [
      { kind: 'context', text: 'keep' },
      { kind: 'removed', text: 'color' },
      { kind: 'added', text: 'colo' },
      { kind: 'context', text: 'end' }
    ]
  },
  {
    name: 'mid-line replacement',
    original: 'keep\nold value\nend\n',
    modified: 'keep\nnew value\nend\n',
    rows: [
      { kind: 'context', text: 'keep' },
      { kind: 'removed', text: 'old value' },
      { kind: 'added', text: 'new value' },
      { kind: 'context', text: 'end' }
    ]
  },
  {
    name: 'newline insertion',
    original: 'beforeafter\nnext\n',
    modified: 'before\nafter\nnext\n',
    rows: [
      { kind: 'removed', text: 'beforeafter' },
      { kind: 'added', text: 'before' },
      { kind: 'added', text: 'after' },
      { kind: 'context', text: 'next' }
    ]
  },
  {
    name: 'newline deletion',
    original: 'before\nafter\nnext\n',
    modified: 'beforeafter\nnext\n',
    rows: [
      { kind: 'removed', text: 'before' },
      { kind: 'removed', text: 'after' },
      { kind: 'added', text: 'beforeafter' },
      { kind: 'context', text: 'next' }
    ]
  },
  {
    name: 'whole-line addition',
    original: 'first\nlast\n',
    modified: 'first\nadded\nlast\n',
    rows: [
      { kind: 'context', text: 'first' },
      { kind: 'added', text: 'added' },
      { kind: 'context', text: 'last' }
    ]
  },
  {
    name: 'whole-line deletion',
    original: 'first\nremoved\nlast\n',
    modified: 'first\nlast\n',
    rows: [
      { kind: 'context', text: 'first' },
      { kind: 'removed', text: 'removed' },
      { kind: 'context', text: 'last' }
    ]
  },
  {
    name: 'multiline addition in one operation',
    original: '',
    modified: 'added\nsecond\n',
    rows: [
      { kind: 'added', text: 'added' },
      { kind: 'added', text: 'second' }
    ]
  },
  {
    name: 'multiline deletion in one operation',
    original: 'removed\nsecond\n',
    modified: '',
    rows: [
      { kind: 'removed', text: 'removed' },
      { kind: 'removed', text: 'second' }
    ]
  },
  {
    name: 'empty-line addition',
    original: 'first\nlast\n',
    modified: 'first\n\nlast\n',
    rows: [
      { kind: 'context', text: 'first' },
      { kind: 'added', text: '' },
      { kind: 'context', text: 'last' }
    ]
  },
  {
    name: 'unterminated final-line replacement',
    original: 'first\nlast',
    modified: 'first\nlast!',
    rows: [
      { kind: 'context', text: 'first' },
      { kind: 'removed', text: 'last' },
      { kind: 'added', text: 'last!' }
    ]
  },
  {
    name: 'final newline insertion',
    original: 'line',
    modified: 'line\n',
    rows: [
      { kind: 'removed', text: 'line' },
      { kind: 'added', text: 'line' }
    ]
  },
  {
    name: 'final newline deletion',
    original: 'line\n',
    modified: 'line',
    rows: [
      { kind: 'removed', text: 'line' },
      { kind: 'added', text: 'line' }
    ]
  },
  {
    name: 'empty-file addition',
    original: '',
    modified: 'added',
    rows: [{ kind: 'added', text: 'added' }]
  },
  {
    name: 'empty-file deletion',
    original: 'removed',
    modified: '',
    rows: [{ kind: 'removed', text: 'removed' }]
  }
] satisfies { name: string; original: string; modified: string; rows: InlineRowExpectation[] }[])(
  'Changes inline diff displays whole lines for $name',
  async ({ original, modified, rows }) => {
    const surface = await renderChanges(makeBuffer('text', modified, null), { original, modified })
    await flush()
    await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
    await flush()

    const actualRows = inlineRows(surface.element)
    expect(actualRows).toEqual(rows)
  }
)

test('Changes navigation reveals the changed modified line', async () => {
  const original = 'first\nlast\n'
  const modified = 'first\nadded\nlast\n'
  const surface = await renderChanges(makeBuffer('text', modified, null), { original, modified })
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Next change"]')?.click())
  await flush()

  expect(surface.element.querySelector<HTMLElement>('[aria-label="Modified editor"] .cm-activeLine')?.textContent).toBe('added')
})

test('Changes side-by-side compares aligned read-only HEAD and editable draft editors', async () => {
  const original = 'before\nold value that wraps to multiple visual lines\nunchanged after\n'
  const initialDraft = 'before\nnew value that wraps to multiple visual lines\nunchanged after\n'
  const draftUpdates: string[] = []
  const surface = await renderChanges(makeBuffer('text', 'Working file\n', initialDraft), {
    original,
    modified: 'Staged index\n'
  }, {
    onDraft: (content) => draftUpdates.push(content)
  })
  await flush()

  const head = surface.element.querySelector<HTMLElement>('.cm-editor[aria-label="HEAD version"]')
  const modified = surface.element.querySelector<HTMLElement>('.cm-editor[aria-label="Modified editor"]')
  expect(head).not.toBeNull()
  expect(modified).not.toBeNull()
  expect(head?.querySelector('.cm-content')?.textContent).toContain('old value')
  expect(modified?.querySelector('.cm-content')?.textContent).toContain('new value')
  expect(modified?.querySelector('.cm-content')?.textContent).not.toContain('Staged index')
  expect(head?.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
  expect(modified?.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')

  for (const editor of [head, modified]) {
    expect(editor?.querySelector('.cm-lineNumbers')).not.toBeNull()
    expect(editor?.querySelector('.cm-content.cm-lineWrapping')).not.toBeNull()
    expect(editor?.querySelector('.cm-changedLine')).not.toBeNull()
    const unchanged = [...(editor?.querySelectorAll<HTMLElement>('.cm-line') ?? [])]
      .find((line) => line.textContent?.includes('unchanged after'))
    expect(unchanged?.classList.contains('cm-changedLine')).toBe(false)
  }

  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', {
    value: { getData: (type: string) => type === 'text/plain' ? 'Local edit\n' : '' }
  })
  modified?.querySelector('.cm-content')?.dispatchEvent(paste)
  await flush()
  const pastedDraft = `Local edit\n${initialDraft}`
  expect(draftUpdates.at(-1)).toBe(pastedDraft)
  await surface.update(makeBuffer('text', 'Working file\n', pastedDraft))
  await flush()

  const updatedDraft = 'before\na newer shared draft line that also wraps\nunchanged after\n'
  await surface.update(makeBuffer('text', 'Working file\n', updatedDraft))
  await flush()
  expect(modified?.querySelector('.cm-content')?.textContent).toContain('newer shared draft')
  expect(head?.querySelector('.cm-content')?.textContent).toContain('old value')
})

test('Changes keeps keyboard focus on the Markdown display toggle in both directions', async () => {
  const surface = await renderChanges(makeBuffer('markdown', '# Working file\n', '# Shared draft\n'))
  await flush()
  const previewButton = surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')!
  previewButton.focus()
  await act(async () => previewButton.click())
  await flush()
  const sourceButton = surface.element.querySelector<HTMLButtonElement>('[aria-label="Source editor"]')!
  expect(document.activeElement).toBe(sourceButton)

  await act(async () => sourceButton.click())
  await flush()
  expect(document.activeElement).toBe(surface.element.querySelector('[aria-label="Markdown preview"]'))
})

test('Changes Markdown preview renders the shared draft image and releases it when Source returns', async () => {
  const draft = '# Shared draft\n\n![Chart](images/chart.png)\n'
  const surface = await renderChanges(makeBuffer('markdown', '# Working file\n', draft), {
    original: '# Committed HEAD\n',
    modified: '# Staged index\n'
  })
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  expect(surface.element.querySelector('.qe-changes-preview-notice')).not.toBeNull()
  expect(surface.element.querySelector('[aria-label="HEAD version"]')).toBeNull()
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).toContain('Shared draft')
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).not.toContain('Committed HEAD')
  const image = surface.element.querySelector<HTMLImageElement>('.qe-changes-markdown-preview img')
  expect(image?.alt).toBe('Preview image')
  const imageUrl = image?.getAttribute('src')
  expect(imageUrl).toBeTruthy()
  expect(surface.isResourceLive(imageUrl!)).toBe(true)
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Source editor"]')?.click())
  await flush()
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain('Shared draft')
  expect(surface.element.querySelector('.qe-changes-markdown-preview img')).toBeNull()
  expect(surface.isResourceLive(imageUrl!)).toBe(false)
})

test('Changes ignores and revokes a late render after replacing the shared draft', async () => {
  const oldDraft = '# Old draft\n\n![Chart](images/chart.png)\n'
  const surface = await renderChanges(makeBuffer('markdown', '# Working file\n', oldDraft), undefined, {
    deferFirstRender: true
  })
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  const staleLeaseId = surface.pendingLeaseIds()[0]
  expect(staleLeaseId).toBeTruthy()

  const currentDraft = '# Current draft\n\n![Chart](images/chart.png)\n'
  await surface.update(makeBuffer('markdown', '# Working file\n', currentDraft))
  await flush()
  const currentImage = surface.element.querySelector<HTMLImageElement>('.qe-changes-markdown-preview img')
  const currentUrl = currentImage?.getAttribute('src')
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).toContain('Current draft')
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).not.toContain('Old draft')
  expect(currentUrl).toBeTruthy()
  expect(surface.isResourceLive(currentUrl!)).toBe(true)

  surface.resolvePending(staleLeaseId!)
  await flush()
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).toContain('Current draft')
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).not.toContain('Old draft')
  expect(surface.element.querySelector('.qe-changes-markdown-preview img')?.getAttribute('src')).toBe(currentUrl)
  expect(surface.isResourceLive(currentUrl!)).toBe(true)
  expect(surface.pendingLeaseIds()).toHaveLength(0)

  await surface.unmount()
  await flush()
  expect(surface.isResourceLive(currentUrl!)).toBe(false)
})

test('Changes rejects a detached response for another lease and leaves Source available', async () => {
  const surface = await renderChanges(makeBuffer('markdown', '# Working file\n', '# Shared draft\n'), undefined, {
    malformedResponse: true
  })
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  const previewError = surface.element.querySelector('[role="alert"]')
  expect(previewError).not.toBeNull()
  expect(previewError?.classList.contains('ui-inline-error')).toBe(true)
  const sourceButton = surface.element.querySelector<HTMLButtonElement>('[aria-label="Source editor"]')
  expect(sourceButton).not.toBeNull()
  expect(surface.element.querySelector('.qe-changes-markdown-preview')).toBeNull()
  expect(surface.liveResourceCount()).toBe(0)
  await act(async () => sourceButton?.click())
  await flush()
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain('Shared draft')
})

test('Changes makes a clean HEAD comparison explicit', async () => {
  const source = 'No changes\n'
  const surface = await renderChanges(makeBuffer('text', source, null), { original: source, modified: source })
  await flush()
  expect(surface.element.textContent).toContain('No uncommitted changes')
})

test('Changes scopes git change subscriptions to the buffer worktree and refreshes on change', async () => {
  const surface = await renderChanges(makeBuffer('text', 'Working version\n', null))
  await flush()

  expect(surface.subscriptions).toHaveLength(1)
  expect(surface.subscriptions[0]?.options).toEqual({ worktreeId: WORKTREE })
  const diffCalls = surface.diffCallCount()

  await act(async () => {
    await surface.subscriptions[0]!.listener({
      type: 'quirky.git/changed',
      data: { worktreeId: WORKTREE },
      worktreeId: WORKTREE
    })
  })

  expect(surface.diffCallCount()).toBe(diffCalls + 1)
})

test('Changes shows shared loading, error and clean states without hiding the source editor', async () => {
  const source = 'No changes\n'
  const loading = await renderChanges(makeBuffer('text', source, null), { original: source, modified: source }, {
    deferDiffCalls: [1]
  })
  expect(loading.element.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Loading HEAD comparison…')
  expect(loading.element.querySelector('.ui-empty-state')).toBeNull()
  await act(async () => loading.resolveDiff(1))
  await flush()
  expect(loading.element.querySelector('.ui-empty-state')?.textContent).toContain('No uncommitted changes.')
  expect(loading.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain(source.trim())
  expect(loading.element.querySelector('[aria-label="Previous change"]')?.hasAttribute('disabled')).toBe(true)
  expect(loading.controls()[0]?.actions).not.toContain('previous-change')
  expect(loading.controls()[0]?.actions).not.toContain('next-change')

  const failed = await renderChanges(makeBuffer('text', 'Modified\n', null), undefined, {
    diffErrors: ['fixture diff failed']
  })
  await flush()
  expect(failed.element.querySelector('.ui-inline-error')?.textContent).toContain('Changes unavailable: fixture diff failed')
  expect(failed.element.querySelector('[role="alert"].ui-inline-error')).not.toBeNull()
  expect(failed.element.querySelector('button')?.textContent).toContain('Retry Changes')
  await act(async () => failed.element.querySelector<HTMLButtonElement>('button')?.click())
  await flush()
  expect(failed.diffCallCount()).toBe(2)
  expect(failed.element.querySelector('.ui-inline-error')).toBeNull()
  expect(failed.bridgeCalls().at(-1)?.params).toMatchObject({
    connId: 22,
    id: 'command:quirky.editor/ui-control',
    args: { action: 'retry', target: `changes:${JSON.stringify(['buffer-changes', 'tab-changes'])}` }
  })
})

test('Changes renders modified-Markdown preview loading and failures with shared states', async () => {
  const pending = await renderChanges(makeBuffer('markdown', '# Working file\n', '# Shared draft\n'), undefined, {
    deferFirstRender: true
  })
  await flush()
  await act(async () => pending.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  expect(pending.element.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Rendering modified Markdown…')
  expect(pending.element.querySelector('[aria-label="Source editor"]')).not.toBeNull()

  const failed = await renderChanges(makeBuffer('markdown', '# Working file\n', '# Shared draft\n'), undefined, {
    previewError: 'fixture Markdown failed'
  })
  await flush()
  await act(async () => failed.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  expect(failed.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture Markdown failed')
  expect(failed.element.querySelector('[aria-label="Source editor"]')).not.toBeNull()
  expect(failed.element.querySelector('.qe-changes-markdown-preview')).toBeNull()
})

test('Changes publishes tab-scoped controls and routes pointer actions through the exact-window bridge', async () => {
  const buffer = makeBuffer('text', 'Working version\n', null)
  const surface = await renderChanges(buffer, { original: 'HEAD version\n', modified: 'Index version\n' }, { tabId: 't1' })
  await flush()
  const address = surface.controls().find((item) => item.target === `changes:${JSON.stringify([buffer.id, 't1'])}`)
  expect(address).toBeDefined()
  expect(address).toMatchObject({
    surface: 'view:quirky.editor/document',
    target: `changes:${JSON.stringify([buffer.id, 't1'])}`
  })
  expect(address?.actions).toEqual(expect.arrayContaining(['retry', 'layout', 'previous-change', 'next-change']))
  expect(surface.report()).toMatchObject({ bufferId: buffer.id, fixtureMarker: 'preserved' })

  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
  await flush()
  expect(surface.element.querySelector('[aria-pressed="true"][aria-label="Inline"]')).not.toBeNull()
  const windowCalls = surface.bridgeCalls()
  expect(windowCalls.map((call) => call.method)).toEqual(['ui.window.self', 'ui.window.command.run'])
  expect(windowCalls[1]?.params).toMatchObject({
    connId: 22,
    id: 'command:quirky.editor/ui-control',
    args: {
      surface: address!.surface,
      target: address!.target,
      generation: address!.generation,
      action: 'layout',
      data: { value: 'inline' }
    }
  })

  const inlineAddress = surface.controls().find((item) => item.target === address!.target)
  expect(inlineAddress).toBeDefined()
  expect(inlineAddress?.generation).not.toBe(address?.generation)
  expect(await surface.dispatch(inlineAddress!, 'layout', { value: 'side-by-side' })).toEqual({ delivered: true })
  expect(surface.element.querySelector('[aria-pressed="true"][aria-label="Side by side"]')).not.toBeNull()
  const currentAddress = surface.controls().find((item) => item.target === address!.target)
  expect(await surface.dispatch(currentAddress!, 'next-change')).toEqual({ delivered: true })
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-activeLine')?.textContent).toBe('Working version')
  expect(await surface.dispatch(currentAddress!, 'previous-change')).toEqual({ delivered: true })
})

test('Changes controls distinguish tabs and reject malformed or stale addresses without UI effects', async () => {
  const buffer = makeBuffer('markdown', '# Working file\n', '# Shared draft\n')
  const first = await renderChanges(buffer, { original: '# HEAD\n', modified: '# Index\n' }, { tabId: 't1' })
  const second = await renderChanges(buffer, { original: '# HEAD\n', modified: '# Index\n' }, { tabId: 't2' })
  await flush()
  const firstAddress = first.controls().find((item) => item.target === `changes:${JSON.stringify([buffer.id, 't1'])}`)
  const secondAddress = second.controls().find((item) => item.target === `changes:${JSON.stringify([buffer.id, 't2'])}`)
  expect(firstAddress).toBeDefined()
  expect(secondAddress).toBeDefined()
  expect(firstAddress?.target).not.toBe(secondAddress?.target)

  expect(await first.dispatch(firstAddress!, 'layout', { value: 'inline', ignored: true })).toEqual({ delivered: false })
  expect(first.bridgeCalls()).toEqual([])
  expect(first.element.querySelector('[aria-pressed="true"][aria-label="Side by side"]')).not.toBeNull()

  expect(await first.dispatch(firstAddress!, 'display', { value: 'markdown-preview' })).toEqual({ delivered: true })
  await flush()
  expect(first.element.querySelector('.qe-changes-markdown-preview')).not.toBeNull()
  const replacementAddress = first.controls().find((item) => item.target === firstAddress!.target)
  expect(replacementAddress).toBeDefined()
  expect(replacementAddress?.generation).not.toBe(firstAddress?.generation)
  expect(await first.dispatch(firstAddress!, 'display', { value: 'source' })).toEqual({ delivered: false })
  expect(first.element.querySelector('.qe-changes-markdown-preview')).not.toBeNull()

  expect(await second.dispatch(secondAddress!, 'layout', { value: 'inline' })).toEqual({ delivered: true })
  expect(second.element.querySelector('[aria-pressed="true"][aria-label="Inline"]')).not.toBeNull()
  expect(first.element.querySelector('[aria-pressed="true"][aria-label="Inline"]')).toBeNull()
})
test('Changes remounts with a fresh generation and refuses the former control session', async () => {
  const buffer = makeBuffer('text', 'Working\n', null)
  const first = await renderChanges(buffer, { original: 'HEAD\n', modified: 'Working\n' })
  await flush()
  const oldAddress = first.controls()[0]
  expect(oldAddress).toBeDefined()
  await first.unmount()

  const second = await renderChanges(buffer, { original: 'HEAD\n', modified: 'Working\n' })
  await flush()
  const currentAddress = second.controls()[0]
  expect(currentAddress?.target).toBe(oldAddress?.target)
  expect(currentAddress?.generation).not.toBe(oldAddress?.generation)
  expect(await first.invoke(oldAddress!, 'layout', { value: 'inline' })).toEqual({ delivered: false })
  expect(second.element.querySelector('[aria-pressed="true"][aria-label="Side by side"]')).not.toBeNull()
})


test('Changes retry is busy-safe and returns to an enabled recovery action after failure', async () => {
  const surface = await renderChanges(makeBuffer('text', 'Modified\n', null), undefined, {
    diffErrors: ['fixture diff failed'],
    deferDiffCalls: [2]
  })
  await flush()
  const address = surface.controls()[0]
  expect(address?.actions).toContain('retry')
  expect(surface.element.querySelector('.ui-inline-error')).not.toBeNull()

  let firstRetry: Promise<{ delivered: boolean }> | undefined
  await act(async () => {
    firstRetry = surface.invoke(address!, 'retry')
    await Promise.resolve()
  })
  await flush()
  expect(surface.diffCallCount()).toBe(2)
  expect(await surface.invoke(address!, 'retry')).toEqual({ delivered: false })
  expect(surface.diffCallCount()).toBe(2)

  await act(async () => surface.resolveDiff(2))
  await flush()
  expect(await firstRetry).toEqual({ delivered: true })
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})
test('Changes addressed Retry rejects the actual diff failure and keeps recovery visible', async () => {
  const surface = await renderChanges(makeBuffer('text', 'Modified\n', null), undefined, {
    diffErrors: ['initial failure', 'retry failure']
  })
  await flush()
  const address = surface.controls()[0]
  let failure: unknown
  await act(async () => {
    failure = await surface.invoke(address!, 'retry').then(() => null, (reason: unknown) => reason)
  })
  await flush()

  expect(failure instanceof Error ? failure.message : String(failure)).toBe('retry failure')
  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('Changes unavailable: retry failure')
  expect(surface.element.querySelector('button')?.textContent).toContain('Retry Changes')
})


test('Changes shows bridge failures without locally applying a pointer action', async () => {
  const surface = await renderChanges(makeBuffer('text', 'Modified\n', null), undefined, {
    bridgeError: 'fixture bridge failed'
  })
  await flush()
  expect(surface.controls().length).toBeGreaterThan(0)
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
  await flush()

  expect(surface.element.querySelector('[aria-pressed="true"][aria-label="Side by side"]')).not.toBeNull()
  expect(surface.element.querySelector('[aria-pressed="true"][aria-label="Inline"]')).toBeNull()
  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture bridge failed')
  expect(surface.bridgeCalls().map((call) => call.method)).toEqual(['ui.window.self', 'ui.window.command.run'])
})

test('Changes hides a previous ready diff while a replacement path loads', async () => {
  const originalBuffer = makeBuffer('text', 'Old working\n', null)
  const surface = await renderChanges(originalBuffer, undefined, {
    deferDiffCalls: [2],
    diffByPath: {
      'src/app.ts': { original: 'Old path HEAD\n', modified: 'Old working\n' },
      'src/other.ts': { original: 'New path HEAD\n', modified: 'New working\n' }
    }
  })
  await flush()
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).toContain('Old path HEAD')
  const oldAddress = surface.controls().find((item) => item.target === `changes:${JSON.stringify([originalBuffer.id, originalBuffer.tabId])}`)
  expect(oldAddress).toBeDefined()
  const nextBuffer = {
    ...originalBuffer,
    path: '/tmp/changes-worktree/src/other.ts',
    relativePath: 'src/other.ts',
    name: 'other.ts',
    content: 'New working\n'
  }
  await surface.update(nextBuffer)
  await flush()
  expect(surface.element.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Loading HEAD comparison…')
  expect(surface.element.querySelector('[aria-label="HEAD version"]')).toBeNull()
  expect(await surface.dispatch(oldAddress!, 'retry')).toEqual({ delivered: false })
  expect(surface.diffCallCount()).toBe(2)
  await act(async () => surface.resolveDiff(2))
  await flush()
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).toContain('New path HEAD')
})

test('Changes ignores a delayed diff from a path that has been replaced', async () => {
  const originalBuffer = makeBuffer('text', 'Old working\n', null)
  const surface = await renderChanges(originalBuffer, undefined, {
    deferDiffCalls: [1],
    diffByPath: {
      'src/app.ts': { original: 'Stale path HEAD\n', modified: 'Stale working\n' },
      'src/other.ts': { original: 'Current path HEAD\n', modified: 'Current working\n' }
    }
  })
  await flush()
  const nextBuffer = {
    ...originalBuffer,
    path: '/tmp/changes-worktree/src/other.ts',
    relativePath: 'src/other.ts',
    name: 'other.ts',
    content: 'Current working\n'
  }
  await surface.update(nextBuffer)
  await flush()
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).toContain('Current path HEAD')
  await act(async () => surface.resolveDiff(1))
  await flush()
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).toContain('Current path HEAD')
  expect(surface.element.textContent).not.toContain('Stale path HEAD')
})

test.each(['worktree', 'path'] as const)(
  'Changes rejects a detached preview response with a mismatched %s identity',
  async (mismatch) => {
    const surface = await renderChanges(makeBuffer('markdown', '# Working file\n', '# Shared draft\n'), undefined, {
      previewMismatch: mismatch
    })
    await flush()
    await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
    await flush()

    expect(surface.element.querySelector('.ui-inline-error')).not.toBeNull()
    expect(surface.element.querySelector('[aria-label="Source editor"]')).not.toBeNull()
    expect(surface.element.querySelector('.qe-changes-markdown-preview')).toBeNull()
    expect(surface.liveResourceCount()).toBe(0)
  }
)
test('Changes releases a stale preview lease when Markdown path and worktree change', async () => {
  const originalBuffer = makeBuffer('markdown', '# Working file\n', '# Old shared draft\n')
  const surface = await renderChanges(originalBuffer, undefined, { deferFirstRender: true })
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  const staleLeaseId = surface.pendingLeaseIds()[0]
  expect(staleLeaseId).toBeTruthy()

  const nextBuffer = {
    ...originalBuffer,
    worktreeId: 'wt-replacement',
    root: '/tmp/replacement-worktree',
    path: '/tmp/replacement-worktree/docs/README.md',
    relativePath: 'docs/README.md',
    name: 'README.md',
    content: '# Replacement source\n',
    draft: '# Current shared draft\n'
  }
  await surface.update(nextBuffer)
  await flush()
  const currentUrl = surface.element.querySelector<HTMLImageElement>('.qe-changes-markdown-preview img')?.getAttribute('src')
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).toContain('Current shared draft')
  expect(currentUrl).toBeTruthy()
  expect(surface.isResourceLive(currentUrl!)).toBe(true)

  await act(async () => surface.resolvePending(staleLeaseId!))
  await flush()
  expect(surface.element.querySelector('.qe-changes-markdown-preview img')?.getAttribute('src')).toBe(currentUrl)
  expect(surface.liveResourceCount()).toBe(1)
  expect(surface.isResourceLive(currentUrl!)).toBe(true)
})
