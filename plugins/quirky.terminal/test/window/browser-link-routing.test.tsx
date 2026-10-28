import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, settle, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'
import type { TerminalPaneProps } from '../../src/window/pane/TerminalPaneView'
import type { FakeContext } from '../ui-fake'

let mounted: MountedPane | null = null
let copied: string[]
let originalPlatform: PropertyDescriptor | undefined

beforeAll(loadPane)
afterAll(unloadPane)
beforeEach(() => {
  startRecording()
  copied = []
  originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } })
})
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
  if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform)
  else Reflect.deleteProperty(navigator, 'platform')
})

const URL = 'https://example.test/docs'
const FILE = '/tmp/w/api/src/app.ts'
const click = (init: MouseEventInit = {}) => new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...init })

async function mount(over: Partial<TerminalPaneProps> = {}, extra: Record<string, (params: Record<string, any>) => unknown> = {}) {
  const fake = fakeContext(paneHandlers({ existing: [FILE] }, extra), over.settings)
  mounted = await mountPane(fake, { workspaceId: 'wt-origin', ...over })
  return { fake, pane: mounted }
}

function openLinkCalls(fake: FakeContext) {
  return fake.callsTo('quirky.browser/openLink').map(({ params }) => params)
}

function activateUrl(pane: MountedPane, event = click()) {
  return pane.term().options.linkHandler!.activate(event, URL, { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } })
}

describe('terminal Browser routing', () => {
  test('Actions routes Open in the originating worktree while Copy Link remains explicit', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'actions' }) }, {
      'quirky.browser/openLink': () => ({ route: 'app', pane: 'browser-1' })
    })

    await act(async () => activateUrl(pane))
    const menu = pane.element.querySelector('[data-pane-link-popover]')!
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Open', 'Copy Link'])
    await act(async () => void [...menu.querySelectorAll('button')].find((item) => item.textContent === 'Open')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(openLinkCalls(fake)).toEqual([{ url: URL, worktree: 'id:wt-origin' }])
    expect(fake.callsTo('quirky.terminal/openExternal')).toEqual([])

    await act(async () => activateUrl(pane))
    const copy = pane.element.querySelector('[data-pane-link-popover] button:last-child') as HTMLButtonElement
    await act(async () => void copy.click())
    expect(copied).toEqual([URL])
    expect(openLinkCalls(fake)).toHaveLength(1)
    await act(async () => activateUrl(pane))
    const modifiedOpen = pane.element.querySelector('[data-pane-link-popover] button:first-child') as HTMLButtonElement
    await act(async () => void modifiedOpen.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, shiftKey: true })))
    await settle()
    expect(openLinkCalls(fake)).toEqual([
      { url: URL, worktree: 'id:wt-origin' },
      { url: URL, worktree: 'id:wt-origin', modifier: true, shift: true }
    ])
  })

  test('plain and middle Open plus Cmd and Shift-Cmd URL clicks use Browser routing', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open', 'link-middle-click': 'open' }) }, {
      'quirky.browser/openLink': () => ({ route: 'app', pane: 'browser-1' })
    })

    await act(async () => activateUrl(pane))
    await act(async () => activateUrl(pane, click({ button: 1 })))
    await act(async () => activateUrl(pane, click({ metaKey: true })))
    await act(async () => activateUrl(pane, click({ metaKey: true, shiftKey: true })))
    await act(async () => activateUrl(pane, click({ ctrlKey: true })))
    await settle()

    expect(openLinkCalls(fake)).toEqual([
      { url: URL, worktree: 'id:wt-origin' },
      { url: URL, worktree: 'id:wt-origin' },
      { url: URL, worktree: 'id:wt-origin', modifier: true },
      { url: URL, worktree: 'id:wt-origin', modifier: true, shift: true }
    ])
    expect(copied).toEqual([])
    expect(fake.callsTo('quirky.terminal/openExternal')).toEqual([])
  })

  test('Cmd-click opens files in the editor and Shift-Cmd-click still reveals them', async () => {
    const { fake, pane } = await mount({}, {
      'quirky.worktree/resolve': () => ({ path: '/tmp/w/api' }),
      'quirky.editor/open': () => ({ opened: true }),
      'quirky.terminal/openExternal': () => ({ opened: true })
    })
    const handler = pane.term().options.linkHandler!

    await act(async () => handler.activate(click({ metaKey: true }), `file://${FILE}`, { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }))
    await act(async () => handler.activate(click({ metaKey: true, shiftKey: true }), `file://${FILE}`, { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }))
    await settle()

    expect(fake.callsTo('quirky.editor/open').map(({ params }) => params)).toEqual([{
      worktree: 'id:wt-origin', path: 'src/app.ts', focus: true
    }])
    expect(fake.callsTo('quirky.terminal/openExternal').map(({ params }) => params)).toEqual([{ target: FILE, reveal: true }])
    expect(openLinkCalls(fake)).toEqual([])
  })

  test('falls back to system open only when Browser openLink is not found', async () => {
    const { fake, pane } = await mount({}, { 'quirky.terminal/openExternal': () => ({ opened: true }) })
    await act(async () => activateUrl(pane, click({ metaKey: true })))
    await settle()
    expect(fake.callsTo('quirky.browser/openLink')).toHaveLength(1)
    expect(fake.callsTo('quirky.terminal/openExternal').map(({ params }) => params)).toEqual([{ target: URL }])
  })

  test('does not hide a Browser routing failure with external fallback', async () => {
    const { fake, pane } = await mount({}, {
      'quirky.browser/openLink': () => { throw new RpcError(RpcErrorCode.Conflict, 'in-app route refused') },
      'quirky.terminal/openExternal': () => ({ opened: true })
    })
    await act(async () => activateUrl(pane, click({ metaKey: true })))
    await settle()
    expect(fake.callsTo('quirky.terminal/openExternal')).toEqual([])
    expect(fake.toasts.at(-1)).toEqual({ title: 'Could not open link', body: 'in-app route refused' })
  })
})

test('the current click setting takes effect before deferred events or React props', async () => {
  const { fake, pane } = await mount({ settings: settings({ 'link-click': 'actions' }) }, {
    'quirky.browser/openLink': () => ({ route: 'app', pane: 'browser-1' })
  })
  fake.setSetting('link-click', 'open')
  await act(async () => activateUrl(pane))
  await settle()
  expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
  expect(openLinkCalls(fake)).toEqual([{ url: URL, worktree: 'id:wt-origin' }])

  fake.setSetting('link-click', 'terminal')
  await act(async () => activateUrl(pane))
  await settle()
  expect(openLinkCalls(fake)).toEqual([{ url: URL, worktree: 'id:wt-origin' }])
  expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
})
