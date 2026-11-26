// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useTerminalPaneChatState } from './use-terminal-pane-chat-state'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'
import { resolveNativeChatLeafRoute } from '../native-chat/native-chat-leaf-routing'
import type { RemotePaneLayoutPusher } from './remote-pane-layout-push'

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const mocks = vi.hoisted(() => {
  const layouts: Record<string, TerminalLayoutSnapshot> = {}
  const tab = { id: 'tab', entityId: 'tab', contentType: 'terminal', viewMode: 'chat' }
  const state = {
    terminalLayoutsByTabId: layouts,
    unifiedTabsByWorktree: { wt: [tab] },
    tabsByWorktree: {},
    settings: { experimentalNativeChat: true },
    pendingPaneAccountRestarts: [],
    runtimePaneTitlesByTabId: { tab: { 1: 'codex', 2: 'codex' } },
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    setTabLayout: (_id: string, layout: TerminalLayoutSnapshot) => {
      layouts.tab = layout
    },
    setTabViewMode: (_id: string, mode: string) => {
      state.unifiedTabsByWorktree = { wt: [{ ...tab, viewMode: mode }] }
    },
    toggleTabViewMode: (id: string): void => {
      state.setTabViewMode(
        id,
        state.unifiedTabsByWorktree.wt[0].viewMode === 'chat' ? 'terminal' : 'chat'
      )
    }
  }
  return { state }
})
vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const { terminalLayoutEqual } = await import('../../../../shared/terminal-layout-equality')
  mocks.state.setTabLayout = (id, layout) => {
    if (terminalLayoutEqual(mocks.state.terminalLayoutsByTabId[id], layout)) {
      return
    }
    mocks.state.terminalLayoutsByTabId = { ...mocks.state.terminalLayoutsByTabId, [id]: layout }
    useAppStore.setState({ terminalLayoutsByTabId: mocks.state.terminalLayoutsByTabId })
  }
  mocks.state.setTabViewMode = (_id, mode) => {
    mocks.state.unifiedTabsByWorktree = {
      wt: [{ ...mocks.state.unifiedTabsByWorktree.wt[0], viewMode: mode }]
    }
    useAppStore.setState({ unifiedTabsByWorktree: mocks.state.unifiedTabsByWorktree })
  }
  const useAppStore = create(() => mocks.state)
  return { useAppStore }
})
vi.mock('@/runtime/web-runtime-terminal-buffer-actions', () => ({
  clearWebRuntimeTerminalBuffer: vi.fn()
}))

function makeFixture(paneIds = [1, 2], remotePusher?: RemotePaneLayoutPusher) {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  container.append(split)
  const panes = [LEFT, RIGHT].map((leafId, index) => {
    const element = document.createElement('div')
    element.className = 'pane'
    element.dataset.paneId = String(paneIds[index])
    element.dataset.leafId = leafId
    split.append(element)
    return { id: paneIds[index], leafId, container: element }
  })
  const manager = {
    getPanes: () => panes,
    getActivePane: () => panes[0],
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
  }
  return {
    managerRef: { current: manager },
    containerRef: { current: container },
    nativeChatTranscriptIsLocalReadable: true,
    onAgentExitedRef: { current: vi.fn() },
    paneCount: 2,
    tabId: 'tab',
    worktreeId: 'wt',
    tabWideAgentHintLeafId: null,
    setTabWideAgentHintLeafId: vi.fn(),
    clearedScrollbackLeafIdsRef: { current: new Set<string>() },
    expandedPaneIdRef: { current: null },
    paneTitles: {},
    paneTitlesRef: { current: {} },
    paneTransportsRef: { current: new Map() },
    remotePaneLayoutPusherRef: { current: remotePusher ?? null },
    removedTitleLeafIdsRef: { current: new Set<string>() },
    setPaneTitles: vi.fn()
  }
}
function useFixture(fixture: ReturnType<typeof makeFixture>, initialOwner: string | null) {
  const [chatLeafId, setChatLeafId] = useState(initialOwner)
  const input = { ...fixture, chatLeafId, setChatLeafId }
  const chat = useTerminalPaneChatState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the chat hook.
    input as unknown as Parameters<typeof useTerminalPaneChatState>[0]
  )
  const layoutInput = { ...input, ...chat, setTabLayout: mocks.state.setTabLayout }
  const layout = useTerminalPaneLayoutPersistence(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the persistence hook.
    layoutInput as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
  )
  const activeLeafId = fixture.managerRef.current.getActivePane()?.leafId ?? null
  const mounted = fixture.managerRef.current.getPanes().some((pane) => pane.leafId === chatLeafId)
  const { applyNativeChatLeafRoute, isChatViewMode } = chat
  useEffect(() => {
    applyNativeChatLeafRoute(
      resolveNativeChatLeafRoute({
        isChatViewMode,
        chatLeafId,
        activeLeafId,
        chatLeafStillMounted: mounted,
        activeLeafIsEligible: false
      })
    )
  }, [applyNativeChatLeafRoute, isChatViewMode, chatLeafId, activeLeafId, mounted])
  return { ...chat, ...layout, chatLeafId, setChatLeafId }
}

beforeEach(() => {
  mocks.state.settings.experimentalNativeChat = true
  mocks.state.runtimePaneTitlesByTabId.tab = { 1: 'codex', 2: 'codex' }
  mocks.state.setTabViewMode('tab', 'chat')
  mocks.state.setTabLayout('tab', {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    },
    activeLeafId: LEFT,
    expandedLeafId: null,
    chatLeafId: RIGHT
  })
})
afterEach(cleanup)

describe('terminal chat ownership lifecycle', () => {
  it('returns a tab saved in the removed chat view mode to its terminal', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))

    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
  })

  it('leaves a terminal tab that was never in chat view alone', () => {
    mocks.state.setTabViewMode('tab', 'terminal')
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, null))

    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })
})
