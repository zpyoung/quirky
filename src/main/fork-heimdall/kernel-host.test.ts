import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { HeimdallKernelHost } from './kernel-host'
import { enrollmentInput, harness, kind } from './kernel-service-test-harness'
import { HostRoutedLeaseStore } from './lease-store'

vi.mock('electron', () => ({}))

const repo: Repo = {
  id: 'repo-1',
  path: '/workspace',
  displayName: 'Repo',
  badgeColor: '',
  addedAt: 0
}

type RuntimeTargetProbe = {
  resolveRuntimeGitTarget?: () => Promise<never>
  resolveRuntimeFileTarget?: () => Promise<never>
  listRepos?: () => Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId' | 'kind'>[]
  listDetectedManagedWorktrees?: () => Promise<{
    authoritative: boolean
    worktrees: { id: string; path?: string }[]
  }>
  listFolderWorkspaces?: () => { id: string }[]
}

async function enrolledWorkspace(worktreeId: string | null = 'worktree-1') {
  const world = await harness()
  world.service.registerKind(kind())
  const result = await world.service.enroll({ ...enrollmentInput(), worktreeId })
  if (result.status !== 'enrolled') {
    throw new Error('expected enrollment')
  }
  return { world, enrollment: result.entry.enrollment }
}

function leaseFor(
  enrollment: WatcherEnrollment,
  runtimeStub: RuntimeTargetProbe
): HostRoutedLeaseStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host only calls the runtime methods supplied by each test before target resolution throws.
  const runtime = runtimeStub as unknown as QuirkyRuntimeService
  const host = new HeimdallKernelHost(
    runtime,
    () => enrollment,
    () => {},
    () => {}
  )
  return new HostRoutedLeaseStore({ resolveTarget: (key) => host.resolveLeaseTarget(key) })
}

describe('Heimdall lease target absence evidence', () => {
  it.each([
    { authoritative: false, worktrees: [], status: 'unverifiable' },
    { authoritative: true, worktrees: [{ id: 'worktree-1' }], status: 'unverifiable' },
    { authoritative: true, worktrees: [], status: 'workspace-removed' }
  ])('classifies a local Git selector miss from the host catalog ($status)', async (catalog) => {
    const { world, enrollment } = await enrolledWorkspace()
    const listDetectedManagedWorktrees = vi.fn(async () => catalog)
    const store = leaseFor(enrollment, {
      resolveRuntimeGitTarget: async () => {
        throw new Error('selector_not_found')
      },
      listRepos: () => [repo],
      listDetectedManagedWorktrees
    })

    const result = await store.acquireOrRenew(enrollment.workspaceKey, 'owner', 90_000)
    expect(result.status).toBe(catalog.status)
    expect(listDetectedManagedWorktrees).toHaveBeenCalledWith('id:repo-1', undefined)
    await world.service.stopForShutdown()
  })

  it('ends a local watcher after its repo is removed from Quirky', async () => {
    const { world, enrollment } = await enrolledWorkspace()
    const store = leaseFor(enrollment, {
      resolveRuntimeGitTarget: async () => {
        throw new Error('selector_not_found')
      },
      listRepos: () => []
    })

    await expect(store.acquireOrRenew(enrollment.workspaceKey, 'owner', 90_000)).resolves.toEqual({
      status: 'workspace-removed',
      reason: 'workspace-removed'
    })
    await world.service.stopForShutdown()
  })

  it.each([
    { authoritative: false, status: 'unverifiable' },
    { authoritative: true, status: 'workspace-removed' }
  ])('requires an SSH host catalog verdict ($status)', async ({ authoritative, status }) => {
    const { world, enrollment } = await enrolledWorkspace()
    const remoteEnrollment = {
      ...enrollment,
      executionHostId: 'ssh:host-a' as const,
      workspaceKey: 'ssh:host-a::/workspace/review-1' as const
    }
    const listDetectedManagedWorktrees = vi.fn(async () => ({
      authoritative,
      worktrees: []
    }))
    const store = leaseFor(remoteEnrollment, {
      resolveRuntimeGitTarget: async () => {
        throw new Error('selector_not_found')
      },
      listRepos: () => [{ ...repo, executionHostId: 'ssh:host-a', connectionId: 'host-a' }],
      listDetectedManagedWorktrees
    })

    const result = await store.acquireOrRenew(remoteEnrollment.workspaceKey, 'owner', 90_000)
    expect(result.status).toBe(status)
    expect(listDetectedManagedWorktrees).toHaveBeenCalledWith('id:repo-1', 'host-a')
    await world.service.stopForShutdown()
  })

  it('ends a removed folder-repo workspace from its authoritative registry', async () => {
    const { world, enrollment } = await enrolledWorkspace(null)
    const store = leaseFor(enrollment, {
      resolveRuntimeFileTarget: async () => {
        throw new Error('selector_not_found')
      },
      listRepos: () => [{ ...repo, kind: 'folder' }],
      listDetectedManagedWorktrees: async () => ({ authoritative: true, worktrees: [] })
    })

    await expect(store.acquireOrRenew(enrollment.workspaceKey, 'owner', 90_000)).resolves.toEqual({
      status: 'workspace-removed',
      reason: 'workspace-removed'
    })
    await world.service.stopForShutdown()
  })

  it('does not mistake a folder-repo root for a deleted instance sharing its path', async () => {
    const { world, enrollment } = await enrolledWorkspace()
    const instance = {
      ...enrollment,
      worktreeId: `repo-1::${enrollment.workspacePath}::workspace:00000000-0000-4000-8000-000000000001`
    }
    const store = leaseFor(instance, {
      resolveRuntimeGitTarget: async () => {
        throw new Error('selector_not_found')
      },
      listRepos: () => [{ ...repo, path: enrollment.workspacePath, kind: 'folder' }],
      listDetectedManagedWorktrees: async () => ({
        authoritative: true,
        worktrees: [{ id: `repo-1::${enrollment.workspacePath}`, path: enrollment.workspacePath }]
      })
    })

    await expect(store.acquireOrRenew(enrollment.workspaceKey, 'owner', 90_000)).resolves.toEqual({
      status: 'workspace-removed',
      reason: 'workspace-removed'
    })
    await world.service.stopForShutdown()
  })

  it('ends a removed standalone folder only when the local registry omits it', async () => {
    const { world, enrollment } = await enrolledWorkspace('folder:gone')
    const store = leaseFor(enrollment, {
      resolveRuntimeFileTarget: async () => {
        throw new Error('selector_not_found')
      },
      listFolderWorkspaces: () => []
    })

    await expect(store.acquireOrRenew(enrollment.workspaceKey, 'owner', 90_000)).resolves.toEqual({
      status: 'workspace-removed',
      reason: 'workspace-removed'
    })
    await world.service.stopForShutdown()
  })
})
