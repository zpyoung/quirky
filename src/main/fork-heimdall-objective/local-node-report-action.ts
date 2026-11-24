import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { requireObjectiveOriginalDispatchFingerprint } from '../../shared/fork-heimdall-objective/decision-context'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  parseAndValidateImplementerReport,
  type ImplementerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  findObjectiveDispatchAttempt,
  findObjectiveWorkerEvidence,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { resolveObjectiveDispatchTarget } from './dispatch-worktree'
import {
  invalidObjectiveReport,
  reportActionNaturalKey,
  verifyWorkerReportEvidence
} from './local-report-validation'
import { ObjectiveNodeIngestRejectedError } from './merge-train-git'
import {
  queueObjectiveDispatchReport,
  type QueueObjectiveDispatchReportResult
} from './merge-train-report'
import { validateObjectiveWorkspaceChanges } from './observed-workspace-changes'
import type { ObjectiveStore } from './objective-store'
import { readObjectiveRoleReport } from './report-ingestion'

type IngestNodeReportAction = Extract<ObjectiveAction, { kind: 'ingest-report' }>

export async function ingestObjectiveNodeReport(args: {
  action: IngestNodeReportAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  runtime?: QuirkyRuntimeService
}): Promise<ActionOutcome> {
  const origin = findObjectiveDispatchAttempt(args.context.ledger, args.action.dispatchId)
  if (
    origin?.action.kind !== 'dispatch-node' ||
    origin.action.revisionId !== args.action.revisionId ||
    origin.action.taskKey !== args.action.taskKey ||
    origin.action.contentIdentity !== args.action.dispatchedContentIdentity
  ) {
    return invalidObjectiveReport({
      reason: 'implementer-dispatch-mismatch',
      code: 'evidence-mismatch',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      detail: 'Ingest action does not match its implementer dispatch'
    })
  }
  const dispatchRecord = args.objectiveStore.dispatchForId(
    args.binding.enrollment.watcherId,
    args.action.dispatchId
  )
  if (
    dispatchRecord &&
    (dispatchRecord.revisionId !== args.action.revisionId ||
      dispatchRecord.taskKey !== args.action.taskKey)
  ) {
    return invalidObjectiveReport({
      reason: 'implementer-dispatch-record-mismatch',
      code: 'evidence-mismatch',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      detail: 'Durable dispatch record does not match the ingest action'
    })
  }
  if (
    dispatchRecord &&
    dispatchRecord.state !== 'running' &&
    dispatchRecord.state !== 'resolving-conflict'
  ) {
    return invalidObjectiveReport({
      reason: `objective-dispatch-${dispatchRecord.state}-report-stale`,
      code: 'evidence-mismatch',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      detail: 'Late worker report cannot change terminal or already-queued dispatch state'
    })
  }
  let target = args.binding.target
  if (dispatchRecord) {
    if (!args.runtime) {
      return invalidObjectiveReport({
        reason: 'objective-dispatch-runtime-unavailable',
        code: 'workspace-invalid',
        role: 'implementer',
        dispatchId: args.action.dispatchId,
        taskKey: args.action.taskKey,
        reportPath: args.action.reportPath,
        detail: 'Dispatch workspace runtime is unavailable',
        hostVerifiable: false
      })
    }
    try {
      target = await resolveObjectiveDispatchTarget(args.runtime, args.binding, dispatchRecord)
    } catch (error) {
      return invalidObjectiveReport({
        reason: 'objective-dispatch-workspace-route-unavailable',
        code: 'workspace-invalid',
        role: 'implementer',
        dispatchId: args.action.dispatchId,
        taskKey: args.action.taskKey,
        reportPath: args.action.reportPath,
        detail: error instanceof Error ? error.message : String(error),
        hostVerifiable: false
      })
    }
  }
  if (!args.action.orchestrationTaskId) {
    return invalidObjectiveReport({
      reason: 'implementer-task-id-missing',
      code: 'evidence-mismatch',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      detail: 'Accepted worker completion has no orchestration task id'
    })
  }
  const verification = verifyWorkerReportEvidence({
    evidence: findObjectiveWorkerEvidence(args.context.ledger, args.action.dispatchId),
    role: 'implementer',
    reasonPrefix: 'implementer',
    detailPrefix: 'Implementer',
    dispatchId: args.action.dispatchId,
    taskKey: args.action.taskKey,
    reportPath: args.action.reportPath,
    orchestrationTaskId: args.action.orchestrationTaskId
  })
  if (!verification.ok) {
    return verification.outcome
  }
  const evidence = verification.evidence
  const task =
    dispatchRecord?.task ?? args.objectiveStore.getTask(args.action.revisionId, args.action.taskKey)
  if (!task) {
    return invalidObjectiveReport({
      reason: 'implementer-task-missing',
      code: 'semantic-invalid',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      detail: `Task ${args.action.taskKey} is unavailable`
    })
  }
  const read = await readObjectiveRoleReport({
    target,
    attemptFingerprint: origin.attempt.fingerprint,
    mailboxReportPath: args.action.reportPath,
    role: 'implementer',
    taskKey: args.action.taskKey
  })
  if (!read.ok) {
    return invalidObjectiveReport({
      reason: `implementer-report-${read.reason}`,
      code: read.reason,
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      ...(read.detail === undefined ? {} : { detail: read.detail }),
      reportedFiles: evidence.filesModified
    })
  }
  let report: ImplementerReport
  try {
    report = parseAndValidateImplementerReport(
      read.report,
      task,
      args.binding.contract.writeTerritory
    )
  } catch (error) {
    return invalidObjectiveReport({
      reason: 'implementer-report-semantic-invalid',
      code: 'semantic-invalid',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      reportDigest: read.reportDigest,
      detail:
        error instanceof Error ? error.message : 'Implementer report semantic validation failed',
      reportedFiles: read.report.filesModified
    })
  }
  const reportedFiles = [...report.filesModified].sort().join('\0')
  if (
    reportedFiles !== [...args.action.filesModified].sort().join('\0') ||
    reportedFiles !== [...evidence.filesModified].sort().join('\0')
  ) {
    return invalidObjectiveReport({
      reason: 'implementer-files-modified-mismatch',
      code: 'files-mismatch',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      reportDigest: read.reportDigest,
      detail: 'Report filesModified does not match accepted worker completion evidence',
      reportedFiles: report.filesModified,
      observedFiles: evidence.filesModified
    })
  }
  const baselineFingerprint = dispatchRecord
    ? dispatchRecord.attemptFingerprint
    : origin.action.retryOf !== undefined
      ? requireObjectiveOriginalDispatchFingerprint(args.context.ledger, origin.action.retryOf)
      : origin.attempt.fingerprint
  const observed = await validateObjectiveWorkspaceChanges({
    target,
    attemptFingerprint: baselineFingerprint,
    reportedFiles: report.filesModified,
    writeTerritory: args.binding.contract.writeTerritory
  })
  if (!observed.ok) {
    const hostVerifiable =
      !observed.reason.startsWith('objective-workspace-route-') &&
      !observed.reason.startsWith('objective-workspace-baseline-') &&
      observed.reason !== 'objective-workspace-observation-failed'
    return invalidObjectiveReport({
      reason: observed.reason,
      code: 'workspace-invalid',
      role: 'implementer',
      dispatchId: args.action.dispatchId,
      taskKey: args.action.taskKey,
      reportPath: args.action.reportPath,
      reportDigest: read.reportDigest,
      detail: observed.reason,
      reportedFiles: report.filesModified,
      observedFiles: observed.observedFiles ?? [],
      hostVerifiable
    })
  }
  await args.context.lease.assertHeld()
  if (dispatchRecord) {
    let queued: QueueObjectiveDispatchReportResult
    try {
      queued = await queueObjectiveDispatchReport({
        record: dispatchRecord,
        target,
        objectiveStore: args.objectiveStore,
        lease: args.context.lease,
        reportPath: args.action.reportPath,
        report,
        reportDigest: read.reportDigest,
        completedAtMs: evidence.atMs
      })
    } catch (error) {
      return {
        effect: 'not-landed',
        // a rejected invariant cannot pass on replay without new evidence, unlike a transient
        // git/IO failure — route it to the failed-node path instead of retrying forever
        failureClass: error instanceof ObjectiveNodeIngestRejectedError ? 'criteria' : 'infra',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    await args.context.lease.assertHeld()
    if (queued.kind === 'conflict-context-missing') {
      return {
        effect: 'not-landed',
        failureClass: 'infra',
        reason: `Applied conflict dispatch ${queued.dispatchId} is unavailable`
      }
    }
    if (queued.kind === 'dispatch-not-queueable') {
      return invalidObjectiveReport({
        reason: `objective-dispatch-${queued.state}-report-stale`,
        code: 'evidence-mismatch',
        role: 'implementer',
        dispatchId: args.action.dispatchId,
        taskKey: args.action.taskKey,
        reportPath: args.action.reportPath,
        detail: 'Dispatch state changed before its report could be queued'
      })
    }
    if (queued.kind === 'conflict-checks-failed') {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'objective-conflict-check-failed',
        result: {
          command: queued.command,
          exitCode: queued.exitCode,
          timedOut: queued.timedOut,
          checkedTaskKeys: queued.checkedTaskKeys
        }
      }
    }
  } else {
    args.objectiveStore.recordNodeDispatch({
      watcherId: args.binding.enrollment.watcherId,
      revisionId: args.action.revisionId,
      taskKey: args.action.taskKey,
      orchestrationTaskId: args.action.orchestrationTaskId,
      dispatchId: args.action.dispatchId,
      dispatchedAtMs: evidence.atMs
    })
  }
  return {
    effect: 'landed',
    result: {
      kind: 'report-ingested',
      naturalKey: reportActionNaturalKey(args.action),
      digest: read.reportDigest
    }
  }
}
