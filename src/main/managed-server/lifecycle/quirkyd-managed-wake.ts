/**
 * Starting a managed quirkyd that is installed and activated but not running, most often one
 * that stopped itself after idling. A stopped server is just "not running": it is neither a
 * failure nor evidence about terminals, which the daemon owns and which outlive quirkyd.
 */
import { QUIRKYD_FENCE_OWNER_FILENAME } from '../activation/quirkyd-activation-fence-scope'
import type { ServeReadiness } from '../../server/serve-readiness'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import { randomUUID } from 'node:crypto'
import {
  quirkydActivationFenceExists,
  releaseQuirkydActivationFence,
  withQuirkydActivationLock
} from '../activation/quirkyd-activation-lock'
import { quirkydLivenessProvenExited } from '../install/quirkyd-remote-launch'
import { readBoundedQuirkydRemoteRecord } from '../install/quirkyd-remote-record-file'
import { quirkydActivationFenceLockDir } from '../activation/quirkyd-activation-transaction'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'

import { readQuirkydActivationTransaction } from '../activation/quirkyd-activation-transaction-store'
import {
  QUIRKYD_RECOVERY_UNVERIFIABLE_CODE,
  recoverInterruptedQuirkydActivation
} from '../activation/quirkyd-activation-recovery'
import {
  ensureQuirkydSlotServing,
  quirkydSlotDir,
  resolveQuirkydSlotIdentity,
  slotLiveness,
  type QuirkydSlotOptions
} from '../../ssh/quirkyd-recovery-slot'

export type QuirkydManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  /** An update, rollback or recovery holds the host; it owns which slot serves. */
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }
  /** An abandoned update or rollback that recovery could not finish without an operator. */
  | { outcome: 'recovery-refused'; reason: string }

/** Launches the active slot only on proven exit; a live or unprovable process is left alone. */
export function wakeStoppedManagedQuirkyd(
  options: QuirkydSlotOptions,
  onStarting: () => void = () => {}
): Promise<QuirkydManagedWake> {
  const host = wakeHostKey(options)
  // Registered before any remote step: a wake on a dropped connection settles first, so a
  // reconnected wake never races it to the fence and finds its fence unexplained.
  const prior = runningWakes.get(host)
  const wake = (async (): Promise<QuirkydManagedWake> => {
    await prior?.catch(() => {})
    return wakeAfterPrior(options, host, onStarting)
  })()
  runningWakes.set(host, wake)
  void wake
    .catch(() => {})
    .finally(() => {
      if (runningWakes.get(host) === wake) {
        runningWakes.delete(host)
      }
    })
  return wake
}

/** One wake, after any earlier one for the same host has settled. */
async function wakeAfterPrior(
  options: QuirkydSlotOptions,
  host: string,
  onStarting: () => void
): Promise<QuirkydManagedWake> {
  const before = await readQuirkydActivationRecord(options)
  if (!before.active) {
    return { outcome: 'not-activated' }
  }
  const liveness = await slotLiveness(options, quirkydSlotDir(options, before.active))
  if (!quirkydLivenessProvenExited(liveness)) {
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  if (!(await quirkydActivationFenceExists(options))) {
    // The fence this client left is gone by some other route; any later one belongs to another run.
    interruptedWakes.delete(host)
  } else if (!(await releaseOwnInterruptedWakeFence(options, host))) {
    const recovered = await recoverAbandonedFence(options, onStarting)
    if (recovered) {
      return recovered
    }
  }
  // Claimed before the fence and written by the command that creates it: a drop at any point
  // after the fence lands leaves one this client can prove its own. Kept on any failure, since a
  // release over a dropped connection fails quietly; the next wake re-proves it on the host.
  const token = randomUUID()
  interruptedWakes.set(host, token)
  const result = await withQuirkydActivationLock(
    options,
    async (): Promise<QuirkydManagedWake> => {
      // Re-read under the fence: another client may have activated or started a slot meanwhile.
      const active = (await readQuirkydActivationRecord(options)).active
      if (!active) {
        return { outcome: 'not-activated' }
      }
      const identity = await resolveQuirkydSlotIdentity(options, active)
      onStarting()
      return { outcome: 'started', readiness: await ensureQuirkydSlotServing(options, identity) }
    },
    (): QuirkydManagedWake => ({ outcome: 'fenced' }),
    token
  )
  // Released, or never acquired.
  if (interruptedWakes.get(host) === token) {
    interruptedWakes.delete(host)
  }
  return result
}

/**
 * An update or rollback whose client quit or crashed leaves a journal nobody finishes, so a later
 * reboot would serve nothing until a manual Recover (P1-A). Recovery takes only a stale,
 * previous-boot or exited-own fence; a run still working answers busy. Null: the fence is gone.
 */
async function recoverAbandonedFence(
  options: QuirkydSlotOptions,
  onStarting: () => void
): Promise<QuirkydManagedWake | null> {
  const recovery = await recoverInterruptedQuirkydActivation(options)
  switch (recovery.outcome) {
    case 'none':
      return null
    case 'pending':
      return { outcome: 'fenced' }
    case 'refused':
      // A step the host did not answer is retried on the fence recheck, like a busy fence.
      return recovery.code === QUIRKYD_RECOVERY_UNVERIFIABLE_CODE
        ? { outcome: 'fenced' }
        : { outcome: 'recovery-refused', reason: recovery.reason }
    case 'recovered':
      if (!recovery.readiness) {
        return { outcome: 'not-activated' }
      }
      onStarting()
      return { outcome: 'started', readiness: recovery.readiness }
  }
}

const runningWakes = new Map<string, Promise<QuirkydManagedWake>>()

// The owner token of a fence this client's own wake may have left when its connection dropped.
const interruptedWakes = new Map<string, string>()

function wakeOwnerPath(options: QuirkydSlotOptions): string {
  return joinRemotePath(
    options.host,
    quirkydActivationFenceLockDir(options.host, options.remoteHome),
    QUIRKYD_FENCE_OWNER_FILENAME
  )
}

function wakeHostKey(options: QuirkydSlotOptions): string {
  return `${options.conn.getTarget().id}\0${options.remoteHome}`
}

/**
 * Releases only the fence carrying this client's own interrupted wake token and no journal; the
 * slot was just proven exited and quirkyd's instance lock bars a double start.
 */
async function releaseOwnInterruptedWakeFence(
  options: QuirkydSlotOptions,
  host: string
): Promise<boolean> {
  const token = interruptedWakes.get(host)
  if (!token || (await readQuirkydActivationTransaction(options))) {
    return false
  }
  // Only a fence carrying this process's own token: a fresh fence another client took has none yet.
  const owner = await readBoundedQuirkydRemoteRecord(options, wakeOwnerPath(options), 64)
  if (owner.state !== 'present' || owner.raw.trim() !== token) {
    interruptedWakes.delete(host)
    return false
  }
  await releaseQuirkydActivationFence(options, token)
  interruptedWakes.delete(host)
  return true
}
