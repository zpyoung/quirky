import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubmissionPreflightResult } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { attempt, CONTRACT } from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import type { ObjectiveStore } from './objective-store'
import { createObjectiveSubmissionAdapter } from './report-submission-preflight'
import { issueObjectiveReportPath } from './report-ingestion'

const { resolveWorkspaceTarget, validateWorkspaceChanges } = vi.hoisted(() => ({
  resolveWorkspaceTarget: vi.fn(),
  validateWorkspaceChanges: vi.fn()
}))

vi.mock('./workspace-target', () => ({
  resolveObjectiveWorkspaceTarget: resolveWorkspaceTarget
}))
vi.mock('./observed-workspace-changes', () => ({
  validateObjectiveWorkspaceChanges: validateWorkspaceChanges
}))

const DISPATCH_ID = 'dispatch-core'
const ACTION: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:core',
  revisionId: 'revision-1',
  taskKey: 'core',
  depsOrchestrationIds: []
}
const TASK: ObjectivePlanTask = {
  taskKey: 'core',
  title: 'Core',
  spec: 'Implement core',
  deps: [],
  criteria: [
    { body: 'First criterion', shellCheckable: false, checkCommand: null },
    { body: 'Second criterion', shellCheckable: false, checkCommand: null }
  ],
  declaresDependencyChange: false
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large WatcherEnrollment type; only kind and kindPayload are read by the submission preflight adapter.
const ENROLLMENT = {
  kind: 'objective',
  kindPayload: CONTRACT
} as unknown as WatcherEnrollment
const LEDGER = {
  watcherId: 'watcher-1',
  entries: [attempt(ACTION, { dispatchId: DISPATCH_ID })]
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
const OBJECTIVE_STORE = {
  getPlan: () => [TASK],
  getTask: () => TASK,
  getDispatch: () => null
} as unknown as ObjectiveStore
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: QuirkyRuntimeService is a class with private fields; the submission preflight adapter never calls it in these tests.
const RUNTIME = {} as QuirkyRuntimeService

const PLANNER_DISPATCH_ID = 'dispatch-planner-repair'
const REPAIR_PLANNER_ACTION: ObjectiveAction = {
  kind: 'dispatch-planner',
  capability: 'plan',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'plan-repair:revision-1:1',
  revisionNumber: 1,
  reason: 'replan-after-failure',
  plannerMode: 'repair',
  repairOrdinal: 1,
  repairRevisionId: 'revision-1'
}
const REPAIR_PLANNER_LEDGER = {
  watcherId: 'watcher-1',
  entries: [attempt(REPAIR_PLANNER_ACTION, { dispatchId: PLANNER_DISPATCH_ID })]
}

function expectActionableRejection(
  result: SubmissionPreflightResult,
  expectedDetail: string
): void {
  expect(result).toMatchObject({ status: 'rejected', code: 'heimdall_report_invalid' })
  if (result.status !== 'rejected') {
    throw new Error('expected report rejection')
  }
  expect(result.reason).toContain(expectedDetail)
  expect(result.reason).toContain('Correct the issued report file')
  expect(result.reason).toContain('resend the same worker_done command')
  expect(result.reason).toContain('Dispatch is still active')
}

describe('objective report submission preflight', () => {
  let workspacePath: string
  let target: ObjectiveWorkspaceTarget
  let reportPath: string

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'quirky-objective-preflight-'))
    target = {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath
    }
    resolveWorkspaceTarget.mockReset()
    validateWorkspaceChanges.mockReset()
    resolveWorkspaceTarget.mockResolvedValue(target)
    validateWorkspaceChanges.mockResolvedValue({ ok: true, changedPaths: ['src/core.ts'] })
    reportPath = await issueObjectiveReportPath(target, `fingerprint-${DISPATCH_ID}`)
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  it('rejects actionable report defects and accepts the corrected same submission', async () => {
    const adapter = createObjectiveSubmissionAdapter({
      runtime: RUNTIME,
      objectiveStore: OBJECTIVE_STORE
    })
    const submission = {
      dispatchId: DISPATCH_ID,
      payload: { reportPath, filesModified: ['src/core.ts'] }
    } as const
    const context = { enrollment: ENROLLMENT, snapshot: null, ledger: LEDGER }

    await writeFile(
      reportPath,
      JSON.stringify({
        taskKey: 'core',
        summary: 's'.repeat(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH + 1),
        filesModified: ['src/core.ts'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'pass', note: 'Verified' },
          { criterionIndex: 1, result: 'pass', note: 'Verified' }
        ]
      })
    )
    expectActionableRejection(await adapter.preflightWorkerReport(submission, context), 'summary')

    await writeFile(reportPath, '{not-json')
    expectActionableRejection(
      await adapter.preflightWorkerReport(submission, context),
      'malformed JSON or schema violation'
    )

    await writeFile(
      reportPath,
      JSON.stringify({
        taskKey: 'core',
        summary: 'Implemented core',
        filesModified: ['src/core.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      })
    )
    expectActionableRejection(
      await adapter.preflightWorkerReport(submission, context),
      'must assess every criterion'
    )

    await writeFile(
      reportPath,
      JSON.stringify({
        taskKey: 'core',
        summary: 'Implemented core',
        filesModified: ['src/core.ts'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'pass', note: 'Verified' },
          { criterionIndex: 1, result: 'pass', note: 'Verified' }
        ]
      })
    )
    await expect(adapter.preflightWorkerReport(submission, context)).resolves.toEqual({
      status: 'accepted'
    })
  })

  it('accepts a real repair-shaped report for a repair dispatch-planner', async () => {
    const adapter = createObjectiveSubmissionAdapter({
      runtime: RUNTIME,
      objectiveStore: OBJECTIVE_STORE
    })
    const repairReportPath = await issueObjectiveReportPath(
      target,
      `fingerprint-${PLANNER_DISPATCH_ID}`
    )
    await writeFile(
      repairReportPath,
      JSON.stringify({
        repair: {
          upsertTasks: [
            {
              taskKey: 'core-2',
              title: 'Core follow-up',
              spec: 'Implement the core follow-up work.',
              deps: [],
              criteria: [{ body: 'Follow-up works', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false,
              territory: ['src/**']
            }
          ],
          dropTaskKeys: []
        },
        assumptions: []
      })
    )

    await expect(
      adapter.preflightWorkerReport(
        {
          dispatchId: PLANNER_DISPATCH_ID,
          payload: { reportPath: repairReportPath, filesModified: [] }
        },
        { enrollment: ENROLLMENT, snapshot: null, ledger: REPAIR_PLANNER_LEDGER }
      )
    ).resolves.toEqual({ status: 'accepted' })
  })

  it('validates a dispatch-plan-review report against its target revision assumptions', async () => {
    const dispatchId = 'dispatch-plan-review-1'
    const action: ObjectiveAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:1',
      target: { kind: 'revision', revisionId: 'revision-1' },
      round: 1
    }
    const planReviewLedger = { watcherId: 'watcher-1', entries: [attempt(action, { dispatchId })] }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
    const store = {
      getDispatch: () => null,
      getPlanReport: () => ({
        plan: [TASK],
        assumptions: [{ claim: 'The fixture already exists.', dependentTaskKeys: ['core'] }]
      })
    } as unknown as ObjectiveStore
    const adapter = createObjectiveSubmissionAdapter({
      runtime: RUNTIME,
      objectiveStore: store
    })
    const planReviewReportPath = await issueObjectiveReportPath(target, `fingerprint-${dispatchId}`)
    const submission = {
      dispatchId,
      payload: { reportPath: planReviewReportPath, filesModified: [] }
    } as const
    const context = { enrollment: ENROLLMENT, snapshot: null, ledger: planReviewLedger }

    await writeFile(
      planReviewReportPath,
      JSON.stringify({
        verdict: 'approve',
        assumptions: [{ index: 0, status: 'unverified', evidence: 'Could not confirm.' }],
        findings: [],
        summary: 'Looks fine.'
      })
    )
    expect(await adapter.preflightWorkerReport(submission, context)).toMatchObject({
      status: 'rejected',
      code: 'heimdall_report_invalid'
    })

    await writeFile(
      planReviewReportPath,
      JSON.stringify({
        verdict: 'approve',
        assumptions: [{ index: 0, status: 'verified', evidence: 'Confirmed in src/core.ts.' }],
        findings: [],
        summary: 'Looks fine.'
      })
    )
    await expect(adapter.preflightWorkerReport(submission, context)).resolves.toEqual({
      status: 'accepted'
    })
  })

  it('rejects a full-shaped report submitted for a repair dispatch-planner', async () => {
    const adapter = createObjectiveSubmissionAdapter({
      runtime: RUNTIME,
      objectiveStore: OBJECTIVE_STORE
    })
    const repairReportPath = await issueObjectiveReportPath(
      target,
      `fingerprint-${PLANNER_DISPATCH_ID}`
    )
    await writeFile(repairReportPath, JSON.stringify({ plan: [TASK] }))

    const result = await adapter.preflightWorkerReport(
      {
        dispatchId: PLANNER_DISPATCH_ID,
        payload: { reportPath: repairReportPath, filesModified: [] }
      },
      { enrollment: ENROLLMENT, snapshot: null, ledger: REPAIR_PLANNER_LEDGER }
    )
    expect(result).toMatchObject({ status: 'rejected', code: 'heimdall_report_invalid' })
  })
})
