import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { runAppCommand, type AppShortcutState } from './app-command-handlers'
import { resolveExplicitWorkspaceDeleteTarget } from './app-command-tab-handlers'

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  deleteConfirmedWorkspace: vi.fn(),
  deleteHoveredWorkspaceImmediately: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/hovered-workspace-delete', () => ({
  deleteConfirmedWorkspace: mocks.deleteConfirmedWorkspace,
  deleteHoveredWorkspaceImmediately: mocks.deleteHoveredWorkspaceImmediately,
  resolveHoveredWorkspaceDeleteTarget: () => null
}))

const WORKTREE_ID = 'repo::/feature'

function appState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: WORKTREE_ID,
    actions: {},
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    pluginCommands: [],
    workspaceChromeActive: true
  } as unknown as AppShortcutState
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo',
    path: '/feature',
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

function deleteStore(worktrees: Worktree[]): AppState {
  return {
    folderWorkspaces: [],
    repos: [],
    worktreesByRepo: { repo: worktrees },
    deleteStateByWorktreeId: {}
  } as unknown as AppState
}

beforeEach(() => {
  mocks.deleteConfirmedWorkspace.mockClear()
  mocks.deleteHoveredWorkspaceImmediately.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.store = {}
})

describe('zoom over RPC', () => {
  function focusTerminalInput(): void {
    vi.stubGlobal('document', {
      activeElement: {
        classList: { contains: (token: string) => token === 'xterm-helper-textarea' }
      }
    })
  }

  it.each(['zoom.in', 'zoom.out', 'zoom.reset'] as const)(
    'declines %s in the probe and the run when a terminal has focus',
    (actionId) => {
      focusTerminalInput()
      mocks.store = { activeView: 'terminal', activeTabType: 'terminal' }

      const probe = runAppCommand(appState(), actionId, { source: 'rpc', probeOnly: true })
      const run = runAppCommand(appState(), actionId, { source: 'rpc' })

      expect(run.claimed).toBe(false)
      expect(run.reason).toContain('terminal')
      expect(probe).toEqual(run)
    }
  )
})

describe('tab.reopenClosed over RPC', () => {
  function reopenStore(kinds: string[], reopened: boolean) {
    const reopenClosedTab = vi.fn(() => reopened)
    mocks.store = {
      activeWorktreeId: WORKTREE_ID,
      recentlyClosedTabKindsByWorktree: { [WORKTREE_ID]: kinds },
      reopenClosedTab
    }
    return reopenClosedTab
  }

  it('declines in the probe and the run when nothing was closed', () => {
    const reopenClosedTab = reopenStore([], false)

    const probe = runAppCommand(appState(), 'tab.reopenClosed', { source: 'rpc', probeOnly: true })
    const run = runAppCommand(appState(), 'tab.reopenClosed', { source: 'rpc' })

    expect(run).toEqual({
      claimed: false,
      reason: `no recently closed tab to reopen in workspace ${WORKTREE_ID}`
    })
    expect(probe).toEqual(run)
    expect(reopenClosedTab).not.toHaveBeenCalled()
  })

  it('declines when every remembered kind has lost its snapshot', () => {
    reopenStore(['browser'], false)

    expect(runAppCommand(appState(), 'tab.reopenClosed', { source: 'rpc' }).claimed).toBe(false)
  })

  it('claims in the probe without reopening, and reopens on the run', () => {
    const reopenClosedTab = reopenStore(['terminal'], true)

    expect(
      runAppCommand(appState(), 'tab.reopenClosed', { source: 'rpc', probeOnly: true })
    ).toEqual({ claimed: true })
    expect(reopenClosedTab).not.toHaveBeenCalled()
    expect(runAppCommand(appState(), 'tab.reopenClosed', { source: 'rpc' })).toEqual({
      claimed: true
    })
    expect(reopenClosedTab).toHaveBeenCalledWith(WORKTREE_ID)
  })
})

describe('workspace.delete target over RPC', () => {
  const local = worktree({ hostId: LOCAL_EXECUTION_HOST_ID })
  const remote = worktree({ hostId: 'ssh:other-host' })

  it('picks the copy on the named host whatever the catalog order', () => {
    for (const rows of [
      [remote, local],
      [local, remote]
    ]) {
      const resolved = resolveExplicitWorkspaceDeleteTarget(
        deleteStore(rows),
        WORKTREE_ID,
        LOCAL_EXECUTION_HOST_ID
      )

      expect(resolved).toEqual({ target: { kind: 'worktree', worktree: local } })
    }
  })

  it('declines an id several hosts publish when no host is named, listing the hosts', () => {
    const resolved = resolveExplicitWorkspaceDeleteTarget(deleteStore([remote, local]), WORKTREE_ID)

    expect(resolved).toEqual({
      reason: expect.stringContaining('local, ssh:other-host')
    })
  })

  it('declines when the named host has no copy', () => {
    const resolved = resolveExplicitWorkspaceDeleteTarget(
      deleteStore([local]),
      WORKTREE_ID,
      'ssh:other-host'
    )

    expect(resolved).toEqual({
      reason: `workspace ${WORKTREE_ID} was not found on host ssh:other-host`
    })
  })

  it('still resolves an id only one host publishes without a host', () => {
    expect(resolveExplicitWorkspaceDeleteTarget(deleteStore([local]), WORKTREE_ID)).toEqual({
      target: { kind: 'worktree', worktree: local }
    })
  })

  it('deletes the resolved copy as confirmed and never touches the hover path', () => {
    mocks.store = deleteStore([remote, local])

    const result = runAppCommand(appState(), 'workspace.delete', {
      source: 'rpc',
      worktreeId: WORKTREE_ID,
      hostId: 'ssh:other-host'
    })

    expect(result).toEqual({ claimed: true })
    expect(mocks.deleteConfirmedWorkspace).toHaveBeenCalledWith(mocks.store, {
      kind: 'worktree',
      worktree: remote
    })
    expect(mocks.deleteHoveredWorkspaceImmediately).not.toHaveBeenCalled()
  })

  it('declines an ambiguous id in the probe without deleting', () => {
    mocks.store = deleteStore([remote, local])

    const result = runAppCommand(appState(), 'workspace.delete', {
      source: 'rpc',
      worktreeId: WORKTREE_ID,
      probeOnly: true
    })

    expect(result.claimed).toBe(false)
    expect(result.reason).toContain('several hosts')
    expect(mocks.deleteConfirmedWorkspace).not.toHaveBeenCalled()
  })
})
