import {
  ReportValidationProvenanceSchema,
  type ActionOutcome
} from '../../shared/fork-heimdall/effect-certainty'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { objectiveInFlightTaskKeys } from '../../shared/fork-heimdall-objective/decision-context'
import {
  ObjectiveActionSchema,
  objectiveActionNaturalKey,
  type AcceptReportAction,
  type AmendPlanAction,
  type ObjectiveAction,
  type SkipCheckAction,
  type SkipReviewAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { ObjectiveWorkspacePathSchema } from '../../shared/fork-heimdall-objective/contract-types'
import {
  IntegratorReportSchema,
  ReviewerReportSchema,
  type IntegratorReport,
  type ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  objectiveResultDigest,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { resolveObjectiveDispatchTarget } from './dispatch-worktree'
import {
  queueObjectiveDispatchReport,
  type QueueObjectiveDispatchReportResult
} from './merge-train-report'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import { readObjectiveRoleReport } from './report-ingestion'
import type { ObjectiveStore } from './objective-store'

function invalid(reason: string): ActionOutcome {
  return { effect: 'not-landed', reason }
}

function requireNaturalKey(action: ObjectiveAction) {
  const key = objectiveActionNaturalKey(action)
  if (!key) {
    throw new Error(`Objective owner-override action ${action.kind} has no natural key`)
  }
  return key
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0')
}

/** The `ingest-report` attempt an `accept-report` override is excusing; null when nothing was ever rejected. */
export function findRejectedIngestReportAttempt(
  ledger: WatcherLedger,
  dispatchId: string
): AttemptEntry | null {
  for (const attempt of getLatestAttempts(ledger)) {
    const parsed = ObjectiveActionSchema.safeParse(attempt.action)
    const result = isRecord(attempt.result) ? attempt.result : {}
    const validation = ReportValidationProvenanceSchema.safeParse(result.reportValidation)
    if (
      parsed.success &&
      parsed.data.kind === 'ingest-report' &&
      parsed.data.dispatchId === dispatchId &&
      attempt.state === 'settled' &&
      attempt.effect === 'not-landed' &&
      validation.success &&
      validation.data.status === 'rejected' &&
      validation.data.hostVerifiable &&
      validation.data.role === 'implementer' &&
      validation.data.dispatchId === dispatchId &&
      typeof result.reportDigest === 'string'
    ) {
      return attempt
    }
  }
  return null
}

export function rejectedReportAudit(attempt: AttemptEntry): {
  rejectionReason: string
  reportDigest: string
  reportedFiles: string[]
  observedFiles: string[]
} {
  const record = isRecord(attempt.result) ? attempt.result : {}
  return {
    rejectionReason: attempt.reason ?? 'unknown',
    reportDigest: typeof record.reportDigest === 'string' ? record.reportDigest : '',
    reportedFiles: isStringArray(record.reportedFiles) ? record.reportedFiles : [],
    observedFiles: isStringArray(record.observedFiles) ? record.observedFiles : []
  }
}

/**
 * Lands a node the deterministic `ingest-report` validator rejected. The owner's attestation and
 * the rejected attempt's own reported-vs-observed files are the audit trail — no other record of
 * the override exists.
 */
export async function acceptOwnerReport(args: {
  action: AcceptReportAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  runtime?: QuirkyRuntimeService
}): Promise<ActionOutcome> {
  const origin = findObjectiveDispatchAttempt(args.context.ledger, args.action.dispatchId)
  if (
    origin?.action.kind !== 'dispatch-node' ||
    origin.action.revisionId !== args.action.revisionId ||
    origin.action.taskKey !== args.action.taskKey
  ) {
    return invalid('accept-report-dispatch-mismatch')
  }
  const evidence = findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId)
  if (evidence?.outcome !== 'succeeded' || !evidence.orchestrationTaskId) {
    return invalid('accept-report-evidence-missing')
  }
  const rejected = findRejectedIngestReportAttempt(args.context.ledger, args.action.dispatchId)
  if (!rejected) {
    return invalid('accept-report-no-rejected-report')
  }
  const audit = rejectedReportAudit(rejected)
  await args.context.lease.assertHeld()
  const dispatchRecord = args.objectiveStore.dispatchForId(
    args.binding.enrollment.watcherId,
    args.action.dispatchId
  )
  if (dispatchRecord) {
    if (dispatchRecord.state === 'discarded') {
      return invalid('accept-report-dispatch-obsolete')
    }
    const currentTask = args.objectiveStore.getTask(
      dispatchRecord.revisionId,
      dispatchRecord.taskKey
    )
    const currentRevision = args.objectiveStore
      .project(dispatchRecord.watcherId)
      .revisions.find((revision) => revision.id === dispatchRecord.revisionId)
    if (
      currentRevision?.status !== 'approved' ||
      !currentTask ||
      objectiveResultDigest(currentTask) !== dispatchRecord.planTaskDigest
    ) {
      return invalid('accept-report-task-obsolete')
    }
    if (!args.runtime) {
      return invalid('accept-report-runtime-unavailable')
    }
    let queued: QueueObjectiveDispatchReportResult
    try {
      const target = await resolveObjectiveDispatchTarget(
        args.runtime,
        args.binding,
        dispatchRecord
      )
      const currentReport = await readObjectiveRoleReport({
        target,
        attemptFingerprint: dispatchRecord.attemptFingerprint,
        mailboxReportPath: evidence.reportPath,
        role: 'implementer',
        taskKey: dispatchRecord.taskKey
      })
      if (!currentReport.ok || currentReport.reportDigest !== audit.reportDigest) {
        return invalid('accept-report-report-stale')
      }
      const rejectedAction = ObjectiveActionSchema.parse(rejected.action)
      if (
        rejectedAction.kind !== 'ingest-report' ||
        !samePaths(currentReport.report.filesModified, rejectedAction.filesModified)
      ) {
        return invalid('accept-report-reported-files-stale')
      }
      const observed = await validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: dispatchRecord.attemptFingerprint,
        reportedFiles: currentReport.report.filesModified,
        writeTerritory: args.binding.contract.writeTerritory
      })
      await args.context.lease.assertHeld()
      const currentObserved = observed.ok ? observed.changedPaths : (observed.observedFiles ?? [])
      if (
        (audit.observedFiles.length === 0 && !observed.ok) ||
        (audit.observedFiles.length > 0 && !samePaths(currentObserved, audit.observedFiles))
      ) {
        return invalid('accept-report-workspace-stale')
      }
      const reportedFiles = currentReport.report.filesModified.filter(
        (path) => ObjectiveWorkspacePathSchema.safeParse(path).success
      )
      const report = {
        taskKey: args.action.taskKey,
        summary: `Owner accepted rejected report: ${audit.rejectionReason}`.slice(0, 16_384),
        filesModified: reportedFiles,
        criteriaSelfAssessment: dispatchRecord.task.criteria.map((_, criterionIndex) => ({
          criterionIndex,
          result: 'unknown' as const,
          note: 'Owner accepted the rejected implementer report'
        }))
      }
      const acceptedReportDigest = objectiveResultDigest({
        rejectedAttempt: rejected.fingerprint,
        rejectedReportDigest: audit.reportDigest,
        attestation: args.action.attestation,
        report
      })
      queued = await queueObjectiveDispatchReport({
        record: dispatchRecord,
        target,
        objectiveStore: args.objectiveStore,
        lease: args.context.lease,
        reportPath: evidence.reportPath,
        report,
        reportDigest: acceptedReportDigest,
        completedAtMs: evidence.atMs,
        allowFailed: true
      })
    } catch (error) {
      return {
        effect: 'not-landed',
        failureClass: 'infra',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    await args.context.lease.assertHeld()
    if (queued.kind === 'conflict-context-missing') {
      return invalid(`accept-report-conflict-context-missing-${queued.dispatchId}`)
    }
    if (queued.kind === 'dispatch-not-queueable') {
      return invalid(`accept-report-dispatch-${queued.state}`)
    }
    if (queued.kind === 'conflict-checks-failed') {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'accept-report-conflict-check-failed',
        result: queued
      }
    }
  } else {
    args.objectiveStore.recordNodeDispatch({
      watcherId: args.binding.enrollment.watcherId,
      revisionId: args.action.revisionId,
      taskKey: args.action.taskKey,
      orchestrationTaskId: evidence.orchestrationTaskId,
      dispatchId: args.action.dispatchId,
      dispatchedAtMs: evidence.atMs
    })
  }
  return {
    effect: 'landed',
    result: {
      kind: 'report-accepted',
      naturalKey: requireNaturalKey(args.action),
      digest: rejected.fingerprint,
      attestation: args.action.attestation,
      ...audit
    }
  }
}

/** Applies an owner's in-place plan correction via the same mutation a human-authored amendment uses. */
export async function amendOwnerPlan(args: {
  action: AmendPlanAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  const result = args.objectiveStore.amendRevision({
    watcherId: args.binding.enrollment.watcherId,
    revisionId: args.action.revisionId,
    patch: args.action.patch,
    amendedAtMs: Date.now(),
    inFlightTaskKeys: [...objectiveInFlightTaskKeys(args.context.ledger, args.action.revisionId)]
  })
  if (!result.ok) {
    return invalid(`amend-plan-${result.reason}`)
  }
  return {
    effect: 'landed',
    result: {
      kind: 'plan-amended',
      naturalKey: requireNaturalKey(args.action),
      digest: args.action.patch.digest,
      attestation: args.action.attestation,
      ordinal: result.ordinal,
      replayed: result.replayed
    }
  }
}

const MAX_REVIEW_NOTE_CHARS = 4_096

function ownerSkipNote(rationale: string): string {
  const note = `Skipped by owner: ${rationale}`
  return note.length > MAX_REVIEW_NOTE_CHARS ? note.slice(0, MAX_REVIEW_NOTE_CHARS) : note
}

/**
 * Records a synthetic 'approve' verdict built from the plan itself, so it always has complete
 * criterion coverage by construction. Never dispatches a reviewer/integrator — the landing bar has
 * no opinion on this stage, so gate 2 never routes here without an owner explicitly asking for it.
 */
export async function skipOwnerReview(args: {
  action: SkipReviewAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const plan = args.objectiveStore.getPlan(args.action.revisionId)
  if (!plan) {
    return invalid('skip-review-plan-missing')
  }
  let report: ReviewerReport | IntegratorReport
  try {
    const criteriaResults = plan.flatMap((task) =>
      task.criteria.map((_, criterionIndex) => ({
        taskKey: task.taskKey,
        criterionIndex,
        result: 'pass' as const,
        note: ownerSkipNote(args.action.rationale)
      }))
    )
    const base = { verdict: 'approve' as const, criteriaResults, summary: args.action.rationale }
    report =
      args.action.role === 'reviewer'
        ? ReviewerReportSchema.parse(base)
        : IntegratorReportSchema.parse({ ...base, checksRun: [] })
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'skip-review-report-invalid')
  }
  await args.context.lease.assertHeld()
  const reportDigest = objectiveResultDigest(report)
  args.objectiveStore.recordVerdict({
    watcherId: args.binding.enrollment.watcherId,
    revisionId: args.action.revisionId,
    dispatchId: args.action.dispatchId,
    role: args.action.role,
    contentIdentity: args.action.reviewedContentIdentity,
    report,
    reportDigest,
    createdAtMs: Date.now()
  })
  return {
    effect: 'landed',
    result: {
      kind: 'review-skipped',
      naturalKey: requireNaturalKey(args.action),
      digest: reportDigest,
      role: args.action.role,
      rationale: args.action.rationale
    }
  }
}

/**
 * Records a synthetic passing check result for one criterion, replacing any `run-check` attempt
 * stored at the same content identity. Never runs `criterion.checkCommand` — the owner is
 * overriding the check gate itself, not attesting to a command that actually ran.
 */
export async function skipOwnerCheck(args: {
  action: SkipCheckAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const criterion = args.objectiveStore.getCriterion(args.action.criterionId)
  if (!criterion || !criterion.shellCheckable) {
    return invalid('skip-check-criterion-not-shell-checkable')
  }
  await args.context.lease.assertHeld()
  args.objectiveStore.recordOwnerCheckSkip({
    watcherId: args.binding.enrollment.watcherId,
    criterionId: criterion.id,
    contentIdentity: args.action.contentIdentity,
    executionHostId: args.binding.target.executionHostId,
    note: ownerSkipNote(args.action.rationale),
    epoch: args.context.lease.epoch,
    recordedAtMs: Date.now()
  })
  return {
    effect: 'landed',
    result: {
      kind: 'check-skipped',
      naturalKey: requireNaturalKey(args.action),
      digest: objectiveResultDigest({
        criterionId: args.action.criterionId,
        contentIdentity: args.action.contentIdentity
      }),
      rationale: args.action.rationale
    }
  }
}
