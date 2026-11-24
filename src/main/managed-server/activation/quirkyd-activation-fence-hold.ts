/**
 * Why a fence answered "held": a run that is still working clears on its own and is retried on
 * a later connect. A stale fence with no journal is cleared here, since Recover would only drop it.
 * Only a stale lock over a journal, or a journal no fence guards, needs Recover: a live run
 * journals under a fresh fence too, and Recover cannot take a fresh fence anyway.
 */
import {
  quirkydActivationFenceExists,
  withStaleQuirkydActivationRecoveryLock,
  type QuirkydActivationLockOptions
} from './quirkyd-activation-lock'
import { readQuirkydActivationTransaction } from './quirkyd-activation-transaction-store'
import { quirkydActivationFenceLockDir } from './quirkyd-activation-transaction'
import { isRelayInstallLockStale } from '../install/remote-install-lock'
import { findExitedOwnLockToken } from '../../ssh/quirkyd-exited-own-lock'
import { quirkydRemoteBaseDir } from '../install/quirkyd-remote-windows-node'

export const QUIRKYD_ACTIVATION_FENCE_BUSY_CODE = 'quirkyd_activation_fence_busy'
const QUIRKYD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'quirkyd_activation_recovery_required'

type QuirkydActivationFenceRefusal = {
  code: string
  reason: string
  /** A stale fence no journal backed was cleared, so the attempt may run again at once. */
  cleared?: true
}

export async function quirkydActivationFenceRefusal(
  options: QuirkydActivationLockOptions,
  attempt: string
): Promise<QuirkydActivationFenceRefusal> {
  const lockDir = quirkydActivationFenceLockDir(options.host, options.remoteHome)
  // An unreadable answer reads as busy: retrying later is never wrong, a sticky failure can be.
  const journal = (await readQuirkydActivationTransaction(options).catch(() => null)) !== null
  const baseDir = quirkydRemoteBaseDir(options.host, options.remoteHome)
  const stale =
    (await findExitedOwnLockToken(options, lockDir, { baseDir, guardsStateMutation: true })) !==
      null || (await isRelayInstallLockStale(options.conn, lockDir, options.host))
  if (stale && !journal && (await clearAbandonedFence(options))) {
    // A wake or release cut short leaves a bare fence; Recover would only drop it (BUG-21).
    return {
      code: QUIRKYD_ACTIVATION_FENCE_BUSY_CODE,
      reason: `An abandoned fence held this host and was cleared; the ${attempt} is retried.`,
      cleared: true
    }
  }
  const stuck =
    stale || (journal && !(await quirkydActivationFenceExists(options).catch(() => true)))
  return stuck
    ? {
        code: QUIRKYD_ACTIVATION_RECOVERY_REQUIRED_CODE,
        reason: `An interrupted update or stop holds this host, so the ${attempt} did not start. Recover it first.`
      }
    : {
        code: QUIRKYD_ACTIVATION_FENCE_BUSY_CODE,
        reason: `Another run is changing this host’s Quirky server, so the ${attempt} did not start. It is retried on a later connect.`
      }
}

/** Takes the stale fence over and drops it, unless a journal appeared under it meanwhile. */
async function clearAbandonedFence(options: QuirkydActivationLockOptions): Promise<boolean> {
  try {
    return await withStaleQuirkydActivationRecoveryLock(options, async (lock) => {
      if (await readQuirkydActivationTransaction(options)) {
        lock.retain()
        return false
      }
      return true
    })
  } catch {
    // Another client took it first, or the host did not answer: classify as before.
    return false
  }
}
