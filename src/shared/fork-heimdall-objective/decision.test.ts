import { describe, expect, it } from 'vitest'
import { decideObjective } from './decision'
import { decideObjectiveChecks } from './decide-review'
import {
  attempt,
  CONTRACT,
  ledger,
  node,
  projection,
  revision,
  snapshot,
  WORKER_EXITED_WITHOUT_COMPLETION,
  workerDone,
  workerHeartbeat
} from './decision-test-harness'
import { projectObjectiveReports } from './decision-context'
import type { ObjectiveAction } from './objective-actions'

describe('objective deterministic phase flow', () => {
  it('dispatches the initial planner with a stable revision evidence key', () => {
    const decision = decideObjective(snapshot(projection({ revisions: [], nodes: [] })), ledger())
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:1',
      revisionNumber: 1,
      reason: 'initial',
      contentIdentity: 'content-current'
    })
  })

  it('activates a draft before dispatching implementation', () => {
    const draft = revision({ status: 'draft', approvedAtMs: null })
    expect(
      decideObjective(snapshot(projection({ revisions: [draft], nodes: [] })), ledger()).action
    ).toMatchObject({
      kind: 'activate-plan',
      evidenceKey: 'revision-1',
      recovery: 'replay-safe'
    })
  })

  it('activates a newer replan draft even while the prior revision remains approved', () => {
    const replanDraft = revision({
      id: 'revision-2',
      number: 2,
      status: 'draft',
      digest: 'replan-digest',
      createdByDispatchId: 'planner-dispatch-2',
      approvedAtMs: null
    })
    const plan = projection({
      revisions: [revision(), replanDraft],
      nodes: [node('core', { state: 'failed' })]
    })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'activate-plan',
      revisionId: 'revision-2',
      digest: 'replan-digest'
    })
  })

  it('dispatches the first ready node with completed dependency orchestration ids', () => {
    const plan = projection({
      nodes: [
        node('base', {
          state: 'succeeded',
          orchestrationTaskId: 'orchestration-base',
          dispatchId: 'dispatch-base'
        }),
        node('dependent', { deps: ['base'] })
      ]
    })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'dependent',
      evidenceKey: 'revision-1:dependent',
      depsOrchestrationIds: ['orchestration-base']
    })
  })

  it('repairs the approved revision after a failed node instead of retrying it', () => {
    const plan = projection({ nodes: [node('core', { state: 'failed', dispatchId: 'failed' })] })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:1',
      revisionNumber: 1,
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      repairOrdinal: 1,
      reason: 'replan-after-failure'
    })
  })

  it('does not duplicate a node dispatch when workspace content moves', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-before-worker',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const decision = decideObjective(
      snapshot(projection(), {}, 'content-after-worker-edit'),
      ledger([attempt(dispatch, { dispatchId: 'dispatch-core' })])
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'node-in-flight' })
  })

  it('honors a resolution fact over a stale running attempt revision', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const decision = decideObjective(
      snapshot(projection()),
      ledger([
        attempt(dispatch, { dispatchId: 'dispatch-core' }),
        {
          kind: 'attempt-resolved',
          eventId: 'event-resolution',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          attemptId: 'attempt-dispatch-core',
          effect: 'not-landed',
          evidence: { reason: 'worker failed' }
        }
      ])
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:1',
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
  })

  it('repairs after a reportless worker death resolves as not landed', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const running = attempt(dispatch, { dispatchId: 'dispatch-core', atMs: 30 })
    const settled = attempt(dispatch, {
      state: 'settled',
      effect: 'indeterminate',
      reason: WORKER_EXITED_WITHOUT_COMPLETION,
      dispatchId: 'dispatch-core',
      atMs: 35
    })
    const decision = decideObjective(
      snapshot(projection()),
      ledger([
        running,
        settled,
        {
          kind: 'attempt-resolved',
          eventId: 'event-worker-death-resolution',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          attemptId: settled.attemptId,
          effect: 'not-landed',
          evidence: { reason: WORKER_EXITED_WITHOUT_COMPLETION }
        }
      ])
    )

    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:1',
      revisionNumber: 1,
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
  })

  it('repairs after a settled worker omits its required report', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const decision = decideObjective(
      snapshot(projection()),
      ledger([
        attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-core' })
      ])
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:1',
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
  })

  it('ingests a completed report at current content while retaining dispatch identity', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-before-worker',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(
      snapshot(plan, {}, 'content-after-worker-edit'),
      ledger([
        attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-core' }),
        workerHeartbeat('dispatch-core'),
        workerDone('dispatch-core')
      ])
    )
    expect(decision.action).toMatchObject({
      kind: 'ingest-report',
      dispatchId: 'dispatch-core',
      orchestrationTaskId: 'first-task-dispatch-core',
      contentIdentity: 'content-after-worker-edit',
      dispatchedContentIdentity: 'content-before-worker',
      recovery: 'replay-safe'
    })
  })

  it('treats a check failure at current identity as a replan boundary', () => {
    const checked = node('core', {
      state: 'succeeded',
      criteria: [
        {
          id: 'criterion-1',
          ordinal: 0,
          body: 'The focused check passes.',
          shellCheckable: true,
          checkCommand: 'pnpm check',
          lastCheck: { contentIdentity: 'content-current', exitCode: 1, timedOut: false, atMs: 50 },
          lastReview: null
        }
      ]
    })
    expect(
      decideObjective(snapshot(projection({ nodes: [checked] })), ledger()).action
    ).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:1',
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
  })
})

describe('objective checks hold for read-only workers and stale evidence', () => {
  const unchecked = node('core', {
    state: 'succeeded',
    criteria: [
      {
        id: 'criterion-1',
        ordinal: 0,
        body: 'The focused check passes.',
        shellCheckable: true,
        checkCommand: 'pnpm check',
        lastCheck: null,
        lastReview: null
      }
    ]
  })
  const staleCheck = (evidenceKey: string, dispatchId: string) => {
    const action: ObjectiveAction = {
      kind: 'run-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey,
      criterionId: 'criterion-1',
      command: 'pnpm check'
    }
    return {
      attempt: attempt(action, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'check-evidence-stale',
        dispatchId
      }),
      action
    }
  }

  it('holds checks while a read-only worker is in flight', () => {
    const planReview: ObjectiveAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:plan-digest:plan-review:1',
      target: { kind: 'revision', revisionId: 'revision-1' },
      round: 1
    }
    const decision = decideObjectiveChecks(
      snapshot(projection({ nodes: [unchecked] })),
      ledger(),
      [
        { attempt: attempt(planReview, { dispatchId: 'plan-review-dispatch' }), action: planReview }
      ],
      [],
      revision()
    )
    expect(decision).toMatchObject({ action: null, reason: 'read-only-worker-in-flight' })
  })

  it('re-issues a stale check with a distinct suffixed evidence key', () => {
    const decision = decideObjectiveChecks(
      snapshot(projection({ nodes: [unchecked] })),
      ledger(),
      [staleCheck('criterion-1:content-current', 'stale-0')],
      [],
      revision()
    )
    expect(decision?.action).toMatchObject({
      kind: 'run-check',
      criterionId: 'criterion-1',
      evidenceKey: 'criterion-1:content-current#stale-1'
    })
  })

  it('falls through to the ordinary failure path once stale retries reach the cap', () => {
    const decision = decideObjectiveChecks(
      snapshot(projection({ nodes: [unchecked] })),
      ledger(),
      [
        staleCheck('criterion-1:content-current', 'stale-0'),
        staleCheck('criterion-1:content-current#stale-1', 'stale-1'),
        staleCheck('criterion-1:content-current#stale-2', 'stale-2')
      ],
      [],
      revision()
    )
    expect(decision).toMatchObject({
      action: { kind: 'dispatch-planner', plannerMode: 'repair', reason: 'replan-after-failure' }
    })
  })
})

describe('objective tier review policy', () => {
  const implemented = projection({ nodes: [node('core', { state: 'succeeded' })] })

  it('express skips review and records files on disk', () => {
    const decision = decideObjective(
      snapshot(implemented, { contract: { ...CONTRACT, tier: 'express' } }),
      ledger()
    )
    expect(decision.action).toMatchObject({
      kind: 'record-landing',
      evidenceKey: 'files-on-disk:content-current',
      recovery: 'replay-safe'
    })
  })

  it('standard dispatches the reviewer before landing', () => {
    expect(decideObjective(snapshot(implemented), ledger()).action).toMatchObject({
      kind: 'dispatch-reviewer',
      evidenceKey: 'revision-1:plan-digest:review:content-current'
    })
  })

  it('does not duplicate an in-flight reviewer when content moves', () => {
    const reviewDispatch: ObjectiveAction = {
      kind: 'dispatch-reviewer',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-before-review',
      evidenceKey: 'revision-1:plan-digest:review:content-before-review',
      revisionId: 'revision-1'
    }
    const decision = decideObjective(
      snapshot(implemented, {}, 'content-after-human-edit'),
      ledger([attempt(reviewDispatch, { dispatchId: 'review-dispatch' })])
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'review-in-flight' })
  })

  it('full dispatches the integrator only after a current reviewer approval', () => {
    const reviewed = projection({
      nodes: [node('core', { state: 'succeeded' })],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'review-digest',
          atMs: 50
        }
      ]
    })
    const decision = decideObjective(
      snapshot(reviewed, { contract: { ...CONTRACT, tier: 'full' } }),
      ledger()
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-integrator',
      evidenceKey: 'revision-1:plan-digest:review:content-current'
    })
  })

  it('full lands only after both reviewer and integrator approve current content', () => {
    const fullyReviewed = projection({
      nodes: [node('core', { state: 'succeeded' })],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'review-digest',
          atMs: 50
        },
        {
          dispatchId: 'integrator-dispatch',
          revisionId: 'revision-1',
          role: 'integrator',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'integrator-digest',
          atMs: 60
        }
      ]
    })
    expect(
      decideObjective(
        snapshot(fullyReviewed, { contract: { ...CONTRACT, tier: 'full' } }),
        ledger()
      ).action
    ).toMatchObject({ kind: 'record-landing', revisionId: 'revision-1' })
  })

  it('replans after a current blocking review', () => {
    const blocked = projection({
      nodes: [node('core', { state: 'succeeded' })],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'block',
          contentIdentity: 'content-current',
          reportDigest: 'review-digest',
          atMs: 50
        }
      ]
    })
    expect(decideObjective(snapshot(blocked), ledger()).action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan-repair:revision-1:1',
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-block'
    })
  })
})

describe('objective landing ladder decisions', () => {
  it('emits a deterministic commit action after files-on-disk', () => {
    const decision = decideObjective(
      snapshot(
        projection({
          landing: [
            {
              rung: 'files-on-disk',
              revisionId: 'revision-1',
              contentIdentity: 'content-current',
              atMs: 50
            }
          ]
        }),
        { contract: { ...CONTRACT, landingBar: 'committed-local-branch' } }
      ),
      ledger()
    )
    expect(decision.action).toEqual({
      kind: 'commit-local-branch',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'committed-local-branch:content-current',
      rung: 'committed-local-branch',
      revisionId: 'revision-1',
      branch: 'feature/objective',
      headSha: 'head-current',
      worktreeContentDigest: 'worktree-digest',
      fromContentIdentity: 'content-current',
      attemptTrailer: 'committed-local-branch:content-current'
    })
  })

  it('emits push with the exact observed remote state while retaining pre-commit lineage', () => {
    const committed = projection({
      nodes: [
        node('core', {
          state: 'succeeded',
          criteria: [
            {
              id: 'criterion-1',
              ordinal: 0,
              body: 'The focused check passes.',
              shellCheckable: true,
              checkCommand: 'pnpm check',
              lastCheck: {
                contentIdentity: 'checked-content',
                exitCode: 0,
                timedOut: false,
                atMs: 40
              },
              lastReview: 'pass'
            }
          ]
        })
      ],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'checked-content',
          reportDigest: 'review-digest',
          atMs: 45
        }
      ],
      landing: [
        {
          rung: 'files-on-disk',
          revisionId: 'revision-1',
          contentIdentity: 'checked-content',
          atMs: 50
        },
        {
          rung: 'committed-local-branch',
          revisionId: 'revision-1',
          contentIdentity: 'committed-content',
          fromContentIdentity: 'checked-content',
          branch: 'feature/objective',
          commitSha: 'commit-1',
          atMs: 60
        }
      ]
    })
    const decision = decideObjective(
      snapshot(
        committed,
        {
          contract: { ...CONTRACT, landingBar: 'pushed-ref' },
          landingContext: {
            branch: 'feature/objective',
            headSha: 'commit-1',
            worktreeContentDigest: 'worktree-digest',
            pushTarget: {
              remote: 'upstream',
              branch: 'review/objective',
              remoteSha: 'remote-before'
            },
            hostedReview: { provider: 'github', repoKey: 'repo-1', base: 'main' }
          }
        },
        'committed-content'
      ),
      ledger()
    )
    expect(decision.action).toEqual({
      kind: 'push-ref',
      capability: 'land',
      visibility: 'external',
      contentIdentity: 'committed-content',
      evidenceKey: 'pushed-ref:commit-1:upstream/review/objective:remote-before',
      rung: 'pushed-ref',
      revisionId: 'revision-1',
      branch: 'review/objective',
      remote: 'upstream',
      commitSha: 'commit-1',
      expectedState: {
        target: 'upstream/review/objective',
        before: 'remote-before'
      }
    })
  })

  it('emits review creation after push and stops merged objectives at hosted review', () => {
    const pushed = projection({
      landing: [
        {
          rung: 'pushed-ref',
          revisionId: 'revision-1',
          contentIdentity: 'committed-content',
          fromContentIdentity: 'committed-content',
          remote: 'origin',
          branch: 'feature/objective',
          commitSha: 'commit-1',
          remoteSha: 'commit-1',
          atMs: 70
        }
      ]
    })
    const reviewDecision = decideObjective(
      snapshot(pushed, { contract: { ...CONTRACT, landingBar: 'merged' } }, 'committed-content'),
      ledger()
    )
    expect(reviewDecision.action).toEqual({
      kind: 'open-hosted-review',
      capability: 'land',
      visibility: 'external',
      contentIdentity: 'committed-content',
      evidenceKey: 'hosted-review:github:feature/objective:commit-1',
      rung: 'hosted-review',
      revisionId: 'revision-1',
      branch: 'feature/objective',
      base: 'main',
      headSha: 'commit-1',
      provider: 'github',
      expectedState: {
        target: 'github:repo-1:feature/objective',
        before: 'no-review'
      }
    })

    const hosted = projection({
      landing: [
        ...pushed.landing,
        {
          rung: 'hosted-review',
          revisionId: 'revision-1',
          contentIdentity: 'committed-content',
          fromContentIdentity: 'committed-content',
          provider: 'github',
          reviewNumber: 42,
          reviewUrl: 'https://github.com/acme/repo/pull/42',
          branch: 'feature/objective',
          headSha: 'commit-1',
          base: 'main',
          atMs: 80
        }
      ]
    })
    expect(
      decideObjective(
        snapshot(hosted, { contract: { ...CONTRACT, landingBar: 'merged' } }, 'committed-content'),
        ledger()
      )
    ).toMatchObject({ action: null, reason: 'landed-at-bar', detail: 'merged' })
  })

  it('does not emit commit from detached HEAD or review without a resolved base', () => {
    const files = projection({
      landing: [
        {
          rung: 'files-on-disk',
          revisionId: 'revision-1',
          contentIdentity: 'content-current',
          atMs: 50
        }
      ]
    })
    expect(
      decideObjective(
        snapshot(files, {
          contract: { ...CONTRACT, landingBar: 'committed-local-branch' },
          landingContext: {
            branch: null,
            headSha: null,
            worktreeContentDigest: null,
            pushTarget: null,
            hostedReview: null
          }
        }),
        ledger()
      )
    ).toMatchObject({ action: null, reason: 'branch-not-attached' })

    const pushed = projection({
      landing: [
        {
          rung: 'pushed-ref',
          revisionId: 'revision-1',
          contentIdentity: 'committed-content',
          fromContentIdentity: 'committed-content',
          branch: 'feature/objective',
          commitSha: 'commit-1',
          atMs: 60
        }
      ]
    })
    expect(
      decideObjective(
        snapshot(
          pushed,
          {
            contract: { ...CONTRACT, landingBar: 'hosted-review' },
            landingContext: {
              branch: 'feature/objective',
              headSha: 'commit-1',
              worktreeContentDigest: 'worktree-digest',
              pushTarget: null,
              hostedReview: { provider: 'github', repoKey: 'repo-1', base: null }
            }
          },
          'committed-content'
        ),
        ledger()
      )
    ).toMatchObject({ action: null, reason: 'base-branch-unresolvable' })
  })
})

describe('objective pending report projection', () => {
  const dispatchNode: ObjectiveAction = {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'revision-1:core',
    revisionId: 'revision-1',
    taskKey: 'core',
    depsOrchestrationIds: []
  }

  it('carries the worker mailbox subject and body into the pending report', () => {
    const reports = projectObjectiveReports(
      ledger([
        attempt(dispatchNode, { dispatchId: 'dispatch-core' }),
        {
          kind: 'evidence',
          eventId: 'evidence-dispatch-core',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          evidenceKind: 'orchestration-mailbox',
          payload: {
            type: 'worker_done',
            subject: 'Blocked on missing environment variable',
            body: 'QUIRKY_SANDBOX_DOCKER_HOST was unset so the sandbox never started.',
            payload: {
              dispatchId: 'dispatch-core',
              taskId: 'task-core',
              outcome: 'failed',
              reportPath: '/outside/report.json',
              filesModified: ['src/core.ts']
            }
          }
        }
      ])
    )
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      subject: 'Blocked on missing environment variable',
      body: 'QUIRKY_SANDBOX_DOCKER_HOST was unset so the sandbox never started.'
    })
  })

  it('still parses a pending report when the worker sends no subject or body', () => {
    const reports = projectObjectiveReports(
      ledger([attempt(dispatchNode, { dispatchId: 'dispatch-core' }), workerDone('dispatch-core')])
    )
    expect(reports).toHaveLength(1)
    expect(reports[0].subject).toBeUndefined()
    expect(reports[0].body).toBeUndefined()
  })

  it.each([
    {
      role: 'planner',
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey: 'plan:1',
        revisionNumber: 1,
        reason: 'initial'
      } satisfies ObjectiveAction
    },
    {
      role: 'reviewer',
      action: {
        kind: 'dispatch-reviewer',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey: 'revision-1:review',
        revisionId: 'revision-1'
      } satisfies ObjectiveAction
    }
  ])('treats omitted $role filesModified evidence as a valid empty list', ({ action }) => {
    const dispatchId = `dispatch-${action.kind}`
    const reports = projectObjectiveReports(
      ledger([
        attempt(action, { dispatchId }),
        {
          kind: 'evidence',
          eventId: `evidence-${dispatchId}`,
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          evidenceKind: 'orchestration-mailbox',
          payload: {
            type: 'worker_done',
            payload: {
              dispatchId,
              taskId: `task-${dispatchId}`,
              outcome: 'succeeded',
              reportPath: '/outside/report.json'
            }
          }
        }
      ])
    )
    expect(reports).toMatchObject([{ dispatchId, filesModified: [] }])
    expect(reports[0]?.evidenceIssue).toBeUndefined()
  })

  it('marks malformed filesModified evidence instead of silently projecting it as an empty list', () => {
    const evidence = {
      kind: 'evidence' as const,
      eventId: 'evidence-malformed-files',
      watcherId: 'watcher-1',
      atMs: 40,
      origin: 'owner' as const,
      class: 'fact' as const,
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'worker_done',
        payload: {
          dispatchId: 'dispatch-core',
          taskId: 'task-core',
          outcome: 'succeeded',
          reportPath: '/outside/report.json',
          filesModified: ['src/core.ts', 42]
        }
      }
    }
    const reportLedger = ledger([attempt(dispatchNode, { dispatchId: 'dispatch-core' }), evidence])
    expect(projectObjectiveReports(reportLedger)).toMatchObject([
      {
        dispatchId: 'dispatch-core',
        filesModified: [],
        evidenceIssue: 'files-modified-malformed'
      }
    ])
    expect(
      decideObjective(
        snapshot(projection({ nodes: [node('core', { state: 'dispatched' })] })),
        reportLedger,
        true
      )
    ).toMatchObject({
      action: null,
      deviation: {
        kind: 'report-rejected',
        dispatchId: 'dispatch-core',
        rejectionReason: 'implementer-report-evidence-malformed',
        detail: expect.stringContaining('filesModified must be an array')
      }
    })
  })

  it('keeps a failed task without a report distinct from malformed report evidence', () => {
    const failedTaskLedger = ledger([
      attempt(dispatchNode, {
        dispatchId: 'dispatch-core',
        state: 'settled',
        effect: 'not-landed',
        reason: 'worker failed'
      }),
      {
        kind: 'evidence',
        eventId: 'evidence-failed-task',
        watcherId: 'watcher-1',
        atMs: 40,
        origin: 'owner',
        class: 'fact',
        evidenceKind: 'orchestration-mailbox',
        payload: {
          type: 'worker_done',
          payload: {
            dispatchId: 'dispatch-core',
            taskId: 'task-core',
            outcome: 'failed'
          }
        }
      }
    ])
    expect(projectObjectiveReports(failedTaskLedger)).toMatchObject([
      {
        dispatchId: 'dispatch-core',
        outcome: 'failed',
        reportPath: null,
        filesModified: []
      }
    ])
    expect(projectObjectiveReports(failedTaskLedger)[0]?.evidenceIssue).toBeUndefined()
    expect(
      decideObjective(
        snapshot(projection({ nodes: [node('core', { state: 'dispatched' })] })),
        failedTaskLedger,
        true
      )
    ).toMatchObject({
      action: null,
      deviation: {
        kind: 'node-failed',
        taskKey: 'core',
        summary: 'worker failed'
      }
    })
  })

  it('projects a legacy terminal rejection into the exact owner-facing report rejection', () => {
    const reportLedger = ledger([
      attempt(dispatchNode, { dispatchId: 'dispatch-core' }),
      {
        kind: 'evidence',
        eventId: 'evidence-legacy-rejection',
        watcherId: 'watcher-1',
        atMs: 40,
        origin: 'owner',
        class: 'fact',
        evidenceKind: 'orchestration-mailbox',
        payload: {
          type: 'worker_done',
          payload: {
            dispatchId: 'dispatch-core',
            taskId: 'task-core',
            outcome: 'failed',
            reportPath: '/outside/report.json',
            filesModified: ['src/core.ts'],
            reportRejection: {
              code: 'sender_not_assignee',
              reason: 'The submitting worker is not the authoritative assignee.'
            }
          }
        }
      }
    ])
    expect(projectObjectiveReports(reportLedger)).toMatchObject([
      {
        dispatchId: 'dispatch-core',
        outcome: 'failed',
        reportValidation: {
          status: 'rejected',
          code: 'semantic-invalid',
          sourceCode: 'sender_not_assignee',
          detail: 'The submitting worker is not the authoritative assignee.'
        }
      }
    ])
    expect(
      decideObjective(
        snapshot(projection({ nodes: [node('core', { state: 'dispatched' })] })),
        reportLedger,
        true
      )
    ).toMatchObject({
      action: null,
      deviation: {
        kind: 'report-rejected',
        dispatchId: 'dispatch-core',
        taskKey: 'core',
        rejectionReason: 'sender_not_assignee',
        detail: expect.stringContaining('The submitting worker is not the authoritative assignee.')
      }
    })
  })
})

describe('objective lowered landing bar', () => {
  it('treats an already reached higher rung as landed at the re-armed lower bar', () => {
    const plan = projection({
      landing: [
        {
          rung: 'pushed-ref',
          revisionId: 'revision-1',
          contentIdentity: 'content-current',
          atMs: 80
        }
      ]
    })
    expect(
      decideObjective(
        snapshot(plan, { contract: { ...CONTRACT, landingBar: 'committed-local-branch' } }),
        ledger()
      )
    ).toMatchObject({
      action: null,
      reason: 'landed-at-bar',
      detail: 'committed-local-branch'
    })
  })
})
