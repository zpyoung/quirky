import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { terminalCommands } from '../../src/window/commands'
import { RpcError, RpcErrorCode, type MobileTerminalState } from '@quirky/protocol'
import type { TerminalPaneProps } from '../../src/window/pane/TerminalPaneView'
import { fakeContext, type FakeContext } from '../ui-fake'
import { act } from 'react'
import { mountPane, paneHandlers, type MountedPane, type PaneWindowAdapterOptions } from './pane-support'
import {
  conceptualWorkspace,
  fakeDaemon,
  loadWorkspace,
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
import type { DockState } from '../../src/window/dock/types'

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
let restoreDockRect: (() => void) | null = null

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
  restoreDockRect?.()
  restoreDockRect = null
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

function mobileTerminal(over: Partial<MobileTerminalState> = {}): MobileTerminalState {
  return {
    session: 's1',
    driver: { deviceId: 'device-1', connectionId: 1, name: 'Phone' },
    phoneFit: false,
    cols: 80,
    rows: 24,
    desktopCols: 80,
    desktopRows: 24,
    ...over
  }
}

function composerState(over: Partial<DockState> = {}): DockState {
  return {
    pane: 'pane-3',
    session: 's-3',
    tab: 'tab-2',
    revision: 1,
    enabled: true,
    supported: true,
    agent: 'claude',
    docked: true,
    userUndocked: false,
    gutterRows: 5,
    mounted: false,
    passthrough: false,
    draft: '',
    attachments: [],
    disabledReason: null,
    activeSend: null,
    queuedSends: [],
    question: null,
    options: {
      model: null,
      effort: null,
      permission: null,
      choices: { model: [], effort: [], permission: [] },
      context: null,
      notice: null
    },
    notice: null,
    ...over
  }
}

function setDockGeometry(): void {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains('qtd-host')) {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        toJSON: () => ({})
      } as DOMRect
    }
    return original.call(this)
  }
  restoreDockRect = () => { Element.prototype.getBoundingClientRect = original }
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

async function mountProviderWorkspace(
  extraHandlers: Record<string, PaneHandler> = {},
  configureContext?: (fake: FakeContext) => void
): Promise<MountedProvider> {
  const daemon = fakeDaemon(conceptualWorkspace())
  const fake = fakeContext({
    ...daemon.handlers,
    'quirky.terminal/quickCommands': () => ({ commands: [] }),
    'quirky.terminal/mobileState': () => ({ terminals: [] }),
    ...extraHandlers
  })
  fake.layout.worktree = 'wt-main'
  const input = { worktree: 'wt-main' }
  fake.layout.view = { id: WORKTREE_VIEW, input }
  // Load after workspace-support registers happy-dom; the UI module imports xterm at evaluation.
  const ui = await import('../../src/ui')
  deactivateUi = ui.deactivate
  ui.activate(fake.context)
  configureContext?.(fake)
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

describe('mobile state recovery', () => {
  test('retries a failed mobile state read and clears the alert for an empty result', async () => {
    let reads = 0
    const { fake, pane } = await mountStandalonePane({}, {
      'quirky.terminal/mobileState': () => {
        reads += 1
        if (reads === 1) throw new Error('offline')
        return { terminals: [] }
      }
    })
    expect(pane.element.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not read mobile terminal state: offline')
    expect(fake.toasts).toEqual([])

    await clickElement(pane.element.querySelector('.ui-inline-error__action'))

    expect(fake.callsTo('quirky.terminal/mobileState').map(({ params }) => params)).toEqual([
      { session: 's1' },
      { session: 's1' }
    ])
    expect(pane.element.querySelector('.ui-inline-error')).toBeNull()
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).toBeNull()
    expect(fake.toasts).toEqual([])
  })
})

async function emitMobileChanged(fake: FakeContext): Promise<void> {
  await fake.emit({ type: 'quirky.terminal/mobileChanged' } as never)
  await settle()
}

describe('mobile disclosure and actions', () => {
  test('keeps the single action outside the native phone-controls disclosure', async () => {
    const { fake, pane } = await mountStandalonePane({}, {
      'quirky.terminal/mobileState': () => ({ terminals: [mobileTerminal()] }),
      'quirky.terminal/takeBack': () => ({ ok: true })
    })
    const overlay = pane.element.querySelector<HTMLElement>('[data-mobile-driver-overlay]')
    const details = overlay?.querySelector<HTMLDetailsElement>('details.ui-disclosure')
    const takeBack = overlay?.querySelector<HTMLButtonElement>('button[aria-label="Take back this terminal"]')
    expect(details?.open).toBe(true)
    expect(details?.querySelector('summary')?.textContent).toBe('Phone driving controls')
    expect(takeBack?.closest('details')).toBeNull()

    await act(async () => {
      details!.open = false
      details!.dispatchEvent(new Event('toggle'))
    })
    expect(details?.open).toBe(false)
    expect(overlay?.querySelector('.terminal-mobile-driver__summary strong')?.textContent).toBe('Your phone is in control')
    expect(takeBack?.textContent).toBe('Take back')

    await act(async () => {
      details!.open = true
      details!.dispatchEvent(new Event('toggle'))
    })
    expect(details?.querySelector('.terminal-mobile-driver__description')?.textContent).toBe('Desktop typing is paused. Output keeps streaming.')
    expect(details?.textContent).toContain('Take back all')

    await clickElement(takeBack ?? null)
    await clickElement(Array.from(details?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Take back all') ?? null)

    expect(fake.callsTo('quirky.terminal/takeBack').map(({ params }) => params)).toEqual([
      { session: 's1' },
      {}
    ])
    expect(fake.callsTo('quirky.terminal/mobileState')).toHaveLength(3)
  })

  test('routes both phone-fit restore scopes and refreshes the state', async () => {
    const { fake, pane } = await mountStandalonePane({}, {
      'quirky.terminal/mobileState': () => ({ terminals: [mobileTerminal({ driver: null, phoneFit: true })] }),
      'quirky.terminal/restoreFit': () => ({ ok: true })
    })
    const overlay = pane.element.querySelector<HTMLElement>('[data-mobile-driver-overlay]')

    expect(overlay?.querySelector('button[aria-label="Restore this terminal"]')?.textContent).toBe('Restore')
    expect(overlay?.querySelector('details')?.textContent).toContain('Restore all')
    await clickElement(overlay?.querySelector('button[aria-label="Restore this terminal"]') ?? null)
    await clickElement(Array.from(overlay?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Restore all') ?? null)

    expect(fake.callsTo('quirky.terminal/restoreFit').map(({ params }) => params)).toEqual([
      { session: 's1' },
      {}
    ])
    expect(fake.callsTo('quirky.terminal/mobileState')).toHaveLength(3)
  })

  test('retains phone controls and toasts after an action failure', async () => {
    const { fake, pane } = await mountStandalonePane({}, {
      'quirky.terminal/mobileState': () => ({ terminals: [mobileTerminal()] }),
      'quirky.terminal/takeBack': () => { throw new Error('phone unavailable') }
    })
    await clickElement(pane.element.querySelector('button[aria-label="Take back this terminal"]'))

    expect(fake.toasts).toEqual([{ title: 'Could not take back terminal', body: 'phone unavailable' }])
    expect(fake.callsTo('quirky.terminal/mobileState')).toHaveLength(2)
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).not.toBeNull()
  })
})

describe('mobile read ordering', () => {
  test('does not cover terminal output while initial mobile discovery is pending and ignores superseded replies', async () => {
    const initial = Promise.withResolvers<unknown>()
    let reads = 0
    const fake = fakeContext(paneHandlers({ replay: 'b3V0cHV0' }, {
      'quirky.terminal/mobileState': () => {
        reads += 1
        return reads === 1 ? initial.promise : { terminals: [mobileTerminal()] }
      }
    }))
    const pane = await mountPane(fake)
    mountedPane = pane
    await pane.flush()

    expect(pane.term().buffer.active.getLine(0)?.translateToString(true)).toContain('output')
    expect(pane.element.querySelector('[data-terminal-connection-state]')).toBeNull()
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).toBeNull()
    expect(pane.element.querySelector('.ui-inline-error')).toBeNull()

    await emitMobileChanged(fake)
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).not.toBeNull()
    initial.resolve({ terminals: [] })
    await settle()

    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).not.toBeNull()
    expect(pane.element.querySelector('.ui-inline-error')).toBeNull()
    expect(fake.callsTo('quirky.terminal/mobileState')).toHaveLength(2)
  })

  test('keeps the last phone state during a read error and Retry can clear it', async () => {
    let reads = 0
    const { fake, pane } = await mountStandalonePane({}, {
      'quirky.terminal/mobileState': () => {
        reads += 1
        if (reads === 2) throw new Error('offline')
        return reads === 3 ? { terminals: [] } : { terminals: [mobileTerminal()] }
      }
    })

    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).not.toBeNull()
    await emitMobileChanged(fake)
    expect(pane.element.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not read mobile terminal state: offline')
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).not.toBeNull()
    expect(fake.toasts).toEqual([])

    await clickElement(pane.element.querySelector('.ui-inline-error__action'))
    expect(fake.callsTo('quirky.terminal/mobileState').map(({ params }) => params)).toEqual([
      { session: 's1' },
      { session: 's1' },
      { session: 's1' }
    ])
    expect(pane.element.querySelector('.ui-inline-error')).toBeNull()
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).toBeNull()
    expect(pane.element.querySelector('.ui-empty-state')).toBeNull()
  })

  test('ignores mobile state that settles after the pane unmounts', async () => {
    const pending = Promise.withResolvers<unknown>()
    const fake = fakeContext(paneHandlers({}, {
      'quirky.terminal/mobileState': () => pending.promise
    }))
    const pane = await mountPane(fake)
    mountedPane = pane
    const reports = pane.reports.length

    await pane.unmount()
    mountedPane = null
    pane.element.remove()
    pending.resolve({ terminals: [mobileTerminal()] })
    await settle()

    expect(pane.reports).toHaveLength(reports)
    expect(pane.element.querySelector('[data-mobile-driver-overlay]')).toBeNull()
    expect(fake.toasts).toEqual([])
  })
})

function dockGetHandler(state: DockState, readTarget: () => DockState = () => state): PaneHandler {
  return (params) => {
    const pane = typeof params.pane === 'string' ? params.pane : String(params.pane)
    const session = typeof params.session === 'string' ? params.session : String(params.session)
    if (pane === state.pane && session === state.session) return readTarget()
    return composerState({ pane, session, enabled: false, supported: false, docked: false, agent: null })
  }
}

describe('terminal connection states', () => {
  test('keeps xterm mounted under a connecting notice until attach replay is handed off', async () => {
    const attach = Promise.withResolvers<unknown>()
    const fake = fakeContext(paneHandlers({}, {
      'quirky.terminal/attach': () => attach.promise,
      'quirky.terminal/mobileState': () => ({ terminals: [] })
    }))
    const pane = await mountPane(fake)
    mountedPane = pane
    const status = pane.element.querySelector('[data-terminal-connection-state] [role="status"]')

    expect(status?.querySelector('.ui-notice-line')?.textContent?.trim()).toBe('Connecting terminal…')
    expect(pane.term().element).not.toBeNull()
    expect(pane.element.contains(pane.term().element!)).toBe(true)

    attach.resolve({ streamId: 101, replay: 'Y29ubmVjdGVk', live: true })
    await settle()
    await pane.flush()
    expect(pane.element.querySelector('[data-terminal-connection-state]')).toBeNull()
    expect(pane.term().buffer.active.getLine(0)?.translateToString(true)).toContain('connected')
  })

  test('detaches an attach that resolves after disposal without publishing more pane state', async () => {
    const attach = Promise.withResolvers<unknown>()
    const fake = fakeContext(paneHandlers({}, {
      'quirky.terminal/attach': () => attach.promise,
      'quirky.terminal/mobileState': () => ({ terminals: [] })
    }))
    const pane = await mountPane(fake)
    mountedPane = pane
    const reports = pane.reports.length
    const terminal = pane.term()
    await pane.unmount()
    mountedPane = null
    pane.element.remove()

    attach.resolve({ streamId: 109, replay: 'bGF0ZS1yZXBsYXk=', live: true })
    await settle()

    expect(fake.callsTo('quirky.terminal/detach').map(({ params }) => params)).toContainEqual({ streamId: 109 })
    expect(fake.streams.has(109)).toBe(false)
    expect(pane.reports).toHaveLength(reports)
    expect(terminal.buffer.active.getLine(0)?.translateToString(true) ?? '').not.toContain('late-replay')
  })
})

describe('dock host shared states and routes', () => {
  test('shows composer loading outside its mount element and clears it on contributed content', async () => {
    setDockGeometry()
    const state = composerState({ passthrough: true })
    const provider = await mountProviderWorkspace({
      'quirky.terminal-dock/get': dockGetHandler(state)
    })
    const host = provider.element.querySelector<HTMLElement>('[data-dock-pane="pane-3"]')
    const status = host?.querySelector<HTMLElement>('[role="status"]')
    const mount = provider.fake.mountedViews.find((view) => view.viewId === 'view:quirky.terminal-dock/composer')

    expect(status?.querySelector('.ui-notice-line')?.textContent?.trim()).toBe('Opening agent composer…')
    expect(mount).toBeDefined()
    expect(status?.contains(mount!.element)).toBe(false)
    expect(host?.querySelector('.qtd-composer-host')).toBe(mount!.element)

    mount!.element.appendChild(document.createElement('div'))
    await settle()
    expect(host?.querySelector('[role="status"]')).toBeNull()
  })

  test('renders mount and host failures through InlineError', async () => {
    setDockGeometry()
    const state = composerState({ passthrough: true })
    const mountFailure = await mountProviderWorkspace(
      { 'quirky.terminal-dock/get': dockGetHandler(state) },
      (fake) => { fake.context.mountView = () => { throw new Error('mount refused') } }
    )
    const mountHost = mountFailure.element.querySelector<HTMLElement>('[data-dock-pane="pane-3"]')
    expect(mountHost?.querySelector('.qtd-error .ui-inline-error__message')?.textContent).toBe('Agent composer unavailable: mount refused')
    expect(mountHost?.querySelector('.qtd-error [role="alert"]')).not.toBeNull()

    await mountFailure.unmount()
    mountedProvider = null
    deactivateUi?.()
    deactivateUi = null
    document.body.innerHTML = ''
    restoreDockRect?.()
    restoreDockRect = null

    setDockGeometry()
    let offline = false
    const hostFailure = await mountProviderWorkspace({
      'quirky.terminal-dock/get': dockGetHandler(state, () => {
        if (offline) throw new Error('offline')
        return state
      })
    })
    offline = true
    await hostFailure.fake.setConnection('reconnecting')
    await hostFailure.fake.setConnection('connected')
    await settle()

    const host = hostFailure.element.querySelector<HTMLElement>('[data-dock-pane="pane-3"]')
    expect(host?.querySelector('.qtd-error .ui-inline-error__message')?.textContent).toBe('Agent composer unavailable: offline')
  })

  test('does not show an error for an absent optional dock on its initial read', async () => {
    setDockGeometry()
    const provider = await mountProviderWorkspace({
      'quirky.terminal-dock/get': () => { throw new RpcError(RpcErrorCode.MethodNotFound, 'dock unavailable') }
    })
    await settle()
    expect(provider.element.querySelector('.qtd-error')).toBeNull()
    expect(provider.element.querySelector('.ui-inline-error')).toBeNull()
  })

  test('routes dock focus through this window and shows its failure in the host', async () => {
    setDockGeometry()
    const state = composerState()
    const requests: { method: string; params: Record<string, unknown> }[] = []
    const provider = await mountProviderWorkspace(
      { 'quirky.terminal-dock/get': dockGetHandler(state) },
      (fake) => {
        const call = fake.context.call.bind(fake.context)
        fake.context.call = async (method, params = {}) => {
          if (method === 'ui.window.self') {
            requests.push({ method, params })
            return { connId: 42 }
          }
          if (method === 'ui.window.command.run') {
            requests.push({ method, params })
            throw new Error('focus window closed')
          }
          return call(method, params)
        }
      }
    )
    const mount = provider.fake.mountedViews.find((view) => view.viewId === 'view:quirky.terminal-dock/composer')
    if (!mount) throw new Error('the dock composer view was not mounted')
    const terminalInput = provider.element.querySelector<HTMLElement>('[data-pane="pane-3"] textarea')
    await act(async () => terminalInput?.focus())
    mount.element.appendChild(document.createElement('div'))
    await settle()

    expect(requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params)).toEqual([{
      connId: 42,
      id: 'command:quirky.terminal-dock/focus',
      args: { pane: 'pane-3' }
    }])
    expect(provider.element.querySelector('[data-dock-pane="pane-3"] .qtd-error .ui-inline-error__message')?.textContent).toBe('Agent composer unavailable: focus window closed')
  })

  test('previews resize locally, persists through the dock method, then rolls back and toasts on failure', async () => {
    setDockGeometry()
    const state = composerState({ passthrough: true })
    const provider = await mountProviderWorkspace({
      'quirky.terminal-dock/get': dockGetHandler(state),
      'quirky.terminal-dock/set': () => { throw new Error('resize offline') }
    })
    const mount = provider.fake.mountedViews.find((view) => view.viewId === 'view:quirky.terminal-dock/composer')
    if (!mount) throw new Error('the dock composer view was not mounted')
    mount.element.appendChild(document.createElement('div'))
    await settle()

    const host = provider.element.querySelector<HTMLElement>('[data-dock-pane="pane-3"]')
    const separator = host?.querySelector<HTMLElement>('[data-resize-handle]')
    const window = host?.ownerDocument.defaultView
    if (!separator || !window) throw new Error('the dock resize handle was not mounted')
    await act(async () => {
      separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 100 }))
    })
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientY: 80 }))
    })
    expect(host?.getAttribute('data-dock-gutter')).toBe('6')
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    })
    await settle()

    expect(provider.fake.callsTo('quirky.terminal-dock/set').map(({ params }) => params)).toEqual([
      { pane: 'pane-3', gutterRows: 6 }
    ])
    expect(host?.getAttribute('data-dock-gutter')).toBe('5')
    expect(provider.fake.toasts).toEqual([{ title: 'Could not resize the agent composer', body: 'resize offline' }])
  })
})
