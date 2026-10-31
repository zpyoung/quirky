import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import type { MarkdownReviewNote } from '../src/markdown/notes'

type CommandHandlers = Parameters<SurfaceProps['registerCommandHandlers']>[0]
type MountedSurface = {
  element: HTMLElement
  commands(): CommandHandlers | undefined
  unmount(): Promise<void>
}

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>

let createRoot: (container: HTMLElement) => Root
let MarkdownSurface: ComponentType<SurfaceProps>
let surfaces: MountedSurface[]

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // MarkdownSurface and TipTap capture browser APIs during initialization.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownSurface } = await import('../src/markdown/MarkdownSurface'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => { surfaces = [] })
afterEach(async () => {
  for (const surface of surfaces) await surface.unmount()
  surfaces = []
  document.body.innerHTML = ''
})

function makeBuffer(content: string): EditorSurfaceBuffer {
  return {
    id: 'buffer-review-notes',
    worktreeId: 'wt-review-notes',
    root: '/tmp/review-notes-worktree',
    path: '/tmp/review-notes-worktree/sample.md',
    relativePath: 'sample.md',
    name: 'sample.md',
    kind: 'markdown',
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: false,
    external: null,
    mode: 'rich',
    tabId: 'tab-review-notes',
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

function makeNote(body: string): MarkdownReviewNote {
  return {
    id: 'note-review-notes-1',
    bufferId: 'buffer-review-notes',
    worktreeId: 'wt-review-notes',
    filePath: 'sample.md',
    source: 'markdown',
    selectedText: 'source text',
    startLine: 1,
    endLine: 1,
    lineNumber: 1,
    body,
    createdAt: 1,
    side: 'modified'
  }
}

async function renderRichSurface(content: string, notes: MarkdownReviewNote[] = []): Promise<MountedSurface> {
  let commands: CommandHandlers | undefined
  const onAction: Call = async (method, params) => {
    if (method === 'quirky.editor/markdown') {
      if (params.action === 'capabilities') return { richEligible: true }
      if (params.action === 'toc') return { headings: [] }
    }
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes }
    return {}
  }
  const context = {
    pluginId: 'quirky.editor',
    call: onAction
  } as unknown as UiPluginContext
  const props: SurfaceProps = {
    context,
    buffer: makeBuffer(content),
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
  await act(async () => root.render(<MarkdownSurface {...props} />))
  let unmounted = false
  const surface: MountedSurface = {
    element,
    commands: () => commands,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
    }
  }
  surfaces.push(surface)
  return surface
}

async function waitFor<T>(condition: () => T | null | undefined | false, description: string): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    let result: T | null | undefined | false
    await act(async () => { result = condition() })
    if (result !== null && result !== undefined && result !== false) return result as T
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 10)
      await promise
    })
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function reviewToggle(surface: MountedSurface, count: number): HTMLButtonElement | undefined {
  const name = `Review notes (${count})`
  const toolbar = surface.element.querySelector('[role="toolbar"][aria-label="Markdown formatting"]')
  return [...(toolbar?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => {
    const accessibleName = button.getAttribute('aria-label') ?? button.textContent?.trim()
    return accessibleName === name
  })
}

function notesAside(surface: MountedSurface): HTMLElement | null {
  return surface.element.querySelector<HTMLElement>('.markdown-review-notes')
}

async function clickReviewToggle(surface: MountedSurface, count: number): Promise<void> {
  const button = await waitFor(() => reviewToggle(surface, count), `Review notes (${count}) toggle`)
  await act(async () => button.click())
}

async function richEditor(surface: MountedSurface): Promise<HTMLElement> {
  return waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich Markdown editor')
}

async function selectText(editor: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode() as Text | null
    let start = -1
    while (textNode) {
      start = textNode.textContent?.indexOf(text) ?? -1
      if (start >= 0) break
      textNode = walker.nextNode() as Text | null
    }
    if (!textNode || start < 0) throw new Error(`Could not find editor text to select: ${text}`)
    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + text.length)
    const selection = window.getSelection()
    if (!selection) throw new Error('The document selection is unavailable.')
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setValue) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    setValue.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('rich Markdown starts with closed review notes and its toolbar toggle opens and closes them', async () => {
  const surface = await renderRichSurface('')
  expect(notesAside(surface)).toBeNull()
  const toggle = reviewToggle(surface, 0)
  expect(toggle).toBeDefined()
  expect(toggle!.getAttribute('aria-expanded')).toBe('false')

  await clickReviewToggle(surface, 0)
  expect(notesAside(surface)).not.toBeNull()
  expect(reviewToggle(surface, 0)?.getAttribute('aria-expanded')).toBe('true')

  await clickReviewToggle(surface, 0)
  expect(notesAside(surface)).toBeNull()
  expect(reviewToggle(surface, 0)?.getAttribute('aria-expanded')).toBe('false')
})

test('populated review notes survive hiding and reopening the sidebar', async () => {
  const body = 'Keep this review note while the sidebar is hidden.'
  const surface = await renderRichSurface('Review note source text.', [makeNote(body)])
  expect(notesAside(surface)).toBeNull()
  const toggle = reviewToggle(surface, 1)
  expect(toggle).toBeDefined()
  expect(toggle!.getAttribute('aria-expanded')).toBe('false')

  await clickReviewToggle(surface, 1)
  expect(notesAside(surface)?.textContent).toContain(body)
  expect(reviewToggle(surface, 1)?.getAttribute('aria-expanded')).toBe('true')

  await clickReviewToggle(surface, 1)
  expect(notesAside(surface)).toBeNull()
  expect(reviewToggle(surface, 1)?.getAttribute('aria-expanded')).toBe('false')

  await clickReviewToggle(surface, 1)
  expect(notesAside(surface)?.textContent).toContain(body)
  expect(reviewToggle(surface, 1)?.getAttribute('aria-expanded')).toBe('true')
})

test('add-review-note opens the hidden sidebar for a real selection and preserves the unsaved composer draft', async () => {
  const selectedText = 'selected phrase'
  const surface = await renderRichSurface(`Please review this ${selectedText}.`)
  expect(notesAside(surface)).toBeNull()
  const editor = await richEditor(surface)
  const toggle = reviewToggle(surface, 0)
  expect(toggle).toBeDefined()
  expect(toggle!.getAttribute('aria-expanded')).toBe('false')

  await selectText(editor, selectedText)
  const command = await waitFor(() => surface.commands()?.['add-review-note'], 'add-review-note command')
  let result: unknown
  await act(async () => { result = await command() })

  expect(result).toMatchObject({ opened: true, startLine: 1, endLine: 1 })
  expect(notesAside(surface)).not.toBeNull()
  expect(reviewToggle(surface, 0)?.getAttribute('aria-expanded')).toBe('true')
  const dialog = surface.element.querySelector<HTMLElement>('[role="dialog"][aria-label="Add note for the AI"]')
  expect(dialog?.textContent).toContain(`Selected text: ${selectedText}`)
  const textarea = dialog?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')
  expect(textarea).toBeDefined()
  await setTextareaValue(textarea!, 'Unsaved note composer draft.')

  await clickReviewToggle(surface, 0)
  expect(notesAside(surface)).toBeNull()
  await clickReviewToggle(surface, 0)

  const reopenedDialog = surface.element.querySelector<HTMLElement>('[role="dialog"][aria-label="Add note for the AI"]')
  expect(reopenedDialog?.textContent).toContain(`Selected text: ${selectedText}`)
  expect(reopenedDialog?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')?.value)
    .toBe('Unsaved note composer draft.')
})
