/**
 * Finishing an activation whose run ended after it launched the candidate, as that run would have:
 * the candidate commits only if it passes the same readiness gate, otherwise recovery undoes it.
 * Undoing first would stop a candidate that may already be serving and, once it changed state,
 * leave the host serving nothing until an operator accepts losing that state (P1-A).
 */
import type { ServeReadiness } from '../server/serve-readiness'
import { withActivatedVersion } from '../managed-server/activation/quirkyd-activation-record'
import { writeQuirkydActivationRecord } from '../managed-server/activation/quirkyd-activation-record-store'
import type { QuirkydActivateTransaction } from '../managed-server/activation/quirkyd-activation-transaction'
import { writeQuirkydActivationTransaction } from '../managed-server/activation/quirkyd-activation-transaction-store'
import { withQuirkydActivationCandidateReady } from '../managed-server/activation/quirkyd-activation-transaction-transitions'
import { QuirkydActiveReadinessError } from './quirkyd-active-readiness'
import { quirkydLivenessProvenExited } from '../managed-server/install/quirkyd-remote-launch'
import {
  QUIRKYD_RECOVERY_CHANGED_STATE_CODE,
  type QuirkydManagedRefusal
} from '../../shared/quirkyd-managed-runtime'
import {
  ensureQuirkydSlotServing,
  quirkydSlotDir,
  resolveQuirkydSlotIdentity,
  slotLiveness
} from './quirkyd-recovery-slot'
import type { QuirkydIncumbentRecoveryOptions } from './quirkyd-incumbent-recovery'

/**
 * Runs under a held fence. Null when the candidate cannot commit, so the caller undoes it; a
 * refusal leaves the host untouched for an operator.
 */
export async function resumeInterruptedQuirkydCandidate(
  options: QuirkydIncumbentRecoveryOptions,
  transaction: QuirkydActivateTransaction
): Promise<ServeReadiness | QuirkydManagedRefusal | null> {
  const snapshotState = transaction.snapshot.state
  const incumbent = transaction.recordBefore.active
  if (
    transaction.phase !== 'snapshot-captured' ||
    snapshotState === 'pending' ||
    // A serving incumbent holds the port and instance lock; undo keeps it.
    (incumbent !== null &&
      !quirkydLivenessProvenExited(await slotLiveness(options, quirkydSlotDir(options, incumbent))))
  ) {
    return null
  }
  const candidate = await resolveQuirkydSlotIdentity(options, transaction.candidateVersion)
  const candidateLiveness = await slotLiveness(options, candidate.remoteDir)
  // A journal from before the field cannot say which app started it; committing without that
  // drops the host-newer guard. Undoing a candidate that may be serving stops it, so only an
  // operator who accepts losing its changes may.
  if (transaction.candidateAppVersion === undefined) {
    if (quirkydLivenessProvenExited(candidateLiveness) || options.acceptChangedState) {
      return null
    }
    if (candidateLiveness === 'UNKNOWN') {
      throw new Error(`Could not tell whether quirkyd ${transaction.candidateVersion} is running.`)
    }
    return {
      outcome: 'refused',
      verdict: 'live',
      code: QUIRKYD_RECOVERY_CHANGED_STATE_CODE,
      reason:
        `An older Quirky left version ${transaction.candidateVersion} running without finishing ` +
        'its update, and did not record which app started it, so it was neither committed nor ' +
        'stopped. Recover to stop it, restore the prelaunch snapshot and restart the previous ' +
        'build; what it changed is discarded.'
    }
  }
  // An unprovable candidate process is left to undo, which rules it out before anything starts.
  if (candidateLiveness === 'UNKNOWN') {
    return null
  }
  let readiness: ServeReadiness
  try {
    readiness = await ensureQuirkydSlotServing(options, candidate)
  } catch (error) {
    // Only a verdict about the candidate sends it to undo; an unanswered host keeps the fence.
    if (error instanceof QuirkydActiveReadinessError && error.verdict !== 'unverifiable') {
      return null
    }
    throw error
  }
  const now = new Date()
  const recordAfter = withActivatedVersion(
    transaction.recordBefore,
    transaction.candidateVersion,
    snapshotState === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: transaction.candidateVersion,
          readableByVersion: incumbent,
          takenAt: transaction.startedAt
        }
      : null,
    now,
    transaction.candidateAppVersion ?? undefined
  )
  await writeQuirkydActivationTransaction(
    options,
    withQuirkydActivationCandidateReady(transaction, recordAfter, now)
  )
  await writeQuirkydActivationRecord(options, recordAfter)
  return readiness
}
