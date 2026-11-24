import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { MessageRow, OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { checkRunMailbox } from '../../runtime/rpc/methods/orchestration/messaging/check-run'
import type { EvidenceEntry, LedgerEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { parseLifecycleRejectionPayload } from './lifecycle-rejection-payload'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export type MailboxCursor = Readonly<{
  previousDeliveryId: string | null
  lastSequence: number
}>

export type MailboxDrainInput = Readonly<{
  enrollment: WatcherEnrollment
  cursor: MailboxCursor
}>

type MailboxCheckResult = {
  runId: string
  deliveryId: string | null
  messages: { id: string }[]
}

export async function drainHeimdallMailbox(input: {
  runtime: QuirkyRuntimeService
  enrollment: WatcherEnrollment
  run: RunRow
  cursor: MailboxCursor
}): Promise<LedgerEntry[]> {
  assertMailboxCursor(input.cursor)
  const db = input.runtime.getOrchestrationDb()
  const identity = input.enrollment.coordinatorIdentity
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checkRunMailbox is intentionally typed Promise<unknown>; this module keeps its own narrow view of the mailbox check result.
  const checked = (await checkRunMailbox({
    params: {
      terminal: identity.handle,
      terminalPaneKey: identity.paneKey,
      run: input.run.id,
      ...(input.cursor.previousDeliveryId ? { ack: input.cursor.previousDeliveryId } : {})
    },
    runtime: input.runtime,
    db,
    handle: identity.handle,
    paneKey: identity.paneKey,
    callerSession: undefined,
    typeFilter: undefined,
    signal: undefined,
    legacyCoordinatorRunId: undefined,
    revalidateLegacyCoordinator: undefined,
    orchestrationCompatibilityEvidence: undefined,
    recordMutationReceipt: undefined
  })) as MailboxCheckResult

  if (checked.runId !== input.run.id) {
    throw new OrchestrationError(
      'consumer_fenced',
      `Mailbox resolved Run ${checked.runId}, expected ${input.run.id}`
    )
  }
  if (checked.messages.length > 0 && !checked.deliveryId) {
    throw new Error(`Mailbox for Run ${input.run.id} returned messages without a delivery receipt`)
  }

  return checked.messages
    .map(({ id }) => requireMailboxMessage(db, input.run.id, id))
    .filter((message) => message.sequence > input.cursor.lastSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map((message) => mailboxEvidenceForMessage(input.enrollment, checked.deliveryId, message))
}

function assertMailboxCursor(cursor: MailboxCursor): void {
  if (!Number.isSafeInteger(cursor.lastSequence) || cursor.lastSequence < -1) {
    throw new Error('Mailbox lastSequence must be a safe integer greater than or equal to -1')
  }
}

function requireMailboxMessage(db: OrchestrationDb, runId: string, id: string): MessageRow {
  const message = db.getMessageById(id)
  if (!message || message.run_id !== runId) {
    throw new Error(`Mailbox message ${id} was not found in Run ${runId}`)
  }
  return message
}

export function mailboxEvidenceForMessage(
  enrollment: WatcherEnrollment,
  deliveryId: string | null,
  message: MessageRow,
  includeDeliverySource: boolean = true
): EvidenceEntry {
  const atMs = Date.parse(message.created_at)
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new Error(`Mailbox message ${message.id} has an invalid created_at timestamp`)
  }
  return {
    eventId: `orchestration-mail:${message.id}`,
    watcherId: enrollment.watcherId,
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    ...(includeDeliverySource
      ? {
          source: {
            kind: 'orchestration' as const,
            sequence: message.sequence,
            messageId: message.id,
            ...(deliveryId ? { deliveryId } : {})
          }
        }
      : {}),
    payload: normalizedMailboxFact(message)
  }
}

function normalizedMailboxFact(message: MessageRow): {
  type: MessageRow['type']
  subject?: string
  body?: string
  payload: {
    dispatchId?: string
    taskId?: string
    outcome?: string
    result?: unknown
    reportPath?: string
    filesModified?: unknown
    reportRejection?: { code: string; reason: string }
  }
} {
  let raw: Record<string, unknown> = {}
  if (message.payload) {
    try {
      const parsed: unknown = JSON.parse(message.payload)
      if (isRecord(parsed)) {
        raw = parsed
      }
    } catch {
      raw = {}
    }
  }
  const lifecycleRejection =
    message.type === 'worker_done' ? parseLifecycleRejectionPayload(raw) : null
  const reportRejection = lifecycleRejection
    ? { code: lifecycleRejection.code, reason: lifecycleRejection.reason }
    : null
  return {
    type: message.type,
    payload: {
      ...(typeof raw.dispatchId === 'string' ? { dispatchId: raw.dispatchId } : {}),
      ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      ...(message.type === 'worker_done' && reportRejection
        ? { outcome: 'failed' }
        : message.type === 'worker_done' && typeof raw.outcome === 'string'
          ? { outcome: raw.outcome }
          : {}),
      ...(message.type === 'worker_done' && typeof raw.reportPath === 'string'
        ? { reportPath: raw.reportPath }
        : {}),
      ...(message.type === 'worker_done' && Object.hasOwn(raw, 'filesModified')
        ? { filesModified: raw.filesModified }
        : {}),
      ...(message.type === 'worker_done'
        ? {
            result: reportRejection
              ? {
                  body: lifecycleRejection?.originalBody ?? message.body,
                  reportRejection
                }
              : message.body,
            ...(reportRejection ? { reportRejection } : {})
          }
        : {})
    },
    ...(message.type === 'status' || message.type === 'escalation'
      ? { subject: message.subject }
      : {}),
    ...(message.type === 'status' || message.type === 'question' || message.type === 'escalation'
      ? { body: message.body }
      : {})
  }
}
