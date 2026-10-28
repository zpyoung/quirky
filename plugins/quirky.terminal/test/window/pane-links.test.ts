import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'
import type { TerminalPaneProps } from '../../src/window/pane/TerminalPaneView'

let mounted: MountedPane | null = null
let providers: ILinkProvider[]
let restoreRegister: () => void
let copied: string[]

beforeAll(loadPane)
afterAll(unloadPane)
beforeEach(async () => {
  startRecording()
  providers = []
  copied = []
  const { Terminal } = await import('@xterm/xterm')
  const register = Terminal.prototype.registerLinkProvider
  Terminal.prototype.registerLinkProvider = function (this: Terminal, provider: ILinkProvider) {
    providers.push(provider)
    return register.call(this, provider)
  }
  restoreRegister = () => {
    Terminal.prototype.registerLinkProvider = register
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text), readText: async () => '' } })
})
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  restoreRegister()
  stopRecording()
  document.body.innerHTML = ''
})

const FILE = '/tmp/w/api/src/app.ts'

async function mount(over: Partial<TerminalPaneProps> = {}, handlers = paneHandlers({ existing: [FILE] })) {
  const fake = fakeContext(handlers, over.settings)
  mounted = await mountPane(fake, over)
  await fake.push(101, 'docs https://example.com/x and src/app.ts:12:4 and src/missing.ts\r\n')
  await mounted.flush()
  return { fake, pane: mounted }
}

function linksFrom(provider: ILinkProvider, y = 1): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(y, (links) => resolve(links ?? [])))
}

/** Every link on row `y`, from the web-links provider and the file-path provider. */
async function allLinks(y = 1): Promise<ILink[]> {
  return (await Promise.all(providers.map((provider) => linksFrom(provider, y)))).flat()
}

const url = async () => (await allLinks()).find((link) => link.text.startsWith('https://'))!
const path = async () => (await allLinks()).find((link) => link.text.startsWith('src/app.ts'))!
const click = (init: MouseEventInit = {}) => new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...init })
const opened = (fake: ReturnType<typeof fakeContext>) => fake.callsTo('quirky.terminal/openExternal').map((call) => call.params)
const hint = (pane: MountedPane) => pane.element.querySelector('[data-pane-link-hint]')?.textContent ?? null

describe('SC-40: links are found and hinted', () => {
  test('a URL and an existing relative path are links, a missing path is not', async () => {
    const { fake } = await mount()
    const texts = (await allLinks()).map((link) => link.text)
    expect(texts).toContain('https://example.com/x')
    expect(texts).toContain('src/app.ts:12:4')
    expect(texts.some((text) => text.includes('missing'))).toBe(false)
    expect(fake.callsTo('quirky.terminal/pathsExist')[0]!.params.paths).toEqual([FILE, '/tmp/w/api/src/missing.ts'])
  })

  test('hovering shows the target at the pane bottom-left and leaving hides it', async () => {
    const { pane } = await mount()
    const file = await path()
    await act(async () => file.hover!(new MouseEvent('mousemove'), file.text))
    expect(hint(pane)).toBe('/tmp/w/api/src/app.ts:12:4')
    await act(async () => file.leave!(new MouseEvent('mousemove'), file.text))
    expect(hint(pane)).toBeNull()
    const link = await url()
    await act(async () => link.hover!(new MouseEvent('mousemove'), link.text))
    expect(hint(pane)).toBe('https://example.com/x')
  })

  test('an OSC 8 hyperlink hints and activates through the link handler', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open' }) })
    const handler = pane.term().options.linkHandler!
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }
    await act(async () => handler.hover!(new MouseEvent('mousemove'), 'https://example.com/docs', range))
    expect(hint(pane)).toBe('https://example.com/docs')
    await act(async () => handler.leave!(new MouseEvent('mousemove'), 'https://example.com/docs', range))
    expect(hint(pane)).toBeNull()
    await act(async () => handler.activate(click(), 'https://example.com/docs', range))
    expect(opened(fake)).toEqual([{ target: 'https://example.com/docs' }])
  })

  test('an OSC 8 link with an unsafe scheme does nothing', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open' }) })
    const handler = pane.term().options.linkHandler!
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }
    await act(async () => handler.activate(click(), 'javascript:alert(1)', range))
    expect(opened(fake)).toEqual([])
  })

  test('an OSC 8 file URL opens as a path', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open' }) })
    const handler = pane.term().options.linkHandler!
    await act(async () => handler.activate(click(), 'file:///tmp/w/api/a%20b.txt', { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }))
    expect(opened(fake)).toEqual([{ target: '/tmp/w/api/a b.txt' }])
  })

  test('a failing existence check yields no file links and leaves the pane working', async () => {
    const { fake, pane } = await mount({}, paneHandlers({}, { 'quirky.terminal/pathsExist': () => Promise.reject(new Error('boom')) }))
    const texts = (await allLinks()).map((link) => link.text)
    expect(texts).toEqual(['https://example.com/x'])
    await act(async () => pane.term().input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toHaveLength(1)
  })

  test('relative paths follow the cwd prop', async () => {
    const { fake, pane } = await mount()
    await pane.rerender({ cwd: '/tmp/other' })
    await allLinks()
    expect(fake.callsTo('quirky.terminal/pathsExist').at(-1)!.params.paths[0]).toBe('/tmp/other/src/app.ts')
  })
})

describe('SC-41: what each click does', () => {
  test('a plain click on a URL shows Open and Copy Link, and each does its thing', async () => {
    const { fake, pane } = await mount()
    const link = await url()
    await act(async () => link.activate(click({ clientX: 30, clientY: 40 }), link.text))
    const menu = pane.element.querySelector('[data-pane-link-popover]') as HTMLElement
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Open', 'Copy Link'])
    expect(opened(fake)).toEqual([])
    await act(async () => void ([...menu.querySelectorAll('button')].find((b) => b.textContent === 'Open') as HTMLElement).click())
    expect(opened(fake)).toEqual([{ target: 'https://example.com/x' }])
    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()

    await act(async () => link.activate(click(), link.text))
    await act(async () => void ([...pane.element.querySelectorAll('button')].find((b) => b.textContent === 'Copy Link') as HTMLElement).click())
    expect(copied).toEqual(['https://example.com/x'])
  })

  test('a plain click on a file shows the three file actions', async () => {
    const { fake, pane } = await mount()
    const link = await path()
    await act(async () => link.activate(click(), link.text))
    const buttons = () => [...pane.element.querySelectorAll('[data-pane-link-popover] button')] as HTMLElement[]
    expect(buttons().map((item) => item.textContent)).toEqual(['Open with Default App', 'Reveal in Finder', 'Copy Path'])
    await act(async () => void buttons()[1]!.click())
    expect(opened(fake)).toEqual([{ target: FILE, reveal: true }])
    await act(async () => link.activate(click(), link.text))
    await act(async () => void buttons()[0]!.click())
    await act(async () => link.activate(click(), link.text))
    await act(async () => void buttons()[2]!.click())
    expect(opened(fake).at(-1)).toEqual({ target: FILE })
    expect(copied).toEqual([FILE])
  })


  test('a middle click follows its setting and an Option-click does nothing', async () => {
    const { fake, pane } = await mount()
    const link = await url()
    await act(async () => link.activate(click({ button: 1 }), link.text))
    expect(opened(fake)).toEqual([{ target: 'https://example.com/x' }])
    await act(async () => link.activate(click({ altKey: true }), link.text))
    await act(async () => link.activate(click({ button: 2 }), link.text))
    expect(opened(fake)).toHaveLength(1)
    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
  })

  test('the plain click setting Open opens, and Leave to terminal does nothing', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open' }) })
    const link = await url()
    await act(async () => link.activate(click(), link.text))
    expect(opened(fake)).toEqual([{ target: 'https://example.com/x' }])
    fake.setSetting('link-click', 'terminal')
    await pane.rerender({ settings: settings({ 'link-click': 'terminal' }) })
    await act(async () => link.activate(click(), link.text))
    expect(opened(fake)).toHaveLength(1)
    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
  })

  test('a click that ends a text selection is not a link click', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open' }) })
    const link = await url()
    pane.term().select(0, 0, 10)
    await act(async () => link.activate(click(), link.text))
    expect(opened(fake)).toEqual([])
  })

  test('a failed open shows a toast', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'link-click': 'open' }) }, paneHandlers({ existing: [FILE] }, { 'quirky.terminal/openExternal': () => Promise.reject(new Error('refused')) }))
    const link = await url()
    await act(async () => link.activate(click(), link.text))
    await act(async () => void new Promise((resolve) => setTimeout(resolve, 0)))
    expect(fake.toasts[0]).toEqual({ title: 'Could not open link', body: 'refused' })
    expect(pane.element.querySelector('[data-terminal-pane]')).not.toBeNull()
  })

  test('the popover closes on Escape', async () => {
    const { pane } = await mount()
    const link = await url()
    await act(async () => link.activate(click(), link.text))
    expect(pane.element.querySelector('[data-pane-link-popover]')).not.toBeNull()
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
  })
})
