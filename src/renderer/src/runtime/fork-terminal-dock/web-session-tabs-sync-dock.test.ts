import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

import { recordWebAgentSessionHandoff } from '../web-agent-session-handoff'

import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from '../web-session-tabs-sync/state'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_SURFACE_ID = `host-tab-1::${LEAF_ID}`

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    editorBuffers: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    // Why: every fixture here exercises dock reconciliation, which requires the setting on.
    settings: { experimentalTerminalDock: true } as GlobalSettings,
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function makeSnapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs,
    ...overrides
  }
}

import type * as WebRuntimeTerminalActionsModule from '../web-runtime-terminal-actions'

import {
  readTerminalDockPaneState,
  writeTerminalDockPaneState
} from '../../components/terminal-pane/fork-terminal-dock/terminal-dock-pane-state'

const TERMINAL_DOCK_STORAGE_KEY = 'quirky.terminalDock.paneState.v1'

function hasStoredPaneEntry(paneKey: string): boolean {
  const raw = window.localStorage.getItem(TERMINAL_DOCK_STORAGE_KEY)
  return raw !== null && Object.hasOwn(JSON.parse(raw) as Record<string, unknown>, paneKey)
}

const setWebRuntimeTabPropsMock = vi.fn()
vi.mock('../web-runtime-terminal-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalActionsModule>()
  return {
    ...actual,
    setWebRuntimeTabProps: (...args: unknown[]) => setWebRuntimeTabPropsMock(...args)
  }
})

describe('applyWebSessionTabsSnapshot dock pane-key mapping', () => {
  it('remaps host terminalDockByPaneKey to the mirrored tab id when this client has no prior tab', () => {
    // Host and local tab ids differ under a remote/web mirror (unlike desktop, where
    // they're the same string and this bug is invisible): the stored key must follow.
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: { [hostPaneKey]: { docked: true, gutterRows: 8 } },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [makePaneKey(mirroredId!, LEAF_ID)]: { docked: true, gutterRows: 8 } })
  })

  it('drops an inbound dock record entry whose key does not parse as a pane key', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          terminalDockByPaneKey: {
            [hostPaneKey]: { docked: true, gutterRows: 8 },
            'not-a-pane-key': { docked: false, gutterRows: 5 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [makePaneKey(mirroredId!, LEAF_ID)]: { docked: true, gutterRows: 8 } })
  })

  it('carries a provisional tab dock record across a host handoff, re-keyed to the replacement tab id', () => {
    // P2: the provisional tab's own unified-tab record is its only copy of the user's
    // optimistic dock choice; the handoff must re-key it onto the replacement instead
    // of letting the in-flight host snapshot (with no dock field yet) erase it.
    const provisionalTabId = 'provisional-dock'
    const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId,
      hostTabId: 'host-tab-1',
      hostTerminalHandle: 'term_host-1'
    })
    const provisionalTerminalTab: TerminalTab = {
      id: provisionalTabId,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }
    const provisionalUnifiedTab: Tab = {
      id: provisionalTabId,
      entityId: provisionalTabId,
      groupId: 'g-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { [provisionalPaneKey]: { docked: true, gutterRows: 5 } }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [provisionalTerminalTab] },
        unifiedTabsByWorktree: { [WT]: [provisionalUnifiedTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).not.toBe(provisionalTabId)
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [makePaneKey(mirroredId!, LEAF_ID)]: { docked: true, gutterRows: 5 } })
  })

  it('rekeys the pending-mutation timestamp through handoff so a stale echo still loses to it (r3-5)', () => {
    // The provisional tab's pending-mutation timestamp must follow the same
    // provisional->final rekey the dock record gets, or a later stale host echo
    // finds no timestamp under the new key and overwrites the optimistic value.
    const provisionalTabId = 'provisional-dock-r3-5'
    const hostTabId = 'host-tab-1'
    const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId,
      hostTabId,
      hostTerminalHandle: 'term_host-1'
    })
    const provisionalTerminalTab: TerminalTab = {
      id: provisionalTabId,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }
    const provisionalUnifiedTab: Tab = {
      id: provisionalTabId,
      entityId: provisionalTabId,
      groupId: 'g-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      terminalDockByPaneKey: { [provisionalPaneKey]: { docked: true, gutterRows: 5 } }
    }

    const initialState = makeState({
      tabsByWorktree: { [WT]: [provisionalTerminalTab] },
      unifiedTabsByWorktree: { [WT]: [provisionalUnifiedTab] },
      terminalDockPendingMutationsByPaneKey: { [provisionalPaneKey]: NOW }
    })

    const handoffPatch = applyWebSessionTabsSnapshot(
      initialState,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: hostTabId,
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = handoffPatch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).not.toBe(provisionalTabId)
    const finalPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(handoffPatch.terminalDockPendingMutationsByPaneKey?.[finalPaneKey]).toBe(NOW)

    const stateAfterHandoff = { ...initialState, ...handoffPatch }

    // A stale host echo, still built before the RPC landed, carrying the pre-mutation value.
    const reconcilePatch = applyWebSessionTabsSnapshot(
      stateAfterHandoff,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: hostTabId,
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          terminalDockByPaneKey: {
            [makePaneKey(hostTabId, LEAF_ID)]: { docked: false, gutterRows: 12 }
          },
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 500
    ) as Partial<WebSessionTabsSyncState>

    const stateAfterReconcile = { ...stateAfterHandoff, ...reconcilePatch }
    expect(
      stateAfterReconcile.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.terminalDockByPaneKey
    ).toEqual({ [finalPaneKey]: { docked: true, gutterRows: 5 } })
  })

  describe('localStorage dock fallback rekey on handoff (r5-6)', () => {
    // Why: this suite runs under Vitest's node environment (no jsdom/happy-dom), so terminal-dock-
    // pane-state's `window.localStorage` calls need a stand-in to exercise, matching the module's
    // own try/catch-guarded access pattern.
    const fakeLocalStorage = (() => {
      let entries = new Map<string, string>()
      return {
        getItem: (key: string): string | null => entries.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          entries.set(key, value)
        },
        removeItem: (key: string): void => {
          entries.delete(key)
        },
        clear: (): void => {
          entries = new Map()
        }
      }
    })()

    beforeEach(() => {
      fakeLocalStorage.clear()
      ;(globalThis as { window?: unknown }).window = { localStorage: fakeLocalStorage }
    })

    afterEach(() => {
      delete (globalThis as { window?: unknown }).window
    })

    function provisionalTerminalTab(id: string): TerminalTab {
      return {
        id,
        ptyId: null,
        worktreeId: WT,
        title: 'Claude',
        defaultTitle: 'Claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: NOW,
        launchAgent: 'claude'
      }
    }

    it('moves the fallback entry to the replacement tab id on handoff', () => {
      const provisionalTabId = 'provisional-dock-r5-6'
      const hostTabId = 'host-tab-1'
      const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
      writeTerminalDockPaneState(provisionalPaneKey, { docked: true, gutterRows: 9 })
      recordWebAgentSessionHandoff({
        environmentId: ENV,
        worktreeId: WT,
        provisionalTabId,
        hostTabId,
        hostTerminalHandle: 'term_host-1'
      })

      applyWebSessionTabsSnapshot(
        makeState({ tabsByWorktree: { [WT]: [provisionalTerminalTab(provisionalTabId)] } }),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId: LEAF_ID,
            isActive: true,
            launchAgent: 'claude',
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        ENV,
        NOW
      )

      const finalPaneKey = makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF_ID)
      expect(hasStoredPaneEntry(provisionalPaneKey)).toBe(false)
      expect(readTerminalDockPaneState(finalPaneKey)).toEqual({ docked: true, gutterRows: 9 })
    })

    it('keeps the pre-existing final-key entry on collision and still drops the source', () => {
      const provisionalTabId = 'provisional-dock-r5-6-collision'
      const hostTabId = 'host-tab-1'
      const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
      const finalPaneKey = makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF_ID)
      writeTerminalDockPaneState(provisionalPaneKey, { docked: true, gutterRows: 9 })
      // Newer, written under the pane's true final identity — must win over the
      // provisional-keyed value it would otherwise be clobbered by.
      writeTerminalDockPaneState(finalPaneKey, { docked: false, gutterRows: 3 })
      recordWebAgentSessionHandoff({
        environmentId: ENV,
        worktreeId: WT,
        provisionalTabId,
        hostTabId,
        hostTerminalHandle: 'term_host-1'
      })

      applyWebSessionTabsSnapshot(
        makeState({ tabsByWorktree: { [WT]: [provisionalTerminalTab(provisionalTabId)] } }),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId: LEAF_ID,
            isActive: true,
            launchAgent: 'claude',
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        ENV,
        NOW
      )

      expect(hasStoredPaneEntry(provisionalPaneKey)).toBe(false)
      expect(readTerminalDockPaneState(finalPaneKey)).toEqual({ docked: false, gutterRows: 3 })
    })

    it('leaves localStorage untouched when the experimental flag is off', () => {
      const provisionalTabId = 'provisional-dock-r5-6-flag-off'
      const hostTabId = 'host-tab-1'
      const provisionalPaneKey = makePaneKey(provisionalTabId, LEAF_ID)
      writeTerminalDockPaneState(provisionalPaneKey, { docked: true, gutterRows: 9 })
      recordWebAgentSessionHandoff({
        environmentId: ENV,
        worktreeId: WT,
        provisionalTabId,
        hostTabId,
        hostTerminalHandle: 'term_host-1'
      })

      applyWebSessionTabsSnapshot(
        makeState({
          tabsByWorktree: { [WT]: [provisionalTerminalTab(provisionalTabId)] },
          settings: { experimentalTerminalDock: false } as GlobalSettings
        }),
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId: LEAF_ID,
            isActive: true,
            launchAgent: 'claude',
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        ENV,
        NOW
      )

      const finalPaneKey = makePaneKey(toWebTerminalSurfaceTabId(hostTabId), LEAF_ID)
      expect(readTerminalDockPaneState(provisionalPaneKey)).toEqual({ docked: true, gutterRows: 9 })
      expect(hasStoredPaneEntry(finalPaneKey)).toBe(false)
    })
  })
})
