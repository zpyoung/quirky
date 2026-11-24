import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { RuntimeListingHostScope } from '../../shared/runtime-listing-host-scope'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'

const worktreeIsClean = vi.fn(async () => true)

vi.mock('./provider-git', () => ({
  resolveHostedReviewSitterGitExecution: () => ({ worktreeIsClean })
}))

const { inspectHostedReviewSitterContention } = await import('./contention')

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/workspaces/grampus'

const DEFINITION: HostedReviewSitterDefinition = {
  repoId: REPO_ID,
  worktreeId: `${REPO_ID}::${WORKTREE_PATH}`,
  repoPath: WORKTREE_PATH,
  branch: 'feature',
  provider: 'github',
  reviewNumber: 63,
  reviewUrl: 'https://github.com/example/repo/pull/63',
  capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'gated' },
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash',
  mergeCheckScope: 'required'
}

// The repo row decides the sitter's execution host: a bare row is local, a `connectionId` is SSH.
function fakeStore(connectionId: string | null = null): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of Store; only getRepo is reached by inspectHostedReviewSitterContention.
  return {
    getRepo: (id: string) => (id === REPO_ID ? { id, connectionId } : undefined)
  } as unknown as Store
}

function fakeRuntime(
  hostScope: RuntimeListingHostScope | undefined,
  truncated = false,
  options: {
    terminals?: { handle: string; title: string | null; connected: boolean }[]
    agentStatus?: { isRunningAgent: boolean; status: 'idle' | 'working' | null }
    dispatchId?: string
  } = {}
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of QuirkyRuntimeService; only the members this suite exercises are stubbed.
  return {
    showManagedWorktree: async () => ({
      repoId: REPO_ID,
      git: { path: WORKTREE_PATH }
    }),
    listTerminals: async () => ({
      terminals: options.terminals ?? [],
      totalCount: options.terminals?.length ?? 0,
      truncated,
      hostScope
    }),
    getTerminalAgentStatus: async () =>
      options.agentStatus ?? { isRunningAgent: false, status: null },
    getOrchestrationDb: () => ({
      getWorkerTerminalResourceByOwner: (dispatchId: string) =>
        dispatchId === options.dispatchId
          ? {
              origin_dispatch_id: dispatchId,
              owner_dispatch_id: dispatchId,
              worktree_id: DEFINITION.worktreeId,
              ownership_state: 'owned',
              terminal_handle: options.terminals?.[0]?.handle
            }
          : undefined
    })
  } as unknown as QuirkyRuntimeService
}

describe('hosted review sitter terminal-census gate', () => {
  beforeEach(() => {
    worktreeIsClean.mockClear()
    worktreeIsClean.mockResolvedValue(true)
  })

  it('proceeds when the local execution host was covered and only unrelated hosts were disclosed', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime({ hostIds: ['local'], omittedHostIds: ['ssh:box-1', 'runtime:env-1'] }),
      fakeStore(),
      DEFINITION
    )

    expect(contention).toEqual({ state: 'clear' })
  })

  it('holds when the listing never covered the SSH host the sitter executes on', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime({ hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }),
      fakeStore('box-1'),
      DEFINITION
    )

    expect(contention).toEqual({
      state: 'unverifiable',
      reason: 'terminal-host-census-incomplete'
    })
  })

  it('holds when the answering host reported no scope at all', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime(undefined),
      fakeStore(),
      DEFINITION
    )

    expect(contention).toEqual({
      state: 'unverifiable',
      reason: 'terminal-host-census-incomplete'
    })
  })

  it('holds when the listing was truncated even though its host was covered', async () => {
    const contention = await inspectHostedReviewSitterContention(
      fakeRuntime({ hostIds: ['local'], omittedHostIds: [] }, true),
      fakeStore(),
      DEFINITION
    )

    expect(contention).toEqual({
      state: 'unverifiable',
      reason: 'terminal-host-census-incomplete'
    })
  })

  it('recognizes an idle worker only through its exact durable dispatch identity', async () => {
    const terminal = { handle: 'term-owned', title: 'unrelated title', connected: true }
    const ownWorker = { attemptId: 'attempt-1', dispatchId: 'dispatch-owned' }

    await expect(
      inspectHostedReviewSitterContention(
        fakeRuntime({ hostIds: ['local'], omittedHostIds: [] }, false, {
          terminals: [terminal],
          agentStatus: { isRunningAgent: true, status: 'idle' },
          dispatchId: ownWorker.dispatchId
        }),
        fakeStore(),
        DEFINITION,
        ownWorker
      )
    ).resolves.toEqual({ state: 'clear' })

    await expect(
      inspectHostedReviewSitterContention(
        fakeRuntime({ hostIds: ['local'], omittedHostIds: [] }, false, {
          terminals: [terminal],
          agentStatus: { isRunningAgent: true, status: 'idle' },
          dispatchId: 'dispatch-foreign'
        }),
        fakeStore(),
        DEFINITION,
        ownWorker
      )
    ).resolves.toEqual({ state: 'foreign-agent', sessionId: terminal.handle })
  })
})
