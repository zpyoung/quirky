import { describe, expect, it, vi } from 'vitest'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { authorizeKindEnrollment } from '../fork-heimdall/kernel-enrollment'
import { type RegisteredWatcherKind, WatcherKindRegistry } from '../fork-heimdall/registry'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { authorizeObjectiveEnrollment, ObjectiveOwnerNotExecutableError } from './definition'
import { createObjectiveKind } from './kind'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import type { ObjectiveStore } from './objective-store'

function enrollment(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: null,
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 12 },
    kindPayload: {
      objectiveText: 'Build the feature',
      tier: 'standard',
      landingBar: 'hosted-review',
      maxConcurrency: 1,
      workspaceKind: 'git',
      writeTerritory: ['src/**'],
      roleAgents: { planner: 'codex' },
      sitterOverrides: {},
      newWorktree: { name: 'feature', baseBranch: 'main' }
    },
    ...overrides
  }
}

function payloadObject(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {}
}

function repository(
  kind: 'git' | 'folder' = 'git',
  executionHostId: 'local' | 'runtime:other' = 'local'
): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Store has private fields; authorization only reads getRepo.
  return {
    getRepo: () => ({ id: 'repo-1', kind, path: '/repo', executionHostId })
  } as unknown as Store
}

function runtime() {
  const createManagedWorktree = vi.fn(async () => ({
    worktree: { id: 'created-1', path: '/workspace/new-feature' }
  }))
  const removeManagedWorktree = vi.fn(async () => ({}))
  const listManagedWorktrees = vi.fn(
    async (): Promise<{
      worktrees: { id: string; displayName: string }[]
      totalCount: number
      truncated: boolean
    }> => ({ worktrees: [], totalCount: 0, truncated: false })
  )
  const invalidateWorktreeCatalog = vi.fn()
  const resolveRuntimeGitTarget = vi.fn(async () => ({
    executionHostId: 'local' as const,
    worktree: {
      id: 'created-1',
      repoId: 'repo-1',
      path: '/workspace/new-feature',
      git: { isBare: false, prunable: false }
    }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: QuirkyRuntimeService has private fields; these methods are the authorization surface exercised.
  const service = {
    createManagedWorktree,
    removeManagedWorktree,
    listManagedWorktrees,
    invalidateWorktreeCatalog,
    resolveRuntimeGitTarget
  } as unknown as QuirkyRuntimeService
  return {
    service,
    createManagedWorktree,
    removeManagedWorktree,
    listManagedWorktrees,
    invalidateWorktreeCatalog,
    resolveRuntimeGitTarget
  }
}

function forge(
  detectProvider: ObjectiveForgeAccess['detectProvider'] = vi.fn(async () => 'github' as const)
): ObjectiveForgeAccess {
  return {
    detectProvider,
    getProvider: vi.fn(async () => null),
    getDefaultBranch: vi.fn(async () => null),
    isAuthenticated: vi.fn(async () => false),
    invalidate: vi.fn()
  }
}

describe('objective enrollment on a new worktree', () => {
  it('creates on the repo host, accepts hosted review, and persists only the contract', async () => {
    const target = runtime()
    const repositoryStore = repository()
    const objectiveForge = forge()
    const registry = new WatcherKindRegistry()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorizeEnrollment does not read the ObjectiveStore's private fields.
    const objectiveStore = {} as ObjectiveStore
    const kind = createObjectiveKind({
      runtime: target.service,
      store: repositoryStore,
      objectiveStore,
      forge: objectiveForge
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registry erases the kind's World/Action/Detail generics at registration.
    registry.register(kind as unknown as RegisteredWatcherKind)
    const result = await authorizeKindEnrollment(registry, enrollment())

    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') {
      return
    }
    expect(result.authorized).toMatchObject({
      worktreeId: 'created-1',
      workspacePath: '/workspace/new-feature',
      workspaceKey: 'local::/workspace/new-feature'
    })
    expect(result.authorized.kindPayload).not.toHaveProperty('newWorktree')
    expect(target.createManagedWorktree).toHaveBeenCalledWith({
      repoSelector: 'id:repo-1',
      name: 'feature',
      baseBranch: 'main',
      displayName: 'feature',
      activate: false,
      lineage: { noParent: true },
      comment: 'Objective enrollment: feature'
    })
    expect(target.resolveRuntimeGitTarget).toHaveBeenCalledWith('id:created-1')
    expect(objectiveForge.detectProvider).toHaveBeenCalledOnce()
    expect(target.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('omits baseBranch when the default should be selected', async () => {
    const target = runtime()
    const source = enrollment()
    const payload = source.kindPayload
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Invalid test payload')
    }
    await authorizeObjectiveEnrollment(
      target.service,
      repository(),
      {
        ...source,
        kindPayload: { ...payload, newWorktree: { name: 'feature' } }
      },
      'desktop',
      forge()
    )
    expect(target.createManagedWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ baseBranch: expect.anything() })
    )
  })

  it('rolls back a worktree on forge failure and preserves the original error', async () => {
    const target = runtime()
    const failure = new Error('forge unavailable')
    const detectProvider = vi.fn(async () => {
      throw failure
    })
    await expect(
      authorizeObjectiveEnrollment(
        target.service,
        repository(),
        enrollment(),
        'desktop',
        forge(detectProvider)
      )
    ).rejects.toBe(failure)
    expect(target.removeManagedWorktree).toHaveBeenCalledWith('id:created-1', {
      force: true,
      hostId: 'local'
    })
  })

  it('does not mask a post-create error when rollback also fails', async () => {
    const target = runtime()
    target.removeManagedWorktree.mockRejectedValueOnce(new Error('removal unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('forge unavailable')
    try {
      await expect(
        authorizeObjectiveEnrollment(
          target.service,
          repository(),
          enrollment(),
          'desktop',
          forge(
            vi.fn(async () => {
              throw failure
            })
          )
        )
      ).rejects.toBe(failure)
      expect(warning).toHaveBeenCalledWith(
        'Objective enrollment worktree rollback failed',
        expect.any(Error)
      )
    } finally {
      warning.mockRestore()
    }
  })

  it('removes a checkout stranded by a failing create but keeps a same-named older one', async () => {
    const target = runtime()
    const older = { id: 'older-feature', displayName: 'feature' }
    target.listManagedWorktrees
      .mockResolvedValueOnce({ worktrees: [older], totalCount: 1, truncated: false })
      .mockResolvedValueOnce({
        worktrees: [
          older,
          { id: 'stranded-1', displayName: 'feature' },
          { id: 'unrelated', displayName: 'other' }
        ],
        totalCount: 3,
        truncated: false
      })
    const failure = new Error('terminal startup failed')
    target.createManagedWorktree.mockRejectedValueOnce(failure)

    await expect(
      authorizeObjectiveEnrollment(target.service, repository(), enrollment(), 'desktop', forge())
    ).rejects.toBe(failure)
    expect(target.invalidateWorktreeCatalog).toHaveBeenCalledWith('repo-1')
    expect(target.removeManagedWorktree).toHaveBeenCalledOnce()
    expect(target.removeManagedWorktree).toHaveBeenCalledWith('id:stranded-1', {
      force: true,
      hostId: 'local'
    })
  })

  it('hands the kernel a rollback that removes the created worktree at most once', async () => {
    const target = runtime()
    const undos: (() => Promise<void>)[] = []
    const scope = {
      onAbandoned: (undo: () => Promise<void>) => {
        undos.push(undo)
      }
    }

    await authorizeObjectiveEnrollment(
      target.service,
      repository(),
      enrollment(),
      'desktop',
      forge(),
      scope
    )
    expect(undos).toHaveLength(1)
    expect(target.removeManagedWorktree).not.toHaveBeenCalled()

    await undos[0]?.()
    await undos[0]?.()
    expect(target.removeManagedWorktree).toHaveBeenCalledOnce()
    expect(target.removeManagedWorktree).toHaveBeenCalledWith('id:created-1', {
      force: true,
      hostId: 'local'
    })
  })

  it('does not remove twice when authorization fails and the kernel also abandons', async () => {
    const target = runtime()
    const undos: (() => Promise<void>)[] = []
    const scope = {
      onAbandoned: (undo: () => Promise<void>) => {
        undos.push(undo)
      }
    }
    const failure = new Error('forge unavailable')

    await expect(
      authorizeObjectiveEnrollment(
        target.service,
        repository(),
        enrollment(),
        'desktop',
        forge(
          vi.fn(async () => {
            throw failure
          })
        ),
        scope
      )
    ).rejects.toBe(failure)
    await undos[0]?.()
    expect(target.removeManagedWorktree).toHaveBeenCalledOnce()
  })

  it.each([
    ['folder repo', () => repository('folder'), () => enrollment()],
    ['existing worktree', () => repository(), () => enrollment({ worktreeId: 'existing' })],
    [
      'empty name',
      () => repository(),
      () => {
        const source = enrollment()
        return {
          ...source,
          kindPayload: { ...payloadObject(source.kindPayload), newWorktree: { name: '  ' } }
        }
      }
    ],
    [
      'unknown role agent',
      () => repository(),
      () => {
        const source = enrollment()
        return {
          ...source,
          kindPayload: {
            ...payloadObject(source.kindPayload),
            roleAgents: { planner: 'not-an-agent' }
          }
        }
      }
    ],
    [
      'plan off',
      () => repository(),
      () => {
        const source = enrollment()
        return { ...source, capabilities: { ...source.capabilities, plan: 'off' as const } }
      }
    ],
    ['non-executable owner', () => repository('git', 'runtime:other'), () => enrollment()]
  ])('refuses %s before creating a worktree', async (_reason, getStore, getInput) => {
    const target = runtime()
    await expect(
      authorizeObjectiveEnrollment(target.service, getStore(), getInput(), 'desktop', forge())
    ).rejects.toThrow()
    expect(target.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('reports the plan-off and scheduler-owner refusals precisely', async () => {
    const target = runtime()
    const source = enrollment()
    await expect(
      authorizeObjectiveEnrollment(target.service, repository(), {
        ...source,
        capabilities: { ...source.capabilities, plan: 'off' }
      })
    ).rejects.toThrow('plan-off-requires-approved-plan')
    await expect(
      authorizeObjectiveEnrollment(target.service, repository('git', 'runtime:other'), source)
    ).rejects.toBeInstanceOf(ObjectiveOwnerNotExecutableError)
  })

  it('rolls back a mismatched runtime identity before forge detection', async () => {
    const target = runtime()
    target.resolveRuntimeGitTarget.mockResolvedValueOnce({
      executionHostId: 'local',
      worktree: {
        id: 'wrong',
        repoId: 'repo-1',
        path: '/workspace/new-feature',
        git: { isBare: false, prunable: false }
      }
    })
    const objectiveForge = forge()
    await expect(
      authorizeObjectiveEnrollment(
        target.service,
        repository(),
        enrollment(),
        'desktop',
        objectiveForge
      )
    ).rejects.toThrow('Invalid objective worktree identity')
    expect(target.removeManagedWorktree).toHaveBeenCalledOnce()
    expect(objectiveForge.detectProvider).not.toHaveBeenCalled()
  })
})
