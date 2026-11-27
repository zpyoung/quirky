import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingActionId } from '../../../shared/keybindings'
import { ACTION_CATALOG, isCatalogedActionId } from '../../../shared/keybindings/action-catalog'
import {
  APP_COMMAND_HANDLER_IDS,
  runAppCommand,
  type AppShortcutState
} from '../app-shell/app-command-handlers'
import {
  dispatchAppCommand,
  dispatchAppCommandWithResult,
  registerAppCommandDispatcher
} from './app-command-dispatch'

const mocks = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  mocks.store = {}
})

describe('app command dispatch', () => {
  it('routes known action ids through the current handler registry', () => {
    const dispatcher = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(dispatcher)

    expect(dispatchAppCommand('view.tasks', 'plugin-palette')).toBe(true)
    expect(dispatcher).toHaveBeenCalledWith('view.tasks', 'plugin-palette')
  })

  it('rejects unknown actions and unregisters only the current dispatcher', () => {
    const staleCleanup = registerAppCommandDispatcher(() => true)
    const current = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(current)
    staleCleanup()

    expect(dispatchAppCommand('missing.action', 'plugin-keybinding')).toBe(false)
    expect(dispatchAppCommand('view.tasks', 'plugin-keybinding')).toBe(true)
    cleanup()
    cleanup = null
    expect(dispatchAppCommand('view.tasks', 'plugin-keybinding')).toBe(false)
  })

  it('keeps the boolean return for plugin callers when the dispatcher explains a decline', () => {
    cleanup = registerAppCommandDispatcher(() => ({ claimed: false, reason: 'no tab' }))

    expect(dispatchAppCommand('tab.close', 'plugin-palette')).toBe(false)
  })

  describe('dispatchAppCommandWithResult', () => {
    it('passes the rpc source and options to the dispatcher and reports a claim', () => {
      const dispatcher = vi.fn(() => ({ claimed: true }))
      cleanup = registerAppCommandDispatcher(dispatcher)

      expect(
        dispatchAppCommandWithResult('tab.close', 'rpc', {
          worktreeId: 'repo::/a',
          probeOnly: true
        })
      ).toEqual({ claimed: true })
      expect(dispatcher).toHaveBeenCalledWith('tab.close', 'rpc', {
        worktreeId: 'repo::/a',
        probeOnly: true
      })
    })

    it('returns the reason the dispatcher gave when nothing claimed the command', () => {
      cleanup = registerAppCommandDispatcher(() => ({
        claimed: false,
        reason: 'no focused tab in workspace repo::/a'
      }))

      expect(dispatchAppCommandWithResult('tab.close', 'rpc')).toEqual({
        claimed: false,
        reason: 'no focused tab in workspace repo::/a'
      })
    })

    it('gives a reason when a boolean dispatcher declines', () => {
      cleanup = registerAppCommandDispatcher(() => false)

      const result = dispatchAppCommandWithResult('view.tasks', 'rpc')

      expect(result.claimed).toBe(false)
      expect(result.reason).toContain('view.tasks')
    })

    it('explains an unknown action and a missing dispatcher', () => {
      expect(dispatchAppCommandWithResult('view.tasks', 'rpc')).toMatchObject({
        claimed: false,
        reason: expect.stringContaining('not ready')
      })

      cleanup = registerAppCommandDispatcher(() => true)
      expect(dispatchAppCommandWithResult('missing.action', 'rpc')).toEqual({
        claimed: false,
        reason: 'unknown action missing.action'
      })
    })
  })
})

describe('action catalog against the app command map', () => {
  it('backs every rpc action with a handler', () => {
    const handlerIds = new Set<string>(APP_COMMAND_HANDLER_IDS)
    const unbacked = Object.entries(ACTION_CATALOG)
      .filter(([, entry]) => entry.dispatch === 'rpc')
      .map(([id]) => id)
      .filter((id) => !handlerIds.has(id))

    expect(unbacked).toEqual([])
  })

  it('catalogs every handled action as rpc, so a ui-only action never has a handler', () => {
    const mislabelled = APP_COMMAND_HANDLER_IDS.filter(
      (id) => !isCatalogedActionId(id) || ACTION_CATALOG[id].dispatch !== 'rpc'
    )

    expect(mislabelled).toEqual([])
  })
})

describe('availability probe against running the command', () => {
  const WORKTREE_ID = 'repo::/feature'

  function appState(actions: Record<string, unknown> = {}): AppShortcutState {
    return {
      activeView: 'terminal',
      activeWorktreeId: WORKTREE_ID,
      actions,
      creationLayoutActive: false,
      floatingTerminalEnabled: false,
      floatingTerminalOpen: false,
      floatingVisibleTabCount: 0,
      keybindings: {},
      pluginCommands: [],
      workspaceChromeActive: true
    } as unknown as AppShortcutState
  }

  function probeAndRun(state: AppShortcutState, actionId: KeybindingActionId) {
    const probe = runAppCommand(state, actionId, { source: 'rpc', probeOnly: true })
    const run = runAppCommand(state, actionId, { source: 'rpc' })
    return { probe, run }
  }

  function terminalTabsStore(terminalIds: string[]) {
    return {
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      activeTabId: terminalIds[0],
      activeFileId: null,
      activeBrowserTabId: null,
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      tabBarOrderByWorktree: {},
      tabsByWorktree: { [WORKTREE_ID]: terminalIds.map((id) => ({ id, worktreeId: WORKTREE_ID })) },
      unifiedTabsByWorktree: {},
      browserTabsByWorktree: {},
      openFiles: [],
      setActiveTab: vi.fn(),
      setActiveTabType: vi.fn(),
      getActiveTab: () => null
    }
  }

  it('declines review notes in the probe when none are unsent, as running does', () => {
    const openMenu = vi.fn(() => false)
    mocks.store = {
      activeWorktreeId: WORKTREE_ID,
      getDiffComments: () => [{ sentAt: 1 }]
    }

    const { probe, run } = probeAndRun(
      appState({ openDiffNotesSendMenuForActiveWorktree: openMenu }),
      'sourceControl.sendReviewNotes'
    )

    expect(run).toEqual({
      claimed: false,
      reason: 'the active workspace has no unsent review notes'
    })
    expect(probe).toEqual(run)
    expect(openMenu).not.toHaveBeenCalled()
  })

  it('claims review notes in the probe without opening the menu when some are unsent', () => {
    const openMenu = vi.fn(() => true)
    mocks.store = {
      activeWorktreeId: WORKTREE_ID,
      getDiffComments: () => [{ sentAt: undefined }]
    }
    const state = appState({ openDiffNotesSendMenuForActiveWorktree: openMenu })

    expect(runAppCommand(state, 'sourceControl.sendReviewNotes', { probeOnly: true })).toEqual({
      claimed: true
    })
    expect(openMenu).not.toHaveBeenCalled()
    expect(runAppCommand(state, 'sourceControl.sendReviewNotes')).toEqual({ claimed: true })
    expect(openMenu).toHaveBeenCalledTimes(1)
  })

  it('declines tab.nextAllTypes in the probe when the workspace has a single tab', () => {
    const store = terminalTabsStore(['t1'])
    mocks.store = store

    const { probe, run } = probeAndRun(appState(), 'tab.nextAllTypes')

    expect(run).toEqual({ claimed: false, reason: 'no other tab to switch to' })
    expect(probe).toEqual(run)
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })

  it('claims tab.nextAllTypes in the probe without switching when another tab exists', () => {
    const store = terminalTabsStore(['t1', 't2'])
    mocks.store = store
    const state = appState()

    expect(runAppCommand(state, 'tab.nextAllTypes', { probeOnly: true })).toEqual({
      claimed: true
    })
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(runAppCommand(state, 'tab.nextAllTypes')).toEqual({ claimed: true })
    expect(store.setActiveTab).toHaveBeenCalledWith('t2')
  })

  it('agrees for the other switch commands when there is nothing to switch to', () => {
    mocks.store = terminalTabsStore(['t1'])

    for (const actionId of [
      'tab.nextSameType',
      'tab.previousAllTypes',
      'tab.nextTerminal',
      'tab.previousRecent'
    ] as const) {
      const { probe, run } = probeAndRun(appState(), actionId)
      expect(run.claimed).toBe(false)
      expect(probe).toEqual(run)
    }
  })
})
