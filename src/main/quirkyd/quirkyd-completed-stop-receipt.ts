/** Durable outcomes of a managed stop, in the data root beside the instance lock. */
import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import {
  QUIRKYD_STOP_RECEIPTS_DIRNAME,
  QuirkydCompletedStopReceiptSchema,
  QuirkydManagedStopRequestSchema,
  QuirkydDaemonRetirementRecordSchema,
  quirkydManagedStopRequestKey,
  type QuirkydCompletedStopReceipt,
  type QuirkydDaemonRetirementRecord,
  type QuirkydManagedStopRequest
} from '../../shared/quirkyd-stop-request'

const RECEIPT_MAX_BYTES = 64 * 1024

export type ReceiptKind = 'completed' | 'retirement' | 'decision'

export function quirkydStopReceiptPath(
  request: QuirkydManagedStopRequest,
  kind: ReceiptKind
): string {
  const { transactionId, instance } = QuirkydManagedStopRequestSchema.parse(request)
  const suffix = kind === 'completed' ? '' : `.${kind}`
  return join(
    dirname(instance.lockPath),
    QUIRKYD_STOP_RECEIPTS_DIRNAME,
    `${transactionId}${suffix}.json`
  )
}

/** `null` when absent; a receipt for a different request throws rather than reading as absent. */
export function readQuirkydStopReceipt<T extends { request: QuirkydManagedStopRequest }>(
  request: QuirkydManagedStopRequest,
  kind: ReceiptKind,
  schema: z.ZodType<T>
): T | null {
  const path = quirkydStopReceiptPath(request, kind)
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error('quirkyd_stop_receipt_unverifiable')
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  const receipt = schema.parse(
    JSON.parse(readNodeFileSyncWithinLimit(path, RECEIPT_MAX_BYTES).buffer.toString('utf8'))
  )
  if (quirkydManagedStopRequestKey(receipt.request) !== quirkydManagedStopRequestKey(request)) {
    throw new Error('quirkyd_stop_receipt_mismatch')
  }
  return receipt
}

function writeReceipt(
  request: QuirkydManagedStopRequest,
  kind: ReceiptKind,
  receipt: unknown
): void {
  if (!writeDurableSecureJsonFile(quirkydStopReceiptPath(request, kind), receipt)) {
    throw new Error('quirkyd_stop_receipt_permissions_unconfirmed')
  }
}

export function readQuirkydCompletedStopReceipt(
  request: QuirkydManagedStopRequest
): QuirkydCompletedStopReceipt | null {
  return readQuirkydStopReceipt(request, 'completed', QuirkydCompletedStopReceiptSchema)
}

/**
 * Called only after exit is proven; rewriting an existing receipt re-runs its fsync. A retiring
 * request whose quirkyd left no retirement record reports `unverifiable`, never `retired`.
 */
export function persistQuirkydCompletedStopReceipt(
  request: QuirkydManagedStopRequest,
  exitedAt: Date
): QuirkydCompletedStopReceipt {
  const parsed = QuirkydManagedStopRequestSchema.parse(request)
  const retirement = parsed.retireIdleDaemon
    ? (readQuirkydDaemonRetirementRecord(parsed)?.retirement ?? 'unverifiable')
    : undefined
  const receipt = readQuirkydCompletedStopReceipt(parsed) ?? {
    schemaVersion: 1 as const,
    kind: 'quirkyd_managed_stop_completed' as const,
    request: parsed,
    exitedAt: exitedAt.toISOString(),
    ...(retirement ? { retirement } : {})
  }
  writeReceipt(parsed, 'completed', receipt)
  return receipt
}

export function readQuirkydDaemonRetirementRecord(
  request: QuirkydManagedStopRequest
): QuirkydDaemonRetirementRecord | null {
  return readQuirkydStopReceipt(request, 'retirement', QuirkydDaemonRetirementRecordSchema)
}

export function persistQuirkydDaemonRetirementRecord(
  request: QuirkydManagedStopRequest,
  outcome: Pick<QuirkydDaemonRetirementRecord, 'retirement' | 'liveSessions' | 'reason'>
): void {
  writeReceipt(request, 'retirement', {
    schemaVersion: 1,
    kind: 'quirkyd_managed_stop_retirement',
    request: QuirkydManagedStopRequestSchema.parse(request),
    // Named, not spread: an in-process outcome may carry fields the strict record rejects.
    retirement: outcome.retirement,
    liveSessions: outcome.liveSessions,
    reason: outcome.reason
  })
}
