import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type {
  SubmissionAdapter,
  SubmissionPreflightResult,
  WorkerReportSubmission
} from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidateImplementerReport,
  parseAndValidateIntegratorReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import { parseAndValidatePlannerRepairReport } from '../../shared/fork-heimdall-objective/plan-repair-schema'
import { parseAndValidatePlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
import type { ObjectivePlanAssumption } from '../../shared/fork-heimdall-objective/plan-schema'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { requireObjectiveOriginalDispatchFingerprint } from '../../shared/fork-heimdall-objective/decision-context'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { objectiveContractFromEnrollment } from './definition'
import { findObjectiveDispatchAttempt } from './execution-context'
import { resolveObjectiveAttemptTarget } from './dispatch-worktree'
import type { ObjectiveStore } from './objective-store'
import { resolvePlanReviewDelta } from './plan-review-delta'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import {
  MAX_OBJECTIVE_REPORT_BYTES,
  readObjectiveRoleReport,
  type ObjectiveReportRole,
  type ObjectiveRoleReportReadResult
} from './report-ingestion'
import { resolveObjectiveWorkspaceTarget } from './workspace-target'

const ACCEPTED = { status: 'accepted' } as const

type DispatchAction = Extract<ObjectiveAction, { kind: `dispatch-${string}` }>

function roleForAction(action: DispatchAction): ObjectiveReportRole {
  return action.kind === 'dispatch-planner'
    ? 'planner'
    : action.kind === 'dispatch-node'
      ? 'implementer'
      : action.kind === 'dispatch-reviewer'
        ? 'reviewer'
        : action.kind === 'dispatch-plan-review'
          ? 'plan-review'
          : 'integrator'
}

/**
 * The declared assumptions a plan review must assess: the draft revision's, or a pending patch's
 * own. `undefined` means the target itself is unavailable, distinct from a target with none declared.
 */
function planReviewTargetAssumptions(
  objectiveStore: ObjectiveStore,
  target: Extract<DispatchAction, { kind: 'dispatch-plan-review' }>['target']
): readonly ObjectivePlanAssumption[] | undefined {
  const found =
    target.kind === 'revision'
      ? objectiveStore.getPlanReport(target.revisionId)
      : objectiveStore.getPlanPatch(target.patchId)?.report
  return found === null || found === undefined ? undefined : (found.assumptions ?? [])
}

function rejected(role: ObjectiveReportRole, reason: string): SubmissionPreflightResult {
  return {
    status: 'rejected',
    code: 'heimdall_report_invalid',
    reason: `Heimdall rejected the ${role} report: ${reason} Correct the issued report file and resend the same worker_done command; this Dispatch is still active.`
  }
}

function reportReadFailure(
  role: ObjectiveReportRole,
  read: Extract<ObjectiveRoleReportReadResult, { ok: false }>
): SubmissionPreflightResult {
  const reason =
    read.reason === 'missing'
      ? 'reportPath: the issued report file is missing.'
      : read.reason === 'oversize'
        ? `reportPath: the report exceeds the ${MAX_OBJECTIVE_REPORT_BYTES}-byte limit.`
        : read.reason === 'binary'
          ? 'reportPath: the report must be UTF-8 JSON, not binary data.'
          : read.reason === 'role-mismatch'
            ? `report: the JSON matches a different role, but this Dispatch requires ${role}.`
            : read.reason === 'task-mismatch'
              ? 'taskKey: the report does not name the task assigned to this Dispatch.'
              : read.reason === 'path-mismatch'
                ? 'payload.reportPath: use the exact report path issued for this Dispatch.'
                : `report: malformed JSON or schema violation${read.detail ? `:\n${read.detail}` : '.'}`
  return rejected(role, reason)
}

function dispatchedTaskKeys(ledger: WatcherLedger): string[] {
  const keys = new Set<string>()
  for (const attempt of getLatestAttempts(ledger)) {
    const parsed = ObjectiveActionSchema.safeParse(attempt.action)
    if (parsed.success && parsed.data.kind === 'dispatch-node') {
      keys.add(parsed.data.taskKey)
    }
  }
  return [...keys]
}

function payloadFiles(
  role: ObjectiveReportRole,
  submission: WorkerReportSubmission
): { ok: true; files: readonly string[] } | { ok: false; rejection: SubmissionPreflightResult } {
  const value = submission.payload.filesModified
  return Array.isArray(value) && value.every((file): file is string => typeof file === 'string')
    ? { ok: true, files: value }
    : {
        ok: false,
        rejection: rejected(
          role,
          'payload.filesModified: expected an array of workspace-relative paths.'
        )
      }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0')
}

function deterministicWorkspaceRejection(args: {
  role: ObjectiveReportRole
  reason: string
  reportedFiles: readonly string[]
  observedFiles?: readonly string[]
}): SubmissionPreflightResult | null {
  if (
    args.reason === 'reported-files-invalid' ||
    args.reason === 'reported-files-do-not-match-observed-changes' ||
    args.reason.startsWith('observed-change-outside-write-territory:')
  ) {
    const observed = args.observedFiles ? JSON.stringify(args.observedFiles) : 'unavailable'
    return rejected(
      args.role,
      `filesModified: ${args.reason}; submitted ${JSON.stringify(args.reportedFiles)}, observed ${observed}.`
    )
  }
  // Routing, baseline, and observation failures describe unverifiable host state, not invalid input.
  return null
}

export function createObjectiveSubmissionAdapter(args: {
  runtime: QuirkyRuntimeService
  objectiveStore: ObjectiveStore
}): SubmissionAdapter<ObjectiveWorld> {
  return {
    async preflightWorkerReport(submission, context) {
      const origin = findObjectiveDispatchAttempt(context.ledger, submission.dispatchId)
      if (!origin) {
        return ACCEPTED
      }
      const action = origin.action
      const role = roleForAction(action)
      const reportPath = submission.payload.reportPath
      if (typeof reportPath !== 'string' || reportPath.length === 0) {
        return rejected(role, 'payload.reportPath: expected the exact issued absolute report path.')
      }

      const contract = objectiveContractFromEnrollment(context.enrollment)
      let target: ObjectiveWorkspaceTarget
      try {
        const enrolledTarget = await resolveObjectiveWorkspaceTarget(
          args.runtime,
          context.enrollment
        )
        target = await resolveObjectiveAttemptTarget({
          runtime: args.runtime,
          binding: { enrollment: context.enrollment, contract, target: enrolledTarget },
          objectiveStore: args.objectiveStore,
          attempt: origin.attempt
        })
      } catch {
        return ACCEPTED
      }

      let read: ObjectiveRoleReportReadResult
      try {
        read = await readObjectiveRoleReport({
          target,
          attemptFingerprint: origin.attempt.fingerprint,
          mailboxReportPath: reportPath,
          role,
          ...(action.kind === 'dispatch-node' ? { taskKey: action.taskKey } : {}),
          ...(action.kind === 'dispatch-planner'
            ? { plannerMode: action.plannerMode ?? 'full' }
            : {})
        })
      } catch {
        return ACCEPTED
      }
      if (!read.ok) {
        return reportReadFailure(role, read)
      }

      let evidenceFiles: readonly string[] = []
      if (action.kind === 'dispatch-planner') {
        if (action.plannerMode === 'repair') {
          const currentPlan = args.objectiveStore.getPlan(action.repairRevisionId ?? '')
          if (!currentPlan) {
            return ACCEPTED
          }
          try {
            parseAndValidatePlannerRepairReport(
              read.report,
              { writeTerritory: contract.writeTerritory },
              currentPlan
            )
          } catch (error) {
            return rejected(
              role,
              error instanceof Error ? error.message : 'report validation failed.'
            )
          }
        } else {
          try {
            parseAndValidatePlannerReport(read.report, {
              writeTerritory: contract.writeTerritory,
              dispatchedTaskKeys: dispatchedTaskKeys(context.ledger)
            })
          } catch (error) {
            return rejected(
              role,
              error instanceof Error ? error.message : 'report validation failed.'
            )
          }
        }
      } else if (action.kind === 'dispatch-plan-review') {
        const assumptions = planReviewTargetAssumptions(args.objectiveStore, action.target)
        if (assumptions === undefined) {
          return ACCEPTED
        }
        try {
          const delta = resolvePlanReviewDelta(
            args.objectiveStore,
            context.enrollment.watcherId,
            action.target,
            action.round
          )
          parseAndValidatePlanReviewReport(
            read.report,
            assumptions.length,
            assumptions,
            new Set(delta?.carryEligible ?? [])
          )
        } catch (error) {
          return rejected(
            role,
            error instanceof Error ? error.message : 'report validation failed.'
          )
        }
      } else {
        const plan = args.objectiveStore.getPlan(action.revisionId)
        if (!plan) {
          return ACCEPTED
        }
        if (action.kind === 'dispatch-node') {
          const task =
            args.objectiveStore.getDispatch(origin.attempt.fingerprint)?.task ??
            args.objectiveStore.getTask(action.revisionId, action.taskKey)
          if (!task) {
            return ACCEPTED
          }
          let report
          try {
            report = parseAndValidateImplementerReport(read.report, task, contract.writeTerritory)
          } catch (error) {
            return rejected(
              role,
              error instanceof Error ? error.message : 'report validation failed.'
            )
          }
          const submittedFiles = payloadFiles(role, submission)
          if (!submittedFiles.ok) {
            return submittedFiles.rejection
          }
          if (!samePaths(report.filesModified, submittedFiles.files)) {
            return rejected(
              role,
              `payload.filesModified: received ${JSON.stringify(submittedFiles.files)}; report.filesModified is ${JSON.stringify(report.filesModified)}.`
            )
          }
          evidenceFiles = submittedFiles.files
        } else if (action.kind === 'dispatch-reviewer') {
          try {
            parseAndValidateReviewerReport(read.report, plan)
          } catch (error) {
            return rejected(
              role,
              error instanceof Error ? error.message : 'report validation failed.'
            )
          }
        } else {
          try {
            parseAndValidateIntegratorReport(read.report, plan)
          } catch (error) {
            return rejected(
              role,
              error instanceof Error ? error.message : 'report validation failed.'
            )
          }
          const submittedFiles = payloadFiles(role, submission)
          if (!submittedFiles.ok) {
            return submittedFiles.rejection
          }
          evidenceFiles = submittedFiles.files
        }
      }

      if (action.kind === 'dispatch-node' || action.kind === 'dispatch-integrator') {
        let baselineFingerprint: string
        try {
          baselineFingerprint = args.objectiveStore.getDispatch(origin.attempt.fingerprint)
            ? origin.attempt.fingerprint
            : action.kind === 'dispatch-node' && action.retryOf !== undefined
              ? requireObjectiveOriginalDispatchFingerprint(context.ledger, action.retryOf)
              : origin.attempt.fingerprint
        } catch {
          return ACCEPTED
        }
        let observed:
          | { ok: true; changedPaths: string[] }
          | { ok: false; reason: string; observedFiles?: string[] }
        try {
          observed = await validateObjectiveWorkspaceChanges({
            target,
            attemptFingerprint: baselineFingerprint,
            reportedFiles: evidenceFiles,
            writeTerritory: contract.writeTerritory
          })
        } catch {
          return ACCEPTED
        }
        if (!observed.ok) {
          return (
            deterministicWorkspaceRejection({
              role,
              reason: observed.reason,
              reportedFiles: evidenceFiles,
              observedFiles: observed.observedFiles
            }) ?? ACCEPTED
          )
        }
      }
      return ACCEPTED
    }
  }
}
