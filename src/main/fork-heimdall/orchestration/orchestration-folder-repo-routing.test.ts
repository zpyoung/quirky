import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const scanLocalRepoWorktreesForResolution = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/repo-worktree-resolution-scan', () => ({
  scanLocalRepoWorktreesForResolution
}))

import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import { HeimdallKernelHost } from '../kernel-host'
import { workspaceRuntimeId } from './orchestration-adapter'

class FolderTestRuntime extends QuirkyRuntimeService {
  public override resolveRuntimeFileTarget(selector: string) {
    return super.resolveRuntimeFileTarget(selector)
  }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('Heimdall folder repo orchestration routing', () => {
  it('resolves the enrolled repo root through the runtime worktree selector', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'heimdall-folder-repo-'))
    directories.push(workspacePath)
    const repo = {
      id: 'folder-repo-1',
      path: workspacePath,
      displayName: 'Folder repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const
    }
    const workspaceId = `${repo.id}::${workspacePath}`
    const meta = {
      displayName: repo.displayName,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
    const metadata: Record<string, typeof meta & Record<string, unknown>> = {
      [workspaceId]: meta
    }
    const store = {
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getRepos: () => [repo],
      getAllWorktreeMeta: () => metadata,
      getWorktreeMeta: (id: string) => metadata[id],
      setWorktreeMeta: vi.fn((id: string, patch: Record<string, unknown>) => {
        const updated = { ...(metadata[id] ?? meta), ...patch }
        metadata[id] = updated
        return updated
      }),
      removeWorktreeLineage: vi.fn(),
      removeWorkspaceLineage: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getAllWorkspaceLineage: () => ({}),
      getGitHubCache: () => undefined,
      getSettings: () => ({
        workspaceDir: '/tmp/workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      }),
      getProjects: () => [],
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    }
    const enrollment: WatcherEnrollment = {
      watcherId: 'watcher-folder-repo',
      kind: 'objective',
      workspaceKey: `local::${workspacePath}`,
      executionHostId: 'local',
      repoId: repo.id,
      worktreeId: null,
      workspacePath,
      schedulerOwner: 'local_host_service',
      enabled: true,
      paused: false,
      commandRevision: 0,
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: {},
      coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
      orchestrationRunId: 'run-folder-repo',
      createdAtMs: 1,
      terminalAtMs: null
    }
    const selector = `id:${workspaceRuntimeId(enrollment)}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large, private-field-bearing Store class; only the persistence methods QuirkyRuntimeService reads for repo/worktree resolution are implemented.
    const runtime = new FolderTestRuntime(store as never)

    await expect(runtime.showManagedTerminalWorkspace(selector)).resolves.toMatchObject({
      id: workspaceId,
      repoId: repo.id,
      path: workspacePath
    })
    expect(scanLocalRepoWorktreesForResolution).not.toHaveBeenCalled()

    const resolveRuntimeFileTarget = runtime.resolveRuntimeFileTarget.bind(runtime)
    let authorityDrift: 'none' | 'host' | 'path' = 'none'
    vi.spyOn(runtime, 'resolveRuntimeFileTarget').mockImplementation(async (runtimeSelector) => {
      const target = await resolveRuntimeFileTarget(runtimeSelector)
      if (authorityDrift === 'host') {
        return { ...target, executionHostId: 'runtime:other-host' as const }
      }
      if (authorityDrift === 'path') {
        return {
          ...target,
          worktree: { ...target.worktree, path: join(workspacePath, 'moved') }
        }
      }
      return target
    })
    const host = new HeimdallKernelHost(
      runtime,
      (key) => (key === enrollment.workspaceKey ? enrollment : null),
      () => {},
      () => {}
    )

    await expect(host.resolveLeaseTarget(enrollment.workspaceKey)).resolves.toMatchObject({
      kind: 'folder',
      executionHostId: 'local',
      workspacePath,
      watcherId: enrollment.watcherId
    })
    authorityDrift = 'host'
    await expect(host.resolveLeaseTarget(enrollment.workspaceKey)).rejects.toThrow(
      'Resolved folder authority changed after Heimdall enrollment'
    )
    authorityDrift = 'path'
    await expect(host.resolveLeaseTarget(enrollment.workspaceKey)).rejects.toThrow(
      'Resolved folder authority changed after Heimdall enrollment'
    )
  })
})
