import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'

type Mounted = { element: HTMLElement; commands(): CommandHandlers | undefined; unmount(): Promise<void> }
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
): Promise<Mounted> {
  let commands: CommandHandlers | undefined
  const props: SurfaceProps = {
    context: {
      pluginId: 'quirky.editor',
      subscribe: () => () => {}
    } as unknown as UiPluginContext,
    buffer,
    fontSize: 13,
    onDraft() {},
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
