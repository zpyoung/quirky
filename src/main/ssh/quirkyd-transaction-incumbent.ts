/** The incumbent slot across a journaled activation or rollback: stop it, then put it back. */
import type { QuirkydActivationLockControl } from '../managed-server/activation/quirkyd-activation-lock'
import type { QuirkydSnapshotVerdict } from '../managed-server/activation/quirkyd-activation-transaction'
import { quirkydStopFreedTheHost } from '../managed-server/install/quirkyd-remote-process-control'
import { withoutAbortSignal } from '../managed-server/install/quirkyd-remote-runtime-control'
import {
  launchQuirkydSlot,
  stopQuirkydSlot,
  QUIRKYD_SLOT_STOP_WAIT_SECONDS,
  type QuirkydSlotIdentity,
  type QuirkydSlotOptions
} from './quirkyd-recovery-slot'
import { recoverQuirkydIncumbent } from './quirkyd-incumbent-recovery'
import { errorMessage } from '../../shared/error-message'

/**
 * Null once the incumbent provably exited; otherwise why not, and whether a stop may be underway,
 * with the fence kept if so.
 */
export async function stopTransactionIncumbent(
  options: QuirkydSlotOptions,
  incumbent: QuirkydSlotIdentity,
  lock: QuirkydActivationLockControl
): Promise<{ reason: string; stopMayBeUnderway: boolean } | null> {
  const stopped = await stopQuirkydSlot(options, incumbent.remoteDir, false)
  if (quirkydStopFreedTheHost(stopped)) {
    return null
  }
  // Only a stop that may have been delivered can still change the host; otherwise nothing happened.
  const stopMayBeUnderway = stopped === 'still-running' || stopped === 'unconfirmed'
  if (stopMayBeUnderway) {
    lock.retain()
  }
  return {
    reason:
      `Could not verify that quirkyd ${incumbent.version} exited within ` +
      `${QUIRKYD_SLOT_STOP_WAIT_SECONDS}s (${stopped}).`,
    stopMayBeUnderway
  }
}

export async function restartAfterSnapshotFailure(
  options: QuirkydSlotOptions,
  incumbent: QuirkydSlotIdentity,
  lock: QuirkydActivationLockControl
): Promise<string> {
  try {
    await launchQuirkydSlot(withoutAbortSignal(options), incumbent)
    lock.recovered()
    return `quirkyd ${incumbent.version} was restarted and is serving again.`
  } catch (error) {
    lock.retain()
    return `restarting quirkyd ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/**
 * Restores `restoreState` when it was replaced, then restarts the incumbent; both slots are
 * already proven exited. Null on success; otherwise why not, with the fence kept.
 */
export async function putTransactionIncumbentBack(
  options: QuirkydSlotOptions,
  lock: QuirkydActivationLockControl,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: QuirkydSlotIdentity | null
    restoreState: QuirkydSnapshotVerdict | null
    launchedFromState?: QuirkydSnapshotVerdict | null
  }
): Promise<string | null> {
  try {
    const recovery = await recoverQuirkydIncumbent(withoutAbortSignal(options), {
      ...input,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    lock.recovered()
    return null
  } catch (error) {
    lock.retain()
    return `Restoring the previous version failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Stop the build this run launched, then put the incumbent back only on safe state. */
export async function restoreAfterRejectedCandidate(
  options: QuirkydSlotOptions,
  lock: QuirkydActivationLockControl,
  input: {
    launchedDir: string
    launchedVersion: string
    transactionStartedAt: string
    incumbent: QuirkydSlotIdentity | null
    restoreState: QuirkydSnapshotVerdict | null
    launchedFromState?: QuirkydSnapshotVerdict | null
  }
): Promise<string> {
  const { launchedDir, ...restore } = input
  const stopped = await stopQuirkydSlot(withoutAbortSignal(options), launchedDir, true).catch(
    (error: unknown) => `unverifiable: ${errorMessage(error)}`
  )
  if (stopped !== 'stopped' && stopped !== 'already-exited') {
    lock.retain()
    return (
      `quirkyd ${input.launchedVersion} could not be confirmed stopped (${stopped}), so nothing ` +
      'was restored over state it may still own. This host requires recovery.'
    )
  }
  const failure = await putTransactionIncumbentBack(options, lock, restore)
  return (
    failure ??
    (input.incumbent
      ? `quirkyd ${input.incumbent.version} was restarted and is serving again.`
      : 'No previous version was active, so this host is now serving nothing.')
  )
}
