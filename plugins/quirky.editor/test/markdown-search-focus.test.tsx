import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'

type Mode = 'preview' | 'rich'
type CommandHandlers = Parameters<SurfaceProps['registerCommandHandlers']>[0]
type SearchResult = { total: number; matches: { from: number; to: number; line: number; text: string }[] }
type MountedSurface = {
  element: HTMLElement
  commands(): CommandHandlers | undefined
  unmount(): Promise<void>
}
type Options = { search?(query: string): Promise<SearchResult> }

const MODES: Mode[] = ['preview', 'rich']
let createRoot: (container: HTMLElement) => Root
let MarkdownSurface: ComponentType<SurfaceProps>
let surfaces: MountedSurface[]

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React DOM and TipTap capture browser APIs during initialization, so import them after Happy DOM is registered.
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

function makeBuffer(mode: Mode, content: string): EditorSurfaceBuffer {
  return {
    id: 'buffer-search-focus',
    worktreeId: 'wt-search-focus',
    root: '/tmp/search-focus-worktree',
    path: '/tmp/search-focus-worktree/sample.md',
    relativePath: 'sample.md',
    name: 'sample.md',
    kind: 'markdown',
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: false,
    dirty: false,
    external: null,
    mode,
    tabId: 'tab-search-focus',
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

async function renderSurface(mode: Mode, content: string, options: Options = {}): Promise<MountedSurface> {
  let commands: CommandHandlers | undefined
  const onAction: SurfaceProps['onAction'] = async (method, params) => {
    if (method === 'quirky.editor/markdown') {
      if (params.action === 'capabilities') {
        return mode === 'preview'
          ? { previewAvailable: true, imageUrls: {} }
          : { richEligible: true }
      }
      if (params.action === 'toc') return { headings: [] }
      if (params.action === 'search') return options.search?.(String(params.query ?? '')) ?? { total: 0, matches: [] }
    }
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    return {}
  }
  const context = { pluginId: 'quirky.editor', call: onAction } as unknown as UiPluginContext
  const props: SurfaceProps = {
    context,
    buffer: makeBuffer(mode, content),
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
  if (mode === 'rich') await waitFor(() => surface.element.querySelector('.ProseMirror'), 'rich Markdown editor')
  return surface
}

async function waitFor<T>(condition: () => T | null | undefined | false, description: string): Promise<T> {
  const deadline = Date.now() + 1_000
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

function searchToolbar(surface: MountedSurface): HTMLElement | null {
  return surface.element.querySelector<HTMLElement>('.markdown-toolbar--search')
}

function searchInput(surface: MountedSurface, mode: Mode): HTMLInputElement | null {
  const label = mode === 'preview' ? 'Find in preview' : 'Find in rich editor'
  return surface.element.querySelector<HTMLInputElement>(`.markdown-toolbar--search input[aria-label="${label}"]`)
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)
}

function searchOpener(surface: MountedSurface, mode: Mode): HTMLButtonElement {
  const toolbar = mode === 'preview'
    ? surface.element.querySelector<HTMLElement>('.markdown-surface--preview > .markdown-toolbar')
    : surface.element.querySelector<HTMLElement>('[role="toolbar"][aria-label="Markdown formatting"]')
  const opener = toolbar && buttonByText(toolbar, mode === 'preview' ? 'Find in preview' : 'Find')
  if (!opener) throw new Error(`Could not find the ${mode} Markdown Find button.`)
  return opener
}

async function openFromToolbar(surface: MountedSurface, mode: Mode): Promise<{ opener: HTMLButtonElement; input: HTMLInputElement }> {
  const opener = searchOpener(surface, mode)
  await act(async () => {
    opener.click()
  })
  const input = await waitFor(() => {
    const candidate = searchInput(surface, mode)
    return candidate && document.activeElement === candidate ? candidate : false
  }, `${mode} search input focus`)
  return { opener, input }
}

async function waitForClosed(surface: MountedSurface): Promise<void> {
  await waitFor(() => searchToolbar(surface) === null || false, 'search toolbar to close')
}

async function waitForFocus(target: HTMLElement, description: string): Promise<void> {
  await waitFor(() => document.activeElement === target ? target : false, description)
}

async function pressEscape(target: HTMLElement): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { target.dispatchEvent(event) })
  return event
}

for (const mode of MODES) {
  test(`${mode} Markdown Find toolbar opening focuses its search input`, async () => {
    const surface = await renderSurface(mode, '# Search focus')
    const { input } = await openFromToolbar(surface, mode)

    expect(document.activeElement).toBe(input)
  })

  test(`${mode} Markdown Find closes on Escape from its input and restores opener focus`, async () => {
    const surface = await renderSurface(mode, '# Search focus')
    const { opener, input } = await openFromToolbar(surface, mode)

    const escape = await pressEscape(input)
    await waitForClosed(surface)
    await waitForFocus(opener, `${mode} Find button focus restoration`)

    expect(escape.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  test(`${mode} Markdown Find Close button restores opener focus`, async () => {
    const surface = await renderSurface(mode, '# Search focus')
    const { opener } = await openFromToolbar(surface, mode)
    const close = buttonByText(searchToolbar(surface)!, 'Close')
    if (!close) throw new Error(`Could not find the ${mode} search Close button.`)

    await act(async () => {
      close.focus()
      close.click()
    })
    await waitForClosed(surface)
    await waitForFocus(opener, `${mode} Find button focus restoration`)

    expect(document.activeElement).toBe(opener)
  })

  test(`${mode} Markdown Find closes on Escape from the formatting toolbar`, async () => {
    const surface = await renderSurface(mode, '# Search focus')
    const { opener } = await openFromToolbar(surface, mode)

    opener.focus()
    const escape = await pressEscape(opener)
    await waitForClosed(surface)
    await waitForFocus(opener, `${mode} Find button focus restoration`)

    expect(escape.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  test(`${mode} Markdown Find handles Escape bubbling from replacement and option controls`, async () => {
    const surface = await renderSurface(mode, '# Search focus')
    const { opener } = await openFromToolbar(surface, mode)
    let toolbar = searchToolbar(surface)
    if (!toolbar) throw new Error(`The ${mode} search toolbar did not open.`)
    const replaceToggle = buttonByText(toolbar, 'Replace')
    if (!replaceToggle) throw new Error(`Could not find the ${mode} Replace toggle.`)
    await act(async () => replaceToggle.click())

    const replaceInput = await waitFor(() => toolbar?.querySelector<HTMLInputElement>('input[aria-label="Replace with"]'), `${mode} replacement input`)
    replaceInput.focus()
    const replaceEscape = await pressEscape(replaceInput)
    await waitForClosed(surface)
    await waitForFocus(opener, `${mode} Find button focus restoration after Escape`)
    expect(replaceEscape.defaultPrevented).toBe(true)

    await openFromToolbar(surface, mode)
    toolbar = searchToolbar(surface)
    if (!toolbar) throw new Error(`The ${mode} search toolbar did not reopen.`)
    const matchCase = toolbar.querySelector<HTMLInputElement>('input[aria-label="Match case"]')
    if (!matchCase) throw new Error(`Could not find the ${mode} Match case option.`)
    matchCase.focus()
    const optionEscape = await pressEscape(matchCase)
    await waitForClosed(surface)
    await waitForFocus(opener, `${mode} Find button focus restoration after option Escape`)

    expect(optionEscape.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(opener)
  })
}

test('Preview command-driven Find focuses its input and restores the original focused element', async () => {
  const surface = await renderSurface('preview', '# Search focus')
  const originalFocus = document.createElement('button')
  originalFocus.type = 'button'
  originalFocus.textContent = 'Original focus target'
  document.body.append(originalFocus)
  originalFocus.focus()
  const find = surface.commands()?.find
  if (!find) throw new Error('The Preview Find command was not registered.')

  let commandResult: unknown
  await act(async () => { commandResult = await find() })
  const input = await waitFor(() => {
    const candidate = searchInput(surface, 'preview')
    return candidate && document.activeElement === candidate ? candidate : false
  }, 'command-opened Preview search input focus')
  expect(commandResult).toEqual({ opened: true, replace: false })
  expect(document.activeElement).toBe(input)

  const close = buttonByText(searchToolbar(surface)!, 'Close')
  if (!close) throw new Error('Could not find the command-opened Preview search Close button.')
  await act(async () => close.click())
  await waitForClosed(surface)
  await waitForFocus(originalFocus, 'original focus restoration after command-driven Preview search')
  expect(document.activeElement).toBe(originalFocus)
})

test('Rich command-driven Find keeps focus through an asynchronous query and restores the original focused element', async () => {
  const pendingSearch = Promise.withResolvers<SearchResult>()
  let searchStarted = false
  const surface = await renderSurface('rich', 'needle in the editor', {
    search(query) {
      searchStarted = query === 'needle'
      return pendingSearch.promise
    }
  })
  const originalFocus = document.createElement('button')
  originalFocus.type = 'button'
  originalFocus.textContent = 'Original focus target'
  document.body.append(originalFocus)
  originalFocus.focus()
  const find = surface.commands()?.find
  if (!find) throw new Error('The Rich Find command was not registered.')

  let commandResult: Promise<unknown> | undefined
  await act(async () => { commandResult = Promise.resolve(find({ query: 'needle' })) })
  await waitFor(() => searchStarted || false, 'asynchronous Rich search request')
  const input = await waitFor(() => {
    const candidate = searchInput(surface, 'rich')
    return candidate && document.activeElement === candidate ? candidate : false
  }, 'command-opened Rich search input focus')
  expect(input.value).toBe('needle')

  await act(async () => {
    pendingSearch.resolve({ total: 0, matches: [] })
    await commandResult
  })
  expect(document.activeElement).toBe(input)

  const close = buttonByText(searchToolbar(surface)!, 'Close')
  if (!close) throw new Error('Could not find the command-opened Rich search Close button.')
  await act(async () => close.click())
  await waitForClosed(surface)
  await waitForFocus(originalFocus, 'original focus restoration after queried Rich search')
  expect(document.activeElement).toBe(originalFocus)
})
