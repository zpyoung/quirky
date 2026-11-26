import type { IpcMainEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { TerminalSideEffectFact } from '../../../shared/terminal-side-effect-facts'
import { setRuntimeDesktopSurface } from '../runtime-desktop-surface'
import { PublicEventBus } from './public-event-bus'
import { installPublicEventSources, UI_TABS_CHANGED_CHANNEL } from './public-event-sources'

const WINDOW_CONTENTS = { id: 'main-window' }

type IpcListener = (event: IpcMainEvent, payload: unknown) => void

type ClientListener = (event: RuntimeClientEvent) => void
type ClientListenerOptions = { consumesTerminalSideEffects?: boolean }

function install(
  options: {
    handleForPane?: (paneKey: string) => string | undefined
    withSubscriber?: boolean
  } = {}
) {
  const bus = new PublicEventBus()
  if (options.withSubscriber !== false) {
    bus.subscribe(() => {})
  }
  const clientListeners = new Set<{ listener: ClientListener; options?: ClientListenerOptions }>()
  const ipcListeners = new Map<string, IpcListener>()
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => null,
    // SAFETY: the sources only ever register listeners shaped (event, payload).
    onIpc: (channel, listener) => ipcListeners.set(channel, listener as unknown as IpcListener),
    removeIpcListener: (channel) => ipcListeners.delete(channel)
  })
  const detach = installPublicEventSources({
    bus,
    // SAFETY: the sources read only these members of the runtime.
    runtime: {
      onClientEvent: (listener: ClientListener, listenerOptions?: ClientListenerOptions) => {
        const entry = { listener, options: listenerOptions }
        clientListeners.add(entry)
        return () => {
          clientListeners.delete(entry)
        }
      },
      onWorktreeLifecycle: () => () => {},
      onNotificationDispatched: () => () => {},
      getAgentStatusTerminalHandleForPaneKey: options.handleForPane
    } as never,
    store: null,
    getWindow: () => ({ webContents: WINDOW_CONTENTS })
  })
  const events = () => {
    const replay = bus.since(0, ['ui', 'workspace'])
    return Array.isArray(replay) ? replay : []
  }
  const emitClientEvent = (event: RuntimeClientEvent): void => {
    for (const { listener } of clientListeners) {
      listener(event)
    }
  }
  const sideEffectConsumers = (): number =>
    [...clientListeners].filter(({ options: o }) => o?.consumesTerminalSideEffects !== false).length
  const sideEffects = (
    facts: TerminalSideEffectFact[],
    extra: { replay?: true; paneKey?: string; worktreeId?: string } = {}
  ): void =>
    emitClientEvent({
      type: 'terminalSideEffects',
      batch: { ptyId: 'pty-1', seq: 1, worktreeId: 'wt-1', facts, ...extra }
    })
  const reportTabs = (
    tabs: Record<string, { id: string; type: string }[]>,
    sender: unknown = WINDOW_CONTENTS
  ): void => {
    // SAFETY: only `sender` is read from the event.
    ipcListeners.get(UI_TABS_CHANGED_CHANNEL)?.({ sender } as unknown as IpcMainEvent, { tabs })
  }
  return {
    bus,
    detach,
    events,
    sideEffects,
    sideEffectConsumers,
    emitClientEvent,
    reportTabs,
    ipcListeners
  }
}

describe('public event sources', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    setRuntimeDesktopSurface(null)
    vi.restoreAllMocks()
  })

  describe('terminal.idle', () => {
    it('is published when a terminal reports an agent going idle, with its workspace and handle', () => {
      const { sideEffects, events } = install({ handleForPane: () => 'term_7' })

      sideEffects([{ kind: 'agent-idle', title: 'Done' }], { paneKey: 'tab:leaf' })

      expect(events()).toMatchObject([
        {
          topic: 'workspace',
          type: 'terminal.idle',
          data: { worktreeId: 'wt-1', terminalHandle: 'term_7' }
        }
      ])
    })

    it('publishes once for a batch and leaves the handle out when the pane has none', () => {
      const { sideEffects, events } = install()

      sideEffects([
        { kind: 'agent-idle', title: 'a' },
        { kind: 'agent-idle', title: 'b' }
      ])

      expect(events()).toHaveLength(1)
      expect(JSON.stringify(events())).not.toContain('terminalHandle')
    })

    it.each([
      [
        'a replayed batch',
        [{ kind: 'agent-idle', title: 'Done' }] as TerminalSideEffectFact[],
        { replay: true as const }
      ],
      [
        'a stale-title clear from a paused agent',
        [
          { kind: 'agent-idle', title: 'Done', staleWorkingTitleClear: true }
        ] as TerminalSideEffectFact[],
        {}
      ],
      ['a batch with no idle fact', [{ kind: 'bell' }] as TerminalSideEffectFact[], {}]
    ])('is not published for %s', (_name, facts, extra) => {
      const { sideEffects, events } = install()

      sideEffects(facts, extra)

      expect(events()).toEqual([])
    })
  })

  describe('terminal side-effect tap', () => {
    it('is attached only while the bus has a live subscriber', () => {
      const { bus, sideEffectConsumers } = install({ withSubscriber: false })
      expect(sideEffectConsumers()).toBe(0)

      const stopFirst = bus.subscribe(() => {})
      const stopSecond = bus.subscribe(() => {})
      expect(sideEffectConsumers()).toBe(1)

      stopFirst()
      expect(sideEffectConsumers()).toBe(1)
      stopSecond()
      expect(sideEffectConsumers()).toBe(0)

      const stopAgain = bus.subscribe(() => {})
      expect(sideEffectConsumers()).toBe(1)
      stopAgain()
    })

    it('does not publish terminal.idle once the last subscriber is gone', () => {
      const { bus, sideEffects, events } = install({ withSubscriber: false })

      const stop = bus.subscribe(() => {})
      stop()
      sideEffects([{ kind: 'agent-idle', title: 'Done' }])

      expect(events()).toEqual([])
    })

    it('is released when the sources are detached', () => {
      const { detach, sideEffectConsumers } = install()
      expect(sideEffectConsumers()).toBe(1)

      detach()

      expect(sideEffectConsumers()).toBe(0)
    })
  })

  describe('view.changed', () => {
    it('is published without subscribing to terminal side effects', () => {
      const { emitClientEvent, sideEffectConsumers, events } = install({ withSubscriber: false })

      emitClientEvent({ type: 'workspaceViewChanged' })

      expect(sideEffectConsumers()).toBe(0)
      expect(events()).toMatchObject([
        { topic: 'ui', type: 'view.changed', data: { view: 'workspace' } }
      ])
    })
  })

  describe('tab.opened and tab.closed', () => {
    const terminal = (id: string) => ({ id, type: 'terminal' })

    it('seeds a workspace silently, then publishes the tabs that appear and disappear', () => {
      const { reportTabs, events } = install()

      reportTabs({ 'wt-1': [terminal('a'), terminal('b')] })
      expect(events()).toEqual([])

      reportTabs({ 'wt-1': [terminal('b'), { id: 'c', type: 'browser' }] })

      expect(events()).toMatchObject([
        {
          topic: 'ui',
          type: 'tab.closed',
          data: { worktreeId: 'wt-1', tabId: 'a', tabType: 'terminal' }
        },
        {
          topic: 'ui',
          type: 'tab.opened',
          data: { worktreeId: 'wt-1', tabId: 'c', tabType: 'browser' }
        }
      ])
    })

    it('does not announce the tabs of a workspace first seen after the baseline', () => {
      const { reportTabs, events } = install()

      reportTabs({ 'wt-1': [terminal('a')] })
      reportTabs({ 'wt-1': [terminal('a')], 'wt-2': [terminal('x'), terminal('y')] })

      expect(events()).toEqual([])
    })

    it('publishes nothing when the tab list is unchanged', () => {
      const { reportTabs, events } = install()

      reportTabs({ 'wt-1': [terminal('a')] })
      reportTabs({ 'wt-1': [terminal('a')] })

      expect(events()).toEqual([])
    })

    it('ignores a report from a sender that is not the app window and a malformed payload', () => {
      const { reportTabs, events, ipcListeners } = install()

      reportTabs({ 'wt-1': [terminal('a')] })
      reportTabs({ 'wt-1': [] }, { id: 'someone-else' })
      // SAFETY: only `sender` is read from the event.
      ipcListeners.get(UI_TABS_CHANGED_CHANNEL)?.(
        { sender: WINDOW_CONTENTS } as unknown as IpcMainEvent,
        {
          tabs: 'nope'
        }
      )

      expect(events()).toEqual([])
    })

    it('stops listening once detached', () => {
      const { detach, ipcListeners } = install()

      detach()

      expect(ipcListeners.has(UI_TABS_CHANGED_CHANNEL)).toBe(false)
    })
  })
})
