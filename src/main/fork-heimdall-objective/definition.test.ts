import { describe, expect, it, vi } from 'vitest'
import { deriveHandoffInput } from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  EnrollInputSchema,
  WatcherEnrollmentSchema,
  type EnrollInput
} from '../../shared/fork-heimdall/watcher-types'
import { authorizeKindEnrollment } from '../fork-heimdall/kernel-enrollment'
import { type RegisteredWatcherKind, WatcherKindRegistry } from '../fork-heimdall/registry'
import { enrollmentPayloadSchema } from '../fork-hosted-review-sitter/definition-store'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { authorizeObjectiveEnrollment, ObjectiveOwnerNotExecutableError } from './definition'
import {
  createObjectiveKind,
  decideObjectiveForEnrollment,
  paceObjectiveForEnrollment
} from './kind'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import type { ObjectiveStore } from './objective-store'

function objectiveKindPayload(
  overrides: Partial<ObjectiveEnrollmentPayload> = {}
): ObjectiveEnrollmentPayload {
  return {
    objectiveText: 'Implement the objective safely.',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritory: ['src/**'],
    roleAgents: { planner: 'codex' },
    sitterOverrides: {},
    ...overrides
  }
}

/** Reads a dynamically-authorized kindPayload as a spreadable base for building a variant fixture. */
function asKindPayloadOverride(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {}
}

function input(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {
      plan: 'on',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'on'
    },
    budget: { wallClockActiveMs: 60_000, turns: 12 },
    kindPayload: objectiveKindPayload(),
    ...overrides
  }
}

function store(repo: Record<string, unknown>): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of Store, a class with private fields no object literal can structurally satisfy; only getRepo is exercised.
  return { getRepo: () => repo } as unknown as Store
}

function storeWithoutRepo(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of Store, a class with private fields no object literal can structurally satisfy; only getRepo is exercised.
  return { getRepo: () => undefined } as unknown as Store
}

function fileRuntime(
  resolveRuntimeFileTarget: (selector: string) => Promise<unknown>
): QuirkyRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only resolveRuntimeFileTarget is exercised.
  return { resolveRuntimeFileTarget } as unknown as QuirkyRuntimeService
}

function gitRuntime(executionHostId: 'local' | `ssh:${string}` | `runtime:${string}`) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only resolveRuntimeGitTarget is exercised.
  return {
    resolveRuntimeGitTarget: async () => ({
      executionHostId,
      worktree: {
        id: 'worktree-1',
        repoId: 'repo-1',
        path: '/workspace/repo',
        git: { isBare: false, prunable: false }
      }
    })
  } as unknown as QuirkyRuntimeService
}

function forge(provider: 'github' | 'unsupported'): ObjectiveForgeAccess {
  return {
    detectProvider: vi.fn(async () => provider),
    getProvider: vi.fn(async () => null),
    getDefaultBranch: vi.fn(async () => null),
    isAuthenticated: vi.fn(async () => false),
    invalidate: vi.fn()
  }
}

async function authorizeThroughKernel(
  runtime: QuirkyRuntimeService,
  repository: Store,
  enrollment: EnrollInput,
  objectiveForge: ObjectiveForgeAccess
) {
  const registry = new WatcherKindRegistry()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ObjectiveStore is a class with private fields; this kind's authorizeEnrollment path never reads it.
  const objectiveStore = {} as ObjectiveStore
  registry.register(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registry erases each kind's specific World/Action/Detail types to `unknown`; the erasure is the registry's documented boundary.
    createObjectiveKind({
      runtime,
      store: repository,
      objectiveStore,
      forge: objectiveForge
    }) as unknown as RegisteredWatcherKind
  )
  return authorizeKindEnrollment(registry, enrollment)
}

describe('objective enrollment authorization', () => {
  it('re-derives an SSH execution host and scheduler owner instead of trusting renderer paths', async () => {
    const authorized = await authorizeObjectiveEnrollment(
      gitRuntime('ssh:build-host'),
      store({ id: 'repo-1', executionHostId: 'local' }),
      input()
    )

    expect(authorized.executionHostId).toBe('ssh:build-host')
    expect(authorized.workspacePath).toBe('/workspace/repo')
    expect(authorized.workspaceKey).toBe('ssh:build-host::/workspace/repo')
    expect(authorized.schedulerOwner).toBe('ssh_bridge')
  })

  it('refuses an objective owned by another runtime before persisting it locally', async () => {
    await expect(
      authorizeObjectiveEnrollment(
        gitRuntime('runtime:other-host'),
        store({ id: 'repo-1' }),
        input()
      )
    ).rejects.toBeInstanceOf(ObjectiveOwnerNotExecutableError)
  })

  it('refuses landing bars above files-on-disk for folder workspaces', async () => {
    const runtime = fileRuntime(async () => ({
      executionHostId: 'local',
      worktree: { repoId: 'repo-1', path: '/workspace/folder' }
    }))
    const enrollment = input({
      worktreeId: null,
      kindPayload: objectiveKindPayload({
        landingBar: 'merged',
        workspaceKind: 'folder'
      })
    })

    await expect(
      authorizeObjectiveEnrollment(
        runtime,
        store({ id: 'repo-1', kind: 'folder', path: '/workspace/folder' }),
        enrollment
      )
    ).rejects.toThrow('landing-bar-requires-git')
  })

  it('resolves a folder objective through the repository root target on its owning host', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'ssh:folder-host' as const,
      worktree: { repoId: 'repo-1', path: '/workspace/folder' }
    }))
    const runtime = fileRuntime(resolveRuntimeFileTarget)
    const enrollment = input({
      worktreeId: null,
      kindPayload: objectiveKindPayload({
        workspaceKind: 'folder',
        maxConcurrency: 3
      })
    })

    const authorized = await authorizeObjectiveEnrollment(
      runtime,
      store({
        id: 'repo-1',
        kind: 'folder',
        path: '/workspace/folder',
        executionHostId: 'ssh:folder-host'
      }),
      enrollment
    )
    const contract = ObjectiveEnrollmentPayloadSchema.parse(authorized.kindPayload)

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:repo-1::/workspace/folder')
    expect(authorized.executionHostId).toBe('ssh:folder-host')
    expect(authorized.workspacePath).toBe('/workspace/folder')
    expect(contract.maxConcurrency).toBe(1)
  })

  it('authorizes a canonical folder workspace without a Repo row and preserves its identities', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'ssh:folder-host' as const,
      worktree: {
        id: 'folder:folder-1',
        repoId: 'folder-workspace:group-1',
        path: '/workspace/folder'
      }
    }))
    const runtime = fileRuntime(resolveRuntimeFileTarget)
    const enrollment = input({
      repoId: 'folder-workspace:group-1',
      worktreeId: 'folder:folder-1',
      kindPayload: objectiveKindPayload({
        workspaceKind: 'folder',
        maxConcurrency: 3
      })
    })

    const authorized = await authorizeObjectiveEnrollment(runtime, storeWithoutRepo(), enrollment)
    const contract = ObjectiveEnrollmentPayloadSchema.parse(authorized.kindPayload)

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder:folder-1')
    expect(authorized).toMatchObject({
      repoId: 'folder-workspace:group-1',
      worktreeId: 'folder:folder-1',
      executionHostId: 'ssh:folder-host',
      workspacePath: '/workspace/folder',
      schedulerOwner: 'ssh_bridge'
    })
    expect(contract).toMatchObject({ workspaceKind: 'folder', maxConcurrency: 1 })
  })

  it('rejects a canonical folder target whose runtime identity does not match enrollment', async () => {
    const runtime = fileRuntime(async () => ({
      executionHostId: 'local',
      worktree: {
        id: 'folder:other-folder',
        repoId: 'folder-workspace:group-1',
        path: '/workspace/folder'
      }
    }))
    const enrollment = input({
      repoId: 'folder-workspace:group-1',
      worktreeId: 'folder:folder-1',
      kindPayload: objectiveKindPayload({ workspaceKind: 'folder' })
    })

    await expect(
      authorizeObjectiveEnrollment(runtime, storeWithoutRepo(), enrollment)
    ).rejects.toThrow('Invalid objective folder workspace identity')
  })

  it('keeps declared gates unchanged in the authorized contract for a git objective', async () => {
    const gates = [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    const enrollment = input({
      kindPayload: objectiveKindPayload({ gates })
    })

    const authorized = await authorizeObjectiveEnrollment(
      gitRuntime('local'),
      store({ id: 'repo-1' }),
      enrollment
    )

    const contract = ObjectiveEnrollmentPayloadSchema.parse(authorized.kindPayload)
    expect(contract.gates).toEqual(gates)
  })

  it('keeps declared gates unchanged for a folder objective that clamps concurrency', async () => {
    const gates = [{ name: 'ownership-guard', command: 'pnpm run guard', timeoutSeconds: 300 }]
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'ssh:folder-host' as const,
      worktree: { repoId: 'repo-1', path: '/workspace/folder' }
    }))
    const runtime = fileRuntime(resolveRuntimeFileTarget)
    const enrollment = input({
      worktreeId: null,
      kindPayload: objectiveKindPayload({
        workspaceKind: 'folder',
        maxConcurrency: 3,
        gates
      })
    })

    const authorized = await authorizeObjectiveEnrollment(
      runtime,
      store({ id: 'repo-1', kind: 'folder', path: '/workspace/folder' }),
      enrollment
    )
    const contract = ObjectiveEnrollmentPayloadSchema.parse(authorized.kindPayload)

    expect(contract.gates).toEqual(gates)
    expect(contract.maxConcurrency).toBe(1)
  })

  it('preserves multi-worker concurrency for a git objective', async () => {
    const enrollment = input({
      kindPayload: objectiveKindPayload({ maxConcurrency: 3 })
    })

    const authorized = await authorizeObjectiveEnrollment(
      gitRuntime('local'),
      store({ id: 'repo-1' }),
      enrollment
    )

    const contract = ObjectiveEnrollmentPayloadSchema.parse(authorized.kindPayload)
    expect(contract.maxConcurrency).toBe(3)
  })
  it('rejects plan-off enrollment when no executable plan is usable', async () => {
    const hasUsablePlan = vi.fn(() => false)
    const kind = createObjectiveKind({
      runtime: gitRuntime('local'),
      store: store({ id: 'repo-1' }),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only hasUsablePlan is exercised.
      objectiveStore: { hasUsablePlan } as unknown as ObjectiveStore
    })
    const base = input()
    const authorized = await kind.authorizeEnrollment({
      ...base,
      capabilities: { ...base.capabilities, plan: 'off' },
      kindPayload: objectiveKindPayload({
        existingPlan: '# Source that still requires planner normalization'
      })
    })

    expect(() => kind.validateEnrollment?.(authorized, null)).toThrow(
      'plan-off-requires-approved-plan'
    )
    expect(hasUsablePlan).not.toHaveBeenCalled()
    const existing = WatcherEnrollmentSchema.parse({
      ...authorized,
      watcherId: 'objective-without-plan',
      enabled: false,
      paused: false,
      commandRevision: 1,
      coordinatorIdentity: { handle: 'coordinator-handle', paneKey: 'coordinator-pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    })
    expect(() => kind.validateEnrollment?.(authorized, existing)).toThrow(
      'plan-off-requires-approved-plan'
    )
    expect(hasUsablePlan).toHaveBeenCalledWith('objective-without-plan')
  })

  it('accepts plan-off re-enrollment when the same objective has a usable plan', async () => {
    const hasUsablePlan = vi.fn(() => true)
    const kind = createObjectiveKind({
      runtime: gitRuntime('local'),
      store: store({ id: 'repo-1' }),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only hasUsablePlan is exercised.
      objectiveStore: { hasUsablePlan } as unknown as ObjectiveStore
    })
    const base = input()
    const authorized = await kind.authorizeEnrollment({
      ...base,
      capabilities: { ...base.capabilities, plan: 'off' }
    })
    const existing = WatcherEnrollmentSchema.parse({
      ...authorized,
      watcherId: 'objective-watcher',
      enabled: false,
      paused: false,
      commandRevision: 1,
      coordinatorIdentity: { handle: 'coordinator-handle', paneKey: 'coordinator-pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    })

    expect(() => kind.validateEnrollment?.(authorized, existing)).not.toThrow()
    expect(() =>
      kind.validateEnrollment?.(
        {
          ...authorized,
          kindPayload: {
            ...asKindPayloadOverride(authorized.kindPayload),
            objectiveText: 'A different objective'
          }
        },
        existing
      )
    ).toThrow('plan-off-requires-approved-plan')
    expect(hasUsablePlan).toHaveBeenCalledWith('objective-watcher')
  })
  it('idles a restored plan-off objective when its next action requires planning', async () => {
    const base = input()
    const authorized = await authorizeObjectiveEnrollment(
      gitRuntime('local'),
      store({ id: 'repo-1' }),
      {
        ...base,
        capabilities: { ...base.capabilities, plan: 'off' }
      }
    )
    const enrollment = WatcherEnrollmentSchema.parse({
      ...authorized,
      watcherId: 'restored-objective',
      enabled: true,
      paused: false,
      commandRevision: 0,
      coordinatorIdentity: { handle: 'coordinator-handle', paneKey: 'coordinator-pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    })
    const snapshot: Snapshot<ObjectiveWorld> = {
      freshness: 'live',
      contentIdentity: 'content-1',
      observedAtMs: 1,
      world: {
        contract: ObjectiveEnrollmentPayloadSchema.parse(enrollment.kindPayload),
        workspaceKind: 'git',
        plan: { revisions: [], nodes: [], verdicts: [], landing: [] },
        reports: [],
        budget: enrollment.budget,
        landingContext: {
          branch: null,
          headSha: null,
          worktreeContentDigest: null,
          pushTarget: null,
          hostedReview: null
        }
      }
    }
    const ledger: WatcherLedger = { watcherId: enrollment.watcherId, entries: [] }

    const decision = decideObjectiveForEnrollment(snapshot, ledger, enrollment)
    expect(decision).toEqual({
      action: null,
      reason: 'plan-off-without-usable-plan',
      considered: [{ phase: 'plan', reason: 'plan-off-without-usable-plan' }]
    })
    expect(paceObjectiveForEnrollment(snapshot, ledger, decision)).toBe('idle')
  })

  it('maps a hosted-review objective without an explicit worktree to invalid-payload', async () => {
    const enrollment = input({
      worktreeId: null,
      kindPayload: objectiveKindPayload({ landingBar: 'hosted-review' })
    })

    await expect(
      authorizeThroughKernel(
        gitRuntime('local'),
        store({ id: 'repo-1' }),
        enrollment,
        forge('github')
      )
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'invalid-payload'
    })
  })

  it('maps an unsupported hosted-review forge to invalid-payload', async () => {
    const enrollment = input({
      kindPayload: objectiveKindPayload({ landingBar: 'hosted-review' })
    })

    await expect(
      authorizeThroughKernel(
        gitRuntime('local'),
        store({ id: 'repo-1' }),
        enrollment,
        forge('unsupported')
      )
    ).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'landing-bar-requires-supported-forge'
    })
  })

  it('derives a handoff accepted by both the kernel and hosted-review kind schemas', () => {
    const source = input()
    const contract = ObjectiveEnrollmentPayloadSchema.parse(
      objectiveKindPayload({ landingBar: 'hosted-review' })
    )
    const enrollment = WatcherEnrollmentSchema.parse({
      watcherId: 'objective-watcher',
      kind: 'objective',
      workspaceKey: 'local::/workspace/repo',
      executionHostId: 'local',
      repoId: source.repoId,
      worktreeId: source.worktreeId,
      workspacePath: '/workspace/repo',
      schedulerOwner: 'local_host_service',
      enabled: true,
      paused: false,
      commandRevision: 0,
      capabilities: source.capabilities,
      budget: source.budget,
      kindPayload: contract,
      coordinatorIdentity: { handle: 'coordinator-handle', paneKey: 'coordinator-pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    })
    const handoff = deriveHandoffInput({
      enrollment,
      contract,
      landing: {
        revisionId: 'revision-1',
        fromContentIdentity: 'content-before-review',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: 'https://github.test/acme/repo/pull/42',
        branch: 'feature/objective',
        headSha: 'a'.repeat(40),
        base: 'main'
      },
      budgetState: { activeMs: 5_000, turns: 2, exhausted: null }
    })

    expect(EnrollInputSchema.parse(handoff)).toEqual(handoff)
    expect(handoff.kindPayload).toMatchObject({ mergeCheckScope: 'all' })
    expect(enrollmentPayloadSchema.parse(handoff.kindPayload)).toEqual(handoff.kindPayload)
  })
})
