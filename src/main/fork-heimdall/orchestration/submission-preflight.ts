import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { FederationRuntime } from '../../runtime/orchestration/federation-runtime'
import type { MessageType, OrchestrationDb } from '../../runtime/orchestration/db'
import type { RelayedMessage } from '../../runtime/orchestration/federation-sync-message'

export type OrchestrationSubmission = Readonly<{
  runId: string
  dispatchId?: string
  from: string
  type: string
  subject: string
  body?: string
  payload?: string
}>

export type OrchestrationSubmissionPreflightResult =
  | { status: 'accepted' }
  | { status: 'rejected'; code: string; reason: string }

export type OrchestrationSubmissionPreflight = (
  submission: OrchestrationSubmission
) => Promise<OrchestrationSubmissionPreflightResult>

const preflights = new WeakMap<FederationRuntime, OrchestrationSubmissionPreflight>()

export function bindOrchestrationSubmissionPreflight(
  runtime: QuirkyRuntimeService,
  preflight: OrchestrationSubmissionPreflight
): void {
  preflights.set(runtime, preflight)
}

export async function preflightOrchestrationSubmission(
  runtime: FederationRuntime,
  submission: OrchestrationSubmission
): Promise<OrchestrationSubmissionPreflightResult> {
  const preflight = preflights.get(runtime)
  return preflight ? await preflight(submission) : { status: 'accepted' }
}

type RejectedSubmissionReceipt = {
  lifecycle: { action: 'rejected'; code: string; reason: string }
}

export async function preflightPointToPointHeimdallSubmission(args: {
  runtime: QuirkyRuntimeService
  runId?: string
  dispatchId?: string
  from: string
  messageType: MessageType
  subject: string
  body?: string
  payload?: string
  authorized: boolean
}): Promise<RejectedSubmissionReceipt | null> {
  if (
    !args.authorized ||
    !args.runId ||
    (args.messageType !== 'worker_done' && args.messageType !== 'status')
  ) {
    return null
  }
  const preflight = await preflightOrchestrationSubmission(args.runtime, {
    runId: args.runId,
    ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
    from: args.from,
    type: args.messageType,
    subject: args.subject,
    ...(args.body === undefined ? {} : { body: args.body }),
    ...(args.payload === undefined ? {} : { payload: args.payload })
  })
  return preflight.status === 'rejected'
    ? {
        lifecycle: {
          action: 'rejected',
          code: preflight.code,
          reason: preflight.reason
        }
      }
    : null
}

type FederatedLifecycle =
  | { kind: 'none' }
  | { kind: 'heartbeat'; at: string }
  | { kind: 'worker_report'; taskId: string; outcome: 'succeeded' | 'failed'; result: string }
  | {
      kind: 'terminal_rejection'
      taskId: string
      code: string
      reason: string
      originalReason: string
      result: string
    }
  | { kind: 'rejected'; code: string; reason: string; suppressMessage?: boolean }

export async function preflightFederatedHeimdallSubmission(args: {
  runtime: FederationRuntime
  db: OrchestrationDb
  dispatch: {
    id: string
    run_id: string
    task_id: string
    status: string
  }
  itemSequence: number
  importedSequence: number
  message: RelayedMessage
  boundPayload?: string
  lifecycle: FederatedLifecycle
  supportsCorrectiveResend: boolean
}): Promise<FederatedLifecycle> {
  if (!preflights.has(args.runtime)) {
    return args.lifecycle
  }
  const task =
    args.lifecycle.kind === 'worker_report' ? args.db.getTask(args.lifecycle.taskId) : undefined
  if (
    args.lifecycle.kind !== 'worker_report' ||
    args.itemSequence <= args.importedSequence ||
    (args.dispatch.status !== 'pending' && args.dispatch.status !== 'dispatched') ||
    task?.status !== 'dispatched' ||
    task.id !== args.dispatch.task_id
  ) {
    return args.lifecycle
  }
  const reportLifecycle = args.lifecycle
  const preflight = await preflightOrchestrationSubmission(args.runtime, {
    runId: args.dispatch.run_id,
    dispatchId: args.dispatch.id,
    from: `dispatch:${args.dispatch.id}`,
    type: args.message.type,
    subject: args.message.subject,
    body: args.message.body,
    ...(args.boundPayload === undefined ? {} : { payload: args.boundPayload })
  })
  if (preflight.status !== 'rejected') {
    return args.lifecycle
  }
  if (args.supportsCorrectiveResend) {
    return {
      kind: 'rejected',
      code: preflight.code,
      reason: preflight.reason,
      suppressMessage: true
    }
  }
  return {
    kind: 'terminal_rejection',
    taskId: reportLifecycle.taskId,
    code: preflight.code,
    originalReason: preflight.reason,
    reason: legacyTerminalRejectionReason(preflight),
    result: legacyTerminalRejectionResult(reportLifecycle, preflight)
  }
}

function legacyTerminalRejectionReason(
  rejection: Extract<OrchestrationSubmissionPreflightResult, { status: 'rejected' }>
): string {
  return (
    `Heimdall rejected this worker report during Run-home validation (${rejection.code}). ` +
    'The exact validation cause is preserved with the rejection evidence and in the Task result. ' +
    'No same-Dispatch correction is available because the execution peer does not support ' +
    'Run-home lifecycle settlement, so this Dispatch is terminal. An operator must verify that ' +
    'no live work remains before authorizing a fresh Dispatch.'
  )
}

function legacyTerminalRejectionResult(
  lifecycle: Extract<FederatedLifecycle, { kind: 'worker_report' }>,
  rejection: Extract<OrchestrationSubmissionPreflightResult, { status: 'rejected' }>
): string {
  let report: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(lifecycle.result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      report = Object.fromEntries(Object.entries(parsed))
    }
  } catch {
    // The canonical parser authors this JSON. Keep the terminal failure useful if persisted data is corrupt.
  }
  return JSON.stringify({
    ...report,
    provenance: 'worker_report_rejected',
    outcome: 'failed',
    reportedOutcome: lifecycle.outcome,
    preflightRejection: {
      code: rejection.code,
      reason: rejection.reason,
      correctiveResendAvailable: false
    },
    correction: {
      kind: 'fresh_dispatch_required_after_operator_review',
      detail:
        'This legacy Dispatch is terminal. Verify that no live work remains before authorizing a fresh Dispatch.'
    }
  })
}
