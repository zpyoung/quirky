import { describe, expect, it, vi } from 'vitest'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import type { Tab } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'

// Why: exercises headless persistence, never an authoritative renderer (r4-9).
const electronMocks = vi.hoisted(() => ({
  BrowserWindow: { fromId: vi.fn((_id: number): unknown => null) },
  webContents: { fromId: vi.fn((_id: number): unknown => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))
vi.mock('electron', () => electronMocks)

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab'
const PANE_KEY = makePaneKey(TAB_ID, '11111111-1111-4111-a111-111111111111')

function makeLegacyTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

// Why: a mutable store double lets setWorkspaceSession's write feed the next
// getWorkspaceSession call, so a second runtime instance can hydrate from it
// the way a real restart reads back whatever was last flushed to disk.
function makeMutableSessionStore(initial: WorkspaceSessionState): {
  store: {
    getWorkspaceSession: () => WorkspaceSessionState
    setWorkspaceSession: (next: WorkspaceSessionState) => void
  }
  read: () => WorkspaceSessionState
} {
  let session = initial
  const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    session = next
  })
  return {
    store: {
      getWorkspaceSession: () => session,
      setWorkspaceSession
    },
    read: () => session
  }
}

describe('persistHeadlessSessionTabProps dock persistence for legacy sessions (r4-9)', () => {
  it('mints a unified tab carrying the dock record and restores it on reload', async () => {
    const legacySession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [makeLegacyTerminalTab()] }
    }
    const { store, read } = makeMutableSessionStore(legacySession)
    const runtime = new QuirkyRuntimeService(store as never)

    await expect(
      runtime.setMobileSessionTabProps(`id:${WORKTREE_ID}`, {
        tabId: TAB_ID,
        terminalDock: { paneKey: PANE_KEY, docked: true, gutterRows: 6 }
      })
    ).resolves.toEqual({ updated: true })

    const saved = read()
    expect(saved.unifiedTabs?.[WORKTREE_ID]).toHaveLength(1)
    expect(saved.unifiedTabs?.[WORKTREE_ID]?.[0]).toMatchObject({
      id: TAB_ID,
      entityId: TAB_ID,
      contentType: 'terminal',
      terminalDockByPaneKey: { [PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
    // Why: the legacy tab entry itself must stay untouched by the dock patch.
    expect(saved.tabsByWorktree[WORKTREE_ID]?.[0]).not.toHaveProperty('terminalDockByPaneKey')

    // Simulate a restart: a fresh runtime hydrating from exactly what got saved.
    const restarted = new QuirkyRuntimeService({ getWorkspaceSession: () => saved } as never)
    const result = await restarted.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('does not mint a phantom tab when the dock patch removes a key that was never persisted', async () => {
    const legacySession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [makeLegacyTerminalTab()] }
    }
    const { store, read } = makeMutableSessionStore(legacySession)
    const runtime = new QuirkyRuntimeService(store as never)

    await runtime.setMobileSessionTabProps(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      terminalDock: { remove: [PANE_KEY] }
    })

    expect(read().unifiedTabs).toBeUndefined()
  })

  it('leaves an already-unified session unchanged (updates in place, mints nothing)', async () => {
    const unifiedTab: Tab = {
      id: TAB_ID,
      entityId: TAB_ID,
      groupId: 'group-1',
      worktreeId: WORKTREE_ID,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const modernSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [makeLegacyTerminalTab()] },
      unifiedTabs: { [WORKTREE_ID]: [unifiedTab] }
    }
    const { store, read } = makeMutableSessionStore(modernSession)
    const runtime = new QuirkyRuntimeService(store as never)

    await runtime.setMobileSessionTabProps(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      terminalDock: { paneKey: PANE_KEY, docked: true, gutterRows: 6 }
    })

    const saved = read()
    expect(saved.unifiedTabs?.[WORKTREE_ID]).toHaveLength(1)
    expect(saved.unifiedTabs?.[WORKTREE_ID]?.[0]).toMatchObject({
      id: TAB_ID,
      groupId: 'group-1',
      terminalDockByPaneKey: { [PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })
})
