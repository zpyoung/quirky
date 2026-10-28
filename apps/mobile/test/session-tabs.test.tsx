import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MobileMarkdownDocument, MobileWorkspaceTab } from '@quirky/protocol'
import type { MobilePageBridge } from '../src/contracts'
import type { Root, createRoot as ReactCreateRoot } from 'react-dom/client'
import { MarkdownPreview } from '../src/pages/MarkdownPreview'
import { MarkdownTabView } from '../src/pages/MarkdownTabView'
import { BrowserWatchView } from '../src/pages/BrowserWatchView'
import { startBrowserHarness } from '../../../plugins/quirky.browser/test/harness'
import type { BrowserTestHarness } from '../../../plugins/quirky.browser/test/harness'

let container: HTMLDivElement | null = null
let root: Root | null = null
let createRoot: typeof ReactCreateRoot

beforeAll(async () => {
  const runtimeNames = [
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
    'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket',
    'Response', 'Request', 'Headers', 'AbortController', 'AbortSignal'
  ] as const
  const runtimeGlobals = runtimeNames.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
  GlobalRegistrator.register()
  // This file mounts DOM UI and an in-process daemon; keep real network and timer primitives.
  for (const [name, value] of runtimeGlobals) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No button named ${name}`)
  return button
}

async function click(name: string): Promise<void> {
  await act(async () => {
    buttonNamed(name).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

async function changeText(selector: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (!field) throw new Error(`No field matches ${selector}`)
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function mount(element: ReactNode): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Fragment, null, element))
    await Promise.resolve()
  })
}

async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await read()
    if (value != null) return value
    await act(async () => { await Bun.sleep(20) })
  }
  throw new Error(`Browser Watch UI condition did not become true within ${timeoutMs}ms`)
}

test('phone Markdown preview keeps raw HTML and external resources inert', () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, {
    text: '# Safe heading\n\n<script>globalThis.__phoneMarkdownPwned = true</script>\n\n![pixel](https://images.invalid/pixel.png)\n\n<img src=\"https://images.invalid/x\" onerror=\"alert(1)\">'
  }))
  const rendered = document.createElement('div')
  rendered.innerHTML = html
  expect(rendered.querySelector('h1')?.textContent).toBe('Safe heading')
  expect(rendered.querySelector('script, img, iframe, audio, video, source')).toBeNull()
  expect([...rendered.querySelectorAll('*')].some((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name)))).toBe(false)
  expect(rendered.textContent).toContain('globalThis.__phoneMarkdownPwned = true')
  expect(rendered.textContent).toContain('https://images.invalid/x')
  expect((globalThis as Record<string, unknown>).__phoneMarkdownPwned).toBeUndefined()
})

test('Markdown tab preserves local text through stale saves and cancelled dirty close', async () => {
  let documentValue: MobileMarkdownDocument = {
    tabId: 'ui-tab-md', worktreeId: 'wt-md', title: 'Phone note.md', relativePath: 'Phone note.md',
    text: '# Original\n', revision: 4, dirty: false, readOnly: false
  }
  let rejectSave = true
  let closeNotified = false
  const bridge = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === 'quirky.mobile/markdownRead') return documentValue as T
      if (method === 'quirky.mobile/markdownWrite') {
        if (params.expectedRevision !== documentValue.revision) throw new Error('stale revision')
        documentValue = { ...documentValue, text: String(params.text), revision: documentValue.revision + 1, dirty: true }
        return documentValue as T
      }
      if (method === 'quirky.mobile/markdownSave') {
        if (rejectSave) {
          rejectSave = false
          throw new Error('stale revision')
        }
        if (params.expectedRevision !== documentValue.revision) throw new Error('stale revision')
        documentValue = { ...documentValue, revision: documentValue.revision + 1, dirty: false }
        return documentValue as T
      }
      if (method === 'quirky.mobile/sessionTabAction' && params.action === 'close') {
        if (params.discard !== true && documentValue.dirty) return { tabId: documentValue.tabId, closed: false } as T
        return { tabId: documentValue.tabId, closed: true } as T
      }
      throw new Error(`Unexpected method ${method}`)
    },
    native: { async clipboardWrite() {} }
  } as unknown as MobilePageBridge
  const tab: MobileWorkspaceTab = { tabId: documentValue.tabId, worktreeId: documentValue.worktreeId, kind: 'markdown', title: documentValue.title, dirty: false }
  await mount(createElement(MarkdownTabView, {
    bridge, worktreeId: documentValue.worktreeId, tab, canMutate: true, canCopy: true, onTabsChanged() {}, onClosed() { closeNotified = true }
  }))

  await changeText('textarea[aria-label=\"Markdown source\"]', '# Phone edit\n')
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await click('Preview')
  expect(container?.querySelector('h1')?.textContent).toBe('Phone edit')

  await click('Source')
  await click('Save')
  expect(container?.querySelector<HTMLTextAreaElement>('textarea[aria-label=\"Markdown source\"]')?.value).toBe('# Phone edit\n')
  expect(container?.textContent).toContain('stale revision')
  await click('Save')
  expect(container?.querySelector('.qp-count')?.textContent).toBe('Saved')

  await changeText('textarea[aria-label=\"Markdown source\"]', '# Unsaved phone edit\n')
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await click('Close tab')
  expect(container?.textContent).toContain('Discard draft and close')
  expect(container?.querySelector<HTMLTextAreaElement>('textarea[aria-label=\"Markdown source\"]')?.value).toBe('# Unsaved phone edit\n')
  await click('Keep editing')
  expect(container?.querySelector<HTMLTextAreaElement>('textarea[aria-label=\"Markdown source\"]')?.value).toBe('# Unsaved phone edit\n')
  await click('Close tab')
  await click('Discard draft and close')
  expect(closeNotified).toBe(true)
})

test('Native Browser tabs stay unavailable and never convert on the phone', async () => {
  const bridge = {
    async call<T>(): Promise<T> { throw new Error('Unexpected Native Browser operation') }
  } as unknown as MobilePageBridge
  const tab = { tabId: 'native-browser-tab', worktreeId: 'wt-md', kind: 'browser' as const, title: 'Human page', dirty: false, browserMode: 'native' as const }
  await mount(createElement(BrowserWatchView, { bridge, worktreeId: tab.worktreeId, tab, canMutate: true, onTabsChanged() {}, onClosed() {} }))
  expect(container?.textContent).toContain('Native browser cannot stream to phone')
  expect(container?.textContent).toContain('Switch it to Watch explicitly on the desktop')
  expect(container?.textContent).not.toContain('Unexpected Native Browser operation')
})

test('Browser Watch scrolls the real page using coordinates in the displayed frame', async () => {
  const previousPort = process.env.QUIRKY_MOBILE_PORT
  process.env.QUIRKY_MOBILE_PORT = '0'
  let harness: BrowserTestHarness | undefined
  try {
    harness = await startBrowserHarness({}, { includeMobile: true })
    const client = harness.client
    const worktree = await harness.addFolderWorktree('mobile-wheel')
    const watch = await client.callAny('quirky.mobile/browserWatchCreate', {
      worktree, url: `${harness.fixtureUrl}tall`
    }) as { tab: MobileWorkspaceTab; watchId: string }
    const panes = await client.callAny('quirky.browser/paneState', { worktree: `id:${worktree}` }) as {
      tabs: Array<{ tabId?: string; page: string | null }>
    }
    const pane = panes.tabs.find((item) => item.tabId === watch.tab.tabId)
    if (!pane?.page) throw new Error('The real Browser Watch tab must own its Chrome page.')
    const bridge = {
      call<T>(method: string, values?: Record<string, unknown>): Promise<T> {
        return client.callAny(method, values) as Promise<T>
      }
    } as unknown as MobilePageBridge
    await mount(createElement(BrowserWatchView, {
      bridge, worktreeId: worktree, tab: { ...watch.tab, browserMode: 'watch' }, canMutate: true, onTabsChanged() {}, onClosed() {}
    }))
    const image = await waitFor(async () => {
      const candidate = document.querySelector<HTMLImageElement>('.qp-browser-watch img')
      return candidate && candidate.naturalWidth > 0 && candidate.naturalHeight > 0 ? candidate : null
    })
    const display = new DOMRect(20, 30, image.naturalWidth / 2, image.naturalHeight / 2)
    image.getBoundingClientRect = () => display
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 150 })
    // Happy DOM's WheelEvent extends UIEvent and omits the standard MouseEvent coordinates.
    Object.defineProperties(wheel, {
      clientX: { value: display.left + display.width / 2 },
      clientY: { value: display.top + display.height / 2 }
    })
    await act(async () => {
      image.dispatchEvent(wheel)
      await Promise.resolve()
    })
    const scrollTop = await waitFor(async () => {
      const result = await client.callAny('quirky.browser/eval', {
        page: pane.page, expression: 'document.scrollingElement.scrollTop'
      }) as { value?: unknown }
      return typeof result.value === 'number' && result.value > 0 ? result.value : null
    })
    expect(scrollTop).toBeGreaterThan(0)
  } finally {
    if (root) {
      await act(async () => root?.unmount())
      root = null
    }
    if (harness) await harness.cleanup()
    if (previousPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousPort
  }
}, 90_000)

