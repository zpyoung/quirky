import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import type { PluginCaller } from '@quirky/protocol'
import type { BrowserPage } from '../src/profiles/store'
import type { RoutingCall } from '../src/client-routing'
import { openUrlOnClient, parseClientSelector, revealOnClient, selectClient } from '../src/client-routing'

const page = (overrides: Partial<BrowserPage> = {}): BrowserPage => ({
  browserPageId: 'page-1',
  worktreeId: 'worktree-A',
  profileId: 'default',
  index: 1,
  active: true,
  url: 'https://example.test/',
  title: 'Example',
  loadError: null,
  ...overrides
})

type Window = {
  connId: number
  worktreeId?: string
  focused?: boolean
  stateError?: Error
}

type RecordedCall = { method: string; params?: Record<string, unknown> }

function routingHarness(windows: Window[]) {
  const calls: RecordedCall[] = []
  const call: RoutingCall = async (method, params) => {
    calls.push({ method, ...(params === undefined ? {} : { params }) })
    if (method === 'ui.state') {
      return { windows: windows.map(({ connId, focused = false }) => ({ connId, focused })) }
    }
    if (method === 'ui.window.state') {
      const connId = params?.connId
      const window = windows.find((candidate) => candidate.connId === connId)
      if (!window || window.stateError) throw window?.stateError ?? new Error(`window ${String(connId)} closed`)
      return { connId, layout: { worktree: window.worktreeId ?? null } }
    }
    if (method === 'ui.window.view.open' || method === 'quirky.terminal/setFloating') return {}
    throw new Error(`Unexpected routing call ${method}`)
  }
  return { call, calls }
}

function cliCaller(worktreeId?: string): PluginCaller {
  return { role: 'cli', ...(worktreeId === undefined ? {} : { worktreeId }) }
}

function uiCaller(connId: number): PluginCaller {
  return {
    role: 'ui',
    connection: {
      id: connId,
      transport: 'websocket',
      onClose: () => { throw new Error('routing must not register connection cleanup') },
      openStream: () => { throw new Error('routing must not open a connection stream') }
    }
  }
}

function rejected(error: unknown): Error {
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return rejected(error)
  }
  throw new Error('Expected promise to reject')
}

function thrownBy(operation: () => unknown): Error {
  try {
    operation()
  } catch (error) {
    return rejected(error)
  }
  throw new Error('Expected operation to throw')
}

test('scenario 1: selects an explicit live window regardless of the caller', async () => {
  const { call } = routingHarness([
    { connId: 3, worktreeId: 'worktree-A', focused: true },
    { connId: 5, worktreeId: 'worktree-B' }
  ])

  expect(await selectClient(call, 5, uiCaller(3))).toBe(5)
})

test('scenario 2: rejects an explicit ID that is not connected without changing state', async () => {
  const { call, calls } = routingHarness([{ connId: 3, worktreeId: 'worktree-A' }])

  const error = await rejectionOf(selectClient(call, 9, cliCaller('worktree-A')))

  expect(error.message).toBe('browser_client_unavailable: window 9 is not connected')
  expect(calls).toEqual([{ method: 'ui.state' }])
})

test('scenario 3: rejects malformed client selectors and parses canonical IDs', () => {
  for (const value of ['', ' 5', '05', '+5', '5.0', '1e1', 'Caller', 'all', '9007199254740993', 5]) {
    expect(thrownBy(() => parseClientSelector(value)).message)
      .toBe('invalid_argument: client must be caller or a live window connection ID')
  }

  expect(parseClientSelector('caller')).toBe('caller')
  expect(parseClientSelector('5')).toBe(5)
})

test('scenario 4: chooses the caller connection when it is a listed window', async () => {
  const { call, calls } = routingHarness([
    { connId: 3, worktreeId: 'worktree-A' },
    { connId: 5, worktreeId: 'worktree-B', focused: true }
  ])

  expect(await selectClient(call, 'caller', uiCaller(3))).toBe(3)
  expect(calls).toEqual([{ method: 'ui.state' }])
})

test("scenario 5: chooses the window showing the caller's worktree", async () => {
  const { call } = routingHarness([
    { connId: 3, worktreeId: 'worktree-A' },
    { connId: 5, worktreeId: 'worktree-B' }
  ])

  expect(await selectClient(call, 'caller', cliCaller('worktree-A'))).toBe(3)
})

test("scenario 6: uses the focused window to break a tie on the caller's worktree", async () => {
  const { call } = routingHarness([
    { connId: 3, worktreeId: 'worktree-A' },
    { connId: 5, worktreeId: 'worktree-A', focused: true }
  ])

  expect(await selectClient(call, 'caller', cliCaller('worktree-A'))).toBe(5)
})

test.each([
  ['none focused', false, false],
  ['several focused', true, true]
] as const)('scenario 7: refuses caller-worktree ties when %s', async (_label, firstFocused, secondFocused) => {
  const { call } = routingHarness([
    { connId: 3, worktreeId: 'worktree-A', focused: firstFocused },
    { connId: 5, worktreeId: 'worktree-A', focused: secondFocused }
  ])

  const error = await rejectionOf(selectClient(call, 'caller', cliCaller('worktree-A')))

  expect(error.message).toBe("browser_client_ambiguous: windows 3, 5 are connected and none is identified as the caller's; pass client <id>")
})

test("scenario 8: uses the sole window when it does not show the caller's worktree or the caller has none", async () => {
  const unmatched = routingHarness([{ connId: 7, worktreeId: 'worktree-B', focused: true }])
  expect(await selectClient(unmatched.call, 'caller', cliCaller('worktree-A'))).toBe(7)

  const noCallerWorktree = routingHarness([{ connId: 8, worktreeId: 'worktree-B', focused: true }])
  expect(await selectClient(noCallerWorktree.call, 'caller', cliCaller())).toBe(8)
})

test('scenario 9: refuses multiple windows when none shows a caller worktree, even if one is focused', async () => {
  const { call } = routingHarness([
    { connId: 3, worktreeId: 'worktree-B' },
    { connId: 5, worktreeId: 'worktree-C', focused: true }
  ])

  const error = await rejectionOf(selectClient(call, 'caller', cliCaller('worktree-A')))

  expect(error.message).toBe("browser_client_ambiguous: windows 3, 5 are connected and none is identified as the caller's; pass client <id>")
  const noCallerWorktree = routingHarness([
    { connId: 3, worktreeId: 'worktree-B' },
    { connId: 5, worktreeId: 'worktree-C', focused: true }
  ])
  const noWorktreeError = await rejectionOf(selectClient(noCallerWorktree.call, 'caller', cliCaller()))
  expect(noWorktreeError.message).toBe("browser_client_ambiguous: windows 3, 5 are connected and none is identified as the caller's; pass client <id>")
})

test('scenario 10: refuses when no Quirky window is connected', async () => {
  const { call } = routingHarness([])

  const error = await rejectionOf(selectClient(call, 'caller', cliCaller()))

  expect(error.message).toBe('browser_client_unavailable: no Quirky window is connected to show the page')
})

test('scenario 11: applies no-worktree caller selection rules to plugin callers', async () => {
  const pluginCaller: PluginCaller = { role: 'plugin', pluginId: 'quirky.browser' }
  const oneWindow = routingHarness([{ connId: 8, worktreeId: 'worktree-B' }])
  expect(await selectClient(oneWindow.call, 'caller', pluginCaller)).toBe(8)

  const severalWindows = routingHarness([
    { connId: 3, worktreeId: 'worktree-A', focused: true },
    { connId: 5, worktreeId: 'worktree-B' }
  ])
  const error = await rejectionOf(selectClient(severalWindows.call, 'caller', pluginCaller))
  expect(error.message).toBe("browser_client_ambiguous: windows 3, 5 are connected and none is identified as the caller's; pass client <id>")
})

test('scenario 12: removes a window whose state read fails before applying the remaining selection rules', async () => {
  const { call } = routingHarness([
    { connId: 3, worktreeId: 'worktree-A', stateError: new Error('closed while reading') },
    { connId: 5, worktreeId: 'worktree-B' }
  ])

  expect(await selectClient(call, 'caller', cliCaller('worktree-A'))).toBe(5)
})

test('scenario 20: rejects a page with no worktree before revealing or making any call', async () => {
  let revealCount = 0
  const calls: string[] = []
  const error = await rejectionOf(revealOnClient({
    call: async (method) => { calls.push(method); return {} },
    revealPage: async () => { revealCount += 1; return { pane: 'pane-1', opened: true } },
    closePane: async () => {}
  }, page({ worktreeId: null }), 3))

  expect(error.message).toBe('invalid_argument: page page-1 belongs to no worktree, so no browser pane can show it')
  expect(revealCount).toBe(0)
  expect(calls).toEqual([])
})

test('scenario 21: opens the floating workspace without opening a window view', async () => {
  const calls: RecordedCall[] = []
  const result = await revealOnClient({
    call: async (method, params) => { calls.push({ method, ...(params === undefined ? {} : { params }) }); return {} },
    revealPage: async () => ({ pane: 'pane-floating', opened: true }),
    closePane: async () => {}
  }, page({ worktreeId: 'floating' }), 3)

  expect(result).toEqual({ pane: 'pane-floating', paneOpened: true, client: 3 })
  expect(calls).toEqual([{ method: 'quirky.terminal/setFloating', params: { open: true } }])
})

test('scenario 24: maps a disconnected target window and keeps the revealed pane', async () => {
  const calls: string[] = []
  const steps = {
    call: async (method: string) => { calls.push(method); throw new Error('closed') },
    revealPage: async () => ({ pane: 'pane-1', opened: true }),
    closePane: async (paneId: string) => { calls.push(`closePane:${paneId}`) }
  }

  const error = await rejectionOf(revealOnClient(steps, page(), 3))

  expect(error.message).toBe('browser_client_unavailable: window 3 disconnected before the page was shown')
  expect(calls).toEqual(['ui.window.view.open'])
})

test('scenario 31: rolls back pane then page after the view step fails and preserves the original reason', async () => {
  const calls: string[] = []
  const steps = {
    call: async () => { calls.push('ui.window.view.open'); throw new Error('view failed') },
    revealPage: async () => ({ pane: 'pane-1', opened: true }),
    closePane: async (paneId: string) => { calls.push(`closePane:${paneId}`) },
    createPage: async () => page(),
    closePage: async (pageId: string) => { calls.push(`closePage:${pageId}`) }
  }

  const error = await rejectionOf(openUrlOnClient(steps, 3))

  expect(error.message).toBe('browser_client_unavailable: window 3 disconnected before the page was shown')
  expect(calls).toEqual(['ui.window.view.open', 'closePane:pane-1', 'closePage:page-1'])
})

test('scenario 31: closes only the page when pane reveal fails and preserves that error', async () => {
  const calls: string[] = []
  const revealFailure = new Error('pane reveal failed')
  const steps = {
    call: async () => { calls.push('unexpected-call'); return {} },
    revealPage: async () => { throw revealFailure },
    closePane: async (paneId: string) => { calls.push(`closePane:${paneId}`) },
    createPage: async () => page(),
    closePage: async (pageId: string) => { calls.push(`closePage:${pageId}`) }
  }

  const error = await rejectionOf(openUrlOnClient(steps, 3))

  expect(error).toBe(revealFailure)
  expect(calls).toEqual(['closePage:page-1'])
})

test('scenario 34: Native profile clear and delete descriptions explain desktop acknowledgement and refusal', () => {
  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8')) as {
    contributes: { method: Array<{ id: string; description: string }> }
  }
  for (const id of ['profileClear', 'profileDelete']) {
    const description = manifest.contributes.method.find((method) => method.id === id)?.description
    expect(description).toBeDefined()
    const wording = description!.toLowerCase()
    expect(wording).toContain('connected desktop window')
    expect(wording).toContain('acknowledg')
    expect(wording).toContain('native storage clear')
    expect(wording).toContain('without one')
    expect(wording).toContain('refused')
    expect(wording).toContain('nothing is removed')
    expect(wording).not.toContain('currently unavailable')
  }
})
