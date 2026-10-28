import { afterAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { DesignPayload, DesignSelection } from '../src/design-contract'
import { DesignWindow, setLiveDesignPageKeys } from '../src/design-window/DesignWindow'

const RUNTIME_GLOBALS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket'] as const
const nativeGlobals = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
GlobalRegistrator.register()
for (const [name, value] of nativeGlobals) {
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  setLiveDesignPageKeys([])
  GlobalRegistrator.unregister()
})
beforeEach(() => { document.body.innerHTML = ''; setLiveDesignPageKeys([]) })

const payload = (url: string): DesignPayload => ({
  page: { sanitizedUrl: url, title: 'Fixture', viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1, capturedAt: '2026-10-27T00:00:00.000Z' },
  target: {
    tagName: 'button', selector: '#save', elementPath: 'button#save', fullPath: 'html > body > button#save', cssClasses: '', nearbyElements: [],
    selectedText: null, isFixed: false, reactComponents: null, sourceFile: null, textSnippet: 'Save', htmlSnippet: '<button id="save">Save</button>', attributes: { id: 'save' },
    accessibility: { role: 'button', accessibleName: 'Save', ariaLabel: '', ariaLabelledBy: '' },
    rectViewport: { x: 20, y: 30, width: 80, height: 24 }, rectPage: { x: 20, y: 30, width: 80, height: 24 }, computedStyles: { display: 'inline-block' }
  },
  nearbyText: [], ancestorPath: ['html', 'body'], screenshot: null
})

function fakeContext(selection: DesignSelection | ((index: number) => DesignSelection), selectionCount = 1) {
  let nextOp = 0
  let selectionIndex = 0
  const delivered = new Set<string>()
  const writes: string[] = []
  const messages: { text: string; kind: 'info' | 'error' }[] = []
  const onMessage = (text: string, kind: 'info' | 'error') => { messages.push({ text, kind }) }
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'quirky.browser/designArm') return { opId: `op-${++nextOp}` }
      if (method === 'quirky.browser/designRead') {
        const opId = typeof params.opId === 'string' ? params.opId : ''
        if (!delivered.has(opId) && selectionIndex < selectionCount) {
          delivered.add(opId)
          const next = typeof selection === 'function' ? selection(selectionIndex) : selection
          selectionIndex++
          return { opId, status: 'armed', selection: next }
        }
        return { opId: params.opId, status: 'armed' }
      }
      if (method === 'quirky.browser/designHover') return { payload: null }
      if (method === 'quirky.browser/designCancel') return { cancelled: true }
      if (method === 'quirky.browser/designFormat') return { text: 'Attached browser context from fixture' }
      if (method === 'quirky.browser/designTargets') return { sessions: [], agents: [] }
      throw new Error(`Unexpected browser call ${method}`)
    }
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  return { context: context as unknown as UiPluginContext, writes, messages, onMessage }
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !predicate(); i++) {
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 5)
    await delay.promise
  }
  expect(predicate()).toBe(true)
}

function mount(selection: DesignSelection | ((index: number) => DesignSelection), url = 'https://example.test/a', selectionCount = 1) {
  const fake = fakeContext(selection, selectionCount)
  setLiveDesignPageKeys(['page-1'])
  const host = document.createElement('div')
  const rootElement = document.createElement('div')
  document.body.append(host, rootElement)
  const root: Root = createRoot(rootElement)
  const pane = { id: 'pane-1', mode: 'watch' as const, page: 'page-1', url, title: 'Fixture', loading: false, error: null, worktreeId: 'worktree-1' }
  const render = (nextPane = pane) => act(() => root.render(<DesignWindow
    context={fake.context}
    pane={nextPane}
    nativeHandle={null}
    pageHost={host}
    watchReady
    onMessage={fake.onMessage}
  />))
  render()
  return { ...fake, host, root, render, pane, rootElement }
}

const button = (root: ParentNode, name: string) => {
  const found = [...root.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name || entry.getAttribute('aria-label') === name)
  if (!found) throw new Error(`Button ${name} was not found`)
  return found
}

test('right-click selection offers actions without changing the clipboard', async () => {
  const selection: DesignSelection = { kind: 'context-selected', payload: payload('https://example.test/a') }
  const ui = mount(selection)
  await act(async () => { button(ui.rootElement, 'Grab').click() })
  await settleUntil(() => [...ui.host.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Copy'))
  expect(ui.writes).toEqual([])
  expect(ui.messages).toEqual([])
  await act(async () => { button(ui.host, 'Copy').click() })
  expect(ui.writes).toEqual(['Attached browser context from fixture'])
  expect(ui.messages).toContainEqual({ text: 'Copied', kind: 'info' })
  await act(async () => ui.root.unmount())
})

test('an annotation keeps the selected page URL when the browser navigates', async () => {
  const selection: DesignSelection = { kind: 'selected', payload: payload('https://example.test/original') }
  const ui = mount(selection, 'https://example.test/original')
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this note on its original page')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(ui.host, 'Add').click() })
  await settleUntil(() => ui.host.textContent?.includes('Keep this note on its original page') === true)
  ui.render({ ...ui.pane, url: 'https://example.test/next' })
  expect(ui.host.textContent).toContain('https://example.test/original')
  await act(async () => ui.root.unmount())
})

test('annotations survive a hosted pane unmount and remount for the same live page', async () => {
  const url = 'https://example.test/retained'
  const selection: DesignSelection = { kind: 'selected', payload: payload(url) }
  const first = mount(selection, url)
  await act(async () => { button(first.rootElement, 'Annotate').click() })
  await settleUntil(() => first.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  const textarea = first.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this note while the hosted pane remounts')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(first.host, 'Add').click() })
  await settleUntil(() => first.host.textContent?.includes('Keep this note while the hosted pane remounts') === true)
  await act(async () => first.root.unmount())

  const remounted = mount(selection, url)
  expect(remounted.host.textContent).toContain('Keep this note while the hosted pane remounts')
  expect(remounted.host.textContent).toContain(url)
  await act(async () => remounted.root.unmount())
})

test('the annotation tray keeps the newest 20 notes and drops the oldest', async () => {
  const url = 'https://example.test/page'
  const ui = mount((index) => {
    const selected = payload(url)
    return { kind: 'selected', payload: { ...selected, target: { ...selected.target, textSnippet: `Element ${index + 1}` } } }
  }, url, 21)
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  for (let index = 0; index < 21; index++) {
    await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
    const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
    await act(async () => {
      textarea.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, `Note ${index + 1}`)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
    })
    await act(async () => { button(ui.host, 'Add').click() })
  }
  await settleUntil(() => ui.host.querySelectorAll('.qbp-design-note').length === 20)
  const comments = [...ui.host.querySelectorAll('.qbp-design-note p')].map((entry) => entry.textContent)
  expect(comments).toHaveLength(20)
  expect(comments[0]).toContain('Note 2')
  expect(comments).not.toContain('Change: Note 1')
  expect(comments[19]).toContain('Note 21')
  await act(async () => ui.root.unmount())
})
