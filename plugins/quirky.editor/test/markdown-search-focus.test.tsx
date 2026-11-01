import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import { searchMarkdown, type SearchMatch } from '../src/markdown/source'

type Mode = 'preview' | 'rich'
type PreviewSearchResponse = { total: number; matches: SearchMatch[] }
type DeferredSearchResponse = {
  resolve(value: PreviewSearchResponse | PromiseLike<PreviewSearchResponse>): void
}
type CommandHandlers = Parameters<SurfaceProps['registerCommandHandlers']>[0]
type MountedSurface = {
  element: HTMLElement
  commands(): CommandHandlers | undefined
  unmount(): Promise<void>
}

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

async function renderSurface(
  mode: Mode,
  content: string,
  searchResponse?: (query: string) => Promise<PreviewSearchResponse>
): Promise<MountedSurface> {
  let commands: CommandHandlers | undefined
  const onAction: SurfaceProps['onAction'] = async (method, params) => {
    if (method === 'quirky.editor/markdown') {
      if (params.action === 'capabilities') {
        return mode === 'preview'
          ? { previewAvailable: true, imageUrls: {} }
          : { richEligible: true }
      }
      if (params.action === 'toc') return { headings: [] }
      if (params.action === 'search') {
        const query = typeof params.query === 'string' ? params.query : ''
        if (searchResponse) return searchResponse(query)
        const result = searchMarkdown(content, query, {
          matchCase: params.matchCase === true,
          wholeWord: params.wholeWord === true
        })
        return { total: result.total, matches: result.matches }
      }
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

async function waitFor<T>(condition: () => T | null | undefined | false, description: string, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
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
async function changeInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('The test DOM does not expose the input value setter.')
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

test('Rich command-driven Find highlights a match without taking input focus and restores the opener', async () => {
  const surface = await renderSurface('rich', 'needle in the editor')
  const originalFocus = document.createElement('button')
  originalFocus.type = 'button'
  originalFocus.textContent = 'Original focus target'
  document.body.append(originalFocus)
  originalFocus.focus()
  const find = surface.commands()?.find
  if (!find) throw new Error('The Rich Find command was not registered.')

  await act(async () => { await find({ query: 'needle' }) })
  const input = await waitFor(() => {
    const candidate = searchInput(surface, 'rich')
    return candidate && document.activeElement === candidate ? candidate : false
  }, 'command-opened Rich search input focus')
  expect(input.value).toBe('needle')

  expect(surface.element.querySelector('.markdown-search-match')?.textContent).toBe('needle')
  expect(document.activeElement).toBe(input)

  const close = buttonByText(searchToolbar(surface)!, 'Close')
  if (!close) throw new Error('Could not find the command-opened Rich search Close button.')
  await act(async () => close.click())
  await waitForClosed(surface)
  expect(surface.element.querySelector('.markdown-search-match')).toBeNull()
  await waitForFocus(originalFocus, 'original focus restoration after queried Rich search')
  expect(document.activeElement).toBe(originalFocus)
})

test('Rich Find highlights a nested match and keeps repeated Enter in the search field', async () => {
  const content = '# Heading\n\nAn earlier paragraph.\n\n- [x] First item\n- [ ] Two isolated worktrees\n'
  const surface = await renderSurface('rich', content)
  await act(async () => { await surface.commands()!.find!({ query: 'isolated' }) })
  const input = await waitFor(() => {
    const candidate = searchInput(surface, 'rich')
    return candidate && document.activeElement === candidate ? candidate : false
  }, 'queried Rich search input focus')
  const editor = surface.element.querySelector<HTMLElement>('.ProseMirror')!
  const originalDocument = editor.innerHTML

  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      const { promise, resolve } = Promise.withResolvers<void>()
      requestAnimationFrame(() => resolve())
      await promise
    })
    expect(document.activeElement).toBe(input)
    expect([...editor.querySelectorAll('.markdown-search-match')].map((node) => node.textContent).join('')).toBe('isolated')
    expect(editor.innerHTML).toBe(originalDocument)
  }
})

test('Rich Find Enter advances through repeated matches and wraps without editing', async () => {
  const content = '# needle\n\nA **nee**dle paragraph.\n\n- [ ] Last needle\n'
  const surface = await renderSurface('rich', content)
  await act(async () => { await surface.commands()!.find!({ query: 'needle' }) })
  const input = await waitFor(() => {
    const candidate = searchInput(surface, 'rich')
    return candidate && document.activeElement === candidate ? candidate : false
  }, 'repeated-match search input focus')
  const editor = surface.element.querySelector<HTMLElement>('.ProseMirror')!
  const originalText = editor.textContent
  const originalCheckboxes = editor.querySelectorAll('input[type="checkbox"]').length

  for (const expected of ['2 of 3', '3 of 3', '1 of 3']) {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      const { promise, resolve } = Promise.withResolvers<void>()
      requestAnimationFrame(() => resolve())
      await promise
    })
    expect(searchToolbar(surface)!.textContent).toContain(expected)
    expect(document.activeElement).toBe(input)
    expect([...editor.querySelectorAll('.markdown-search-match')].map((node) => node.textContent).join('')).toBe('needle')
    expect(editor.textContent).toBe(originalText)
    expect(editor.querySelectorAll('input[type="checkbox"]').length).toBe(originalCheckboxes)
  }
})
test('Preview Find highlights and scrolls each source match in nested task text without editing the preview', async () => {
  const content = '---\ntitle: isolated\n---\n# Tasks\n\n- [ ] parent\n  - [ ] isolated task; isolated again\n'
  const surface = await renderSurface('preview', content)
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  const scrollTargets: HTMLElement[] = []
  HTMLElement.prototype.scrollIntoView = function () { scrollTargets.push(this) }
  try {
    let commandResult: unknown
    await act(async () => { commandResult = await surface.commands()!.find!({ query: 'isolated' }) })
    expect(commandResult).toEqual({ opened: true, replace: false, query: 'isolated', total: 2 })
    expect(searchToolbar(surface)?.textContent).toContain('1 of 2')
    const input = await waitFor(() => {
      const candidate = searchInput(surface, 'preview')
      return candidate && document.activeElement === candidate ? candidate : false
    }, 'queried Preview search input focus')
    const article = surface.element.querySelector<HTMLElement>('.markdown-preview-body')!
    const originalText = article.textContent
    const firstMatch = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-preview-search-match'), 'first Preview search highlight')

    expect(searchToolbar(surface)?.textContent).toContain('1 of 2')
    expect(firstMatch.textContent).toBe('isolated')
    expect(firstMatch.closest('li')?.textContent).toContain('isolated task')
    expect(scrollTargets.at(-1)).toBe(firstMatch)
    expect(document.activeElement).toBe(input)

    await act(async () => { buttonByText(searchToolbar(surface)!, 'Next')!.click() })
    expect(searchToolbar(surface)?.textContent).toContain('2 of 2')
    const secondMatch = await waitFor(() => {
      const match = surface.element.querySelector<HTMLElement>('.markdown-preview-search-match')
      return match && match.previousSibling?.textContent === ' isolated task; ' ? match : false
    }, 'next Preview search highlight')
    expect(secondMatch.textContent).toBe('isolated')
    expect(secondMatch.previousSibling?.textContent).toBe(' isolated task; ')
    expect(scrollTargets.at(-1)).toBe(secondMatch)

    await act(async () => { buttonByText(searchToolbar(surface)!, 'Previous')!.click() })
    const previousMatch = await waitFor(() => {
      const match = surface.element.querySelector<HTMLElement>('.markdown-preview-search-match')
      return match && match.previousSibling?.textContent === ' ' ? match : false
    }, 'previous Preview search highlight')
    expect(previousMatch.previousSibling?.textContent).toBe(' ')
    expect(scrollTargets.at(-1)).toBe(previousMatch)
    expect(article.textContent).toBe(originalText)

    await act(async () => { buttonByText(searchToolbar(surface)!, 'Close')!.click() })
    await waitForClosed(surface)
    expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()
    expect(article.textContent).toBe(originalText)
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  }
})

test('Preview Find clears its highlight for no-result and empty queries', async () => {
  const surface = await renderSurface('preview', '- [ ] isolated\n')
  await act(async () => { await surface.commands()!.find!({ query: 'isolated' }) })
  const marker = surface.element.querySelector<HTMLElement>('.markdown-preview-body mark')!
  expect(marker.className).toBe('markdown-preview-search-match')
  await waitFor(() => surface.element.querySelector('.markdown-preview-search-match'), 'Preview search highlight before clearing')

  await act(async () => { await surface.commands()!.find!({ query: 'missing' }) })
  expect(searchToolbar(surface)?.textContent).toContain('No results')
  expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()

  await act(async () => { await surface.commands()!.find!({ query: '' }) })
  expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()
})
test('Preview Find maps unlabeled document links and CRLF-normalized source offsets', async () => {
  const content = '---\r\ntitle: Search offsets\r\n---\r\n# Heading\r\n\r\nSee [[needle]]\r\nThen needle\r\n'
  const surface = await renderSurface('preview', content)
  let commandResult: unknown
  await act(async () => { commandResult = await surface.commands()!.find!({ query: 'needle' }) })
  expect(commandResult).toEqual({ opened: true, replace: false, query: 'needle', total: 2 })
  const article = surface.element.querySelector<HTMLElement>('.markdown-preview-body')!
  const originalText = article.textContent
  const firstMatch = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-preview-search-match'), 'unlabeled document-link Preview highlight')
  expect(firstMatch.closest('a')).not.toBeNull()
  expect(firstMatch.textContent).toBe('needle')

  await act(async () => { buttonByText(searchToolbar(surface)!, 'Next')!.click() })
  expect(searchToolbar(surface)?.textContent).toContain('2 of 2')
  const secondMatch = await waitFor(() => {
    const match = surface.element.querySelector<HTMLElement>('.markdown-preview-search-match')
    return match && !match.closest('a') ? match : false
  }, 'CRLF-normalized next Preview highlight')
  expect(secondMatch.closest('p')?.textContent).toBe('See needle\nThen needle')
  expect(secondMatch.previousSibling?.textContent).toBe('\nThen ')
  expect(article.textContent).toBe(originalText)
})
test('Preview Find highlights matches inside fenced code without editing code text', async () => {
  const content = '# Code\n\n```ts\nconst needle = "raw";\n\n```\n'
  const surface = await renderSurface('preview', content)
  const article = surface.element.querySelector<HTMLElement>('.markdown-preview-body')!
  const originalCodeText = article.querySelector('pre code')?.textContent
  expect(originalCodeText).toBe('const needle = "raw";\n\n')
  await act(async () => { await surface.commands()!.find!({ query: 'needle' }) })

  const match = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-preview-search-match'), 'fenced-code Preview highlight')
  expect(match.textContent).toBe('needle')
  expect(match.closest('code')).not.toBeNull()
  expect(article.querySelector('pre code')?.textContent).toBe(originalCodeText)
})
test('Preview Find leaves Mermaid code for the real diagram renderer', async () => {
  const source = 'graph TD\n  A[needle] --> B[done]'
  const surface = await renderSurface('preview', `\`\`\`mermaid\n${source}\n\`\`\`\n`)
  await act(async () => { await surface.commands()!.find!({ query: 'needle' }) })

  const rendered = await waitFor(() => surface.element.querySelector<HTMLElement>('[role="img"][aria-label="Mermaid diagram"], .markdown-mermaid-error'), 'Mermaid renderer result', 10_000)
  if (rendered.classList.contains('markdown-mermaid-error')) {
    expect(rendered.querySelector('details pre')?.textContent).toBe(source)
  } else {
    expect(rendered.querySelector('svg')).not.toBeNull()
  }
  expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()
})

test('Preview command Find ignores delayed results after empty-query and Close changes', async () => {
  const content = 'needle in a paragraph'
  const deferred: DeferredSearchResponse[] = []
  const surface = await renderSurface('preview', content, () => {
    const response = Promise.withResolvers<PreviewSearchResponse>()
    deferred.push({ resolve: response.resolve })
    return response.promise
  })
  let pendingAfterEmpty: unknown
  await act(async () => { pendingAfterEmpty = surface.commands()!.find!({ query: 'needle' }) })
  await act(async () => { await surface.commands()!.find!({ query: '' }) })
  deferred[0]!.resolve({ total: 1, matches: searchMarkdown(content, 'needle').matches })
  await act(async () => { await pendingAfterEmpty })
  expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()

  let pendingAfterClose: unknown
  await act(async () => { pendingAfterClose = surface.commands()!.find!({ query: 'needle' }) })
  await act(async () => { buttonByText(searchToolbar(surface)!, 'Close')!.click() })
  await waitForClosed(surface)
  deferred[1]!.resolve({ total: 1, matches: searchMarkdown(content, 'needle').matches })
  await act(async () => { await pendingAfterClose })
  expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()
})

test('Preview toolbar Find ignores a delayed result after its query is emptied', async () => {
  const content = 'needle in a paragraph'
  const deferred = Promise.withResolvers<PreviewSearchResponse>()
  let searchRequests = 0
  const surface = await renderSurface('preview', content, () => {
    searchRequests += 1
    return deferred.promise
  })
  await act(async () => { await surface.commands()!.find!() })
  const input = searchInput(surface, 'preview')!
  await changeInputValue(input, 'needle')
  await act(async () => { buttonByText(searchToolbar(surface)!, 'Find')!.click() })
  await waitFor(() => searchRequests === 1 ? true : false, 'deferred toolbar search request')
  await changeInputValue(input, '')

  deferred.resolve({ total: 1, matches: searchMarkdown(content, 'needle').matches })
  await act(async () => { await deferred.promise })
  expect(surface.element.querySelector('.markdown-preview-search-match')).toBeNull()
})
