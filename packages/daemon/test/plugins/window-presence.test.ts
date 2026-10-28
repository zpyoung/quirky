import { afterEach, describe, expect, test } from 'bun:test'
import {
  DESKTOP_AWAY_MS,
  RpcErrorCode,
  type ClientRole,
  type QuirkyClient,
  type QuirkyEvent,
  type UiModel,
  type UiWindowInfo
} from '@quirky/protocol'
import { LayoutService } from '../../src/plugins/layout'
import { Core, type CoreOptions } from '../../src/service'
import { Store } from '../../src/store'
import type { ClientConn } from '../../src/types'
import { startHarness, waitFor, type Harness } from '../helpers'

const SLOT = 'view:acme.notes/page'
const OTHER_SLOT = 'sidebar-section:acme.notes/list'

let nextId = 1
function fakeWindow(role: ClientRole | null = 'ui', name?: string): ClientConn {
  return { id: nextId++, role, name, closed: false } as unknown as ClientConn
}

function makeLayout(options: { awayMs?: number } = {}) {
  const clock = { now: 1_000_000 }
  const conns: ClientConn[] = []
  const broadcasts: QuirkyEvent[] = []
  const layout = new LayoutService({
    plugins: { contributions: () => [], addWarning: () => {} },
    store: { getUiState: () => null, setUiState: () => {} },
    ui: { contributions: () => ({ sidebarSections: [], statusBars: [], activityItems: [], panels: [], views: [], overlays: [], commands: [] }) as unknown as UiModel },
    clients: () => conns,
    broadcast: (event) => broadcasts.push(event),
    broadcastNonWindows: () => {},
    sendTo: () => {},
    now: () => clock.now,
    ...options
  })
  const open = (role: ClientRole | null = 'ui', name?: string) => {
    const conn = fakeWindow(role, name)
    conns.push(conn)
    return conn
  }
  const changed = () => broadcasts.filter((event) => event.type === 'ui.window.changed')
  const reportChanged = () => broadcasts.filter((event) => event.type === 'ui.report.changed')
  const windows = () => layout.state().windows
  return { layout, clock, conns, broadcasts, open, changed, reportChanged, windows }
}

describe('window activity', () => {
  test('SC-4: a window is present until the away threshold passes without input', () => {
    const t = makeLayout({ awayMs: 1000 })
    const conn = t.open()
    expect(t.windows()).toEqual([{ connId: conn.id, focused: false, inputAt: null, present: false }])

    t.layout.windowActivity(conn)
    expect(t.windows()[0]).toMatchObject({ inputAt: t.clock.now, present: true })

    t.clock.now += 999
    expect(t.windows()[0]!.present).toBe(true)
    t.clock.now += 1
    expect(t.windows()[0]).toMatchObject({ present: false, inputAt: 1_000_000 })
  })

  test('the default threshold is DESKTOP_AWAY_MS and setAwayMs replaces it', () => {
    const t = makeLayout()
    const conn = t.open()
    t.layout.windowActivity(conn)
    t.clock.now += DESKTOP_AWAY_MS - 1
    expect(t.windows()[0]!.present).toBe(true)
    t.clock.now += 1
    expect(t.windows()[0]!.present).toBe(false)

    t.layout.setAwayMs(50)
    t.layout.windowActivity(conn)
    t.clock.now += 50
    expect(t.windows()[0]!.present).toBe(false)
  })

  test('only a window can report activity', () => {
    const t = makeLayout()
    const cli = t.open('cli')
    expect(() => t.layout.windowActivity(cli)).toThrow('only a window')
  })

  test('SC-5: ui.window.changed fires when activity turns a window present, not on every report', () => {
    const t = makeLayout({ awayMs: 1000 })
    const conn = t.open('ui', 'main')
    t.layout.windowActivity(conn)
    expect(t.changed()).toEqual([
      {
        type: 'ui.window.changed',
        windows: [{ connId: conn.id, name: 'main', focused: false, inputAt: t.clock.now, present: true }]
      }
    ])

    t.clock.now += 100
    t.layout.windowActivity(conn)
    t.clock.now += 100
    t.layout.windowActivity(conn)
    expect(t.changed()).toHaveLength(1)

    t.clock.now += 5000
    t.layout.windowActivity(conn)
    expect(t.changed()).toHaveLength(2)
  })

  test('ui.window.changed fires when the focused window changes and not when focus is repeated', () => {
    const t = makeLayout()
    const first = t.open('ui', 'first')
    const second = t.open('ui', 'second')

    t.layout.windowFocused(first, true)
    expect(t.changed()).toHaveLength(1)
    t.layout.windowFocused(first, true)
    expect(t.changed()).toHaveLength(1)

    t.layout.windowFocused(second, true)
    expect(t.changed()).toHaveLength(2)
    const last = t.changed()[1] as Extract<QuirkyEvent, { type: 'ui.window.changed' }>
    expect(last.windows.filter((w: UiWindowInfo) => w.focused).map((w: UiWindowInfo) => w.name)).toEqual(['second'])

    t.layout.windowFocused(first, false)
    expect(t.changed()).toHaveLength(2)
    t.layout.windowFocused(second, false)
    expect(t.changed()).toHaveLength(3)
  })

  test('blurring the focused window hands focus back to the earlier one and says so', () => {
    const t = makeLayout()
    const first = t.open('ui', 'first')
    const second = t.open('ui', 'second')
    t.layout.windowFocused(first, true)
    t.layout.windowFocused(second, true)
    t.layout.windowFocused(second, false)
    const last = t.changed().at(-1) as Extract<QuirkyEvent, { type: 'ui.window.changed' }>
    expect(last.windows.find((w: UiWindowInfo) => w.focused)?.name).toBe('first')
  })

  test('a dropped window connection is announced without it', () => {
    const t = makeLayout()
    const stays = t.open('ui', 'stays')
    const gone = t.open('ui', 'gone')
    gone.closed = true
    t.layout.dropConnection(gone)
    expect(t.changed()).toEqual([
      { type: 'ui.window.changed', windows: [{ connId: stays.id, name: 'stays', focused: false, inputAt: null, present: false }] }
    ])
  })

  test('a dropped connection that was not a window announces nothing', () => {
    const t = makeLayout()
    t.open('ui')
    const cli = t.open('cli')
    cli.closed = true
    t.layout.dropConnection(cli)
    expect(t.changed()).toEqual([])
  })
})

describe('report changes', () => {
  test('SC-9: a changed report emits ui.report.changed, an identical one does not', () => {
    const t = makeLayout()
    const conn = t.open()
    t.layout.report(conn, SLOT, { open: 'n1', ids: [1, 2] })
    expect(t.reportChanged()).toEqual([{ type: 'ui.report.changed', slot: SLOT, connId: conn.id }])

    t.layout.report(conn, SLOT, { ids: [1, 2], open: 'n1' })
    expect(t.reportChanged()).toHaveLength(1)

    t.layout.report(conn, SLOT, { open: 'n1', ids: [1, 3] })
    expect(t.reportChanged()).toHaveLength(2)
  })

  test('clearing an existing report emits, clearing nothing does not', () => {
    const t = makeLayout()
    const conn = t.open()
    t.layout.report(conn, SLOT, null)
    expect(t.reportChanged()).toEqual([])

    t.layout.report(conn, SLOT, 'x')
    t.layout.report(conn, SLOT, null)
    expect(t.reportChanged()).toHaveLength(2)
    t.layout.report(conn, SLOT, null)
    expect(t.reportChanged()).toHaveLength(2)
  })

  test('dropping a window emits ui.report.changed for each report it removes, and only those', () => {
    const t = makeLayout()
    const gone = t.open()
    const stays = t.open()
    t.layout.report(gone, SLOT, 1)
    t.layout.report(gone, OTHER_SLOT, 2)
    t.layout.report(stays, SLOT, 3)
    t.broadcasts.length = 0

    gone.closed = true
    t.layout.dropConnection(gone)
    expect(t.reportChanged()).toEqual([
      { type: 'ui.report.changed', slot: SLOT, connId: gone.id },
      { type: 'ui.report.changed', slot: OTHER_SLOT, connId: gone.id }
    ])

    t.broadcasts.length = 0
    stays.closed = true
    t.layout.dropConnection(stays)
    expect(t.reportChanged()).toEqual([{ type: 'ui.report.changed', slot: SLOT, connId: stays.id }])
  })

  test('dropping a window with no reports emits no ui.report.changed', () => {
    const t = makeLayout()
    const conn = t.open()
    conn.closed = true
    t.layout.dropConnection(conn)
    expect(t.reportChanged()).toEqual([])
  })

  test('reports are tracked per window and per slot', () => {
    const t = makeLayout()
    const a = t.open()
    const b = t.open()
    t.layout.report(a, SLOT, 1)
    t.layout.report(b, SLOT, 1)
    t.layout.report(a, OTHER_SLOT, 1)
    expect(t.reportChanged().map((event) => (event as { connId: number }).connId)).toEqual([a.id, b.id, a.id])
  })
})

describe('ui.report.changed delivery', () => {
  function makeCore(onEvent: (event: QuirkyEvent) => void): Core {
    return new Core({
      home: '/tmp/qd-presence',
      pty: { onData() {}, onExit() {}, onReconnect() {}, connected: true },
      notifier: () => {},
      hookToken: 'token',
      hookUrl: () => 'http://127.0.0.1:1/hook',
      onEvent
    } as unknown as CoreOptions)
  }

  test('reaches plugin listeners but no subscribed client', () => {
    const seen: QuirkyEvent[] = []
    const core = makeCore((event) => seen.push(event))
    const text: string[] = []
    const client = { id: 1, role: 'ui', subscribed: true, closed: false, sendText: (t: string) => text.push(t) } as unknown as ClientConn
    core.addClient(client)

    core.broadcast({ type: 'ui.report.changed', slot: SLOT, connId: 1 })
    expect(seen).toEqual([{ type: 'ui.report.changed', slot: SLOT, connId: 1 }])
    expect(text).toEqual([])

    core.broadcast({ type: 'ui.window.changed', windows: [] })
    expect(text).toHaveLength(1)
  })
})

describe('ui.window.activity over RPC', () => {
  const harnesses: Harness[] = []
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.cleanup()
  })

  async function start(options: Parameters<typeof startHarness>[0] = {}) {
    const harness = await startHarness(options)
    harnesses.push(harness)
    return harness
  }

  async function subscribedWindow(harness: Harness, name: string): Promise<{ client: QuirkyClient; events: QuirkyEvent[] }> {
    const client = await harness.connect('ui', name)
    const events: QuirkyEvent[] = []
    client.onEvent((event) => events.push(event))
    await client.call('events.subscribe', {})
    return { client, events }
  }

  test('SC-4: activity makes the window present in ui.state and subscribers hear it', async () => {
    const harness = await start()
    const caller = await harness.connect('cli')
    const window = await subscribedWindow(harness, 'main')
    expect((await caller.call('ui.state', {})).windows).toEqual([
      { connId: expect.any(Number), name: 'main', focused: false, inputAt: null, present: false }
    ])

    expect(await window.client.call('ui.window.activity', {})).toEqual({ ok: true })
    const [info] = (await caller.call('ui.state', {})).windows
    expect(info).toMatchObject({ present: true, inputAt: expect.any(Number) })
    await waitFor(() => window.events.some((event) => event.type === 'ui.window.changed'))
  })

  test('a non-window connection is refused', async () => {
    const harness = await start()
    const caller = await harness.connect('cli')
    try {
      await caller.call('ui.window.activity', {})
      throw new Error('expected the call to reject')
    } catch (error) {
      expect((error as { code: number }).code).toBe(RpcErrorCode.InvalidParams)
    }
  })

  test('the away threshold comes from the daemon option', async () => {
    const harness = await start({ desktopAwayMs: 150 })
    const caller = await harness.connect('cli')
    const window = await subscribedWindow(harness, 'main')
    await window.client.call('ui.window.activity', {})
    expect((await caller.call('ui.state', {})).windows[0]!.present).toBe(true)
    await Bun.sleep(200)
    expect((await caller.call('ui.state', {})).windows[0]!.present).toBe(false)
  })

  test('ui.report.changed never reaches a subscribed window', async () => {
    const harness = await start()
    const window = await subscribedWindow(harness, 'main')
    await window.client.call('ui.report', { slot: SLOT, state: 1 })
    await window.client.call('ui.window.activity', {})
    await waitFor(() => window.events.some((event) => event.type === 'ui.window.changed'))
    expect(window.events.some((event) => event.type === 'ui.report.changed')).toBe(false)
  })
})
