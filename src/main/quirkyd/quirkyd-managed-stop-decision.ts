/**
 * Arbitrating a managed request between the quirkyd acting on it and a client cancelling it.
 *
 * Both sides race to create one decision file per transaction with a hard link, which fails if
 * the file exists. Exactly one wins, and the loser reads the winner's decision, so a cancel can
 * never report success for a stop that quirkyd already began.
 */
import { linkSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  QuirkydManagedStopDecisionSchema,
  QuirkydManagedStopRequestSchema,
  type QuirkydManagedStopDecision,
  type QuirkydManagedStopRequest
} from '../../shared/quirkyd-stop-request'
import { quirkydStopReceiptPath, readQuirkydStopReceipt } from './quirkyd-completed-stop-receipt'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

export type QuirkydManagedStopDecisionValue = QuirkydManagedStopDecision['decision']

export function readQuirkydManagedStopDecision(
  request: QuirkydManagedStopRequest
): QuirkydManagedStopDecisionValue | null {
  return (
    readQuirkydStopReceipt(request, 'decision', QuirkydManagedStopDecisionSchema)?.decision ?? null
  )
}

/** Returns the decision that stands: ours if we created it first, otherwise the other side's. */
export function claimQuirkydManagedStopDecision(
  input: QuirkydManagedStopRequest,
  decision: QuirkydManagedStopDecisionValue
): QuirkydManagedStopDecisionValue {
  const request = QuirkydManagedStopRequestSchema.parse(input)
  const path = quirkydStopReceiptPath(request, 'decision')
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`
  const record: QuirkydManagedStopDecision = {
    schemaVersion: 1,
    kind: 'quirkyd_managed_stop_decision',
    request,
    decision
  }
  if (!writeDurableSecureJsonFile(staged, record)) {
    rmSync(staged, { force: true })
    throw new Error('quirkyd_managed_stop_decision_permissions_unconfirmed')
  }
  try {
    linkSync(staged, path)
    return decision
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error
    }
    const standing = readQuirkydManagedStopDecision(request)
    if (!standing) {
      throw new Error('quirkyd_managed_stop_decision_unverifiable')
    }
    return standing
  } finally {
    rmSync(staged, { force: true })
  }
}
