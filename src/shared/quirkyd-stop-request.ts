/**
 * Stop requests for a running quirkyd, as files beside the process they address.
 *
 * Why files and not signals: a PID can be reused once its process exits, so a signal sent
 * from a stale record can stop an unrelated process. A file in the slot or data root reaches
 * only the quirkyd that watches it.
 */
import { z } from 'zod'
import { openEnum } from './zod-salvage'

/** Plain request in the slot directory: the same graceful stop as SIGTERM. */
export const QUIRKYD_STOP_REQUEST_FILENAME = '.quirkyd-stop-request'
/** Prefix of an instance-bound request in the data root; older listeners never match it. */
export const QUIRKYD_MANAGED_STOP_REQUEST_PREFIX = '.quirkyd-managed-stop-request'
export const QUIRKYD_MANAGED_STOP_REQUEST_MAX_BYTES = 32 * 1024
export const QUIRKYD_STOP_RECEIPTS_DIRNAME = 'quirkyd-stop-receipts'
export const QUIRKYD_COMPLETE_MANAGED_STOP_FLAG = '--complete-managed-stop'
/** Names a staged request file instead of inline JSON; Windows hosts never put the JSON on argv. */
export const QUIRKYD_MANAGED_STOP_REQUEST_FILE_FLAG = '--request-file'

/** One quirkyd process: its PID, start time, and the instance lock record it published. */
export const QuirkydManagedStopInstanceSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** Linux only, copied from the lock; older clients omit it and older slots drop it. */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  nonce: z.string().min(1).max(255),
  lockPath: z.string().min(1).max(4096)
})

// Not strict: the slot's own (possibly older) build parses what a newer client wrote, so an
// unknown optional field is dropped rather than refusing the stop.
export const QuirkydManagedStopRequestSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.uuid(),
  version: z.string().min(1).max(255),
  runtimeId: z.string().min(1).max(255),
  instance: QuirkydManagedStopInstanceSchema,
  /** Best effort: also retire the terminal daemon if it is provably idle. Never blocks the stop. */
  retireIdleDaemon: z.literal(true).optional()
})

export type QuirkydManagedStopInstance = z.infer<typeof QuirkydManagedStopInstanceSchema>
export type QuirkydManagedStopRequest = z.infer<typeof QuirkydManagedStopRequestSchema>

/** Equality key for a request; omits the incarnation, which an older client recovering it drops. */
export function quirkydManagedStopRequestKey(request: QuirkydManagedStopRequest): string {
  const { instance, ...rest } = QuirkydManagedStopRequestSchema.parse(request)
  const { linuxStartTicks: _ticks, bootId: _bootId, ...bound } = instance
  return JSON.stringify({ ...rest, instance: bound })
}
/** What a stopping quirkyd must match before a managed request may stop it. */
export type QuirkydManagedStopContext = Omit<
  QuirkydManagedStopRequest,
  'schemaVersion' | 'transactionId'
>

const STOP_VERDICTS = ['live', 'unverifiable', 'exited'] as const
const RETIREMENT_VERDICTS = ['retired', 'live', 'unverifiable'] as const

/** The execution host's verdict; `exited` only on proof, never on silence. */
export const QuirkydManagedStopVerdictSchema = z.enum(STOP_VERDICTS)

/** `retired` only when the daemon accepted; a busy daemon stays up and keeps its terminals. */
export const QuirkydDaemonRetirementVerdictSchema = z.enum(RETIREMENT_VERDICTS)

// Read by clients older than the slot that printed them: unknown fields and arms degrade.
const stopReplyRequestFields = QuirkydManagedStopRequestSchema.shape

export const QuirkydManagedStopCompletionSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('quirkyd_managed_stop_completion'),
  verdict: openEnum(STOP_VERDICTS, 'unverifiable'),
  receiptPersisted: z.boolean(),
  /** For a request that asked to retire the daemon, the outcome its receipt recorded. */
  retirement: openEnum(RETIREMENT_VERDICTS, 'unverifiable').optional()
})

/** What the stopping quirkyd observed about its daemon, written before it exits. */
export const QuirkydDaemonRetirementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('quirkyd_managed_stop_retirement'),
  request: QuirkydManagedStopRequestSchema,
  retirement: QuirkydDaemonRetirementVerdictSchema,
  liveSessions: z.number().int().nonnegative().nullable(),
  reason: z.string().max(4096).nullable()
})

export const QuirkydCompletedStopReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('quirkyd_managed_stop_completed'),
  request: QuirkydManagedStopRequestSchema,
  exitedAt: z.iso.datetime({ offset: true }),
  /** Present only when the request asked to retire the daemon. */
  retirement: QuirkydDaemonRetirementVerdictSchema.optional()
})

export type QuirkydManagedStopVerdict = z.infer<typeof QuirkydManagedStopVerdictSchema>
export type QuirkydManagedStopCompletion = z.infer<typeof QuirkydManagedStopCompletionSchema>
export type QuirkydCompletedStopReceipt = z.infer<typeof QuirkydCompletedStopReceiptSchema>
export type QuirkydDaemonRetirementVerdict = z.infer<typeof QuirkydDaemonRetirementVerdictSchema>
export type QuirkydDaemonRetirementRecord = z.infer<typeof QuirkydDaemonRetirementRecordSchema>

export const QUIRKYD_CANCEL_MANAGED_STOP_FLAG = '--cancel-managed-stop'
/** Readiness `health.stopRequests`: this build consumes stop files and both commands above. */
export const QUIRKYD_STOP_REQUESTS_CAPABILITY = 1

/**
 * Which side won a managed request: the running quirkyd acting on it, or a client cancelling it.
 * Created exclusively once per transaction, so the two can never both believe they won.
 */
export const QuirkydManagedStopDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('quirkyd_managed_stop_decision'),
  request: QuirkydManagedStopRequestSchema,
  decision: z.enum(['dispatched', 'canceled'])
})

/** `dispatched` means quirkyd already acted on the request; the caller must await its exit. */
export const QuirkydManagedStopCancellationSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('quirkyd_managed_stop_cancellation'),
  // Unknown degrades to `dispatched`: the caller then awaits exit rather than assume a cancel.
  outcome: openEnum(['canceled', 'dispatched'], 'dispatched')
})

export type QuirkydManagedStopDecision = z.infer<typeof QuirkydManagedStopDecisionSchema>
export type QuirkydManagedStopCancellation = z.infer<typeof QuirkydManagedStopCancellationSchema>
