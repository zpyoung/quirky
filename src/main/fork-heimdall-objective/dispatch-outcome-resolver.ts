import {
  WORKER_EXITED_WITHOUT_COMPLETION,
  createReportValidationProvenance,
  type EffectCertaintyResolution,
  type ObjectiveFailureClass,
  type ReportValidationCode,
  type ReportValidationProvenance
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { requireObjectiveOriginalDispatchFingerprint } from '../../shared/fork-heimdall-objective/decision-context'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { judgmentFailureClassification } from '../../shared/fork-heimdall/judgment/objective-judgment-policy'
import { getErrorCode } from '../git/worktree-operation-options'
import {
  classifyValidatedReportFailure,
  dispatchReportRole,
  validateResolvedDispatchReport,
  type ObjectiveDispatchAction
} from './dispatch-report-validation'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { resolveObjectiveDispatchTarget } from './dispatch-worktree'
import { findObjectiveWorkerEvidence, type ObjectiveSnapshotBinding } from './execution-context'
import {
  validateObjectiveWorkspaceChanges,
  type ObjectiveWorkspaceChangesValidation
} from './observed-workspace-changes'
import type { ObjectiveStore } from './objective-store'
import {
  readObjectiveRoleReport,
  type ObjectiveReportRole,
  type ObjectiveRoleReportReadResult
} from './report-ingestion'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function resolveObjectiveDispatchOutcome(args: {
  attempt: AttemptEntry
  action: ObjectiveDispatchAction
  ledger: WatcherLedger
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  runtime: QuirkyRuntimeService
  lease: LeaseGuard
  world: ObjectiveWorld
}): Promise<EffectCertaintyResolution> {
  const failureSubject = args.attempt.dispatchId ?? args.attempt.attemptId
  const failed = (
    fallback: ObjectiveFailureClass,
    reportValidation?: ReportValidationProvenance
  ): EffectCertaintyResolution => ({
    effect: 'not-landed',
    failureClass: judgmentFailureClassification(args.world, failureSubject, fallback),
    ...(reportValidation === undefined ? {} : { reportValidation })
  })
  if (!args.attempt.dispatch) {
    return failed('infra')
  }
  const dispatchId = args.attempt.dispatchId
  if (!dispatchId) {
    return { effect: 'indeterminate' }
  }
  let dispatchRecord = args.objectiveStore.getDispatch(args.attempt.fingerprint)
  if (dispatchRecord && dispatchRecord.dispatchId === null) {
    const result = isRecord(args.attempt.result) ? args.attempt.result : null
    dispatchRecord = {
      ...dispatchRecord,
      dispatchId,
      terminalHandle:
        typeof result?.terminalHandle === 'string'
          ? result.terminalHandle
          : dispatchRecord.terminalHandle,
      reportPath:
        typeof result?.reportPath === 'string' ? result.reportPath : dispatchRecord.reportPath
    }
    await args.lease.assertHeld()
    args.objectiveStore.saveDispatch(dispatchRecord)
  }
  const persistDispatchFailure = async (
    result: EffectCertaintyResolution
  ): Promise<EffectCertaintyResolution> => {
    const record = dispatchRecord
    if (record) {
      await args.lease.assertHeld()
      args.objectiveStore.saveDispatch({
        ...record,
        state: 'failed',
        setupState: 'retained',
        completedAtMs: record.completedAtMs ?? Date.now()
      })
    }
    return result
  }
  const evidence = findObjectiveWorkerEvidence(args.ledger, dispatchId)
  if (!evidence) {
    return args.attempt.reason === WORKER_EXITED_WITHOUT_COMPLETION
      ? persistDispatchFailure(failed('infra'))
      : { effect: 'indeterminate' }
  }
  const role = dispatchReportRole(args.action)
  // a plan critic is dispatched as the wire `reviewer` role, but its report is the differently
  // shaped internal 'plan-review' kind, not a normal reviewer report
  const reportRole: ObjectiveReportRole =
    args.action.kind === 'dispatch-plan-review' ? 'plan-review' : role
  const provenance = (
    status: ReportValidationProvenance['status'],
    code: ReportValidationCode,
    detail?: string,
    observedFiles: readonly string[] = []
  ): ReportValidationProvenance =>
    createReportValidationProvenance({
      status,
      code,
      role,
      dispatchId,
      ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {}),
      reportPath: evidence.reportPath,
      ...(detail === undefined ? {} : { detail }),
      reportedFiles: evidence.filesModified,
      observedFiles,
      hostVerifiable: status === 'rejected'
    })
  const validationFailure = async (
    reportValidation: ReportValidationProvenance
  ): Promise<EffectCertaintyResolution> =>
    reportValidation.status === 'unverifiable' && evidence.outcome === 'succeeded'
      ? { effect: 'indeterminate', reportValidation }
      : persistDispatchFailure(failed('criteria', reportValidation))

  if (!evidence.reportRejectionValid) {
    return validationFailure(
      provenance(
        'rejected',
        'evidence-malformed',
        'Worker completion carried malformed report-rejection evidence'
      )
    )
  }
  if (evidence.reportRejection !== null) {
    return validationFailure(
      createReportValidationProvenance({
        status: 'rejected',
        code: 'semantic-invalid',
        sourceCode: evidence.reportRejection.code,
        role,
        dispatchId,
        ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {}),
        reportPath: evidence.reportPath,
        detail: evidence.reportRejection.reason,
        reportedFiles: evidence.filesModified,
        hostVerifiable: true
      })
    )
  }
  if (!evidence.filesModifiedValid) {
    return validationFailure(
      provenance(
        'rejected',
        'evidence-malformed',
        'Worker completion filesModified must be an array of workspace-relative paths'
      )
    )
  }
  if (evidence.reportPath === null) {
    return evidence.outcome === 'failed'
      ? persistDispatchFailure(failed('criteria'))
      : validationFailure(
          provenance('rejected', 'missing', 'Successful worker completion omitted its report path')
        )
  }
  if (args.action.kind === 'dispatch-planner' && args.action.plannerMode === 'repair') {
    // a repair report's schema/semantic validity is the ingest step's concern (X1): resolving here
    // regardless of content lets an invalid report reach ingestObjectivePlanRepair and land as a
    // stored rejected patch, so the repair retry budget actually counts it instead of the dispatch
    // silently redispatching forever
    return evidence.outcome === 'failed'
      ? persistDispatchFailure(failed('criteria'))
      : { effect: 'landed' }
  }
  let validationTarget = args.binding.target
  if (dispatchRecord) {
    try {
      validationTarget = await resolveObjectiveDispatchTarget(
        args.runtime,
        args.binding,
        dispatchRecord
      )
    } catch (error) {
      return validationFailure(
        provenance(
          'unverifiable',
          'read-unverifiable',
          error instanceof Error ? error.message : 'Dispatch workspace authority could not be read'
        )
      )
    }
  }
  let read: ObjectiveRoleReportReadResult
  try {
    read = await readObjectiveRoleReport({
      target: validationTarget,
      attemptFingerprint: args.attempt.fingerprint,
      mailboxReportPath: evidence.reportPath,
      role: reportRole,
      ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {})
    })
  } catch (error) {
    const errorCode = getErrorCode(error) ?? null
    return validationFailure(
      provenance(
        'unverifiable',
        'read-unverifiable',
        errorCode === null
          ? 'Report authority could not be read'
          : `Report authority could not be read (${errorCode})`
      )
    )
  }
  if (!read.ok) {
    return validationFailure(provenance('rejected', read.reason, read.detail))
  }
  const validation = validateResolvedDispatchReport({
    ...args,
    dispatchId,
    attemptFingerprint: args.attempt.fingerprint,
    reportPath: evidence.reportPath,
    report: read.report,
    evidenceFiles: evidence.filesModified
  })
  if (!validation.ok) {
    return validationFailure(validation.reportValidation)
  }
  if (args.action.kind === 'dispatch-node' || args.action.kind === 'dispatch-integrator') {
    const baselineFingerprint = dispatchRecord
      ? args.attempt.fingerprint
      : args.action.kind === 'dispatch-node' && args.action.retryOf !== undefined
        ? requireObjectiveOriginalDispatchFingerprint(args.ledger, args.action.retryOf)
        : args.attempt.fingerprint
    let observed: ObjectiveWorkspaceChangesValidation
    try {
      observed = await validateObjectiveWorkspaceChanges({
        target: validationTarget,
        attemptFingerprint: baselineFingerprint,
        reportedFiles: evidence.filesModified,
        writeTerritory: args.binding.contract.writeTerritory
      })
    } catch (error) {
      const errorCode = getErrorCode(error) ?? null
      return validationFailure(
        createReportValidationProvenance({
          status: 'unverifiable',
          code: 'workspace-invalid',
          role,
          dispatchId,
          ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {}),
          reportPath: evidence.reportPath,
          detail:
            errorCode === null
              ? 'Workspace authority could not be read'
              : `Workspace authority could not be read (${errorCode})`,
          reportedFiles: evidence.filesModified,
          hostVerifiable: false
        })
      )
    }
    if (!observed.ok) {
      const hostVerifiable =
        !observed.reason.startsWith('objective-workspace-route-') &&
        !observed.reason.startsWith('objective-workspace-baseline-') &&
        observed.reason !== 'objective-workspace-observation-failed'
      return validationFailure(
        createReportValidationProvenance({
          status: hostVerifiable ? 'rejected' : 'unverifiable',
          code: 'workspace-invalid',
          role,
          dispatchId,
          ...(args.action.kind === 'dispatch-node' ? { taskKey: args.action.taskKey } : {}),
          reportPath: evidence.reportPath,
          detail: observed.reason,
          reportedFiles: evidence.filesModified,
          observedFiles: observed.observedFiles ?? [],
          hostVerifiable
        })
      )
    }
  }
  if (evidence.outcome === 'failed') {
    const deterministicClass = classifyValidatedReportFailure(read.report, args.action)
    return persistDispatchFailure(failed(deterministicClass))
  }
  return { effect: 'landed' }
}
