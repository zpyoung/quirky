import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, type ComponentType, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorSurfaceBuffer } from '../src/types'
import type { ChangesSurfaceProps } from '../src/window/ChangesSurface'
import type { SourceEditor as SourceEditorComponent } from '../src/window/SourceEditor'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'
import type { createEditorUiControlReportScope as CreateReportScope, EditorUiControlReportScope } from '../src/window/uiControl'

const WORKTREE = 'wt-editor-changes'
type KeptSubscription = {
  listener: (event: { type: string; data?: unknown; worktreeId?: string }) => void | Promise<void>
  options?: { worktreeId?: string | null }
}
type UiAddress = { surface: string; target: string; generation: string; actions: string[] }
type UiReport = { mounted?: boolean; bufferId?: string | null; tabId?: string | null; mode?: string | null; uiControls?: UiAddress[] }
type CommandHandler = (args?: unknown) => unknown
type Mounted = {
  element: HTMLElement
  isResourceLive(url: string): boolean
  liveResourceCount(): number
  pendingLeaseIds(): string[]
  resolvePending(leaseId: string): void
  subscriptions: KeptSubscription[]
  diffCallCount(): number
  controlCalls: { method: string; params: Record<string, unknown> }[]
  report(): UiReport
  dispatch(address: UiAddress, action: string, data?: Record<string, unknown>): Promise<unknown>
  update(buffer: EditorSurfaceBuffer): Promise<void>
  unmount(): Promise<void>
}
type FixtureOptions = {
  deferFirstRender?: boolean
  malformedResponse?: boolean
  interactive?: boolean
  onDraft?: (content: string) => void
}

let createRoot: (container: HTMLElement) => Root
let ChangesSurface: ComponentType<ChangesSurfaceProps>
let SourceEditorControlScope: ComponentType<{ context: UiPluginContext; children: ReactNode }>
let EditorUiControlProvider: ComponentType<{ scope: EditorUiControlReportScope; children: ReactNode }>
let createEditorUiControlReportScope: typeof CreateReportScope
let activateEditor: typeof Activate
let deactivateEditor: typeof Deactivate
let mounted: Mounted[]
let controlActive = false

beforeAll(async () => {
  // SourceEditor and CodeMirror inspect window at module initialization; load them after Happy DOM.
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChangesSurface } = await import('../src/window/ChangesSurface'))
  const source = await import('../src/window/SourceEditor') as {
    SourceEditor: typeof SourceEditorComponent
    SourceEditorControlScope: ComponentType<{ context: UiPluginContext; children: ReactNode }>
  }
  SourceEditorControlScope = source.SourceEditorControlScope
  const controls = await import('../src/window/uiControl')
  EditorUiControlProvider = controls.EditorUiControlProvider
  createEditorUiControlReportScope = controls.createEditorUiControlReportScope
  ;({ activate: activateEditor, deactivate: deactivateEditor } = await import('../src/ui'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  mounted = []
  controlActive = false
})
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  if (controlActive) deactivateEditor()
  controlActive = false
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
  let diffCalls = 0
  const activeLeases = new Set<string>()
  const resources = new Map<string, string>()
  const pending = new Map<string, () => void>()
  let renders = 0
  function resourceUrl(leaseId: string): string {
    return `https://images.invalid/${leaseId}`
  }
  function response(leaseId: string, text: string): Record<string, unknown> {
    const heading = text.split(/\r?\n/, 1)[0]?.replace(/^#\s*/, '') ?? ''
    return {
      leaseId: options.malformedResponse ? `${leaseId}-wrong` : leaseId,
      worktreeId: WORKTREE,
      path: buffer.relativePath,
      html: `<article><h1>${heading}</h1><img src="${resourceUrl(leaseId)}" alt="Preview image"></article>`
    }
  }
  const handlers = new Map<string, CommandHandler>()
  const controlCalls: { method: string; params: Record<string, unknown> }[] = []
  const context = {
    pluginId: 'quirky.editor',
    provide(id: string, handler: CommandHandler) { handlers.set(id, handler) },
    async call(method: string, params: Record<string, unknown> = {}) {
      controlCalls.push({ method, params })
      if (options.interactive && method === 'ui.window.self') return { connId: 22 }
      if (options.interactive && method === 'ui.window.command.run') {
        if (params.connId !== 22) throw new Error('Changes controls must stay in this window.')
        const handler = handlers.get(String(params.id))
        if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.git/diff') {
        diffCalls += 1
        return {
          path: buffer.relativePath,
          source: 'unstaged',
          staged: false,
          original: diff?.original ?? 'HEAD version\n',
          modified: diff?.modified ?? 'Index version\n',
          binary: false,
          kind: 'text',
          modifiedHash: 'working-hash',
          modifiedDeleted: false
        }
      }
      if (method === 'quirky.editor/markdownPreview') {
        const leaseId = typeof params.leaseId === 'string' ? params.leaseId : ''
        if (params.action === 'render') {
          activeLeases.add(leaseId)
          const value = response(leaseId, typeof params.text === 'string' ? params.text : '')
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
    getSetting() { return 320 },
    subscribe(listener: KeptSubscription['listener'], options?: KeptSubscription['options']) {
      subscriptions.push({ listener, options })
      return () => {}
    },
    setContext() {},
    toast() {},
    togglePanel() {},
    setPanelBadge() {},
    getLayout() { return {} },
    mountView() { return () => {} }
  } as unknown as UiPluginContext
  const props: ChangesSurfaceProps = {
    context,
    buffer,
    tabId: buffer.tabId,
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
  let report: UiReport = {}
  let scope: EditorUiControlReportScope | undefined
  if (options.interactive) {
    activateEditor(context)
    controlActive = true
    scope = createEditorUiControlReportScope((value) => { report = value as UiReport }, {
      surface: 'view:quirky.editor/document'
    })
    scope.report({ mounted: true, bufferId: buffer.id, tabId: buffer.tabId, mode: 'source' })
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const tree = (nextProps: ChangesSurfaceProps) => {
    const child = <ChangesSurface {...nextProps} />
    if (!scope) return child
    return <EditorUiControlProvider scope={scope}>
      <SourceEditorControlScope context={context}>{child}</SourceEditorControlScope>
    </EditorUiControlProvider>
  }
  await act(async () => root.render(tree(props)))
  let unmounted = false
  const surface: Mounted = {
    subscriptions,
    diffCallCount: () => diffCalls,
    element,
    isResourceLive: (url) => resources.has(url),
    liveResourceCount: () => resources.size,
    pendingLeaseIds: () => [...pending.keys()],
    resolvePending(leaseId) {
      const resolve = pending.get(leaseId)
      if (!resolve) throw new Error(`No pending preview render for ${leaseId}.`)
      pending.delete(leaseId)
      resolve()
    },
    controlCalls,
    report: () => report,
    async dispatch(address, action, data) {
      return await context.call('ui.window.command.run', {
        connId: 22,
        id: 'command:quirky.editor/ui-control',
        args: {
          surface: address.surface,
          target: address.target,
          generation: address.generation,
          action,
          ...(data === undefined ? {} : { data })
        }
      })
    },
    async update(nextBuffer) {
      await act(async () => {
        scope?.report({ mounted: true, bufferId: nextBuffer.id, tabId: nextBuffer.tabId, mode: 'source' })
        root.render(tree({ ...props, buffer: nextBuffer, tabId: nextBuffer.tabId }))
      })
    },
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
      scope?.dispose()
      if (options.interactive && controlActive) {
        deactivateEditor()
        controlActive = false
      }
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
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Next change"]')?.click())

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
test('Changes inherits the activated document report and source bridge for its real CodeMirror editor', async () => {
  const buffer = makeBuffer('text', 'Working file\n', 'alpha alpha\nbeta\n')
  const drafts: string[] = []
  const surface = await renderChanges(buffer, {
    original: 'HEAD version\n',
    modified: 'Staged index\n'
  }, { interactive: true, onDraft: (content) => drafts.push(content) })
  await flush()

  expect(surface.report()).toMatchObject({
    mounted: true,
    bufferId: buffer.id,
    tabId: buffer.tabId,
    mode: 'source'
  })
  const sourceAddresses = surface.report().uiControls?.filter(({ target }) => target.startsWith('source:')) ?? []
  expect(sourceAddresses).toHaveLength(1)
  const source = sourceAddresses[0]!
  expect(source).toMatchObject({
    surface: 'view:quirky.editor/document',
    target: `source:${JSON.stringify([buffer.id, buffer.tabId])}`
  })
  const head = surface.element.querySelector<HTMLElement>('.cm-editor[aria-label="HEAD version"]')
  const modified = surface.element.querySelector<HTMLElement>('.cm-editor[aria-label="Modified editor"]')
  expect(head?.querySelector('.cm-content')?.textContent).toContain('HEAD version')
  expect(modified?.querySelector('.cm-content')?.textContent).toContain('alpha alpha')
  expect(modified?.querySelector('.cm-content')?.textContent).not.toContain('Staged index')
  expect(head?.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
  expect(modified?.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')

  let found: unknown
  await act(async () => { found = await surface.dispatch(source, 'find', { query: 'alpha' }) })
  expect(found).toEqual({ result: { delivered: true } })
  expect(surface.element.querySelector<HTMLInputElement>('input[aria-label="Find in source"]')?.value).toBe('alpha')

  let replaced: unknown
  await act(async () => {
    replaced = await surface.dispatch(source, 'replace-all', { query: 'alpha', replacement: 'z' })
  })
  expect(replaced).toEqual({ result: { delivered: true } })
  expect(modified?.querySelector('.cm-content')?.textContent).toContain('z z')
  expect(drafts.at(-1)).toBe('z z\nbeta\n')
  expect(surface.controlCalls.some(({ method }) => method === 'quirky.editor/save')).toBe(false)
  expect(surface.report().uiControls?.filter(({ target }) => target.startsWith('source:'))).toHaveLength(1)
  await surface.update({ ...buffer, draft: drafts.at(-1)!, contentRevision: buffer.contentRevision + 1 })
  expect(surface.report().uiControls?.find(({ target }) => target === source.target)?.generation).toBe(source.generation)

  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
  await flush()
  const inlineSource = surface.report().uiControls?.find(({ target }) => target.startsWith('source:'))
  expect(inlineSource?.target).toBe(source.target)
  expect(inlineSource?.generation).not.toBe(source.generation)
  expect(surface.element.querySelector('[aria-label="HEAD version"]')).toBeNull()
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain('z z')
})
