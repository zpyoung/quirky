// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Tab } from '../../../../../shared/tab-types'
import {
  DEFAULT_GUTTER_ROWS,
  readTerminalDockPaneState,
  writeTerminalDockPaneAgent,
  writeTerminalDockPaneState,
  writeTerminalDockPaneUserUndocked
} from './terminal-dock-pane-state'

type FakeState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  settings:
    | {
        experimentalTerminalDock?: boolean
        dockTerminalComposerByDefault?: boolean
        keybindings?: unknown
      }
    | undefined
  keybindings: Record<string, string[]>
  agentStatusByPaneKey: Record<string, { state?: string; agentType?: string } | undefined>
  setTabTerminalDockState: (
    tabId: string,
    patch: { paneKey: string; docked?: boolean; gutterRows?: number }
  ) => void
}

function makeUnifiedTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'unified-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    terminalDockByPaneKey: {},
    ...overrides
  } as Tab
}

// Why: vi.mock's factory is hoisted above ordinary top-level consts, so the fake store this
// test drives (and the spy it asserts against) both have to be built inside vi.hoisted.
const mocks = vi.hoisted(() => {
  const setTabTerminalDockState = () => {}
  return { setTabTerminalDockState }
})

vi.mock('@/store', () => {
  const fakeStore = create<FakeState>(() => ({
    unifiedTabsByWorktree: {},
    settings: { experimentalTerminalDock: true },
    keybindings: {},
    agentStatusByPaneKey: {},
    setTabTerminalDockState: mocks.setTabTerminalDockState
  }))
  return { useAppStore: fakeStore }
})

import { useAppStore as realUseAppStore } from '@/store'
import { useTerminalPaneDock } from './use-terminal-pane-dock'

// why: vi.mock swaps the runtime value, not the static type — re-cast to the fake shape.
const fakeStore = realUseAppStore as unknown as UseBoundStore<StoreApi<FakeState>>

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

beforeEach(() => {
  window.localStorage.clear()
  mocks.setTabTerminalDockState = vi.fn()
  fakeStore.setState({
    setTabTerminalDockState: mocks.setTabTerminalDockState,
    unifiedTabsByWorktree: {
      'wt-1': [
        makeUnifiedTab({ terminalDockByPaneKey: { [PANE_KEY]: { docked: true, gutterRows: 5 } } })
      ]
    },
    settings: { experimentalTerminalDock: true },
    keybindings: {},
    agentStatusByPaneKey: {}
  })
})

afterEach(() => {
  window.localStorage.clear()
})

function renderDockHook(enabled: boolean) {
  return renderHook(() =>
    useTerminalPaneDock({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      enabled,
      managerRef: { current: null },
      containerRef: { current: null }
    })
  )
}

// Why: the dock's window-level keydown listener only reacts inside its owning pane's
// container, so exercising the shortcut needs a real DOM node and an active-pane stub.
function renderDockHookWithShortcutTarget(): {
  container: HTMLDivElement
  result: ReturnType<typeof renderHook<ReturnType<typeof useTerminalPaneDock>, unknown>>['result']
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { result } = renderHook(() =>
    useTerminalPaneDock({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      enabled: true,
      managerRef: {
        current: { getActivePane: () => ({ leafId: LEAF_ID, terminal: { focus: () => {} } }) }
      } as never,
      containerRef: { current: container }
    })
  )
  act(() => result.current.setPaneDockMounted(PANE_KEY, true))
  return { container, result }
}

function dispatchPassthroughToggle(container: HTMLDivElement): void {
  container.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
  )
}

function dispatchDockToggle(container: HTMLDivElement): void {
  container.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
  )
}

describe('useTerminalPaneDock', () => {
  it('undocks on confirmed agent exit when the pane was docked', () => {
    const { result } = renderDockHook(true)
    act(() => {
      result.current.undockOnConfirmedAgentExit(LEAF_ID)
    })
    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: false
    })
  })

  it('never writes dock state when the flag is disabled, even to clean up a stale docked pane', () => {
    const { result } = renderDockHook(false)
    act(() => {
      result.current.undockOnConfirmedAgentExit(LEAF_ID)
    })
    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('reads persisted dock state and owns focus only while the composer is mounted', () => {
    const { result } = renderDockHook(true)
    expect(result.current.isPaneDocked(PANE_KEY)).toBe(true)
    expect(result.current.gutterRowsFor(PANE_KEY)).toBe(5)
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(false)
    act(() => result.current.setPaneDockMounted(PANE_KEY, true))
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(true)
    act(() => result.current.setPaneDockMounted(PANE_KEY, false))
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(false)
  })

  it('docks a recognized pane by default only when neither persistence source decided', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: {} })] }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: true,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState(PANE_KEY)).toEqual({
      docked: true,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('docks a recognized pane by default when the host echoed an empty record, even with a stale local entry', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: {} })] }
    })
    writeTerminalDockPaneState(PANE_KEY, { docked: false, gutterRows: 7 })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: true,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('preserves an explicit local undock when the host has not echoed dock state', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    writeTerminalDockPaneUserUndocked(PANE_KEY, true)
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('auto-docks after the render-time agent latch writes the first local entry', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    const { result } = renderDockHook(true)

    act(() => {
      result.current.resolveDockAgent(PANE_KEY, 'claude')
      result.current.ensurePaneDockDefault(PANE_KEY, 'claude')
    })

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: true,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('auto-docks again after a confirmed agent exit in the same pane', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))
    act(() => result.current.undockOnConfirmedAgentExit(LEAF_ID))
    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).toHaveBeenNthCalledWith(3, 'unified-1', {
      paneKey: PANE_KEY,
      docked: true,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('does not auto-dock again after the user closes the dock', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))
    act(() => result.current.toggleDockForLeaf(LEAF_ID))
    vi.mocked(mocks.setTabTerminalDockState).mockClear()
    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('clears the user decision when the dock is reopened manually', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))
    act(() => result.current.toggleDockForLeaf(LEAF_ID))
    act(() => result.current.toggleDockForLeaf(LEAF_ID))
    act(() => result.current.undockOnConfirmedAgentExit(LEAF_ID))
    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).toHaveBeenNthCalledWith(5, 'unified-1', {
      paneKey: PANE_KEY,
      docked: true,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  // a second client has none of the first client's localStorage, so only the host record
  // can carry the undock decision across
  it('does not auto-dock a pane another client marked user-undocked', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            terminalDockByPaneKey: {
              [PANE_KEY]: { docked: false, gutterRows: 5, userUndocked: true }
            }
          })
        ]
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('auto-docks a pane the host undocked without a user decision', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            terminalDockByPaneKey: { [PANE_KEY]: { docked: false, gutterRows: 5 } }
          })
        ]
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: true,
      gutterRows: 5
    })
  })

  it('does not rewrite a pane that is already docked', () => {
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('does not auto-dock a fresh pane when automatic opening is off', () => {
    fakeStore.setState({
      settings: {
        experimentalTerminalDock: true,
        dockTerminalComposerByDefault: false
      },
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.ensurePaneDockDefault(PANE_KEY, 'claude'))

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('keeps a persisted dock mounted and focus-owning when automatic opening is off', () => {
    fakeStore.setState({
      settings: {
        experimentalTerminalDock: true,
        dockTerminalComposerByDefault: false
      }
    })
    const { result } = renderDockHook(true)

    act(() => result.current.setPaneDockMounted(PANE_KEY, true))

    expect(result.current.isPaneDocked(PANE_KEY)).toBe(true)
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(true)
    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('keeps a mounted dock open when automatic opening is disabled mid-session', () => {
    const { result } = renderDockHook(true)
    act(() => result.current.setPaneDockMounted(PANE_KEY, true))

    act(() => {
      fakeStore.setState({
        settings: {
          experimentalTerminalDock: true,
          dockTerminalComposerByDefault: false
        }
      })
    })

    expect(result.current.isPaneDocked(PANE_KEY)).toBe(true)
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(true)
    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('keeps resolving the last-recognized agent for a persisted-docked pane through a status-record deletion and re-add cycle, writing no docked:false', () => {
    const { result } = renderDockHook(true)

    expect(result.current.resolveDockAgent(PANE_KEY, 'claude')).toBe('claude')

    // Simulates a reconnect/hook-reconciliation status flap: the live agentStatusByPaneKey
    // entry (and therefore the caller's detectedAgent) is gone, but the pane is still
    // persisted-docked.
    expect(result.current.resolveDockAgent(PANE_KEY, null)).toBe('claude')

    expect(result.current.resolveDockAgent(PANE_KEY, 'claude')).toBe('claude')

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalledWith(
      'unified-1',
      expect.objectContaining({ docked: false })
    )
  })

  it('resolves no agent for a status loss on a pane that was never docked', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: {} })] }
    })
    const { result } = renderDockHook(true)

    expect(result.current.resolveDockAgent(PANE_KEY, 'claude')).toBe('claude')
    expect(result.current.resolveDockAgent(PANE_KEY, null)).toBeNull()
  })

  it('paneDockOwnsFocus is false when disabled even for a persisted docked pane', () => {
    const { result } = renderDockHook(false)
    expect(result.current.paneDockOwnsFocus(PANE_KEY)).toBe(false)
  })

  it('resolves the dock toggle shortcut from the live keybindings registry, not settings.keybindings', () => {
    // A stale override on the legacy field must have no effect, and an empty override on the
    // live registry (an actual rebind result) must be honored — proving which source is read.
    fakeStore.setState({
      settings: { experimentalTerminalDock: true, keybindings: { 'terminal.dock.toggle': [] } },
      keybindings: {}
    })
    const { container } = renderDockHookWithShortcutTarget()

    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: PANE_KEY,
      docked: false,
      userUndocked: true
    })
  })

  it('seeds the previous agent state on passthrough entry, so the first working->done transition auto-exits', () => {
    fakeStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: { state: 'working', agentType: 'claude' } }
    })
    const { container, result } = renderDockHookWithShortcutTarget()

    act(() => dispatchPassthroughToggle(container))
    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(true)

    // The only status change observed since entering passthrough — without a seed, this
    // reads as a transition from an unknown (null) previous state and never auto-exits.
    act(() => {
      fakeStore.setState({
        agentStatusByPaneKey: { [PANE_KEY]: { state: 'done', agentType: 'claude' } }
      })
    })

    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(false)
  })

  it('keeps passthrough active when an undock cannot resolve its unified tab', () => {
    fakeStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
      }
    })
    writeTerminalDockPaneState(PANE_KEY, { docked: true, gutterRows: 5 })
    const { container, result } = renderDockHookWithShortcutTarget()
    act(() => dispatchPassthroughToggle(container))
    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(true)

    act(() => fakeStore.setState({ unifiedTabsByWorktree: {} }))
    act(() => result.current.toggleDockForLeaf(LEAF_ID))

    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(true)
  })

  it('prunes passthrough membership and auto-exit tracking when a pane retires', () => {
    fakeStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: { state: 'working', agentType: 'claude' } }
    })
    const { container, result } = renderDockHookWithShortcutTarget()

    act(() => dispatchPassthroughToggle(container))
    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(true)

    act(() => result.current.prunePassthroughForRetiredPane(LEAF_ID))

    expect(result.current.isPanePassthrough(PANE_KEY)).toBe(false)
  })

  // The keyboard shortcut targets the focused pane, but a context menu acts on the pane it
  // was opened over — in a split those differ, so a leaf-targeted toggle must not read the
  // active pane.
  it('toggles the named pane, not the focused one', () => {
    const otherLeafId = '22222222-2222-4222-8222-222222222222'
    const { result } = renderDockHookWithShortcutTarget()

    act(() => result.current.toggleDockForLeaf(otherLeafId))

    expect(mocks.setTabTerminalDockState).toHaveBeenCalledExactlyOnceWith('unified-1', {
      paneKey: `tab-1:${otherLeafId}`,
      docked: true,
      userUndocked: false
    })
  })

  it('ignores a leaf-targeted toggle while the flag is off', () => {
    const { result } = renderDockHook(false)

    act(() => result.current.toggleDockForLeaf(LEAF_ID))

    expect(mocks.setTabTerminalDockState).not.toHaveBeenCalled()
  })

  it('exposes a pty-binding notifier that re-renders the dock host', () => {
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useTerminalPaneDock({
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        enabled: true,
        managerRef: { current: null },
        containerRef: { current: null }
      })
    })
    const before = renderCount

    act(() => result.current.notePanePtyBindingChanged())

    expect(renderCount).toBe(before + 1)
  })

  describe('agent latch survives a renderer remount', () => {
    it('rehydrates the client-local agent for a persisted-docked pane with no live status or launch/title evidence yet', () => {
      writeTerminalDockPaneAgent(PANE_KEY, 'claude')

      // A fresh hook instance stands in for a post-remount mount: its in-memory
      // paneAgentRef starts empty, unlike the same-session flap covered above.
      const { result } = renderDockHook(true)

      expect(result.current.resolveDockAgent(PANE_KEY, null)).toBe('claude')
    })

    it('renders no phantom dock for a pane that was never docked, even with a stray persisted agent', () => {
      fakeStore.setState({
        unifiedTabsByWorktree: { 'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: {} })] }
      })
      writeTerminalDockPaneAgent(PANE_KEY, 'claude')

      const { result } = renderDockHook(true)

      expect(result.current.resolveDockAgent(PANE_KEY, null)).toBeNull()
    })

    it('persists a live-detected agent so a later remount can rehydrate it', () => {
      const { result } = renderDockHook(true)

      act(() => {
        result.current.resolveDockAgent(PANE_KEY, 'claude')
      })

      const { result: afterRemount } = renderDockHook(true)
      expect(afterRemount.current.resolveDockAgent(PANE_KEY, null)).toBe('claude')
    })

    it('never writes the agent latch when the flag is disabled', () => {
      const { result } = renderDockHook(false)

      act(() => {
        result.current.resolveDockAgent(PANE_KEY, 'claude')
      })

      expect(window.localStorage.getItem('quirky.terminalDock.paneState.v1')).toBeNull()
    })

    it('ignores a persisted agent value outside the known TUI-agent set', () => {
      window.localStorage.setItem(
        'quirky.terminalDock.paneState.v1',
        JSON.stringify({
          [PANE_KEY]: { docked: true, gutterRows: 5, lastAgent: 'not-a-real-agent' }
        })
      )

      const { result } = renderDockHook(true)

      expect(result.current.resolveDockAgent(PANE_KEY, null)).toBeNull()
    })
  })

  describe('client-local fallback', () => {
    it('writes the localStorage fallback when the dock is toggled', () => {
      // gutterRows deliberately off the default (5) so a spuriously-untouched read can't
      // coincidentally match the expected value.
      fakeStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [
            makeUnifiedTab({
              terminalDockByPaneKey: { [PANE_KEY]: { docked: true, gutterRows: 7 } }
            })
          ]
        }
      })
      const { container } = renderDockHookWithShortcutTarget()

      act(() => dispatchDockToggle(container))

      expect(readTerminalDockPaneState(PANE_KEY)).toEqual({
        docked: false,
        gutterRows: 7,
        userUndocked: true
      })
    })

    it('writes the localStorage fallback when the gutter is resized', () => {
      const { result } = renderDockHook(true)

      act(() => result.current.commitGutterRows(PANE_KEY, 9))

      expect(readTerminalDockPaneState(PANE_KEY)).toEqual({ docked: true, gutterRows: 9 })
    })

    it('resolves persistence values before the store action writes localStorage', () => {
      const setTabTerminalDockState = vi.fn(
        (_tabId: string, patch: { paneKey: string; gutterRows?: number }) => {
          writeTerminalDockPaneState(patch.paneKey, {
            docked: false,
            gutterRows: patch.gutterRows ?? DEFAULT_GUTTER_ROWS
          })
        }
      )
      fakeStore.setState({
        setTabTerminalDockState,
        unifiedTabsByWorktree: {
          'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
        }
      })
      writeTerminalDockPaneState(PANE_KEY, { docked: true, gutterRows: 11 })
      const { result } = renderDockHook(true)

      act(() => result.current.commitGutterRows(PANE_KEY, 9))

      expect(readTerminalDockPaneState(PANE_KEY)).toEqual({ docked: true, gutterRows: 9 })
    })

    it('lets the local value govern at mount when the host has never echoed the field', () => {
      fakeStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
        }
      })
      writeTerminalDockPaneState(PANE_KEY, { docked: true, gutterRows: 11 })

      const { result } = renderDockHook(true)

      expect(result.current.isPaneDocked(PANE_KEY)).toBe(true)
      expect(result.current.gutterRowsFor(PANE_KEY)).toBe(11)
    })

    it('lets the host value win once echoed, without the local value overriding it', () => {
      fakeStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [
            makeUnifiedTab({
              terminalDockByPaneKey: { [PANE_KEY]: { docked: false, gutterRows: 6 } }
            })
          ]
        }
      })
      writeTerminalDockPaneState(PANE_KEY, { docked: true, gutterRows: 12 })

      const { result } = renderDockHook(true)

      expect(result.current.isPaneDocked(PANE_KEY)).toBe(false)
      expect(result.current.gutterRowsFor(PANE_KEY)).toBe(6)
    })

    it('defaults when neither the host nor the local fallback has a value', () => {
      fakeStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [makeUnifiedTab({ terminalDockByPaneKey: undefined })]
        }
      })

      const { result } = renderDockHook(true)

      expect(result.current.isPaneDocked(PANE_KEY)).toBe(false)
      expect(result.current.gutterRowsFor(PANE_KEY)).toBe(DEFAULT_GUTTER_ROWS)
    })

    it('writes nothing to localStorage when the flag is disabled', () => {
      writeTerminalDockPaneState(PANE_KEY, { docked: true, gutterRows: 6 })
      const before = window.localStorage.getItem('quirky.terminalDock.paneState.v1')
      const { result } = renderDockHook(false)

      act(() => {
        result.current.undockOnConfirmedAgentExit(LEAF_ID)
        result.current.prunePassthroughForRetiredPane(LEAF_ID)
      })

      expect(window.localStorage.getItem('quirky.terminalDock.paneState.v1')).toBe(before)
    })
  })
})
