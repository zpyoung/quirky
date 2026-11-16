import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { createNativeBrowserCapability } from '../../../packages/ui/src/native-browser'
import type { Inspection, PanelState, SectionId, SessionInfo, Usage } from '../src/types'

type Call = { method: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>
type MountFunction = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
type ConnectionStatus = 'connected' | 'reconnecting'
type PanelOptions = {
  model?: string
  activity?: string
  tokens?: number
  freshness?: Usage['freshness']
  usedPercentage?: number
  workspace?: string | null
  openSections?: SectionId[]
}
type Fake = {
  context: UiPluginContext
  calls: Call[]
  provided: Map<string, (...args: unknown[]) => unknown>
  emit(event: QuirkyEvent): Promise<void>
  connection(status: ConnectionStatus): Promise<void>
  listenerCount(): number
}
type PanelFixture = { element: HTMLElement; unmount(): void }

const PANEL_ID = 'panel:quirky.session-info/info'
const GET_METHOD = 'quirky.session-info/get'
const SESSION_INFO_CHANGED = 'quirky.session-info/changed'
const FOCUS_CHANGED = 'quirky.terminal/focusContextChanged'
const timerControls = jest as unknown as { advanceTimersByTime(milliseconds: number): void }
const mountedDisposers: (() => void)[] = []

function panelState(session: string | null, options: PanelOptions = {}): PanelState {
  if (session === null) {
    return { session: null, pane: null, workspace: null, openSections: options.openSections ?? ['liveActivity'], info: null }
  }

  const timestamp = 1_700_000_060_000
  const info: SessionInfo = {
    identity: {
      agent: 'claude', sessionId: session, providerSessionId: `provider-${session}`, model: options.model ?? `Model ${session}`,
      pane: `pane-${session}`, paneTitle: `Pane ${session}`, worktreeId: `wt-${session}`, cwd: '/repo',
      startedAt: timestamp - 60_000, updatedAt: timestamp
    },
    liveActivity: {
      state: 'working', label: options.activity ?? `Activity ${session}`, toolName: 'Read', subagentCount: 1,
      startedAt: timestamp - 60_000, updatedAt: timestamp
    },
    usage: {
      status: 'ready', freshness: options.freshness ?? 'stale', totalTokens: options.tokens ?? 100, turnCount: 2,
      input: 60, output: 40, cacheRead: 0, cacheWrite: 0, updatedAt: timestamp
    },
    context: { status: 'ready', usedPercentage: options.usedPercentage ?? 25, remainingPercentage: 75, window: 1000, used: 250, remaining: 750, updatedAt: timestamp }
  }
  return {
    session,
    pane: `pane-${session}`,
    workspace: options.workspace ?? `wt-${session}`,
    openSections: options.openSections ?? ['liveActivity', 'usage', 'context'],
    info
  }
}

function makeInspection(session: string): Inspection {
  return {
    hooks: { state: 'installed', detail: `Inspection for ${session}` },
    mcp: [],
    updatedAt: 1_700_000_060_001
  }
}

function makeFake(handlers: Record<string, Handler>): Fake {
  const calls: Call[] = []
  const provided = new Map<string, (...args: unknown[]) => unknown>()
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connectionListeners = new Set<(status: ConnectionStatus) => void>()
  const context: UiPluginContext = {
    pluginId: 'quirky.session-info',
    nativeBrowser: createNativeBrowserCapability(),
    nativeDropPaths: async () => null,
    readClipboardText: async () => '',
    log() {},
    provide(id, implementation) { provided.set(id, implementation as (...args: unknown[]) => unknown) },
    async call(method, params = {}) {
      const args = params as Record<string, unknown>
      calls.push({ method, params: args })
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected call ${method}`)
      return handler(args)
    },
    subscribe(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    getSetting() { throw new Error('no settings') },
    async executeCommand(id, args) {
      const handler = provided.get(id)
      if (handler) await handler(args)
    },
    createCommandDrag() { throw new Error('command dragging is unavailable in this fake') },
    consumeCommandDrag() { return null },
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    getLayout() { return { view: null, panel: null, sidebar: true, focus: null } },
    setPalette() { throw new Error('unexpected palette mutation') },
    onLayout() { return () => {} },
    onStream() { return () => {} },
    onConnection(listener) { connectionListeners.add(listener); return () => connectionListeners.delete(listener) },
    async confirm() { return true },
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  }
  return {
    context,
    calls,
    provided,
    async emit(event) {
      await act(async () => {
        for (const listener of eventListeners) await listener(event)
      })
    },
    async connection(status) {
      await act(async () => {
        for (const listener of connectionListeners) listener(status)
      })
    },
    listenerCount() { return eventListeners.size + connectionListeners.size }
  }
}

let activatePlugin: (context: UiPluginContext) => void

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ activate: activatePlugin } = await import('../src/ui'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => {
  jest.useFakeTimers()
  document.body.innerHTML = ''
})
afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
  jest.useRealTimers()
})

function mountPanel(fake: Fake): PanelFixture {
  const mount = fake.provided.get(PANEL_ID) as MountFunction | undefined
  if (!mount) throw new Error(`missing mount ${PANEL_ID}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  act(() => { cleanup = mount(element, { report() {} }) })
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    act(() => { cleanup?.() })
    element.remove()
  }
  mountedDisposers.push(unmount)
  return { element, unmount }
}

function getCalls(fake: Fake): Call[] {
  return fake.calls.filter(({ method }) => method === GET_METHOD)
}

function canonicalChange(sessionId?: string | null): QuirkyEvent {
  return { type: SESSION_INFO_CHANGED, data: sessionId === undefined ? {} : { sessionId } } as QuirkyEvent
}

function focusChange(workspace: string | null): QuirkyEvent {
  return { type: FOCUS_CHANGED, data: { workspace } } as QuirkyEvent
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    timerControls.advanceTimersByTime(milliseconds)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle()
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = root.querySelector(`button[aria-label="${label}"]`)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button ${label}`)
  return found
}

describe('Session info projection refresh coalescing', () => {
  test('bounds canonical invalidations, ignores raw and other-session events, and supports unscoped changes', async () => {
    const fake = makeFake({ [GET_METHOD]: () => panelState('A') })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()
    expect(getCalls(fake)).toHaveLength(1)

    for (let index = 0; index < 10; index++) {
      await fake.emit(canonicalChange(null))
      if (index < 9) await advance(10)
    }

    expect(getCalls(fake)).toHaveLength(1)
    await advance(1_409)
    expect(getCalls(fake)).toHaveLength(1)
    await advance(1)
    expect(getCalls(fake)).toHaveLength(2)

    await fake.emit({ type: 'quirky.session/changed', data: { session: { id: 'A', status: 'running' } } } as QuirkyEvent)
    await fake.emit({ type: 'quirky.agent-status/changed', data: { sessionId: 'A' } } as QuirkyEvent)
    await fake.emit(canonicalChange('B'))
    expect(getCalls(fake)).toHaveLength(2)

    await fake.emit(canonicalChange())
    await advance(1_499)
    expect(getCalls(fake)).toHaveLength(2)
    await advance(1)
    expect(getCalls(fake)).toHaveLength(3)
    panel.unmount()
  })

  test('starts the first focus read while mount is pending, deduplicates its target, and fences the old projection', async () => {
    const initial = Promise.withResolvers<PanelState>()
    let gets = 0
    const fake = makeFake({
      [GET_METHOD]: () => ++gets === 1 ? initial.promise : panelState('B', { model: 'Focused B' })
    })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()
    expect(getCalls(fake)).toHaveLength(1)

    await fake.emit(focusChange('wt-B'))
    expect(getCalls(fake)).toHaveLength(2)
    expect(panel.element.textContent).not.toContain('Model A')
    await fake.emit(focusChange('wt-B'))
    expect(getCalls(fake)).toHaveLength(2)

    initial.resolve(panelState('A', { model: 'Stale A' }))
    await settle()
    expect(getCalls(fake)).toHaveLength(2)
    expect(panel.element.textContent).toContain('Focused B')
    expect(panel.element.textContent).not.toContain('Stale A')
    panel.unmount()
  })

  test('clears a displayed projection and reads a genuine focus change immediately despite the cooldown', async () => {
    const next = Promise.withResolvers<PanelState>()
    let gets = 0
    const fake = makeFake({
      [GET_METHOD]: () => ++gets === 1 ? panelState('A', { model: 'Old A' }) : next.promise
    })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()
    expect(panel.element.textContent).toContain('Old A')

    await fake.emit(canonicalChange('A'))
    await advance(300)
    expect(getCalls(fake)).toHaveLength(1)

    await fake.emit(focusChange('wt-B'))
    expect(getCalls(fake)).toHaveLength(2)
    expect(panel.element.textContent).not.toContain('Old A')
    await fake.emit(focusChange('wt-B'))
    expect(getCalls(fake)).toHaveLength(2)

    next.resolve(panelState('B', { model: 'New B' }))
    await settle()
    expect(panel.element.textContent).toContain('New B')
    expect(panel.element.textContent).not.toContain('Old A')
    panel.unmount()
  })

  test('keeps one activation deadline across reconnect and remount, and cancels queued work on unmount', async () => {
    const fake = makeFake({ [GET_METHOD]: () => panelState('A') })
    activatePlugin(fake.context)
    let panel = mountPanel(fake)
    await settle()
    expect(getCalls(fake)).toHaveLength(1)

    await fake.connection('connected')
    await fake.connection('connected')
    expect(getCalls(fake)).toHaveLength(1)

    await fake.emit(canonicalChange(null))
    await advance(600)
    await fake.connection('reconnecting')
    await fake.connection('connected')
    expect(getCalls(fake)).toHaveLength(2)
    await fake.emit(canonicalChange(null))
    await advance(1_499)
    expect(getCalls(fake)).toHaveLength(2)
    await advance(1)
    expect(getCalls(fake)).toHaveLength(3)

    panel.unmount()
    panel = mountPanel(fake)
    await settle()
    expect(getCalls(fake)).toHaveLength(3)
    await fake.connection('connected')
    await fake.emit(canonicalChange(null))
    await advance(1_499)
    expect(getCalls(fake)).toHaveLength(3)
    await advance(1)
    expect(getCalls(fake)).toHaveLength(4)

    await fake.emit(canonicalChange(null))
    panel.unmount()
    await advance(3_000)
    expect(getCalls(fake)).toHaveLength(4)
    expect(fake.listenerCount()).toBe(0)
  })

  test('allows a pending automatic response to publish during sustained invalidations and spaces starts by 1500ms', async () => {
    const initial = Promise.withResolvers<PanelState>()
    let gets = 0
    const fake = makeFake({
      [GET_METHOD]: () => ++gets === 1 ? initial.promise : panelState('A', { model: `Automatic ${gets}` })
    })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()

    for (let index = 0; index < 10; index++) {
      await fake.emit(canonicalChange(null))
      await advance(100)
    }
    expect(getCalls(fake)).toHaveLength(1)
    initial.resolve(panelState('A', { model: 'Published initial' }))
    await settle()
    expect(panel.element.textContent).toContain('Published initial')
    expect(getCalls(fake)).toHaveLength(1)

    for (let index = 0; index < 40; index++) {
      await fake.emit(canonicalChange(null))
      await advance(100)
    }
    expect(getCalls(fake)).toHaveLength(4)
    await advance(999)
    expect(getCalls(fake)).toHaveLength(4)
    await advance(1)
    expect(getCalls(fake)).toHaveLength(5)
    panel.unmount()
  })

  test('Retry starts get 3 beside pending get 2 and inspection, publishes first, and fences inspection across focus', async () => {
    const oldAutomatic = Promise.withResolvers<PanelState>()
    const retryInspection = Promise.withResolvers<Inspection>()
    const inspectedSessions: string[] = []
    let gets = 0
    const fake = makeFake({
      [GET_METHOD]: () => {
        gets++
        if (gets === 1) return panelState('A', { model: 'Initial stale', tokens: 100, openSections: ['liveActivity', 'usage', 'context'] })
        if (gets === 2) return oldAutomatic.promise
        if (gets === 3) return panelState('A', { model: 'Fresh retry', activity: 'Fresh activity', tokens: 900, freshness: 'fresh', usedPercentage: 82 })
        return panelState('B', { model: 'Focused B', activity: 'Activity B', tokens: 200 })
      },
      'quirky.session-info/inspect': ({ session }) => {
        inspectedSessions.push(String(session))
        return session === 'A' ? retryInspection.promise : makeInspection(String(session))
      },
      'quirky.session-info/sections': ({ open }) => ({ open })
    })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()
    expect(getCalls(fake)).toHaveLength(1)
    expect(inspectedSessions).toEqual([])

    await fake.emit(canonicalChange(null))
    await advance(1_500)
    expect(getCalls(fake)).toHaveLength(2)

    await click(button(panel.element, 'Retry usage'))
    expect(getCalls(fake)).toHaveLength(3)
    expect(inspectedSessions).toEqual(['A'])
    await settle()
    expect(panel.element.textContent).toContain('Fresh retry')
    expect(panel.element.textContent).toContain('Fresh activity')
    expect(panel.element.textContent).toContain('900')
    expect(panel.element.textContent).toContain('82% context used')

    oldAutomatic.resolve(panelState('A', { model: 'Stale automatic', activity: 'Stale activity', tokens: 111 }))
    await settle()
    expect(panel.element.textContent).toContain('Fresh retry')
    expect(panel.element.textContent).not.toContain('Stale automatic')
    expect(panel.element.textContent).toContain('900')

    await fake.emit(focusChange('wt-B'))
    await settle()
    expect(getCalls(fake)).toHaveLength(4)
    expect(panel.element.textContent).toContain('Focused B')
    retryInspection.resolve(makeInspection('A'))
    await settle()
    expect(panel.element.textContent).not.toContain('Inspection for A')

    await click(button(panel.element, 'Hooks & MCP'))
    expect(inspectedSessions).toEqual(['A', 'B'])
    expect(panel.element.textContent).toContain('Inspection for B')
    expect(panel.element.textContent).not.toContain('Inspection for A')
    panel.unmount()
  })

  test('keeps Hooks & MCP lazy and preserves its inspection only for the matching session', async () => {
    let gets = 0
    const inspectedSessions: string[] = []
    const fake = makeFake({
      [GET_METHOD]: () => {
        gets++
        if (gets === 1) return panelState('A', { openSections: ['liveActivity'] })
        if (gets === 2) return panelState('A', { openSections: ['liveActivity', 'hooksAndMcp'] })
        return panelState('B', { openSections: ['liveActivity'] })
      },
      'quirky.session-info/inspect': ({ session }) => {
        const value = String(session)
        inspectedSessions.push(value)
        return makeInspection(value)
      },
      'quirky.session-info/sections': ({ open }) => ({ open })
    })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()
    expect(inspectedSessions).toEqual([])

    await click(button(panel.element, 'Hooks & MCP'))
    expect(inspectedSessions).toEqual(['A'])
    expect(panel.element.textContent).toContain('Inspection for A')

    await fake.emit(canonicalChange('A'))
    await advance(1_500)
    expect(getCalls(fake)).toHaveLength(2)
    expect(inspectedSessions).toEqual(['A'])
    expect(panel.element.textContent).toContain('Inspection for A')

    await fake.emit(focusChange('wt-B'))
    await settle()
    expect(panel.element.textContent).not.toContain('Inspection for A')
    await click(button(panel.element, 'Hooks & MCP'))
    expect(inspectedSessions).toEqual(['A', 'B'])
    expect(panel.element.textContent).toContain('Inspection for B')
    expect(panel.element.textContent).not.toContain('Inspection for A')
    panel.unmount()
  })

  test('fences pending telemetry when focus becomes empty and cancels pending work on unmount', async () => {
    const pendingTelemetry = Promise.withResolvers<{ statusline?: Inspection['statusline']; nextLaunchEffect: string }>()
    const pendingAutomatic = Promise.withResolvers<PanelState>()
    const inspectedSessions: string[] = []
    let gets = 0
    const fake = makeFake({
      [GET_METHOD]: () => {
        gets++
        if (gets === 1) return panelState('A', { model: 'Target A', openSections: ['liveActivity', 'hooksAndMcp'] })
        if (gets === 2) return panelState(null)
        if (gets === 3) return panelState('B', { model: 'Target B', openSections: ['liveActivity'] })
        return pendingAutomatic.promise
      },
      'quirky.session-info/inspect': ({ session }) => {
        const value = String(session)
        inspectedSessions.push(value)
        return value === 'A'
          ? { hooks: { state: 'installed', detail: 'Inspection for A' }, statusline: { state: 'available', detail: 'Custom A statusline' }, mcp: [], updatedAt: 1_700_000_060_001 }
          : makeInspection(value)
      },
      'quirky.session-info/enableTelemetry': () => pendingTelemetry.promise,
      'quirky.session-info/sections': ({ open }) => ({ open })
    })
    activatePlugin(fake.context)
    let panel = mountPanel(fake)
    await settle()
    expect(inspectedSessions).toEqual(['A'])
    expect(panel.element.textContent).toContain('Custom statusline detected')

    await click(button(panel.element, 'Enable session telemetry'))
    expect(fake.calls.filter(({ method }) => method === 'quirky.session-info/enableTelemetry')).toHaveLength(1)
    await fake.emit(focusChange(null))
    expect(getCalls(fake)).toHaveLength(2)
    expect(panel.element.textContent).toContain('No agent session')
    expect(panel.element.textContent).not.toContain('Target A')

    await fake.emit(focusChange('wt-B'))
    await settle()
    expect(getCalls(fake)).toHaveLength(3)
    expect(panel.element.textContent).toContain('Target B')
    expect(panel.element.textContent).not.toContain('Inspection for A')
    await click(button(panel.element, 'Hooks & MCP'))
    expect(inspectedSessions).toEqual(['A', 'B'])
    expect(panel.element.textContent).toContain('Inspection for B')

    pendingTelemetry.resolve({
      statusline: { state: 'managed', detail: 'Stale A telemetry statusline' },
      nextLaunchEffect: 'Stale A consent effect'
    })
    await settle()
    expect(panel.element.textContent).not.toContain('Stale A telemetry statusline')
    expect(panel.element.textContent).not.toContain('Stale A consent effect')
    expect(panel.element.textContent).not.toContain('Inspection for A')
    expect(panel.element.textContent).toContain('Inspection for B')

    await fake.emit(canonicalChange(null))
    await advance(1_500)
    expect(getCalls(fake)).toHaveLength(4)
    await fake.emit(canonicalChange(null))
    panel.unmount()
    await advance(3_000)
    expect(getCalls(fake)).toHaveLength(4)
    pendingAutomatic.resolve(panelState('B'))
    await settle()
    expect(getCalls(fake)).toHaveLength(4)
    expect(fake.listenerCount()).toBe(0)
  })

  test('recovers with Retry after a rejected projection read', async () => {
    let gets = 0
    const fake = makeFake({
      [GET_METHOD]: () => {
        gets++
        if (gets === 1) return panelState('A', { model: 'Last good', tokens: 100 })
        if (gets === 2) throw new Error('temporary projection failure')
        return panelState('A', { model: 'Recovered', tokens: 250, freshness: 'fresh' })
      },
      'quirky.session-info/inspect': ({ session }) => makeInspection(String(session))
    })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await settle()

    await fake.emit(canonicalChange('A'))
    await advance(1_500)
    await settle()
    expect(getCalls(fake)).toHaveLength(2)
    expect(panel.element.textContent).toContain('temporary projection failure')

    await click(button(panel.element, 'Retry usage'))
    expect(getCalls(fake)).toHaveLength(3)
    await settle()
    expect(panel.element.textContent).toContain('Recovered')
    expect(panel.element.textContent).toContain('250')
    expect(panel.element.textContent).not.toContain('temporary projection failure')
    panel.unmount()
  })

  for (const reconnectAt of [600, 3_000]) {
    test(`remount after offscreen recovery at ${reconnectAt}ms retains its deadline and resumes reads`, async () => {
      const fake = makeFake({ [GET_METHOD]: () => panelState('A') })
      activatePlugin(fake.context)
      const first = mountPanel(fake)
      await settle()
      expect(getCalls(fake)).toHaveLength(1)
      await fake.connection('reconnecting')
      first.unmount()
      await fake.connection('connected')
      await advance(reconnectAt)

      const reopened = mountPanel(fake)
      await settle()
      if (reconnectAt < 1_500) {
        expect(getCalls(fake)).toHaveLength(1)
        await fake.connection('connected')
        expect(getCalls(fake)).toHaveLength(1)
        await advance(1_500 - reconnectAt)
      }
      expect(getCalls(fake)).toHaveLength(2)
      expect(reopened.element.textContent).toContain('Model A')
      await fake.emit(canonicalChange(null))
      await advance(1_500)
      expect(getCalls(fake)).toHaveLength(3)
    })
  }

  for (const connectedBeforeFailure of [false, true]) {
    test(`mount during outage recovers when connected arrives ${connectedBeforeFailure ? 'before' : 'after'} rejection`, async () => {
      const initial = Promise.withResolvers<PanelState>()
      let reads = 0
      const fake = makeFake({ [GET_METHOD]: () => ++reads === 1 ? initial.promise : panelState('A') })
      activatePlugin(fake.context)
      await fake.connection('reconnecting')
      const panel = mountPanel(fake)
      await settle()
      expect(getCalls(fake)).toHaveLength(1)
      if (connectedBeforeFailure) await fake.connection('connected')
      await act(async () => initial.reject(new Error('Not connected')))
      if (!connectedBeforeFailure) await fake.connection('connected')
      await settle()
      expect(getCalls(fake)).toHaveLength(2)
      expect(panel.element.textContent).toContain('Model A')
      await fake.connection('connected')
      await fake.connection('connected')
      expect(getCalls(fake)).toHaveLength(2)
      await fake.emit(canonicalChange(null))
      await advance(1_499)
      expect(getCalls(fake)).toHaveLength(2)
      await advance(1)
      expect(getCalls(fake)).toHaveLength(3)
    })
  }

  test('first connected notifications share a successful pending mount read', async () => {
    const initial = Promise.withResolvers<PanelState>()
    const fake = makeFake({ [GET_METHOD]: () => initial.promise })
    activatePlugin(fake.context)
    const panel = mountPanel(fake)
    await fake.connection('connected')
    await fake.connection('connected')
    expect(getCalls(fake)).toHaveLength(1)
    await act(async () => initial.resolve(panelState('A')))
    await settle()
    expect(panel.element.textContent).toContain('Model A')
    expect(getCalls(fake)).toHaveLength(1)
  })
})

test('a failed connection recovery does not retry duplicate connected events and permits explicit Retry', async () => {
  let reads = 0
  const fake = makeFake({ [GET_METHOD]: () => {
    if (++reads <= 2) throw new Error('Not connected')
    return panelState('A')
  } })
  activatePlugin(fake.context)
  const panel = mountPanel(fake)
  await settle()
  await fake.connection('connected')
  expect(getCalls(fake)).toHaveLength(2)
  expect(panel.element.textContent).toContain('Not connected')
  await fake.connection('connected')
  await fake.connection('connected')
  expect(getCalls(fake)).toHaveLength(2)
  const retry = panel.element.querySelector('.ui-inline-error__action')
  if (!retry) throw new Error('missing projection Retry action')
  await click(retry)
  expect(getCalls(fake)).toHaveLength(3)
  expect(panel.element.textContent).toContain('Model A')
  expect(panel.element.textContent).not.toContain('Not connected')
})
