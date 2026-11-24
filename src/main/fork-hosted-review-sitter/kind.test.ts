import { describe, expect, it, vi } from 'vitest'
import type { ExecuteContext, PreflightContext } from '../../shared/fork-heimdall/kind-contract'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  buildMergeAction,
  hostedReviewAttemptFingerprint,
  actionWritesWorktree,
  type HostedReviewSitterAction,
  type HostedReviewSitterContention,
  type HostedReviewSnapshot,
  type HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { HostedReviewSitterGitExecution } from './provider'
import { resolveHostedReviewSitterOutcome } from './service-action-executor'
import type { HostedReviewWorkerDispatch } from './agent-preparation'
import { createHostedReviewKind, registerHostedReviewKind, type HostedReviewKind } from './kind'
import type { WatcherRunner } from '../fork-heimdall/runner-state'
import { WatcherRunnerStopLifecycle } from '../fork-heimdall/runner-stop-lifecycle'
import type { WatcherRunnerStatusLifecycle } from '../fork-heimdall/runner-status'

const { inspectContention, launchFix } = vi.hoisted(() => ({
  inspectContention: vi.fn<() => Promise<HostedReviewSitterContention>>(),
  launchFix: vi.fn()
}))
vi.mock('./contention', () => ({
  inspectHostedReviewSitterContention: inspectContention
}))
vi.mock('./agent', () => ({
  launchHostedReviewSitterFixAgent: launchFix
}))

const definition = {
  repoId: 'repo-1',
  worktreeId: 'repo-1::/work/repo',
  repoPath: '/work/repo',
  branch: 'feature',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  capabilities: { updateBranch: 'on', resolveConflicts: 'gated', fixChecks: 'on', merge: 'gated' },
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash',
  mergeCheckScope: 'required'
} as const

const review = {
  provider: 'github',
  reviewNumber: 42,
  url: definition.reviewUrl,
  lifecycle: 'open',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  draft: false,
  checks: [],
  checksComplete: true,
  providerReadiness: { verdict: 'ready', blockers: [] },
  behindBase: false,
  conflicts: 'none',
  queue: { required: false, membership: 'not-enqueued' },
  defaultMergeMethod: 'squash'
} as const

const snapshot: Snapshot<HostedReviewWorld> = {
  freshness: 'live',
  contentIdentity: JSON.stringify([review.headSha, review.baseSha]),
  observedAtMs: 1,
  world: { review, definition, preparedCommit: null }
}

function fakeStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of Store; only the members this suite reaches are stubbed.
  return {
    getRepo: () => ({ id: 'repo-1' }),
    getSettings: () => ({
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      sourceControlAi: undefined,
      commitMessageAi: undefined
    })
  } as unknown as Store
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of QuirkyRuntimeService; only launchAgentTerminal is reached by kind.execute in this suite.
const runtime = { launchAgentTerminal: vi.fn() } as unknown as QuirkyRuntimeService

function attemptLedger(
  action: HostedReviewSitterAction,
  state: 'running' | 'settled',
  effect?: 'landed' | 'not-landed' | 'indeterminate'
): WatcherLedger {
  return {
    watcherId: 'watcher-1',
    entries: [
      {
        eventId: `attempt-${state}-${effect ?? 'pending'}`,
        watcherId: 'watcher-1',
        atMs: 1,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'attempt-1',
        fingerprint: hostedReviewAttemptFingerprint(action),
        action,
        state,
        ...(effect === undefined ? {} : { effect })
      }
    ]
  }
}

// Only `kind` (and `mode` for update-branch) drive the gating/preflight paths these fixtures exercise.
function fakeAction(
  kind: HostedReviewSitterAction['kind'],
  overrides: Record<string, unknown> = {}
): HostedReviewSitterAction {
  const base = {
    kind,
    capability: 'fixChecks',
    visibility: 'external',
    contentIdentity: snapshot.contentIdentity,
    evidenceKey: 'evidence',
    headSha: review.headSha,
    reviewUrl: definition.reviewUrl,
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture; gating.ts and hostedReviewPreflight only read `kind` (and `mode` for update-branch) from these actions.
  return base as HostedReviewSitterAction
}

// kind.ts's own preflight implementation takes no context argument; this only satisfies the type.
function fakePreflightContext(): PreflightContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: never read by kind.preflight, which ignores its fourth argument.
  return { enrollment: {} } as PreflightContext
}

function fakeGit(
  overrides: Partial<HostedReviewSitterGitExecution>
): HostedReviewSitterGitExecution {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double; each scenario only exercises the git methods it overrides.
  return overrides as HostedReviewSitterGitExecution
}

describe('hosted review kind', () => {
  it('registers identity, stop predicates, and the payload schema', () => {
    let registered: HostedReviewKind | undefined
    registerHostedReviewKind({ registerKind: (kind) => (registered = kind) }, runtime, fakeStore())

    expect(registered?.id).toBe('hosted-review')
    expect(registered?.displayName).toBe('Hosted review')
    expect(registered?.stopPredicates?.map((predicate) => predicate.id)).toEqual([
      'hosted-review-lifecycle-closed',
      'repeated-failure-after-own-fix',
      'unverifiable-reproduced-failure'
    ])
    expect(
      registered?.enrollmentPayloadSchema.safeParse({
        branch: 'feature',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: definition.reviewUrl,
        branchUpdateMode: 'merge-base-update',
        mergeMethod: 'squash'
      }).success
    ).toBe(true)
  })

  it.each(['merged', 'closed'] as const)(
    'defers a %s lifecycle terminal until attempts are settled',
    async (lifecycle) => {
      const kind = createHostedReviewKind(runtime, fakeStore())
      const action = buildMergeAction(review, definition)
      if (!action) {
        throw new Error('Expected merge action')
      }
      const terminalSnapshot: Snapshot<HostedReviewWorld> = {
        ...snapshot,
        world: { ...snapshot.world, review: { ...review, lifecycle } }
      }
      const terminal = vi.fn()
      const assertHeld = vi.fn(async () => undefined)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of WatcherRunner; only kind and leaseGuard are reached by stopLifecycle.evaluate.
      const runner = {
        kind,
        leaseGuard: {
          epoch: 1,
          holder: 'test-holder',
          assertHeld,
          renewLoop: () => ({ dispose: () => undefined })
        }
      } as unknown as WatcherRunner
      const stopLifecycle = new WatcherRunnerStopLifecycle(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of WatcherRunnerStatusLifecycle; only terminal and park are reached.
        {
          terminal,
          park: vi.fn()
        } as unknown as WatcherRunnerStatusLifecycle
      )

      await expect(
        stopLifecycle.evaluate(runner, terminalSnapshot, attemptLedger(action, 'running'))
      ).resolves.toBe('deferred')
      await expect(
        stopLifecycle.evaluate(
          runner,
          terminalSnapshot,
          attemptLedger(action, 'settled', 'indeterminate')
        )
      ).resolves.toBe('deferred')
      expect(assertHeld).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()

      const settledEffect = lifecycle === 'merged' ? 'landed' : 'not-landed'
      await expect(
        stopLifecycle.evaluate(
          runner,
          terminalSnapshot,
          attemptLedger(action, 'settled', settledEffect)
        )
      ).resolves.toBe('terminal')
      expect(assertHeld).toHaveBeenCalledOnce()
      expect(terminal).toHaveBeenCalledWith(runner, {
        predicateId: 'hosted-review-lifecycle-closed',
        disposition: 'terminal',
        reason: `review ${lifecycle}`,
        detail: review.headSha
      })
    }
  )

  it.each([
    [{ state: 'clear' }, { verdict: 'allow' }],
    [
      { state: 'dirty', reason: 'local-changes' },
      { verdict: 'hold', reason: 'local-changes' }
    ],
    [
      { state: 'foreign-agent', sessionId: 't-1' },
      { verdict: 'hold', reason: 'foreign-agent' }
    ],
    [
      { state: 'sitter-fix-agent', actionId: 'a-1' },
      { verdict: 'hold', reason: 'action-in-flight' }
    ],
    [
      { state: 'unverifiable', reason: 'git-unreachable' },
      { verdict: 'hold', reason: 'contention-unverifiable' }
    ],
    [
      { state: 'abandoned-sitter-fix', actionId: 'old' },
      { verdict: 'escalate', reason: 'abandoned-fix' }
    ]
  ] as const)('maps contention %j through kind preflight', async (contention, verdict) => {
    inspectContention.mockResolvedValueOnce(contention)
    const action = fakeAction('prepare-fix')
    const kind = createHostedReviewKind(runtime, fakeStore())
    await expect(
      kind.preflight!(
        action,
        snapshot,
        { watcherId: 'watcher-1', entries: [] },
        fakePreflightContext()
      )
    ).resolves.toEqual(verdict)
  })

  it('passes the preparation attempt dispatch identity into publication contention', async () => {
    inspectContention.mockClear()
    inspectContention.mockResolvedValueOnce({ state: 'clear' })
    const preparation = {
      kind: 'prepare-fix',
      capability: 'fixChecks',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: 'prepare:test',
      headSha: review.headSha,
      reviewUrl: definition.reviewUrl,
      checkKey: 'test',
      checkIds: ['check-1'],
      observationIds: ['observation-1'],
      failureSignature: 'failure:test',
      evidence: 'fresh-rerun'
    } as const satisfies HostedReviewSitterAction
    const previous = attemptLedger(preparation, 'settled', 'landed')
    const previousAttempt = previous.entries[0]
    if (previousAttempt?.kind !== 'attempt') {
      throw new Error('Expected preparation attempt')
    }
    const ledger: WatcherLedger = {
      ...previous,
      entries: [{ ...previousAttempt, dispatchId: 'dispatch-1' }]
    }
    const publication = {
      kind: 'publish-fix',
      capability: 'fixChecks',
      visibility: 'external',
      contentIdentity: preparation.contentIdentity,
      evidenceKey: 'publish:test',
      expectedState: { target: definition.reviewUrl, before: review.headSha },
      headSha: review.headSha,
      reviewUrl: definition.reviewUrl,
      checkKey: 'test',
      failureSignature: 'failure:test',
      preparationActionId: 'attempt-1',
      preparedCommitSha: 'c'.repeat(40)
    } as const satisfies HostedReviewSitterAction
    const kind = createHostedReviewKind(runtime, fakeStore())

    await expect(
      kind.preflight!(publication, snapshot, ledger, fakePreflightContext())
    ).resolves.toEqual({
      verdict: 'allow'
    })
    expect(inspectContention).toHaveBeenCalledWith(runtime, expect.anything(), definition, {
      attemptId: 'attempt-1',
      dispatchId: 'dispatch-1'
    })
  })

  it('marks only local worktree mutations as contention-sensitive', async () => {
    expect(actionWritesWorktree(fakeAction('prepare-fix'), definition)).toBe(true)
    expect(actionWritesWorktree(fakeAction('prepare-conflict-resolution'), definition)).toBe(true)
    expect(actionWritesWorktree(fakeAction('publish-fix'), definition)).toBe(true)
    expect(actionWritesWorktree(fakeAction('publish-conflict-resolution'), definition)).toBe(true)
    expect(
      actionWritesWorktree(fakeAction('update-branch', { mode: 'merge-base-update' }), definition)
    ).toBe(false)
    expect(actionWritesWorktree(fakeAction('update-branch', { mode: 'rebase' }), definition)).toBe(
      true
    )
    expect(
      actionWritesWorktree(fakeAction('update-branch', { mode: 'merge-base-update' }), {
        ...definition,
        provider: 'gitlab'
      })
    ).toBe(true)
    expect(actionWritesWorktree(fakeAction('rerun-check'), definition)).toBe(false)
    expect(actionWritesWorktree(fakeAction('merge'), definition)).toBe(false)
    inspectContention.mockClear()
    const kind = createHostedReviewKind(runtime, fakeStore())
    await expect(
      kind.preflight!(
        fakeAction('rerun-check'),
        snapshot,
        { watcherId: 'watcher-1', entries: [] },
        fakePreflightContext()
      )
    ).resolves.toEqual({ verdict: 'allow' })
    expect(inspectContention).not.toHaveBeenCalled()
  })

  it('dispatches autonomous preparation through the fenced worker capability only', async () => {
    const kind = createHostedReviewKind(runtime, fakeStore())
    const dispatchWorker = vi.fn(async (_request: HostedReviewWorkerDispatch) => ({
      status: 'dispatched' as const,
      dispatchId: 'd-1'
    }))
    const action: HostedReviewSitterAction = {
      kind: 'prepare-fix',
      capability: 'fixChecks',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: 'failure:test',
      headSha: review.headSha,
      reviewUrl: definition.reviewUrl,
      checkKey: 'test',
      checkIds: ['check-1'],
      observationIds: ['observation-1'],
      failureSignature: 'failure:test',
      evidence: 'fresh-rerun'
    }
    const context: ExecuteContext<HostedReviewWorld> = {
      snapshot,
      ledger: { watcherId: 'watcher-1', entries: [] },
      lease: {
        epoch: 1,
        holder: 'test-holder',
        assertHeld: vi.fn(async () => undefined),
        renewLoop: () => ({ dispose: () => undefined })
      },
      dispatchWorker
    }

    await expect(kind.execute(action, context)).resolves.toMatchObject({ effect: 'landed' })
    expect(dispatchWorker).toHaveBeenCalledOnce()
    const request = dispatchWorker.mock.calls[0]![0]
    expect(request.spec).toContain('Quirky-Heimdall-Attempt:')
    expect(request.spec.toLowerCase()).toContain('local commit')
    expect(request.spec.toLowerCase()).toContain('do not push')
    expect(launchFix).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('recovers authoritative effects while stale asynchronous reads remain indeterminate', async () => {
    const merge = buildMergeAction(review, definition)
    if (!merge || merge.kind !== 'merge') {
      throw new Error('Expected direct merge action')
    }
    const preparedCommitSha = 'c'.repeat(40)
    const actions: {
      name: string
      action: HostedReviewSitterAction
      expectedAfter: string
      landedReview: HostedReviewSnapshot
      unchangedEffect: 'not-landed' | 'indeterminate'
    }[] = [
      {
        name: 'merge',
        action: merge,
        expectedAfter: `merged:${review.headSha}`,
        landedReview: { ...review, lifecycle: 'merged' },
        unchangedEffect: 'not-landed'
      },
      {
        name: 'rerun',
        action: {
          kind: 'rerun-check',
          capability: 'fixChecks',
          visibility: 'external',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: 'rerun:test',
          expectedState: { target: `${definition.reviewUrl}#check:test`, before: review.headSha },
          headSha: review.headSha,
          reviewUrl: definition.reviewUrl,
          checkKey: 'test',
          checkIds: ['check-1'],
          observationIds: ['observation-old'],
          failureSignature: 'failure:test'
        },
        expectedAfter: 'rerun-observed:rerun:test',
        landedReview: {
          ...review,
          checks: [
            {
              checkKey: 'test',
              checkId: 'check-1',
              name: 'test',
              required: true,
              headSha: review.headSha,
              state: 'pending',
              observationId: 'observation-new',
              failureSignature: null
            }
          ]
        },
        unchangedEffect: 'indeterminate'
      },
      {
        name: 'enqueue',
        action: {
          kind: 'enqueue',
          capability: 'merge',
          visibility: 'external',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: 'enqueue:test',
          expectedState: { target: definition.reviewUrl, before: review.headSha },
          headSha: review.headSha,
          reviewUrl: definition.reviewUrl,
          checkScope: 'required'
        },
        expectedAfter: `enqueued:${review.headSha}`,
        landedReview: {
          ...review,
          queue: { required: true, membership: 'enqueued' }
        },
        unchangedEffect: 'indeterminate'
      },
      {
        name: 'update',
        action: {
          kind: 'update-branch',
          capability: 'updateBranch',
          visibility: 'external',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: 'update:test',
          expectedState: { target: `refs/heads/${definition.branch}`, before: review.headSha },
          headSha: review.headSha,
          reviewUrl: definition.reviewUrl,
          baseSha: review.baseSha,
          mode: 'merge-base-update'
        },
        expectedAfter: `updated:${review.headSha}:${review.baseSha}`,
        landedReview: { ...review, headSha: 'd'.repeat(40), behindBase: false },
        unchangedEffect: 'not-landed'
      },
      {
        name: 'publish-fix',
        action: {
          kind: 'publish-fix',
          capability: 'fixChecks',
          visibility: 'external',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: 'publish-fix:test',
          expectedState: { target: definition.reviewUrl, before: review.headSha },
          headSha: review.headSha,
          reviewUrl: definition.reviewUrl,
          checkKey: 'test',
          failureSignature: 'failure:test',
          preparationActionId: 'prepare-fix-1',
          preparedCommitSha
        },
        expectedAfter: preparedCommitSha,
        landedReview: { ...review, headSha: preparedCommitSha },
        unchangedEffect: 'not-landed'
      },
      {
        name: 'publish-conflict-resolution',
        action: {
          kind: 'publish-conflict-resolution',
          capability: 'resolveConflicts',
          visibility: 'external',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: 'publish-conflict:test',
          expectedState: { target: definition.reviewUrl, before: review.headSha },
          headSha: review.headSha,
          reviewUrl: definition.reviewUrl,
          baseSha: review.baseSha,
          preparationActionId: 'prepare-conflict-1',
          preparedCommitSha
        },
        expectedAfter: preparedCommitSha,
        landedReview: { ...review, headSha: preparedCommitSha },
        unchangedEffect: 'not-landed'
      }
    ]
    const kind = createHostedReviewKind(runtime, fakeStore())

    for (const scenario of actions) {
      const expectation = kind.attemptExpectation?.(scenario.action, snapshot)
      expect(expectation, scenario.name).toEqual({
        expectedBefore: review.headSha,
        expectedAfter: scenario.expectedAfter
      })
      if (!expectation) {
        throw new Error(`Missing recovery expectation for ${scenario.name}`)
      }
      const attempt: AttemptEntry = {
        eventId: `attempt-${scenario.name}`,
        watcherId: 'watcher-1',
        atMs: 1,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: `attempt-${scenario.name}`,
        fingerprint: hostedReviewAttemptFingerprint(scenario.action),
        action: scenario.action,
        state: 'attempted',
        ...expectation
      }
      const landedSnapshot: LiveSnapshot<HostedReviewWorld> = {
        ...snapshot,
        freshness: 'live',
        world: { ...snapshot.world, review: scenario.landedReview }
      }
      const unchangedSnapshot: LiveSnapshot<HostedReviewWorld> = {
        ...snapshot,
        freshness: 'live'
      }
      const landedGit = fakeGit({
        remoteHeadSha: async () => scenario.landedReview.headSha,
        currentHeadSha: async () => scenario.landedReview.headSha
      })
      const unchangedGit = fakeGit({
        remoteHeadSha: async () => review.headSha
      })
      const needsGit =
        scenario.action.kind === 'publish-fix' ||
        scenario.action.kind === 'publish-conflict-resolution' ||
        scenario.action.kind === 'update-branch'

      expect(
        await resolveHostedReviewSitterOutcome(
          attempt,
          landedSnapshot,
          needsGit ? landedGit : undefined
        )
      ).toBe('landed')
      expect(
        await resolveHostedReviewSitterOutcome(
          attempt,
          unchangedSnapshot,
          needsGit ? unchangedGit : undefined
        )
      ).toBe(scenario.unchangedEffect)
      if (needsGit) {
        const unavailableGit = fakeGit({
          remoteHeadSha: async () => {
            throw new Error('execution host unavailable')
          }
        })
        expect(
          await resolveHostedReviewSitterOutcome(attempt, landedSnapshot, unavailableGit)
        ).toBe('indeterminate')
      }
      if (scenario.action.kind === 'update-branch') {
        const hostedHead = 'e'.repeat(40)
        const hostedSnapshot: LiveSnapshot<HostedReviewWorld> = {
          ...snapshot,
          freshness: 'live',
          world: {
            ...snapshot.world,
            review: { ...review, headSha: hostedHead, behindBase: false }
          }
        }
        const hostedGit = fakeGit({
          remoteHeadSha: async () => hostedHead,
          currentHeadSha: async () => review.headSha,
          commitParents: async () =>
            [scenario.action.headSha, scenario.action.baseSha].filter(
              (sha): sha is string => typeof sha === 'string'
            )
        })
        expect(await resolveHostedReviewSitterOutcome(attempt, hostedSnapshot, hostedGit)).toBe(
          'landed'
        )

        const foreignGit = fakeGit({
          ...hostedGit,
          commitParents: async () =>
            ['f'.repeat(40), scenario.action.baseSha].filter(
              (sha): sha is string => typeof sha === 'string'
            )
        })
        expect(await resolveHostedReviewSitterOutcome(attempt, hostedSnapshot, foreignGit)).toBe(
          'indeterminate'
        )
      }
    }
  })
})
