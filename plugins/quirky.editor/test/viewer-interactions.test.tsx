import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'

type Mounted = { element: HTMLElement; commands(): CommandHandlers | undefined; rerender(buffer: EditorSurfaceBuffer): Promise<void>; unmount(): Promise<void> }
type CommandHandlers = Parameters<SurfaceProps['registerCommandHandlers']>[0]

let createRoot: (container: HTMLElement) => Root
let NotebookSurface: ComponentType<SurfaceProps>
let ViewerSurface: ComponentType<SurfaceProps>
let mounted: Mounted[]

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // These modules capture browser APIs during initialization, so Happy DOM must be registered first.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ NotebookSurface } = await import('../src/notebook/NotebookSurface'))
  ;({ ViewerSurface } = await import('../src/viewers/ViewerSurface'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => { mounted = [] })
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  document.body.innerHTML = ''
})

function makeBuffer(kind: EditorSurfaceBuffer['kind'], content = ''): EditorSurfaceBuffer {
  return {
    id: `buffer-${kind}`,
    worktreeId: 'wt-editor-viewers',
    root: '/tmp/viewer-worktree',
    path: `/tmp/viewer-worktree/sample.${kind === 'notebook' ? 'ipynb' : 'csv'}`,
    relativePath: `sample.${kind === 'notebook' ? 'ipynb' : 'csv'}`,
    name: `sample.${kind === 'notebook' ? 'ipynb' : 'csv'}`,
    kind,
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: kind === 'csv',
    diskWritable: kind !== 'csv',
    dirty: false,
    external: null,
    mode: 'rich',
    tabId: 'tab-viewers',
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    diskContentLength: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function renderSurface(
  Component: ComponentType<SurfaceProps>,
  buffer: EditorSurfaceBuffer,
  onAction: SurfaceProps['onAction'],
  onDraft: SurfaceProps['onDraft'] = () => {},
): Promise<Mounted> {
  let commands: CommandHandlers | undefined
  let props: SurfaceProps = {
    context: {
      pluginId: 'quirky.editor',
      subscribe: () => () => {}
    } as unknown as UiPluginContext,
    buffer,
    fontSize: 13,
    onDraft,
    onAction,
    onView() {},
    registerCommandHandlers(handlers) {
      commands = handlers
      return () => { if (commands === handlers) commands = undefined }
    }
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(<Component {...props} />))
  let unmounted = false
  const surface: Mounted = {
    element,
    commands: () => commands,
    async rerender(buffer) {
      props = { ...props, buffer }
      await act(async () => root.render(<Component {...props} />))
    },
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
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

function notebookWithSource(cellType: 'code' | 'markdown', source: string): string {
  return JSON.stringify({
    cells: [{
      cell_type: cellType,
      metadata: {},
      source,
      ...(cellType === 'code' ? { outputs: [], execution_count: null } : {})
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  })
}

function notebookCellSource(content: string): string {
  const notebook = JSON.parse(content) as { cells: { source: string | string[] }[] }
  const source = notebook.cells[0]!.source
  return Array.isArray(source) ? source.join('') : source
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string, selection: number): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setValue) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    setValue.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => textarea.setSelectionRange(selection, selection))
}

async function replaceTextareaSelection(textarea: HTMLTextAreaElement, replacement: string): Promise<void> {
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  await setTextareaValue(
    textarea,
    textarea.value.slice(0, start) + replacement + textarea.value.slice(end),
    start + replacement.length
  )
}

async function flushNotebookChanges(surface: Mounted): Promise<void> {
  const flushChanges = surface.commands()?.flush
  expect(flushChanges).toBeDefined()
  await act(async () => { flushChanges!() })
}

test.each([
  { cellType: 'code' as const },
  { cellType: 'markdown' as const }
])('accepting queued local $cellType cell drafts preserves editing focus and later input', async ({ cellType }) => {
  const content = notebookWithSource(cellType, 'seed')
  const buffer = makeBuffer('notebook', content)
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  expect(editButton).toBeDefined()
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => {
    textarea!.focus()
    textarea!.setSelectionRange(1, 3)
  })
  await replaceTextareaSelection(textarea!, 'X')
  expect(textarea!.value).toBe('sXd')

  await flushNotebookChanges(surface)
  expect(submittedDrafts).toHaveLength(1)
  const firstDraft = submittedDrafts[0]!
  expect(notebookCellSource(firstDraft)).toBe('sXd')
  await replaceTextareaSelection(textarea!, 'Y')
  expect(textarea!.value).toBe('sXYd')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toHaveLength(2)
  const secondDraft = submittedDrafts[1]!
  expect(notebookCellSource(secondDraft)).toBe('sXYd')
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect(textarea!.value).toBe('sXYd')

  await surface.rerender({
    ...buffer,
    draft: firstDraft,
    contentRevision: buffer.contentRevision + 1,
    dirty: true
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect(textarea!.selectionStart).toBe(3)
  expect(textarea!.selectionEnd).toBe(3)
  expect(textarea!.value).toBe('sXYd')

  await surface.rerender({
    ...buffer,
    draft: secondDraft,
    contentRevision: buffer.contentRevision + 2,
    dirty: true
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect(textarea!.value).toBe('sXYd')
  expect(textarea!.selectionStart).toBe(3)
  expect(textarea!.selectionEnd).toBe(3)
  expect(notebookCellSource(secondDraft)).toBe('sXYd')

  const doneButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Done editing')
  expect(doneButton).toBeDefined()
  await act(async () => doneButton!.click())
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('sXYd')
})

test('unrelated external replacements discard local cell text and reset editing', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'seed'))
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => textarea!.focus())
  await setTextareaValue(textarea!, 'stale local text', 15)
  await flushNotebookChanges(surface)
  const acceptedA = submittedDrafts[0]!
  expect(notebookCellSource(acceptedA)).toBe('stale local text')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toEqual([acceptedA])

  const replacement = notebookWithSource('code', 'external replacement')
  await surface.rerender({
    ...buffer,
    content: replacement
  })

  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('external replacement')
  expect(surface.element.textContent).not.toContain('stale local text')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toEqual([acceptedA])

  await surface.unmount()
  expect(submittedDrafts).toEqual([acceptedA])
})

test('an unflushed cell edit is discarded when an external replacement arrives', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'seed'))
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => textarea!.focus())
  await setTextareaValue(textarea!, 'unflushed local text', 20)

  const replacement = notebookWithSource('code', 'external replacement')
  await surface.rerender({
    ...buffer,
    content: replacement
  })

  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('external replacement')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toEqual([])
  await surface.unmount()
  expect(submittedDrafts).toEqual([])
})


test('an earlier local echo cannot hide an unrelated replacement that returns to its content', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'seed'))
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => {
    textarea!.focus()
    textarea!.setSelectionRange(1, 3)
  })
  await replaceTextareaSelection(textarea!, 'X')
  await flushNotebookChanges(surface)
  const submittedA = submittedDrafts[0]!
  expect(notebookCellSource(submittedA)).toBe('sXd')

  const externalB = notebookWithSource('code', 'external B')
  await surface.rerender({
    ...buffer,
    content: externalB,
    contentRevision: buffer.contentRevision + 1
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('external B')

  const editExternalButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editExternalButton!.click())
  const externalTextarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(externalTextarea).not.toBeNull()
  await act(async () => externalTextarea!.focus())
  await setTextareaValue(externalTextarea!, 'stale B edit', 12)

  await surface.rerender({
    ...buffer,
    content: submittedA,
    contentRevision: buffer.contentRevision + 2
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('sXd')
  expect(surface.element.textContent).not.toContain('stale B edit')
})

test('switching notebook buffers resets cell editing', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'first file'))
  const surface = await renderSurface(NotebookSurface, buffer, async () => ({}))
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).not.toBeNull()

  const nextBuffer = {
    ...makeBuffer('notebook', notebookWithSource('markdown', 'second file')),
    id: 'buffer-notebook-second',
    path: '/tmp/viewer-worktree/second.ipynb',
    relativePath: 'second.ipynb',
    name: 'second.ipynb'
  }
  await surface.rerender(nextBuffer)

  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('second file')
})

test('Escape cancels notebook trust without authorizing execution', async () => {
  const actions: string[] = []
  const content = JSON.stringify({
    cells: [{ cell_type: 'code', metadata: {}, source: 'print(1)', outputs: [], execution_count: null }],
    metadata: { kernelspec: { language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5
  })
  const surface = await renderSurface(NotebookSurface, makeBuffer('notebook', content), async (_method, params) => {
    const action = String(params.action)
    actions.push(action)
    if (action === 'state') return { trusted: false, busy: false, kernel: { status: 'stopped' } }
    return {}
  })
  await flush()

  const runAll = [...surface.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Run all')
  expect(runAll).toBeDefined()
  await act(async () => { runAll!.click() })
  const dialog = surface.element.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog!.textContent).toContain('Run Notebook Code?')
  await act(async () => {
    dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
  expect(actions).not.toContain('trust')
  expect(actions).not.toContain('runAll')
})

test('read-only paged CSV keeps edit controls hidden and rejects find', async () => {
  const actions: string[] = []
  const buffer = makeBuffer('csv', 'name,value\nalpha,1\n')
  const surface = await renderSurface(ViewerSurface, buffer, async (_method, params) => {
    const action = String(params.action)
    actions.push(action)
    if (action === 'metadata') return { paged: true, rows: 2, columns: 2, limits: { maxColumns: 4, maxRecordBytes: 2048, maxCachedPages: 2 } }
    if (action === 'page') return {
      rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }],
      nextPage: null,
      offset: 0,
      delimiter: ','
    }
    return {}
  })
  await flush()
  const commands = surface.commands()

  expect(surface.element.querySelector('section[aria-label="Paged CSV preview"]')).not.toBeNull()
  expect(surface.element.querySelector('input')).toBeNull()
  for (const label of ['Save', 'Add row', 'Add column', 'Paste', 'Copy range', 'Delete column']) {
    expect([...surface.element.querySelectorAll('button')].some((button) => button.textContent?.trim() === label)).toBe(false)
  }
  expect(commands?.find).toBeDefined()
  await expect(Promise.resolve().then(() => commands!.find!({ query: 'alpha' }))).rejects.toThrow('read-only paged CSV previews')
  expect(actions).not.toContain('filter')
  expect(actions).not.toContain('edit')
})
