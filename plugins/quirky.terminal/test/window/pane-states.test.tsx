import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { terminalCommands } from '../../src/window/commands'
import type { TerminalPaneProps } from '../../src/window/pane/TerminalPaneView'
import { fakeContext, type FakeContext } from '../ui-fake'
import { act } from 'react'
import { mountPane, paneHandlers, type MountedPane, type PaneWindowAdapterOptions } from './pane-support'
import {
  conceptualWorkspace,
  fakeDaemon,
  loadWorkspace,
  mountFixture,
  settle,
  startRecording,
  stopRecording,
  unloadWorkspace,
  type MountedWorkspace
} from './workspace-support'
import {
  copyTextCommand,
  dockFocusCommand,
  requestWindowCommand,
  searchCloseCommand,
  searchCommand,
  searchNextCommand,
  searchPreviousCommand,
  type WindowCommandDescriptor
} from '../../src/window/pane/commands'

import type { WorkspaceController } from '../../src/window/workspace/controller'

const WORKTREE_VIEW = 'view:quirky.session/worktree'
type MountedProvider = {
  fake: FakeContext
  element: HTMLElement
  controller: () => WorkspaceController
  reports: unknown[]
  unmount(): Promise<void>
}

let mountedProvider: MountedProvider | null = null
let deactivateUi: (() => void) | null = null

let restoreClipboard: (() => void) | null = null
let mountedPane: MountedPane | null = null
let mountedWorkspace: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mountedPane?.unmount()
  mountedPane = null
  await mountedWorkspace?.unmount()
  mountedWorkspace = null
  await mountedProvider?.unmount()
  mountedProvider = null
  deactivateUi?.()
  deactivateUi = null
  stopRecording()
  document.body.innerHTML = ''
  restoreClipboard?.()
  restoreClipboard = null
})

function setClipboard(writeText?: (text: string) => Promise<void>): void {
  if (restoreClipboard === null) {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    restoreClipboard = () => {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText }
  })
}

describe('terminal pane command contracts', () => {
  test('copies explicit link text without a mounted workspace', async () => {
    const copied: string[] = []
    setClipboard(async (value) => { copied.push(value) })
    const commands = terminalCommands(fakeContext().context)

    await expect(commands.copy!({ text: 'https://example.test/x' })).resolves.toEqual({ text: 'https://example.test/x' })
    await expect(commands.copy!({ text: '' })).resolves.toEqual({ text: '' })
    expect(copied).toEqual(['https://example.test/x', ''])
  })

  test('rejects explicit non-string text before workspace resolution', async () => {
    const commands = terminalCommands(fakeContext().context)
    await expect(commands.copy!({ text: 42 })).rejects.toThrow('text must be a string')
  })

  test('reports unavailable clipboard access and propagates clipboard rejection', async () => {
    const commands = terminalCommands(fakeContext().context)
    setClipboard()
    await expect(commands.copy!({ text: 'x' })).rejects.toThrow('Clipboard access is unavailable in this window.')

    setClipboard(async () => { throw new Error('clipboard offline') })
    await expect(commands.copy!({ text: 'x' })).rejects.toThrow('clipboard offline')
  })

  test('publishes explicit copy text and pane-scoped search arguments', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../quirky-plugin.json', import.meta.url)), 'utf8')) as {
      contributes?: { command?: { id: string; args?: { properties?: Record<string, { type?: string }> } }[] }
    }
    const copy = manifest.contributes?.command?.find((entry) => entry.id === 'copy')
    const search = manifest.contributes?.command?.find((entry) => entry.id === 'search')

    expect(copy?.args?.properties?.text?.type).toBe('string')
    expect(search?.args?.properties?.pane?.type).toBe('string')
  })
})

type WindowRequest = { method: string; params: Record<string, unknown> }

function exactWindowContext(
  self: () => unknown | Promise<unknown>,
  run: (params: Record<string, unknown>) => unknown | Promise<unknown>
) {
  const fake = fakeContext()
  const requests: WindowRequest[] = []
  const ownerCalls = { count: 0 }
  const call = fake.context.call.bind(fake.context)
  fake.context.call = async (method, params = {}) => {
    requests.push({ method, params })
    if (method === 'ui.window.self') return self()
    if (method === 'ui.window.command.run') return run(params)
    return call(method, params)
  }
  fake.context.executeCommand = async () => {
    ownerCalls.count += 1
    throw new Error('owner command fallback was used')
  }
  return { context: fake.context, requests, ownerCalls, fake }
}

describe('exact-window pane command dispatch', () => {
  test('builds literal descriptors for every pane action', () => {
    expect(searchCommand('pane-3', { query: '19', regex: true })).toEqual({
      command: 'command:quirky.terminal/search',
      args: { pane: 'pane-3', query: '19', regex: true }
    })
    expect(searchNextCommand('pane-3')).toEqual({ command: 'command:quirky.terminal/search-next', args: { pane: 'pane-3' } })
    expect(searchPreviousCommand('pane-3')).toEqual({ command: 'command:quirky.terminal/search-previous', args: { pane: 'pane-3' } })
    expect(searchCloseCommand('pane-3')).toEqual({ command: 'command:quirky.terminal/search-close', args: { pane: 'pane-3' } })
    expect(copyTextCommand('https://example.test/x')).toEqual({
      command: 'command:quirky.terminal/copy',
      args: { text: 'https://example.test/x' }
    })
    expect(dockFocusCommand('pane-3')).toEqual({
      command: 'command:quirky.terminal-dock/focus',
      args: { pane: 'pane-3' }
    })
  })

  test('caches self per context without crossing windows', async () => {
    const first = exactWindowContext(() => ({ connId: 42 }), (params) => ({ result: params.connId }))
    const second = exactWindowContext(() => ({ connId: 43 }), (params) => ({ result: params.connId }))
    const descriptor: WindowCommandDescriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(first.context, descriptor)).resolves.toBe(42)
    await expect(requestWindowCommand(second.context, descriptor)).resolves.toBe(43)
    await expect(requestWindowCommand(first.context, descriptor)).resolves.toBe(42)

    expect(first.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(1)
    expect(second.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(1)
    expect(first.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([42, 42])
    expect(second.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([43])
    expect(first.ownerCalls.count).toBe(0)
  })

  test('rejects an invalid connection and retries a failed self lookup on the next action', async () => {
    let calls = 0
    const fixture = exactWindowContext(
      () => {
        calls += 1
        if (calls === 1) return { connId: 0 }
        if (calls === 2) throw new Error('window gone')
        return { connId: 42 }
      },
      () => ({ result: 'ok' })
    )
    const descriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(fixture.context, descriptor)).rejects.toThrow('No live window connection is available.')
    await expect(requestWindowCommand(fixture.context, descriptor)).rejects.toThrow('window gone')
    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe('ok')
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(3)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(1)
  })

  test('does not replay a failed command and reacquires its dead connection', async () => {
    let connId = 42
    let fail = true
    const fixture = exactWindowContext(
      () => ({ connId }),
      (params) => {
        if (fail) {
          fail = false
          throw new Error('connection closed')
        }
        return { result: 'ok' }
      }
    )
    const descriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(fixture.context, descriptor)).rejects.toThrow('connection closed')
    connId = 43
    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe('ok')
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self').map(({ method }) => method)).toHaveLength(2)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([42, 43])
  })

  test('rejects command refusal objects using their reason', async () => {
    const fixture = exactWindowContext(() => ({ connId: 42 }), () => ({
      result: { ok: false, reason: 'no mounted terminal workspace holds pane-3' }
    }))
    await expect(requestWindowCommand(fixture.context, searchNextCommand('pane-3'))).rejects.toThrow('no mounted terminal workspace holds pane-3')
  })
  test('refreshes a cached connection after the window reconnects', async () => {
    let selfCalls = 0
    const fixture = exactWindowContext(
      () => ({ connId: selfCalls++ === 0 ? 42 : 43 }),
      (params) => ({ result: params.connId })
    )
    const descriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe(42)
    await fixture.fake.setConnection('reconnecting')
    await fixture.fake.setConnection('connected')
    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe(43)

    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(2)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([42, 43])
  })

  test('rejects a self reply made stale by reconnect and reacquires the new connection', async () => {
    const firstSelf = Promise.withResolvers<unknown>()
    let selfCalls = 0
    const fixture = exactWindowContext(
      () => {
        selfCalls += 1
        return selfCalls === 1 ? firstSelf.promise : { connId: 43 }
      },
      (params) => ({ result: params.connId })
    )
    const descriptor = searchNextCommand('pane-3')
    const staleRequest = requestWindowCommand(fixture.context, descriptor)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(1)

    await fixture.fake.setConnection('reconnecting')
    await fixture.fake.setConnection('connected')
    firstSelf.resolve({ connId: 42 })
    await expect(staleRequest).rejects.toThrow('No live window connection is available.')
    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe(43)

    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(2)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([43])
  })
})

type PaneHandler = (params: Record<string, unknown>) => unknown

async function mountStandalonePane(
  over: Partial<TerminalPaneProps> = {},
  handlers: Record<string, PaneHandler> = {},
  windowAdapter: PaneWindowAdapterOptions = {}
) {
  const fake = fakeContext(paneHandlers({}, {
    'quirky.terminal/mobileState': () => ({ terminals: [] }),
    ...handlers
  }))
  const pane = await mountPane(fake, over, windowAdapter)
  mountedPane = pane
  return { fake, pane }
}

function windowRuns(pane: MountedPane): Record<string, unknown>[] {
  return pane.windowCalls
    .filter(({ method }) => method === 'ui.window.command.run')
    .map(({ params }) => params)
}

function searchInput(pane: MountedPane): HTMLInputElement {
  const input = pane.element.querySelector<HTMLInputElement>('[data-pane-search] input')
  if (!input) throw new Error('expected the pane search input')
  return input
}

async function clickElement(element: Element | null): Promise<void> {
  if (!element) throw new Error('expected a clickable element')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function openSearch(pane: MountedPane, query = '19'): Promise<void> {
  await act(async () => pane.handle().search(query))
  await settle()
}

async function typeSearch(pane: MountedPane, value: string): Promise<void> {
  const input = searchInput(pane)
  await act(async () => input.focus())
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await settle()
}

async function pressSearch(
  pane: MountedPane,
  init: KeyboardEventInit,
  options: { isComposing?: boolean; keyCode?: number } = {}
): Promise<KeyboardEvent> {
  const target = pane.element.querySelector<HTMLElement>('[data-pane-search]')
  if (!target) throw new Error('expected the pane search box')
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (options.isComposing) Object.defineProperty(event, 'isComposing', { value: true })
  if (options.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: options.keyCode })
  await act(async () => target.dispatchEvent(event))
  await settle()
  return event
}

async function activateOscLink(pane: MountedPane, target: string): Promise<void> {
  const handler = pane.term().options.linkHandler
  if (!handler) throw new Error('expected the terminal OSC 8 link handler')
  const event = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 30 })
  const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }
  await act(async () => handler.activate(event, target, range))
  await settle()
}

function popoverItem(pane: MountedPane, label: string): HTMLButtonElement | null {
  const popover = pane.element.querySelector('[data-pane-link-popover]')
  return Array.from(popover?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === label) ?? null
}

async function mountProviderWorkspace(): Promise<MountedProvider> {
  const daemon = fakeDaemon(conceptualWorkspace())
  const fake = fakeContext({
    ...daemon.handlers,
    'quirky.terminal/quickCommands': () => ({ commands: [] }),
    'quirky.terminal/mobileState': () => ({ terminals: [] })
  })
  fake.layout.worktree = 'wt-main'
  const input = { worktree: 'wt-main' }
  fake.layout.view = { id: WORKTREE_VIEW, input }
  // Load after workspace-support registers happy-dom; the UI module imports xterm at evaluation.
  const ui = await import('../../src/ui')
  deactivateUi = ui.deactivate
  ui.activate(fake.context)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: unknown[] = []
  const view = fake.provided.get(WORKTREE_VIEW)
  if (!view) throw new Error('the UI provider did not register the worktree view')
  let cleanup: unknown
  await act(async () => {
    cleanup = view(element, { input, report: (state: unknown) => reports.push(state) })
  })
  await settle()
  await settle()
  // Workspace imports the pane and xterm, so resolve it only after the DOM harness is ready.
  const workspace = await import('../../src/window/workspace')
  const mounted: MountedProvider = {
    fake,
    element,
    controller: () => workspace.focusedController()!,
    reports,
    async unmount() {
      await act(async () => {
        if (typeof cleanup === 'function') cleanup()
      })
      element.remove()
    }
  }
  mountedProvider = mounted
  return mounted
}

describe('pane search and popover routes', () => {
  test('targets the pane for search options and all button commands', async () => {
    const { pane } = await mountStandalonePane({ paneId: 'pane-3' })
    await openSearch(pane)

    await clickElement(pane.element.querySelector('button[title="Regex"]'))
    expect(pane.lastReport().search).toMatchObject({ query: '19', regex: true })
    expect(pane.element.querySelector('button[title="Regex"]')?.getAttribute('aria-pressed')).toBe('true')
    await clickElement(pane.element.querySelector('button[title="Case sensitive"]'))
    expect(pane.lastReport().search).toMatchObject({ query: '19', regex: true, caseSensitive: true })
    await clickElement(pane.element.querySelector('button[title="Next match"]'))
    await clickElement(pane.element.querySelector('button[title="Previous match"]'))
    await clickElement(pane.element.querySelector('button[title="Close"]'))

    expect(windowRuns(pane)).toEqual([
      { connId: 42, id: 'command:quirky.terminal/search', args: { pane: 'pane-3', regex: true } },
      { connId: 42, id: 'command:quirky.terminal/search', args: { pane: 'pane-3', caseSensitive: true } },
      { connId: 42, id: 'command:quirky.terminal/search-next', args: { pane: 'pane-3' } },
      { connId: 42, id: 'command:quirky.terminal/search-previous', args: { pane: 'pane-3' } },
      { connId: 42, id: 'command:quirky.terminal/search-close', args: { pane: 'pane-3' } }
    ])
    expect(pane.element.querySelector('[data-pane-search]')).toBeNull()
  })

  test('keeps query edits local and caps them at 1,000 characters', async () => {
    const { pane } = await mountStandalonePane({ paneId: 'pane-3' })
    await openSearch(pane, '')

    const query = 'x'.repeat(1000)
    await typeSearch(pane, query)
    expect(pane.lastReport().search?.query).toBe(query)
    expect(windowRuns(pane)).toEqual([])

    await typeSearch(pane, `${query}x`)
    expect(searchInput(pane).value).toBe(query)
    expect(pane.lastReport().search?.query).toBe(query)
    expect(windowRuns(pane)).toEqual([])
  })

  test('routes recognized keys, stops propagation, and ignores IME input', async () => {
    const { pane } = await mountStandalonePane({ paneId: 'pane-3' })
    await openSearch(pane)
    let bubbled = 0
    const shortcutHost = document.createElement('div')
    document.body.appendChild(shortcutHost)
    shortcutHost.appendChild(pane.element)
    shortcutHost.addEventListener('keydown', () => { bubbled += 1 })

    await pressSearch(pane, { key: 'Enter' }, { isComposing: true })
    await pressSearch(pane, { key: 'Enter' }, { keyCode: 229 })
    expect(windowRuns(pane)).toEqual([])
    expect(bubbled).toBe(0)

    const next = await pressSearch(pane, { key: 'Enter' })
    const previous = await pressSearch(pane, { key: 'Enter', shiftKey: true })
    await pressSearch(pane, { key: 'g', metaKey: true })
    await pressSearch(pane, { key: 'g', metaKey: true, shiftKey: true })
    const close = await pressSearch(pane, { key: 'Escape' })

    expect(next.defaultPrevented).toBe(true)
    expect(previous.defaultPrevented).toBe(true)
    expect(close.defaultPrevented).toBe(true)
    expect(bubbled).toBe(0)
    expect(windowRuns(pane).map(({ id, args }) => ({ id, args }))).toEqual([
      { id: 'command:quirky.terminal/search-next', args: { pane: 'pane-3' } },
      { id: 'command:quirky.terminal/search-previous', args: { pane: 'pane-3' } },
      { id: 'command:quirky.terminal/search-next', args: { pane: 'pane-3' } },
      { id: 'command:quirky.terminal/search-previous', args: { pane: 'pane-3' } },
      { id: 'command:quirky.terminal/search-close', args: { pane: 'pane-3' } }
    ])
  })

  test('routes Copy Link and Copy Path through the exact window command', async () => {
    const copied: string[] = []
    setClipboard(async (text) => { copied.push(text) })
    const { pane, fake } = await mountStandalonePane({ paneId: 'pane-3' })
    await fake.push(101, 'selection text')
    await pane.flush()
    await activateOscLink(pane, 'https://example.test/x')

    pane.term().select(0, 0, 9)
    const selection = pane.term().getSelection()
    expect(selection).not.toBe('')
    await clickElement(popoverItem(pane, 'Copy Link'))

    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
    expect(windowRuns(pane).at(-1)).toEqual({
      connId: 42,
      id: 'command:quirky.terminal/copy',
      args: { text: 'https://example.test/x' }
    })
    expect(copied).toEqual(['https://example.test/x'])
    expect(pane.term().getSelection()).toBe(selection)
    pane.term().clearSelection()

    await activateOscLink(pane, 'file:///tmp/w/api/src/app.ts')
    await clickElement(popoverItem(pane, 'Copy Path'))
    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
    expect(windowRuns(pane).at(-1)).toEqual({
      connId: 42,
      id: 'command:quirky.terminal/copy',
      args: { text: '/tmp/w/api/src/app.ts' }
    })
    expect(copied).toEqual(['https://example.test/x', '/tmp/w/api/src/app.ts'])
  })

  test('shows one error toast when a popover copy route fails', async () => {
    const { pane, fake } = await mountStandalonePane(
      { paneId: 'pane-3' },
      {},
      { run: () => { throw new Error('clipboard offline') } }
    )
    await activateOscLink(pane, 'https://example.test/x')
    await clickElement(popoverItem(pane, 'Copy Link'))

    expect(fake.toasts).toEqual([{ title: 'Could not copy link', body: 'clipboard offline' }])
    expect(pane.element.querySelector('[data-pane-link-popover]')).toBeNull()
  })

  test('shows route failures without optimistic search changes or owner fallback', async () => {
    let runCalls = 0
    const { fake, pane } = await mountStandalonePane(
      { paneId: 'pane-3' },
      {},
      {
        self: () => { throw new Error('window gone') },
        run: () => {
          runCalls += 1
          return { result: { ok: true } }
        }
      }
    )
    let ownerCalls = 0
    fake.context.executeCommand = async () => { ownerCalls += 1 }
    await openSearch(pane)
    await clickElement(pane.element.querySelector('button[title="Regex"]'))

    expect(pane.lastReport().search?.regex).toBe(false)
    expect(pane.element.querySelector('button[title="Regex"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(fake.toasts).toEqual([{ title: 'Could not run terminal action', body: 'window gone' }])
    expect(runCalls).toBe(0)
    expect(ownerCalls).toBe(0)
    await pane.unmount()
    pane.element.remove()
    mountedPane = null

    const invalid = await mountStandalonePane(
      { paneId: 'pane-3' },
      {},
      { self: () => ({ connId: 0 }), run: () => ({ result: { ok: true } }) }
    )
    await openSearch(invalid.pane)
    await clickElement(invalid.pane.element.querySelector('button[title="Regex"]'))
    expect(invalid.fake.toasts).toEqual([{
      title: 'Could not run terminal action',
      body: 'No live window connection is available.'
    }])
    expect(windowRuns(invalid.pane)).toEqual([])
  })

  test('surfaces command rejection and handler refusal without changing search options', async () => {
    let selfCalls = 0
    let runCalls = 0
    const { fake, pane } = await mountStandalonePane(
      { paneId: 'pane-3' },
      {},
      {
        self: () => ({ connId: ++selfCalls === 1 ? 42 : 43 }),
        run: () => {
          runCalls += 1
          if (runCalls === 1) throw new Error('window run failed')
          return { result: { ok: false, reason: 'no mounted terminal workspace holds pane-3' } }
        }
      }
    )
    await openSearch(pane)
    await clickElement(pane.element.querySelector('button[title="Regex"]'))
    expect(pane.lastReport().search?.regex).toBe(false)
    await clickElement(pane.element.querySelector('button[title="Regex"]'))

    expect(pane.lastReport().search?.regex).toBe(false)
    expect(windowRuns(pane).map(({ connId }) => connId)).toEqual([42, 43])
    expect(fake.toasts).toEqual([
      { title: 'Could not run terminal action', body: 'window run failed' },
      { title: 'Could not run terminal action', body: 'no mounted terminal workspace holds pane-3' }
    ])
  })

  test('uses the actual provider command for an unfocused pane in its own window', async () => {
    const provider = await mountProviderWorkspace()
    const originalCall = provider.fake.context.call.bind(provider.fake.context)
    const windowRequests: { method: string; params: Record<string, unknown> }[] = []
    provider.fake.context.call = async (method, params = {}) => {
      if (method === 'ui.window.self') {
        windowRequests.push({ method, params })
        return { connId: 42 }
      }
      if (method === 'ui.window.command.run') {
        windowRequests.push({ method, params })
        const handler = provider.fake.provided.get(String(params.id))
        if (!handler) throw new Error(`unknown command ${String(params.id)}`)
        return { result: await handler(params.args) }
      }
      return originalCall(method, params)
    }
    let ownerCalls = 0
    provider.fake.context.executeCommand = async () => { ownerCalls += 1 }

    await act(async () => provider.controller().focusPane('pane-4'))
    expect(provider.element.querySelector('[data-pane="pane-4"]')?.getAttribute('data-active')).toBe('true')
    const openSearchCommand = provider.fake.provided.get('command:quirky.terminal/search')
    if (!openSearchCommand) throw new Error('the actual search command was not provided')
    await act(async () => { await openSearchCommand({ pane: 'pane-3', query: '19' }) })
    await settle()
    expect(provider.element.querySelector('[data-pane="pane-4"]')?.getAttribute('data-active')).toBe('true')
    const pane3 = provider.element.querySelector('[data-pane="pane-3"]')
    await clickElement(pane3?.querySelector('button[title="Regex"]') ?? null)
    expect(provider.controller().getSnapshot().paneStates['pane-3']?.search).toMatchObject({ query: '19', regex: true })
    expect(pane3?.querySelector('button[title="Regex"]')?.getAttribute('aria-pressed')).toBe('true')
    await clickElement(pane3?.querySelector('button[title="Case sensitive"]') ?? null)
    await clickElement(pane3?.querySelector('button[title="Next match"]') ?? null)
    await clickElement(pane3?.querySelector('button[title="Previous match"]') ?? null)
    await clickElement(pane3?.querySelector('button[title="Close"]') ?? null)

    expect(windowRequests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(1)
    expect(windowRequests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params)).toEqual([
      { connId: 42, id: 'command:quirky.terminal/search', args: { pane: 'pane-3', regex: true } },
      { connId: 42, id: 'command:quirky.terminal/search', args: { pane: 'pane-3', caseSensitive: true } },
      { connId: 42, id: 'command:quirky.terminal/search-next', args: { pane: 'pane-3' } },
      { connId: 42, id: 'command:quirky.terminal/search-previous', args: { pane: 'pane-3' } },
      { connId: 42, id: 'command:quirky.terminal/search-close', args: { pane: 'pane-3' } }
    ])
    expect(provider.controller().getSnapshot().paneStates['pane-3']?.search).toBeNull()
    expect(provider.controller().getSnapshot().paneStates['pane-4']?.search).toBeNull()
    expect(ownerCalls).toBe(0)
  })
})
