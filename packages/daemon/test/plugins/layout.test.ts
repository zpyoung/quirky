import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  RpcErrorCode,
  type ClientRole,
  type PluginInfo,
  type QuirkyClient,
  type QuirkyEvent,
  type UiLayout,
  type UiModel,
  type UiState
} from '@quirky/protocol'
import type { ClientConn } from '../../src/types'
import { LayoutService } from '../../src/plugins/layout'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

/** The error a call rejects with; `.rejects` misreports daemon errors raised in the same process. */
async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

const NOTES = 'acme.notes'
const PAGE = `view:${NOTES}/page`
const OTHER_PAGE = `view:${NOTES}/other`
const OUTLINE = `panel:${NOTES}/outline`
const LIST = `sidebar-section:${NOTES}/list`
const GREET = `command:${NOTES}/greet`
const BOOM = `command:${NOTES}/boom`

const greetArgs = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

function writeNotesPlugin(root: string): void {
  writePlugin(
    root,
    {
      id: NOTES,
      name: NOTES,
      version: '1.0.0',
      ui: 'ui.js',
      contributes: {
        'sidebar-section': [{ id: 'list', title: 'Notes' }],
        panel: [{ id: 'outline', title: 'Outline' }],
        view: [
          { id: 'page', title: 'Page' },
          { id: 'other', title: 'Other' }
        ],
        command: [
          { id: 'greet', title: 'Greet', args: greetArgs },
          { id: 'boom', title: 'Boom' }
        ]
      }
    },
    { 'ui.js': 'export function activate() {}\n' }
  )
}

/** A fresh temp home with the notes plugin installed; `restart` keeps the home so the layout carries over. */
function makeEnv() {
  const home = makeTempHome()
  writeNotesPlugin(join(home, 'plugins'))
  const builtin = makeTempDir('qd-builtin-')
  const env = {
    home,
    harness: null as Harness | null,
    async start(): Promise<Harness> {
      const harness = await startHarness({ home, builtinPluginsDir: builtin })
      harnesses.push(harness)
      env.harness = harness
      return harness
    },
    async restart(): Promise<Harness> {
      const old = env.harness!
      harnesses.splice(harnesses.indexOf(old), 1)
      for (const client of old.clients) client.close()
      await old.daemon.stop()
      old.pty.stop()
      return env.start()
    }
  }
  return env
}

type Window = { client: QuirkyClient; events: QuirkyEvent[]; requests: Extract<QuirkyEvent, { type: 'ui.command.request' }>[] }

/** A subscribed client standing in for a window; it records the commands routed to it. */
async function openWindow(harness: Harness, name?: string, role: ClientRole = 'ui'): Promise<Window> {
  const client = await harness.connect(role, name)
  const window: Window = { client, events: [], requests: [] }
  client.onEvent((event) => {
    window.events.push(event)
    if (event.type === 'ui.command.request') window.requests.push(event)
  })
  await client.call('events.subscribe', {})
  return window
}
async function windowConnId(client: QuirkyClient): Promise<number> {
  const state = await client.call('ui.window.self', {})
  return state.connId
}

/** Makes the window answer every routed command with `reply(args)`. */
function answerWith(window: Window, reply: (id: string, args: unknown) => { result?: unknown; error?: { message: string } }): void {
  window.client.onEvent((event) => {
    if (event.type !== 'ui.command.request') return
    // the test may finish and close the window before the daemon acknowledges the reply
    window.client.call('ui.command.reply', { requestId: event.requestId, ...reply(event.id, event.args) }).catch(() => {})
  })
}

const changes = (window: Window) =>
  window.events.filter((event): event is Extract<QuirkyEvent, { type: 'ui.state.changed' }> => event.type === 'ui.state.changed')
const slotOf = (state: UiState, id: string) => state.slots.find((slot) => slot.id === id)!

async function start() {
  const env = makeEnv()
  const harness = await env.start()
  const caller = await harness.connect('cli')
  return { env, harness, caller }
}

describe('layout state', () => {
  test('SC-35: ui.state exposes current tool bodies, opened views and connection reports', async () => {
    const { harness, caller } = await start()
    const initial = await caller.call('ui.state', {})
    expect(initial.windows).toEqual([])
    expect(initial.layout).toMatchObject({
      view: null,
      viewTabs: [],
      panel: null,
      sidebar: false,
      focus: null,
      tools: {
        open: {
          'left-top': null,
          'left-bottom': null,
          'right-top': null,
          'right-bottom': null,
          'bottom-left': null,
          'bottom-right': null
        }
      }
    })
    expect(slotOf(initial, LIST).shown).toBe(false)
    expect(slotOf(initial, OUTLINE).shown).toBe(false)
    expect(slotOf(initial, PAGE).shown).toBe(false)

    const window = await openWindow(harness, 'main window')
    await caller.call('ui.view.open', { id: PAGE, input: { note: 'n1' } })
    await caller.call('ui.focus', { target: 'view' })
    await window.client.call('ui.report', { slot: LIST, state: { notes: ['n1', 'n2'] } })
    await window.client.call('ui.report', { slot: PAGE, state: { open: 'n1' } })
    await window.client.call('ui.window.focused', { focused: true })

    const state = await caller.call('ui.state', {})
    expect(state.windows).toEqual([{ connId: expect.any(Number), name: 'main window', focused: true, inputAt: null, present: false }])
    expect(state.layout).toMatchObject({
      view: { id: PAGE, input: { note: 'n1' } },
      viewTabs: [{ id: PAGE, input: { note: 'n1' } }],
      panel: null,
      sidebar: false,
      focus: 'view'
    })
    expect(slotOf(state, PAGE)).toMatchObject({ kind: 'view', shown: true, report: { open: 'n1' } })
    expect(slotOf(state, LIST)).toMatchObject({ shown: false, report: { notes: ['n1', 'n2'] } })
    expect(slotOf(state, OUTLINE).shown).toBe(false)
  })

  test('only clients with role ui count as windows', async () => {
    const { harness, caller } = await start()
    await openWindow(harness, 'cli-ish', 'cli')
    await openWindow(harness, 'real')
    expect((await caller.call('ui.state', {})).windows.map((window) => window.name)).toEqual(['real'])
  })

  test('the focused window is the one that last reported focus, and blurring clears it', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    const focusedNames = async () =>
      (await caller.call('ui.state', {})).windows.filter((window) => window.focused).map((window) => window.name)
    expect(await focusedNames()).toEqual([])
    await first.client.call('ui.window.focused', { focused: true })
    await second.client.call('ui.window.focused', { focused: true })
    expect(await focusedNames()).toEqual(['second'])
    await second.client.call('ui.window.focused', { focused: false })
    expect(await focusedNames()).toEqual(['first'])
  })

  test('a slot shows the focused window report, else the most recent one', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    await first.client.call('ui.report', { slot: LIST, state: 'from first' })
    await second.client.call('ui.report', { slot: LIST, state: 'from second' })
    expect(slotOf(await caller.call('ui.state', {}), LIST).report).toBe('from second')
    await first.client.call('ui.window.focused', { focused: true })
    expect(slotOf(await caller.call('ui.state', {}), LIST).report).toBe('from first')
  })

  test('non-window connections cannot report or claim focus', async () => {
    const { caller } = await start()
    const report = await failure(caller.call('ui.report', { slot: LIST, state: 1 }))
    expect(report.code).toBe(RpcErrorCode.InvalidParams)
    const focused = await failure(caller.call('ui.window.focused', { focused: true }))
    expect(focused.code).toBe(RpcErrorCode.InvalidParams)
  })
})
test('ui.window.self returns only the calling live UI connection ID', async () => {
  const { harness, caller } = await start()
  const window = await openWindow(harness, 'self')
  expect((await window.client.call('ui.window.self', {})).connId).toBeGreaterThan(0)

  const nonWindow = await failure(caller.call('ui.window.self', {}))
  expect(nonWindow.code).toBe(RpcErrorCode.InvalidParams)
})

describe('exact window routes', () => {
  test('view updates and shared layout events preserve independent per-window navigation', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    const firstConnId = await windowConnId(first.client)
    const secondConnId = await windowConnId(second.client)

    const opened = await caller.call('ui.window.view.open', {
      connId: firstConnId,
      id: PAGE,
      input: { note: 'one' }
    })
    expect(opened.view).toEqual({ id: PAGE, input: { note: 'one' } })
    expect(opened.viewTabs).toEqual([{ id: PAGE, input: { note: 'one' } }])
    await caller.call('ui.window.view.open', { connId: firstConnId, id: OTHER_PAGE, input: { note: 'second' } })
    await caller.call('ui.window.view.open', { connId: firstConnId, id: OTHER_PAGE, input: { note: 'latest' } })
    const secondOpened = await caller.call('ui.window.view.open', {
      connId: secondConnId,
      id: PAGE,
      input: { note: 'other window' }
    })
    expect(secondOpened.viewTabs).toEqual([{ id: PAGE, input: { note: 'other window' } }])
    await waitFor(() => changes(first).length === 3 && changes(second).length === 1)
    expect(changes(first).map((event) => event.layout.view)).toEqual([
      { id: PAGE, input: { note: 'one' } },
      { id: OTHER_PAGE, input: { note: 'second' } },
      { id: OTHER_PAGE, input: { note: 'latest' } }
    ])
    expect(changes(second).map((event) => event.layout.view)).toEqual([{ id: PAGE, input: { note: 'other window' } }])
    expect((await caller.call('ui.window.state', { connId: firstConnId })).layout.viewTabs).toEqual([
      { id: PAGE, input: { note: 'one' } },
      { id: OTHER_PAGE, input: { note: 'latest' } }
    ])
    expect((await caller.call('ui.window.state', { connId: firstConnId })).layout.view).toEqual({
      id: OTHER_PAGE,
      input: { note: 'latest' }
    })
    expect((await caller.call('ui.window.state', { connId: secondConnId })).layout.viewTabs).toEqual([
      { id: PAGE, input: { note: 'other window' } }
    ])
    expect((await caller.call('ui.window.state', { connId: secondConnId })).layout.view).toEqual({
      id: PAGE,
      input: { note: 'other window' }
    })

    const firstToast = { key: 'first-toast', kind: 'info' as const, title: 'First', body: 'one', detail: null, persistent: false, actions: [] }
    const secondToast = { key: 'second-toast', kind: 'info' as const, title: 'Second', body: 'two', detail: null, persistent: false, actions: [] }
    await first.client.call('ui.report', { slot: PAGE, state: { from: 'first' } })
    await second.client.call('ui.report', { slot: PAGE, state: { from: 'second' } })
    await first.client.call('ui.shell.report', { toasts: [firstToast] })
    await second.client.call('ui.shell.report', { toasts: [secondToast] })
    const firstState = await caller.call('ui.window.state', { connId: firstConnId })
    const secondState = await caller.call('ui.window.state', { connId: secondConnId })
    expect(slotOf(firstState, PAGE).report).toEqual({ from: 'first' })
    expect(slotOf(secondState, PAGE).report).toEqual({ from: 'second' })
    expect(firstState.toasts).toEqual([firstToast])
    expect(secondState.toasts).toEqual([secondToast])

    await caller.call('ui.panel.open', { id: OUTLINE })
    await waitFor(() => changes(first).length === 4 && changes(second).length === 2)
    expect(changes(first)[3]!.layout).toMatchObject({ view: { id: OTHER_PAGE, input: { note: 'latest' } }, panel: OUTLINE })
    expect(changes(second)[1]!.layout).toMatchObject({ view: { id: PAGE, input: { note: 'other window' } }, panel: OUTLINE })
    expect(changes(first)[3]!.layout.tools?.open['right-bottom']).toBe(OUTLINE)
    expect(changes(second)[1]!.layout.tools?.open['right-bottom']).toBe(OUTLINE)
    expect((await caller.call('ui.window.state', { connId: firstConnId })).layout.viewTabs).toEqual([
      { id: PAGE, input: { note: 'one' } },
      { id: OTHER_PAGE, input: { note: 'latest' } }
    ])
  })

  test('view close is compare-and-close against the complete current view', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness, 'closable')
    const connId = await windowConnId(window.client)
    await caller.call('ui.window.view.open', { connId, id: PAGE, input: { note: 'current' } })
    expect((await caller.call('ui.window.state', { connId })).layout.viewTabs).toEqual([{ id: PAGE, input: { note: 'current' } }])

    const omittedInput = await failure(caller.call('ui.window.view.close', { connId, expectedView: { id: PAGE } }))
    expect(omittedInput.code).toBe(RpcErrorCode.Conflict)
    expect((await caller.call('ui.window.state', { connId })).layout.view).toEqual({
      id: PAGE,
      input: { note: 'current' }
    })
    await caller.call('ui.window.view.open', { connId, id: PAGE, input: { note: 'latest' } })
    expect((await caller.call('ui.window.state', { connId })).layout.viewTabs).toEqual([{ id: PAGE, input: { note: 'latest' } }])

    await caller.call('ui.window.view.open', { connId, id: OTHER_PAGE })
    const stale = await failure(caller.call('ui.window.view.close', {
      connId,
      expectedView: { id: PAGE, input: { note: 'current' } }
    }))
    expect(stale.code).toBe(RpcErrorCode.Conflict)
    expect((await caller.call('ui.window.state', { connId })).layout.view).toEqual({ id: OTHER_PAGE })

    const closed = await caller.call('ui.window.view.close', { connId, expectedView: { id: OTHER_PAGE } })
    expect(closed.view).toEqual({ id: PAGE, input: { note: 'latest' } })
    expect(closed.viewTabs).toEqual([{ id: PAGE, input: { note: 'latest' } }])
  })

  test('a targeted command receives its result from exactly the named window', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    answerWith(first, () => ({ result: 'first-result' }))
    answerWith(second, () => ({ result: 'second-result' }))

    const result = await caller.call('ui.window.command.run', { connId: await windowConnId(first.client), id: BOOM })
    expect(result).toEqual({ result: 'first-result' })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toEqual([])
  })

  test('stale window IDs and non-UI self lookups are refused', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness, 'temporary')
    const staleConnId = await windowConnId(window.client)
    const nonWindow = await harness.connect('cli', 'not a window')
    window.client.close()

    expect((await failure(caller.call('ui.window.state', { connId: staleConnId }))).code).toBe(RpcErrorCode.Conflict)
    expect((await failure(nonWindow.call('ui.window.self', {}))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('unselected view and command operations refuse when multiple windows are open', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    answerWith(first, () => ({ result: 'first' }))
    answerWith(second, () => ({ result: 'second' }))

    expect((await failure(caller.call('ui.view.open', { id: PAGE }))).code).toBe(RpcErrorCode.Conflict)
    expect((await failure(caller.call('ui.view.close', {}))).code).toBe(RpcErrorCode.Conflict)
    expect((await failure(caller.call('ui.command.run', { id: BOOM }))).code).toBe(RpcErrorCode.Conflict)
    expect(first.requests).toEqual([])
    expect(second.requests).toEqual([])
  })
})

describe('layout changes', () => {
  test('SC-36: methods open and close the view and panel, move focus and the sidebar, and each persists a broadcast', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)

    const opened = await caller.call('ui.view.open', { id: PAGE, input: { note: 'n2' } })
    expect(opened).toMatchObject({
      view: { id: PAGE, input: { note: 'n2' } },
      viewTabs: [{ id: PAGE, input: { note: 'n2' } }],
      panel: null,
      sidebar: false,
      focus: null
    })
    await caller.call('ui.panel.open', { id: OUTLINE })
    await caller.call('ui.focus', { target: 'panel' })
    await caller.call('ui.sidebar.set', { visible: false })
    expect(slotOf(await caller.call('ui.state', {}), LIST).shown).toBe(false)
    expect(slotOf(await caller.call('ui.state', {}), OUTLINE).shown).toBe(true)

    const closed = await caller.call('ui.panel.close', {})
    expect(closed).toMatchObject({
      view: { id: PAGE, input: { note: 'n2' } },
      viewTabs: [{ id: PAGE, input: { note: 'n2' } }],
      panel: null,
      sidebar: false,
      focus: null,
      tools: { open: { 'right-bottom': null } }
    })
    await caller.call('ui.view.close', {})

    await waitFor(() => changes(window).length === 6)
    const layouts = changes(window).map((event) => event.layout)
    expect(layouts[0]!.view).toEqual({ id: PAGE, input: { note: 'n2' } })
    expect(layouts[2]!.focus).toBe('panel')
    expect(layouts[5]).toMatchObject({ view: null, viewTabs: [], panel: null, sidebar: false, focus: null })
    const final = (await caller.call('ui.state', {})).layout
    expect(final.view).toBeNull()
    expect(final.viewTabs).toEqual([])
    expect(final.tools?.open['right-bottom']).toBeNull()
  })
  test('ui.palette.set toggles atomically, broadcasts and persists its canonical state', async () => {
    const env = makeEnv()
    const harness = await env.start()
    const caller = await harness.connect('cli')
    const window = await openWindow(harness, 'palette')

    const [first, second] = await Promise.all([
      caller.call('ui.palette.set', {}),
      caller.call('ui.palette.set', {})
    ])
    expect([first.palette === true, second.palette === true].sort()).toEqual([false, true])
    await waitFor(() => changes(window).length === 2)
    expect(changes(window).map((event) => event.layout.palette === true).sort()).toEqual([false, true])
    expect((await caller.call('ui.state', {})).layout.palette).toBeUndefined()

    await caller.call('ui.palette.set', { open: true })
    expect((await caller.call('ui.state', {})).layout.palette).toBe(true)
    const restarted = await env.restart()
    const afterRestart = await restarted.connect('cli')
    expect((await afterRestart.call('ui.state', {})).layout.palette).toBe(true)
  })

  test('targeted view changes reach only the selected window', async () => {
    const { harness } = await start()
    const clicker = await openWindow(harness, 'clicker')
    const watcher = await openWindow(harness, 'watcher')
    const connId = await windowConnId(clicker.client)
    await clicker.client.call('ui.window.view.open', { connId, id: OTHER_PAGE, input: { note: 'n3' } })
    await clicker.client.call('ui.window.view.open', { connId, id: PAGE })

    await waitFor(() => changes(clicker).length === 2)
    expect(changes(clicker).map((event) => event.layout.view)).toEqual([
      { id: OTHER_PAGE, input: { note: 'n3' } },
      { id: PAGE }
    ])
    expect(changes(watcher)).toEqual([])
  })

  test('SC-38: the layout survives a restart on the same home', async () => {
    const env = makeEnv()
    const first = await env.start()
    const caller = await first.connect('cli')
    await caller.call('ui.view.open', { id: PAGE, input: { note: 'n9' } })
    await caller.call('ui.panel.open', { id: OUTLINE })
    await caller.call('ui.focus', { target: 'view' })

    const second = await env.restart()
    const again = await second.connect('cli')
    const layout = (await again.call('ui.state', {})).layout
    expect(layout.view).toEqual({ id: PAGE, input: { note: 'n9' } })
    expect(layout.viewTabs).toEqual([{ id: PAGE, input: { note: 'n9' } }])
    expect(layout.panel).toBe(OUTLINE)
    expect(layout.sidebar).toBe(false)
    expect(layout.focus).toBe('view')
    expect(layout.tools?.open['right-bottom']).toBe(OUTLINE)
  })

  test('drops disabled views and panels from persisted layout while preserving unrelated effective state', async () => {
    const env = makeEnv()
    const harness = await env.start()
    const caller = await harness.connect('cli')
    await caller.call('ui.view.open', { id: PAGE })
    await caller.call('ui.panel.open', { id: OUTLINE })

    await caller.call('plugin.disable', { id: PAGE })
    expect((await caller.call('ui.state', {})).layout).toMatchObject({ view: null, panel: OUTLINE })
    await caller.call('plugin.enable', { id: PAGE })
    const reenabled = (await caller.call('ui.state', {})).layout
    expect(reenabled.view).toBeNull()
    expect(reenabled.viewTabs).toEqual([])

    await caller.call('plugin.disable', { id: PAGE })
    await caller.call('plugin.disable', { id: OUTLINE })
    const restarted = await (await env.restart()).connect('cli')
    expect((await restarted.call('ui.state', {})).layout).toMatchObject({ view: null, panel: null })
  })

  test('SC-39: unknown, wrong-kind and invalid targets are refused and leave the layout alone', async () => {
    const { caller } = await start()
    await caller.call('ui.view.open', { id: PAGE })
    const before = (await caller.call('ui.state', {})).layout

    const missing = await failure(caller.call('ui.view.open', { id: 'view:acme.x/missing' }))
    expect(missing.code).toBe(RpcErrorCode.NotFound)
    const sectionAsPanel = await failure(caller.call('ui.panel.open', { id: LIST }))
    expect(sectionAsPanel.code).toBe(RpcErrorCode.InvalidParams)
    const panelAsView = await failure(caller.call('ui.view.open', { id: OUTLINE }))
    expect(panelAsView.code).toBe(RpcErrorCode.InvalidParams)
    const missingPanel = await failure(caller.call('ui.panel.open', { id: 'panel:acme.x/missing' }))
    expect(missingPanel.code).toBe(RpcErrorCode.NotFound)
    const nowhere = await failure(caller.call('ui.focus', { target: 'nowhere' as 'view' }))
    expect(nowhere.code).toBe(RpcErrorCode.InvalidParams)
    const huge = await failure(caller.call('ui.view.open', { id: PAGE, input: { text: 'x'.repeat(65 * 1024) } }))
    expect(huge.code).toBe(RpcErrorCode.InvalidParams)

    const after = (await caller.call('ui.state', {})).layout
    expect(after.view).toEqual(before.view)
    expect(after.viewTabs).toEqual(before.viewTabs)
    expect(after.tools?.open).toEqual(before.tools?.open)
    expect(after.focus).toBe(before.focus)
  })
})

describe('routed UI commands', () => {
  test('SC-40: the window runs the command and its result comes back', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    answerWith(window, (_id, args) => ({ result: `hello ${(args as { name: string }).name}` }))

    expect(await caller.call('ui.command.run', { id: GREET, args: { name: 'zed' } })).toEqual({ result: 'hello zed' })
    expect(window.requests).toEqual([{ type: 'ui.command.request', requestId: expect.any(String), id: GREET, args: { name: 'zed' } }])
  })

  test('SC-40: args the schema refuses never reach the window, and an unknown command is NotFound', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    answerWith(window, () => ({ result: 'unreachable' }))

    const bad = await failure(caller.call('ui.command.run', { id: GREET, args: {} }))
    expect(bad.code).toBe(RpcErrorCode.InvalidParams)
    expect(bad.message).toContain('name')
    const absent = await failure(caller.call('ui.command.run', { id: GREET }))
    expect(absent.code).toBe(RpcErrorCode.InvalidParams)
    const unknown = await failure(caller.call('ui.command.run', { id: `command:${NOTES}/missing` }))
    expect(unknown.code).toBe(RpcErrorCode.NotFound)
    expect(window.requests).toEqual([])
  })

  test('SC-40: a command without an args schema takes an empty or omitted args', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    answerWith(window, () => ({ result: 7 }))
    expect(await caller.call('ui.command.run', { id: BOOM })).toEqual({ result: 7 })
    expect(window.requests[0]!.args).toEqual({})
  })

  test('SC-40: the thrown message of the window code comes back as a Conflict', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    answerWith(window, () => ({ error: { message: 'kaboom' } }))
    const error = await failure(caller.call('ui.command.run', { id: BOOM }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'kaboom' })
  })

  test('SC-41: with no window the command fails', async () => {
    const { harness, caller } = await start()
    await openWindow(harness, 'not a window', 'cli')
    const error = await failure(caller.call('ui.command.run', { id: BOOM }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'no Quirky window is open' })
  })

  test('untargeted commands refuse with two windows while explicit targets remain exact', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    answerWith(first, () => ({ result: 'first' }))
    answerWith(second, () => ({ result: 'second' }))

    const ambiguous = await failure(caller.call('ui.command.run', { id: BOOM }))
    expect(ambiguous.code).toBe(RpcErrorCode.Conflict)
    expect(first.requests).toEqual([])
    expect(second.requests).toEqual([])

    expect(await caller.call('ui.window.command.run', { connId: await windowConnId(second.client), id: BOOM })).toEqual({ result: 'second' })
    expect(await caller.call('ui.window.command.run', { connId: await windowConnId(first.client), id: BOOM })).toEqual({ result: 'first' })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
  })

  test('the window disconnecting before it answers fails the command', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    const running = failure(caller.call('ui.command.run', { id: BOOM }))
    await waitFor(() => window.requests.length === 1)
    window.client.close()
    expect(await running).toMatchObject({ code: RpcErrorCode.Conflict, message: 'the window did not answer' })
  })

  test('a reply from a client that was not sent the command is ignored', async () => {
    const { harness, caller } = await start()
    const target = await openWindow(harness, 'target')
    const stranger = await openWindow(harness, 'stranger')
    const running = caller.call('ui.window.command.run', { connId: await windowConnId(target.client), id: BOOM })
    await waitFor(() => target.requests.length === 1)
    const { requestId } = target.requests[0]!

    await stranger.client.call('ui.command.reply', { requestId, result: 'stolen' })
    await stranger.client.call('ui.command.reply', { requestId: 'unknown-id', result: 'nothing' })
    await target.client.call('ui.command.reply', { requestId, result: 'genuine' })
    expect(await running).toEqual({ result: 'genuine' })
  })
})

describe('slot reports', () => {
  test('SC-42: a report is replaced, an over-cap one is refused with a warning, and null clears it', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    await window.client.call('ui.report', { slot: OUTLINE, state: { n: 1 } })
    await window.client.call('ui.report', { slot: OUTLINE, state: { n: 2 } })
    expect(slotOf(await caller.call('ui.state', {}), OUTLINE).report).toEqual({ n: 2 })

    const tooBig = await failure(window.client.call('ui.report', { slot: OUTLINE, state: 'x'.repeat(100 * 1024) }))
    expect(tooBig.code).toBe(RpcErrorCode.InvalidParams)
    expect(slotOf(await caller.call('ui.state', {}), OUTLINE).report).toEqual({ n: 2 })
    const plugin = (await caller.call('plugin.list', {})).find((item: PluginInfo) => item.id === NOTES)!
    expect(plugin.diagnostics.filter((item) => item.level === 'warning').map((item) => item.message)).toContainEqual(
      expect.stringContaining(OUTLINE)
    )

    await window.client.call('ui.report', { slot: OUTLINE, state: null })
    expect(slotOf(await caller.call('ui.state', {}), OUTLINE).report).toBeUndefined()
  })

  test('SC-42: a window disconnecting takes its reports with it', async () => {
    const { harness, caller } = await start()
    const gone = await openWindow(harness, 'gone')
    const stays = await openWindow(harness, 'stays')
    await stays.client.call('ui.report', { slot: LIST, state: 'kept' })
    await gone.client.call('ui.report', { slot: LIST, state: 'dropped' })
    expect(slotOf(await caller.call('ui.state', {}), LIST).report).toBe('dropped')

    gone.client.close()
    await waitForAsync(async () => slotOf(await caller.call('ui.state', {}), LIST).report === 'kept')
  })

  test('a slot that is not a contribution ID is refused', async () => {
    const { harness } = await start()
    const window = await openWindow(harness)
    const error = await failure(window.client.call('ui.report', { slot: 'nonsense', state: 1 }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('overlay slots', () => {
  const FLOAT = 'acme.float'
  const SHELF = `overlay:${FLOAT}/shelf`
  const HUD = `overlay:${FLOAT}/hud`

  async function startWithOverlays() {
    const env = makeEnv()
    writePlugin(
      join(env.home, 'plugins'),
      {
        id: FLOAT,
        name: FLOAT,
        version: '1.0.0',
        ui: 'ui.js',
        contributes: {
          overlay: [
            { id: 'hud', title: 'Hud', order: 5 },
            { id: 'shelf', title: 'Shelf' }
          ]
        }
      },
      { 'ui.js': 'export function activate() {}\n' }
    )
    const harness = await env.start()
    return { harness, caller: await harness.connect('cli') }
  }

  test('SC-67: ui.state lists each overlay, hidden until a window reports for it', async () => {
    const { harness, caller } = await startWithOverlays()
    const before = await caller.call('ui.state', {})
    expect(slotOf(before, SHELF)).toEqual({ id: SHELF, kind: 'overlay', plugin: FLOAT, title: 'Shelf', shown: false })
    expect(before.slots.map((slot) => slot.id).filter((id) => id.startsWith('overlay:'))).toEqual([HUD, SHELF])

    const window = await openWindow(harness)
    await window.client.call('ui.report', { slot: SHELF, state: { open: false } })
    expect(slotOf(await caller.call('ui.state', {}), SHELF)).toEqual({
      id: SHELF,
      kind: 'overlay',
      plugin: FLOAT,
      title: 'Shelf',
      shown: true,
      report: { open: false }
    })
    expect(slotOf(await caller.call('ui.state', {}), HUD).shown).toBe(false)
  })

  test('SC-67: shown follows the report boolean and stays true for any other report', async () => {
    const { harness, caller } = await startWithOverlays()
    const window = await openWindow(harness)
    const shown = async () => slotOf(await caller.call('ui.state', {}), SHELF).shown

    await window.client.call('ui.report', { slot: SHELF, state: { shown: false } })
    expect(await shown()).toBe(false)
    await window.client.call('ui.report', { slot: SHELF, state: { shown: true } })
    expect(await shown()).toBe(true)
    for (const state of [{ shown: 'no' }, { shown: 0 }, {}, 'text', 3, [false], [{ shown: false }]]) {
      await window.client.call('ui.report', { slot: SHELF, state })
      expect(await shown()).toBe(true)
    }
    await window.client.call('ui.report', { slot: SHELF, state: null })
    expect(await shown()).toBe(false)
  })

  test('SC-67: shown is false again once the window that reported disconnects', async () => {
    const { harness, caller } = await startWithOverlays()
    const window = await openWindow(harness)
    await window.client.call('ui.report', { slot: SHELF, state: {} })
    expect(slotOf(await caller.call('ui.state', {}), SHELF).shown).toBe(true)
    window.client.close()
    await waitForAsync(async () => slotOf(await caller.call('ui.state', {}), SHELF).shown === false)
  })

  test('SC-67: the focused window decides when two windows report different shown values', async () => {
    const { harness, caller } = await startWithOverlays()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    await first.client.call('ui.report', { slot: SHELF, state: { shown: false } })
    await second.client.call('ui.report', { slot: SHELF, state: { shown: true } })
    expect(slotOf(await caller.call('ui.state', {}), SHELF).shown).toBe(true)
    await first.client.call('ui.window.focused', { focused: true })
    expect(slotOf(await caller.call('ui.state', {}), SHELF).shown).toBe(false)
  })

  test('SC-67: disabling the plugin removes its overlays from ui.state', async () => {
    const { caller } = await startWithOverlays()
    expect(slotOf(await caller.call('ui.state', {}), SHELF).kind).toBe('overlay')
    await caller.call('plugin.disable', { id: FLOAT })
    const state = await caller.call('ui.state', {})
    expect(state.slots.some((slot) => slot.kind === 'overlay')).toBe(false)
  })
})

describe('command routing timeout', () => {
  test('a window that never answers fails the command after the timeout', async () => {
    const conn = { id: 1, role: 'ui', closed: false, focusedAt: undefined } as unknown as ClientConn
    const layout = new LayoutService({
      plugins: { contributions: () => [], addWarning: () => {} },
      store: { getUiState: () => null, setUiState: () => {} },
      ui: {
        contributions: () =>
          ({ activityItems: [], sidebarSections: [], statusBars: [], panels: [], views: [], commands: [{ id: BOOM }] }) as unknown as UiModel
      },
      clients: () => [conn],
      broadcast: () => {},
      broadcastNonWindows: () => {},
      sendTo: () => {},
      commandTimeoutMs: 20
    })
    const error = await failure(layout.runCommand(BOOM, {}))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'the window did not answer' })
  })
})
