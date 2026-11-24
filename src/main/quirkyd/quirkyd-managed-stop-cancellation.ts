/** Withdrawing a managed stop request that the running quirkyd has not acted on yet. */
import { rmSync } from 'node:fs'
import type {
  QuirkydManagedStopCancellation,
  QuirkydManagedStopRequest
} from '../../shared/quirkyd-stop-request'
import { claimQuirkydManagedStopDecision } from './quirkyd-managed-stop-decision'
import {
  quirkydManagedStopRequestPath,
  readQuirkydManagedStopRequest
} from './quirkyd-managed-stop-request'

/** `dispatched` means quirkyd already began stopping; only its completion can say how it ended. */
export function cancelQuirkydManagedStop(
  request: QuirkydManagedStopRequest
): QuirkydManagedStopCancellation['outcome'] {
  const outcome = claimQuirkydManagedStopDecision(request, 'canceled')
  if (outcome === 'canceled') {
    withdrawQuirkydManagedStopRequest(request)
  }
  return outcome
}

/** Removes the request file only while it still carries this transaction. */
export function withdrawQuirkydManagedStopRequest(request: QuirkydManagedStopRequest): void {
  const path = quirkydManagedStopRequestPath(request.instance)
  try {
    if (readQuirkydManagedStopRequest(path).transactionId === request.transactionId) {
      rmSync(path, { force: true })
    }
  } catch {
    // Absent or another transaction's request: the standing decision already fences this one.
  }
}
