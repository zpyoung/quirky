import { describe, expect, it, vi } from 'vitest'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { RuntimeSyncWindowGraph } from '../../../../../shared/runtime-types'

// Why: exercises the authoritative-renderer branch of setMobileSessionTabProps,
// which needs BrowserWindow.fromId to resolve a live window (r3-4).
const electronMocks = vi.hoisted(() => ({
  BrowserWindow: { fromId: vi.fn((_id: number): unknown => null) },
  webContents: { fromId: vi.fn((_id: number): unknown => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))
vi.mock('electron', () => electronMocks)

const DOCK_WORKTREE_ID = 'repo::/worktree'
const DOCK_TAB_ID = 'tab'
const DOCK_PANE_KEY = makePaneKey(DOCK_TAB_ID, '11111111-1111-4111-a111-111111111111')

function makeDockWorktreeSession(
  overrides: Partial<WorkspaceSessionState> = {}
): WorkspaceSessionState {
  const terminalTab: TerminalTab = {
    id: DOCK_TAB_ID,
    ptyId: 'pty-1',
    worktreeId: DOCK_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [DOCK_WORKTREE_ID]: [terminalTab] },
    ...overrides
  }
}

// Why: seeds the stored snapshot via a real renderer publication (not headless
// hydrate) — attachWindow alone leaves mobileSessionTabsByWorktree empty once a
// window is authoritative, since listMobileSessionTabs's full hydrate then skips.
function makeAuthoritativeRuntime(): QuirkyRuntimeService {
  const runtime = new QuirkyRuntimeService({
    getWorkspaceSession: () => makeDockWorktreeSession()
  } as never)
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
  runtime.syncWindowGraph(1, rendererGraphWithoutDockPane(1))
  return runtime
}

function rendererGraphWithoutDockPane(snapshotVersion: number): RuntimeSyncWindowGraph {
  return {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: DOCK_WORKTREE_ID,
        publicationEpoch: 'renderer:epoch-1',
        snapshotVersion,
        activeGroupId: 'group-1',
        activeTabId: `${DOCK_TAB_ID}::leaf-1`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${DOCK_TAB_ID}::leaf-1`,
            parentTabId: DOCK_TAB_ID,
            leafId: 'leaf-1',
            title: 'Terminal',
            ptyId: 'pty-1',
            isActive: true
            // Why: the renderer never learned about the client's dock patch, so its
            // own publication carries no terminalDockByPaneKey for this tab.
          }
        ]
      }
    ]
  }
}

describe('setMobileSessionTabProps dock patch on an authoritative-renderer host (r3-4)', () => {
  it('applies a client dock patch instead of dropping it, and acks only what it actually applied', async () => {
    const runtime = makeAuthoritativeRuntime()

    await expect(
      runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
      })
    ).resolves.toEqual({ updated: true })

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('survives a subsequent renderer publication that never knew about the patched pane', async () => {
    const runtime = makeAuthoritativeRuntime()

    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })

    // A later renderer publication under the same epoch, still unaware of the pane.
    runtime.syncWindowGraph(1, rendererGraphWithoutDockPane(2))

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('leaves the headless path (no authoritative renderer) unchanged', async () => {
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makeDockWorktreeSession()
    } as never)
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    await expect(
      runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
      })
    ).resolves.toEqual({ updated: true })

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })
})
