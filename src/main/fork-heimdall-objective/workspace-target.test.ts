import { describe, expect, it, vi } from 'vitest'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import type { ResolvedRuntimeFileTarget } from '../runtime/files/file-target'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { resolveObjectiveWorkspaceTarget } from './workspace-target'

function enrollment(
  executionHostId: WatcherEnrollment['executionHostId'] = 'local'
): WatcherEnrollment {
  return {
    watcherId: 'objective-1',
    kind: 'objective',
    workspaceKey: `${executionHostId}::/srv/project`,
    executionHostId,
    repoId: 'folder-repo',
    worktreeId: null,
    workspacePath: '/srv/project',
    schedulerOwner: executionHostId === 'local' ? 'local_host_service' : 'ssh_bridge',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 10 },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

function fileTarget(executionHostId: WatcherEnrollment['executionHostId']) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large Worktree type; only the fields below are read by workspace target resolution.
  return {
    executionHostId,
    worktree: {
      id: 'folder-repo::/srv/project',
      repoId: 'folder-repo',
      path: '/srv/project'
    }
  } as ResolvedRuntimeFileTarget
}

function fileRuntime(
  resolveRuntimeFileTarget: (selector: string) => Promise<unknown>
): QuirkyRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only resolveRuntimeFileTarget is exercised.
  return { resolveRuntimeFileTarget } as unknown as QuirkyRuntimeService
}

describe('resolveObjectiveWorkspaceTarget', () => {
  it('resolves a folder repo root by its canonical repo-path workspace id', async () => {
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue(fileTarget('local'))

    const target = await resolveObjectiveWorkspaceTarget(
      fileRuntime(resolveRuntimeFileTarget),
      enrollment()
    )

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder-repo::/srv/project')
    expect(resolveRuntimeFileTarget).not.toHaveBeenCalledWith('folder:folder-repo')
    expect(target).toEqual({
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/srv/project'
    })
  })

  it('resolves a canonical folder workspace by its persisted folder key', async () => {
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue({
      ...fileTarget('local'),
      worktree: {
        id: 'folder:folder-1',
        repoId: 'folder-workspace:group-1',
        path: '/srv/project'
      }
    })
    const canonical = {
      ...enrollment(),
      repoId: 'folder-workspace:group-1',
      worktreeId: 'folder:folder-1'
    }

    const target = await resolveObjectiveWorkspaceTarget(
      fileRuntime(resolveRuntimeFileTarget),
      canonical
    )

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder:folder-1')
    expect(target).toMatchObject({
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/srv/project'
    })
  })

  it('refuses a folder repo root enrolled on an SSH host', async () => {
    const executionHostId = 'ssh:objective-folder-target' as const
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue(fileTarget(executionHostId))

    await expect(
      resolveObjectiveWorkspaceTarget(
        fileRuntime(resolveRuntimeFileTarget),
        enrollment(executionHostId)
      )
    ).rejects.toBeInstanceOf(SshHostNotServedError)
    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder-repo::/srv/project')
  })
})
