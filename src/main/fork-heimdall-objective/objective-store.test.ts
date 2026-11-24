import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReportValidationProvenance } from '../../shared/fork-heimdall/effect-certainty'
import type { ObjectiveLandingBar } from '../../shared/fork-heimdall-objective/contract-types'
import {
  ObjectiveDetailSchema,
  type ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { ReviewerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { decideObjective } from '../../shared/fork-heimdall-objective/decision'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveLandingPayload } from './objective-store-data'
import { ObjectiveStore } from './objective-store'
import { oneRow } from './objective-store-queries'
import {
  action,
  CONTENT_IDENTITY,
  CONTRACT,
  ingest as sharedIngest,
  REPORT,
  settledAttempt,
  WATCHER_ID
} from './objective-store-test-fixtures'

const REVIEW: ReviewerReport = {
  verdict: 'approve',
  criteriaResults: [
    { taskKey: 'task-a', criterionIndex: 0, result: 'pass', note: 'Verified A' },
    { taskKey: 'task-b', criterionIndex: 0, result: 'pass', note: 'Verified B' }
  ],
  summary: 'Everything meets the contract'
}

let database: ObjectiveDatabase
let store: ObjectiveStore
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

function ingest(revisionNumber = 1, dispatchId = `planner-${revisionNumber}`) {
  return sharedIngest(store, revisionNumber, dispatchId)
}

function rowCounts(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const table of [
    'plan_revision',
    'plan_node',
    'acceptance_criterion',
    'check_attempt',
    'review_verdict',
    'landing_evidence'
  ]) {
    const row = oneRow<{ count: number }>(
      database.connection().prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    )
    result[table] = row?.count ?? 0
  }
  return result
}

describe('ObjectiveStore natural-key persistence', () => {
  it('replays every v1 table mutation without duplicating a row', () => {
    const revision = ingest()
    expect(ingest()).toEqual(revision)
    expect(() => ingest(2, 'planner-1')).toThrow(/Planner dispatch natural key/)
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(false)
    const activation = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    }
    const activated = store.activatePlan(activation)
    expect(store.activatePlan({ ...activation, approvedAtMs: 201 })).toEqual(activated)
    expect(store.isPlanActivated(WATCHER_ID, revision.revisionId, revision.digest)).toBe(true)
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(true)
    expect(store.planForDispatch(WATCHER_ID, 'planner-1')).toEqual({
      revisionId: revision.revisionId,
      revisionNumber: 1,
      digest: revision.digest
    })
    const dispatch = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      orchestrationTaskId: 'orchestration-task-a',
      dispatchId: 'implementer-dispatch-a',
      dispatchedAtMs: 300
    }
    expect(store.recordNodeDispatch(dispatch)).toEqual(store.recordNodeDispatch(dispatch))
    const criterionId = store.project(WATCHER_ID).nodes[0].criteria[0].id
    const started = {
      watcherId: WATCHER_ID,
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'execution-host-1',
      command: 'pnpm check:a',
      epoch: 4,
      startedAtMs: 400
    }
    expect(store.startCheckAttempt(started)).toEqual(store.startCheckAttempt(started))
    const completed = {
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'passed',
      stderrTail: '',
      completedAtMs: 450
    }
    expect(store.completeCheckAttempt(completed)).toEqual(store.completeCheckAttempt(completed))
    const verdict = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'review-dispatch-1',
      role: 'reviewer' as const,
      contentIdentity: CONTENT_IDENTITY,
      report: REVIEW,
      reportDigest: 'review-digest-1',
      createdAtMs: 500
    }
    expect(store.recordVerdict(verdict)).toEqual(
      store.recordVerdict({ ...verdict, createdAtMs: 501 })
    )
    expect(() => store.recordVerdict({ ...verdict, reportDigest: 'conflicting-digest' })).toThrow(
      /different content/
    )
    const landing = {
      watcherId: WATCHER_ID,
      rung: 'files-on-disk' as const,
      contentIdentity: CONTENT_IDENTITY,
      attemptFingerprint: 'landing-fingerprint-1',
      payload: { revisionId: revision.revisionId },
      epoch: 4,
      createdAtMs: 600
    }
    const landed = store.recordLanding(landing)
    expect(store.recordLanding({ ...landing, epoch: 5, createdAtMs: 601 })).toEqual(landed)
    expect(() =>
      store.recordLanding({ ...landing, attemptFingerprint: 'conflicting-fingerprint' })
    ).toThrow(/different content/)

    expect(rowCounts()).toEqual({
      plan_revision: 1,
      plan_node: 2,
      acceptance_criterion: 2,
      check_attempt: 1,
      review_verdict: 1,
      landing_evidence: 1
    })
    expect(store.getCheckAttempt(criterionId, CONTENT_IDENTITY)?.completedAtMs).toBe(450)
  })

  it('round-trips every landing rung and rejects a changed rich payload replay', () => {
    const revision = ingest()
    const cases: {
      rung: ObjectiveLandingBar
      payload: ObjectiveLandingPayload
    }[] = [
      {
        rung: 'files-on-disk',
        payload: { revisionId: revision.revisionId }
      },
      {
        rung: 'committed-local-branch',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-before-commit',
          commitSha: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
          branch: 'feature/objective'
        }
      },
      {
        rung: 'pushed-ref',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-after-commit',
          remote: 'origin',
          branch: 'feature/objective',
          commitSha: 'a'.repeat(40),
          remoteSha: 'a'.repeat(40)
        }
      },
      {
        rung: 'hosted-review',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-after-commit',
          provider: 'github',
          reviewNumber: 42,
          reviewUrl: 'https://github.test/acme/repo/pull/42',
          branch: 'feature/objective',
          headSha: 'a'.repeat(40),
          base: 'main'
        }
      },
      {
        rung: 'merged',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-after-commit',
          mergeSha: 'c'.repeat(40)
        }
      }
    ]

    for (const [index, entry] of cases.entries()) {
      const landing = {
        watcherId: WATCHER_ID,
        rung: entry.rung,
        contentIdentity: `content-${entry.rung}`,
        attemptFingerprint: `landing-fingerprint-${entry.rung}`,
        payload: entry.payload,
        epoch: 4,
        createdAtMs: 600 + index
      }
      const recorded = store.recordLanding(landing)
      expect(store.landingRow(WATCHER_ID, entry.rung, landing.contentIdentity)).toEqual(
        entry.payload
      )
      expect(
        store.recordLanding({
          ...landing,
          payload: structuredClone(entry.payload),
          epoch: 99,
          createdAtMs: 9_999
        })
      ).toEqual(recorded)
    }

    expect(() =>
      store.recordLanding({
        watcherId: WATCHER_ID,
        rung: 'committed-local-branch',
        contentIdentity: 'content-committed-local-branch',
        attemptFingerprint: 'landing-fingerprint-committed-local-branch',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-before-commit',
          commitSha: 'd'.repeat(40),
          treeOid: 'b'.repeat(40),
          branch: 'feature/objective'
        },
        epoch: 4,
        createdAtMs: 601
      })
    ).toThrow(/different content/)
  })

  it('projects the check for the requested content identity after workspace reversion', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const criterionId = store.project(WATCHER_ID).nodes[0].criteria[0].id
    for (const [contentIdentity, startedAtMs] of [
      [CONTENT_IDENTITY, 300],
      ['newer-content-identity', 400]
    ] as const) {
      store.startCheckAttempt({
        watcherId: WATCHER_ID,
        criterionId,
        contentIdentity,
        executionHostId: 'execution-host-1',
        command: 'pnpm check:a',
        epoch: 4,
        startedAtMs
      })
      store.completeCheckAttempt({
        criterionId,
        contentIdentity,
        exitCode: 0,
        timedOut: false,
        stdoutTail: 'passed',
        stderrTail: '',
        completedAtMs: startedAtMs + 10
      })
    }

    expect(
      store.project(WATCHER_ID, undefined, CONTENT_IDENTITY).nodes[0].criteria[0].lastCheck
        ?.contentIdentity
    ).toBe(CONTENT_IDENTITY)
    expect(
      store.project(WATCHER_ID, undefined, 'never-checked').nodes[0].criteria[0].lastCheck
    ).toBeNull()
  })

  it('permits only one draft revision per watcher', () => {
    const first = ingest()
    expect(() => ingest(2)).toThrow(/UNIQUE constraint failed/)
    expect(store.project(WATCHER_ID).revisions).toHaveLength(1)

    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: first.revisionId,
      digest: first.digest,
      approvedAtMs: 200
    })
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(true)
    expect(() => ingest(2)).not.toThrow()
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(false)
    expect(store.project(WATCHER_ID).revisions.map(({ status }) => status)).toEqual([
      'approved',
      'draft'
    ])
  })

  it('keeps plan and node bodies out while projecting bounded criterion bodies', () => {
    const revision = ingest()
    const projection = store.project(WATCHER_ID)
    expect(projection.revisions[0]).not.toHaveProperty('payload')
    expect(projection.nodes[0]).not.toHaveProperty('title')
    expect(projection.nodes[0]).not.toHaveProperty('spec')
    expect(projection.nodes[0].criteria[0].body).toBe('Secret acceptance body A')
    expect(JSON.stringify(projection)).not.toContain('Secret node')
    expect(JSON.stringify(projection)).not.toContain('Secret implementer')
    expect(store.getPlan(revision.revisionId)).toEqual(REPORT.plan)
    expect(store.getTask(revision.revisionId, 'task-a')?.spec).toBe(
      'Secret implementer specification A'
    )
    expect(store.getCriterion(projection.nodes[0].criteria[0].id)?.body).toBe(
      'Secret acceptance body A'
    )
  })

  it('refuses malformed persisted JSON instead of returning a partial projection', () => {
    ingest()
    database
      .connection()
      .prepare("UPDATE plan_node SET deps_json = '{}' WHERE task_key = 'task-a'")
      .run()
    expect(() => store.project(WATCHER_ID)).toThrow(/invalid node dependencies/)
  })

  it('maps persisted dispatches and ledger settlements onto node states', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const runningDispatch: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt(
            'running',
            action('dispatch-node', {
              revisionId: revision.revisionId,
              taskKey: 'task-a',
              depsOrchestrationIds: []
            }),
            'landed'
          ),
          state: 'running',
          effect: undefined
        }
      ]
    }
    expect(store.project(WATCHER_ID, runningDispatch).nodes[0].state).toBe('dispatched')
    const ledger: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        settledAttempt(
          'success',
          action('ingest-report', {
            revisionId: revision.revisionId,
            taskKey: 'task-a',
            dispatchId: 'dispatch-task-a'
          }),
          'landed'
        ),
        settledAttempt(
          'failure',
          action('dispatch-node', {
            revisionId: revision.revisionId,
            taskKey: 'task-b'
          }),
          'not-landed'
        )
      ]
    }
    expect(store.project(WATCHER_ID, ledger).nodes.map(({ state }) => state)).toEqual([
      'succeeded',
      'failed'
    ])
  })

  it('keeps a later durably applied dispatch succeeded despite an earlier retryable failure', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const dispatchId = 'dispatch-task-a-d2'
    const record: ObjectiveDispatchRecord = {
      attemptFingerprint: 'fingerprint-dispatch-task-a-d2',
      watcherId: WATCHER_ID,
      executionHostId: 'local',
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      planTaskDigest: 'task-a-digest',
      dispatchId,
      workspaceId: 'worktree-task-a-d2',
      workspacePath: '/workspace/task-a-d2',
      baseCommit: 'base-commit',
      laneTaskKeys: ['task-a'],
      sessionNodeCount: 1,
      state: 'applied',
      commitSha: 'node-commit',
      appliedCommitSha: 'applied-commit',
      reportDigest: 'report-digest',
      conflictPaths: [],
      conflictingTaskKeys: [],
      conflictingDispatchIds: [],
      createdAtMs: 300,
      completedAtMs: 400,
      terminalHandle: null,
      setupState: 'retained',
      reportPath: '.quirky/reports/task-a.json',
      report: {
        taskKey: 'task-a',
        summary: 'Applied the second dispatch',
        filesModified: ['src/task-a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      },
      task: REPORT.plan[0]!
    }
    store.saveDispatch(record)
    store.recordNodeDispatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      orchestrationTaskId: 'orchestration-task-a-d2',
      dispatchId,
      dispatchedAtMs: 400
    })
    const ledger: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt(
            'dispatch-task-a-d1',
            action('dispatch-node', {
              revisionId: revision.revisionId,
              taskKey: 'task-a',
              depsOrchestrationIds: []
            }),
            'not-landed'
          ),
          failureClass: 'infra'
        },
        settledAttempt(
          'dispatch-task-a-d2',
          action('dispatch-node', {
            revisionId: revision.revisionId,
            taskKey: 'task-a',
            depsOrchestrationIds: []
          }),
          'landed'
        ),
        settledAttempt(
          'ingest-task-a-d2',
          action('ingest-report', {
            revisionId: revision.revisionId,
            taskKey: 'task-a',
            dispatchId
          }),
          'landed'
        )
      ]
    }

    expect(store.project(WATCHER_ID, ledger).nodes[0]?.state).toBe('succeeded')
  })

  it('preserves a rejected report cause through real projection into the owner decision', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const dispatchId = 'dispatch-task-a-rejected'
    const reportPath = '/workspace/report.json'
    const dispatchAction = action('dispatch-node', {
      capability: 'implement',
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      depsOrchestrationIds: [],
      evidenceKey: `${revision.revisionId}:task-a`
    })
    const ingestAction = action('ingest-report', {
      capability: 'implement',
      recovery: 'replay-safe',
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      dispatchId,
      orchestrationTaskId: 'orchestration-task-a',
      reportPath,
      filesModified: ['src/task-a.ts'],
      dispatchedContentIdentity: CONTENT_IDENTITY,
      evidenceKey: dispatchId
    })
    const dispatchAttempt = {
      ...settledAttempt('dispatch-rejected', dispatchAction, 'landed'),
      dispatchId
    }
    const rejectedAttempt = {
      ...settledAttempt('ingest-rejected', ingestAction, 'not-landed', {
        detail: 'summary: expected string',
        reportedFiles: ['src/task-a.ts'],
        observedFiles: [],
        reportValidation: createReportValidationProvenance({
          status: 'rejected',
          code: 'malformed',
          role: 'implementer',
          dispatchId,
          taskKey: 'task-a',
          reportPath,
          detail: 'summary: expected string',
          reportedFiles: ['src/task-a.ts'],
          hostVerifiable: true
        })
      }),
      reason: 'implementer-report-malformed'
    }
    const ledger: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        dispatchAttempt,
        {
          eventId: 'worker-done-rejected',
          watcherId: WATCHER_ID,
          atMs: 1_001,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          payload: {
            type: 'worker_done',
            payload: {
              dispatchId,
              taskId: 'orchestration-task-a',
              outcome: 'succeeded',
              reportPath,
              filesModified: ['src/task-a.ts']
            }
          }
        },
        rejectedAttempt
      ]
    }
    const plan = store.project(WATCHER_ID, ledger)
    expect(plan.nodes.find((node) => node.taskKey === 'task-a')?.state).toBe('failed')
    const objectiveSnapshot = {
      freshness: 'live',
      contentIdentity: CONTENT_IDENTITY,
      observedAtMs: 2_000,
      world: {
        contract: CONTRACT,
        workspaceKind: 'git',
        plan,
        reports: [],
        budget: { wallClockActiveMs: 60_000, turns: 10 },
        landingContext: {
          branch: null,
          headSha: null,
          worktreeContentDigest: null,
          pushTarget: null,
          hostedReview: null
        }
      }
    } satisfies Snapshot<ObjectiveWorld>

    expect(decideObjective(objectiveSnapshot, ledger, true)).toMatchObject({
      action: null,
      deviation: {
        kind: 'report-rejected',
        dispatchId,
        taskKey: 'task-a',
        rejectionReason: 'implementer-report-malformed',
        reportedFiles: ['src/task-a.ts'],
        detail: expect.stringContaining('summary: expected string')
      }
    })
  })

  it('keeps an infra/environment failure pending under the redispatch cap, but failed past it', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const retryOf = `${revision.revisionId}:task-a`
    const dispatchNode = (extras: Record<string, unknown> = {}) =>
      action('dispatch-node', {
        revisionId: revision.revisionId,
        taskKey: 'task-a',
        depsOrchestrationIds: [],
        ...extras
      })
    const underCap: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt('under-cap', dispatchNode(), 'not-landed'),
          failureClass: 'infra'
        }
      ]
    }
    expect(store.project(WATCHER_ID, underCap).nodes[0].state).toBe('pending')

    const pastCap: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt('original', dispatchNode(), 'not-landed'),
          failureClass: 'infra'
        },
        {
          ...settledAttempt('retry-0', dispatchNode({ retryOf }), 'not-landed'),
          failureClass: 'environment'
        },
        {
          ...settledAttempt('retry-1', dispatchNode({ retryOf }), 'not-landed'),
          failureClass: 'infra'
        }
      ]
    }
    expect(store.project(WATCHER_ID, pastCap).nodes[0].state).toBe('failed')
  })

  it('recognizes only the base evidence key for a dispatch-node awaiting-approval escalation', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const baseKey = `${revision.revisionId}:task-a`

    function pendingApproval(evidenceKey: string): WatcherLedger {
      return {
        watcherId: WATCHER_ID,
        entries: [
          {
            eventId: `escalation-${evidenceKey}`,
            watcherId: WATCHER_ID,
            atMs: 50,
            origin: 'owner',
            class: 'fact',
            kind: 'escalation',
            escalationId: `awaiting-approval:${evidenceKey}`,
            escalationKind: 'awaiting-approval',
            status: 'open',
            foldCount: 1,
            approvalScope: {
              actionKind: 'dispatch-node',
              contentIdentity: CONTENT_IDENTITY,
              evidenceKey
            }
          }
        ]
      }
    }

    expect(store.project(WATCHER_ID, pendingApproval(`${baseKey}:r0`)).nodes[0].state).toBe(
      'pending'
    )
    expect(store.project(WATCHER_ID, pendingApproval(baseKey)).nodes[0].state).toBe(
      'awaiting-approval'
    )
  })

  it('returns schema-valid detail with bodies, checks, verdicts, and landing evidence', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const criterionId = store.project(WATCHER_ID).nodes[0].criteria[0].id
    store.startCheckAttempt({
      watcherId: WATCHER_ID,
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'execution-host-1',
      command: 'pnpm check:a',
      epoch: 4,
      startedAtMs: 400
    })
    store.completeCheckAttempt({
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'passed',
      stderrTail: '',
      completedAtMs: 450
    })
    store.recordVerdict({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'review-dispatch-1',
      role: 'reviewer',
      contentIdentity: CONTENT_IDENTITY,
      report: REVIEW,
      reportDigest: 'review-digest-1',
      createdAtMs: 500
    })
    store.recordLanding({
      watcherId: WATCHER_ID,
      rung: 'files-on-disk',
      contentIdentity: CONTENT_IDENTITY,
      attemptFingerprint: 'landing-fingerprint-1',
      payload: { revisionId: revision.revisionId },
      epoch: 4,
      createdAtMs: 600
    })

    const detail = store.detail(WATCHER_ID, CONTRACT)
    expect(ObjectiveDetailSchema.parse(detail)).toEqual(detail)
    expect(detail.revisions[0].nodeCount).toBe(2)
    expect(detail.nodes[0].criteria[0]).toMatchObject({
      body: 'Secret acceptance body A',
      lastCheck: { exitCode: 0, timedOut: false },
      lastReview: 'pass'
    })
    expect(detail.nodes.map((node) => node.laneTaskKeys)).toEqual([
      ['task-a', 'task-b'],
      ['task-a', 'task-b']
    ])
    expect(detail.landing).toEqual([
      { rung: 'files-on-disk', contentIdentity: CONTENT_IDENTITY, atMs: 600 }
    ])
    expect(detail.asOfMs).toBe(9_999)
  })

  it('purges only the selected watcher', () => {
    ingest()
    store.ingestPlan({
      watcherId: 'watcher-objective-2',
      revisionNumber: 1,
      dispatchId: 'other-plan',
      report: REPORT,
      digest: 'other-digest',
      createdAtMs: 100
    })
    store.purge(WATCHER_ID)
    expect(store.project(WATCHER_ID).revisions).toEqual([])
    expect(store.project('watcher-objective-2').revisions).toHaveLength(1)
  })

  it('projects plan patches, plan reviews, and gate attempts, and purge clears them', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: {
        repair: {
          upsertTasks: [
            {
              taskKey: 'task-c',
              title: 'Task C',
              spec: 'Implement C',
              deps: ['task-b'],
              criteria: [{ body: 'C works', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false
            }
          ],
          dropTaskKeys: []
        },
        assumptions: []
      },
      createdAtMs: 300
    })
    store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 400,
      frozenTaskKeys: []
    })
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: revision.revisionId,
      round: 1,
      dispatchId: 'plan-review-1',
      report: { verdict: 'approve', assumptions: [], findings: [], summary: 'Looks solid' },
      reportDigest: 'review-digest-1',
      createdAtMs: 500
    })
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 600
    })
    store.completeGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'ok',
      stderrTail: '',
      completedAtMs: 650
    })

    const projection = store.project(WATCHER_ID)
    expect(projection.patches).toEqual([
      expect.objectContaining({
        id: patch.id,
        revisionId: revision.revisionId,
        status: 'applied',
        touchedTaskKeys: ['task-c']
      })
    ])
    expect(projection.planReviews).toEqual([
      expect.objectContaining({
        targetKind: 'revision',
        targetId: revision.revisionId,
        round: 1,
        verdict: 'approve'
      })
    ])
    expect(projection.gateAttempts).toEqual([
      expect.objectContaining({ gateName: 'typecheck:node', exitCode: 0, timedOut: false })
    ])

    store.purge(WATCHER_ID)
    const purged = store.project(WATCHER_ID)
    expect(purged.patches).toEqual([])
    expect(purged.planReviews).toEqual([])
    expect(purged.gateAttempts).toEqual([])
  })
})
