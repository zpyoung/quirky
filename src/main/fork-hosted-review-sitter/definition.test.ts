import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY } from '../../shared/fork-heimdall/capability'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import type { AuthorizedEnrollment, EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import { authorizeKindEnrollment } from '../fork-heimdall/kernel-enrollment'
import { WatcherKindRegistry, type RegisteredWatcherKind } from '../fork-heimdall/registry'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { createHostedReviewKind } from './kind'
import {
  authorizeHostedReviewSitterDefinition,
  hostedReviewDefinitionFromEnrollment
} from './definition'

const { getHostedReviewForBranchMock } = vi.hoisted(() => ({
  getHostedReviewForBranchMock: vi.fn<() => Promise<HostedReviewInfo | null>>()
}))

vi.mock('../source-control/hosted-review', () => {
  return { getHostedReviewForBranch: getHostedReviewForBranchMock }
})
vi.mock('../project-runtime-git-options', () => {
  return {
    getLocalProjectWorktreeGitOptions: vi.fn<() => Record<string, never>>().mockReturnValue({})
  }
})

const defaultReview: HostedReviewInfo = {
  provider: 'github',
  number: 42,
  title: 'Existing review',
  state: 'open',
  url: 'https://github.com/acme/repo/pull/42',
  status: 'pending',
  updatedAt: '2026-09-28T00:00:00.000Z',
  mergeable: 'UNKNOWN'
}

beforeEach(() => {
  getHostedReviewForBranchMock.mockReset()
  getHostedReviewForBranchMock.mockResolvedValue(defaultReview)
})

describe('hosted review enrollment authorization', () => {
  it('derives and persists review identity when the renderer submits only policy', async () => {
    const review: HostedReviewInfo = {
      provider: 'github',
      number: 84,
      title: 'Actual review',
      state: 'open',
      url: 'https://github.com/acme/quirky/pull/84',
      status: 'pending',
      updatedAt: '2026-09-28T00:00:00.000Z',
      mergeable: 'UNKNOWN'
    }
    getHostedReviewForBranchMock.mockResolvedValue(review)
    const runtimeDouble = {
      showManagedWorktree: vi.fn(async () => ({
        id: 'worktree-1',
        repoId: 'repo-1',
        git: {
          path: '/actual/worktree',
          branch: 'refs/heads/actual-branch',
          head: 'a'.repeat(40),
          isBare: false,
          prunable: false
        }
      }))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization only calls showManagedWorktree.
    const runtime = runtimeDouble as unknown as QuirkyRuntimeService
    const storeDouble = {
      getRepo: () => ({ id: 'repo-1', path: '/actual/repo' }),
      getWorktreeMeta: () => ({ linkedPR: 12, linkedGitLabMR: 19 })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization only calls getRepo and getWorktreeMeta.
    const store = storeDouble as unknown as Store
    const kind = createHostedReviewKind(runtime, store)
    const registry = new WatcherKindRegistry()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The kernel erases heterogeneous kind types before registry storage.
    registry.register(kind as unknown as RegisteredWatcherKind)
    const input: EnrollInput = {
      kind: 'hosted-review',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {
        updateBranch: 'on',
        resolveConflicts: 'off',
        fixChecks: 'gated',
        merge: 'off'
      },
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: { branchUpdateMode: 'rebase', mergeMethod: null }
    }

    expect(kind.enrollmentPayloadSchema.safeParse(input.kindPayload).success).toBe(false)
    expect(RUNTIME_CAPABILITIES).toContain(
      HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY
    )

    const authorization = await authorizeKindEnrollment(registry, input)

    if (authorization.status !== 'authorized') {
      throw new Error(`Hosted review enrollment was refused: ${authorization.reason}`)
    }
    expect(authorization.authorized.kindPayload).toEqual({
      branch: 'actual-branch',
      provider: 'github',
      reviewNumber: 84,
      reviewUrl: review.url,
      branchUpdateMode: 'rebase',
      mergeMethod: null,
      mergeCheckScope: 'all'
    })
    expect(
      kind.enrollmentPayloadSchema.safeParse(authorization.authorized.kindPayload).success
    ).toBe(true)
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/actual/worktree',
        branch: 'actual-branch',
        linkedGitHubPR: 12,
        linkedGitLabMR: 19,
        currentHeadOid: 'a'.repeat(40)
      })
    )
  })
})

const kindPayload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash',
  mergeCheckScope: 'all'
} as const

function baseEnrollment(
  capabilities: Record<string, 'off' | 'gated' | 'on'>
): Pick<
  AuthorizedEnrollment,
  'repoId' | 'worktreeId' | 'workspacePath' | 'capabilities' | 'kindPayload'
> {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/repo',
    capabilities,
    kindPayload
  }
}

const FOUR_CAPABILITIES = {
  updateBranch: 'on',
  resolveConflicts: 'off',
  fixChecks: 'gated',
  merge: 'off'
} as const
const legacyKindPayload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
} as const

function authorizationStore(executionHostId?: string): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial Store double supplies only the methods authorization calls.
  return {
    getRepo: () => ({ id: 'repo-1', path: '/repo', executionHostId }),
    getWorktreeMeta: () => undefined
  } as unknown as Store
}

function authorizationRuntime(): QuirkyRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime double supplies only the worktree lookup exercised by authorization.
  return {
    showManagedWorktree: async () => ({
      id: 'worktree-1',
      repoId: 'repo-1',
      git: {
        path: '/repo/worktree',
        isBare: false,
        prunable: false,
        branch: 'feature/review',
        head: 'head-1'
      }
    })
  } as unknown as QuirkyRuntimeService
}

function authorizationInput(kindPayload: unknown): EnrollInput {
  return {
    kind: 'hosted-review',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: FOUR_CAPABILITIES,
    budget: { wallClockActiveMs: 3_600_000, turns: null },
    kindPayload
  }
}

async function authorize(kindPayload: unknown): Promise<AuthorizedEnrollment> {
  return authorizeHostedReviewSitterDefinition(
    authorizationRuntime(),
    authorizationStore(),
    authorizationInput(kindPayload)
  )
}

describe('hosted review merge-check scope', () => {
  it('defaults legacy definitions to all checks', () => {
    const definition = hostedReviewDefinitionFromEnrollment({
      ...baseEnrollment(FOUR_CAPABILITIES),
      kindPayload: legacyKindPayload
    })
    expect(definition.mergeCheckScope).toBe('all')
  })

  it('preserves explicit scope and defaults legacy candidates during authorization', async () => {
    const required = await authorize({ ...legacyKindPayload, mergeCheckScope: 'required' })
    const legacy = await authorize(legacyKindPayload)

    expect(required.kindPayload).toMatchObject({ mergeCheckScope: 'required' })
    expect(legacy.kindPayload).toMatchObject({ mergeCheckScope: 'all' })
  })
})

describe('hosted review enrollment owner gating', () => {
  it('refuses desktop authorization for a runtime-owned repository before reading its worktree', async () => {
    const runtime = authorizationRuntime()
    const showManagedWorktree = vi.spyOn(runtime, 'showManagedWorktree')

    await expect(
      authorizeHostedReviewSitterDefinition(
        runtime,
        authorizationStore('runtime:env-1'),
        authorizationInput(legacyKindPayload)
      )
    ).rejects.toMatchObject({
      name: 'HostedReviewOwnerNotExecutableError',
      schedulerOwner: 'remote_host_service'
    })
    expect(showManagedWorktree).not.toHaveBeenCalled()
  })

  it('refuses runtime authorization for an SSH-owned repository before reading its worktree', async () => {
    const runtime = authorizationRuntime()
    const showManagedWorktree = vi.spyOn(runtime, 'showManagedWorktree')

    await expect(
      authorizeHostedReviewSitterDefinition(
        runtime,
        authorizationStore('ssh:host-1'),
        authorizationInput(legacyKindPayload),
        'runtime'
      )
    ).rejects.toMatchObject({
      name: 'HostedReviewOwnerNotExecutableError',
      schedulerOwner: 'ssh_bridge'
    })
    expect(showManagedWorktree).not.toHaveBeenCalled()
  })
})

describe('hosted review capability re-parse tolerates an owner-configured enrollment', () => {
  it('parses a persisted enrollment with no owner-intervention key exactly as today', () => {
    const definition = hostedReviewDefinitionFromEnrollment(baseEnrollment(FOUR_CAPABILITIES))
    expect(definition.capabilities).toEqual(FOUR_CAPABILITIES)
  })

  it('tolerates an owner-configured enrollment without leaking owner-intervention into the definition', () => {
    const definition = hostedReviewDefinitionFromEnrollment(
      baseEnrollment({ ...FOUR_CAPABILITIES, 'owner-intervention': 'on' })
    )
    expect(definition.capabilities).toEqual(FOUR_CAPABILITIES)
    expect(Object.keys(definition.capabilities)).not.toContain('owner-intervention')
  })

  it('still rejects any other unrecognized capability key', () => {
    expect(() =>
      hostedReviewDefinitionFromEnrollment(
        baseEnrollment({ ...FOUR_CAPABILITIES, 'some-other-key': 'on' })
      )
    ).toThrow()
  })
})
