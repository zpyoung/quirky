/**
 * Finishing or undoing an activation, rollback or decommission that a crash, a lost connection or an
 * unverifiable failure left fenced. Either way the host ends serving exactly the slot its
 * activation record names, or the fence stays for an operator.
 */
import type { ServeReadiness } from '../../server/serve-readiness'
import {
  planQuirkydTransactionRecovery,
  type QuirkydActivationTransaction
} from './quirkyd-activation-transaction'
import { readQuirkydActivationTransaction } from './quirkyd-activation-transaction-store'
import {
  readQuirkydActivationRecord,
  writeQuirkydActivationRecord
} from './quirkyd-activation-record-store'
import {
  quirkydActivationFenceExists,
  withStaleQuirkydActivationRecoveryLock
} from './quirkyd-activation-lock'
import { RemoteInstallLockBusyError } from '../install/remote-install-lock'
import {
  ensureQuirkydSlotServing,
  resolveQuirkydSlotIdentity
} from '../../ssh/quirkyd-recovery-slot'
import { reconcileQuirkydDecommission } from '../lifecycle/quirkyd-decommission-recovery'
import {
  recoverQuirkydIncumbent,
  type QuirkydIncumbentRecoveryOptions
} from '../../ssh/quirkyd-incumbent-recovery'
import type { QuirkydManagedRefusal } from '../../../shared/quirkyd-managed-runtime'
import { resumeInterruptedQuirkydCandidate } from '../../ssh/quirkyd-interrupted-candidate-resume'
import { errorMessage } from '../../../shared/error-message'

export type QuirkydActivationRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      readiness: ServeReadiness | null
    }
  | QuirkydManagedRefusal

export type QuirkydActivationRecoveryOptions = QuirkydIncumbentRecoveryOptions

export const QUIRKYD_RECOVERY_UNVERIFIABLE_CODE = 'quirkyd_recovery_unverifiable'

export async function recoverInterruptedQuirkydActivation(
  options: QuirkydActivationRecoveryOptions
): Promise<QuirkydActivationRecoveryResult> {
  try {
    if (
      !(await readQuirkydActivationTransaction(options)) &&
      !(await quirkydActivationFenceExists(options))
    ) {
      return { outcome: 'none' }
    }
    return await withStaleQuirkydActivationRecoveryLock(options, async (lock) => {
      const transaction = await readQuirkydActivationTransaction(options)
      if (!transaction) {
        // A release cut short after removing the journal; dropping the lock finishes it.
        return { outcome: 'none' }
      }
      const result = await reconcileQuirkydTransaction(options, transaction)
      if (result.outcome !== 'recovered') {
        lock.retain()
      }
      return result
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending',
        code: 'quirkyd_recovery_transaction_still_fresh',
        reason:
          'The activation fence is held by a run that may still be working. Retry after the ' +
          'install lock recovery window.'
      }
    }
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: QUIRKYD_RECOVERY_UNVERIFIABLE_CODE,
      reason:
        `The interrupted activation could not be reconciled safely: ${errorMessage(error)} ` +
        'The host remains fenced.'
    }
  }
}

/** Runs under a held fence. Throws when a step is unverifiable. */
export async function reconcileQuirkydTransaction(
  options: QuirkydActivationRecoveryOptions,
  transaction: QuirkydActivationTransaction
): Promise<QuirkydActivationRecoveryResult> {
  const plan = planQuirkydTransactionRecovery(
    transaction,
    await readQuirkydActivationRecord(options)
  )
  if (plan.action === 'refuse') {
    return { outcome: 'refused', verdict: 'unverifiable', code: plan.code, reason: plan.reason }
  }
  if (
    plan.action === 'confirm-decommissioned' ||
    plan.action === 'resume-stop' ||
    plan.action === 'keep-serving'
  ) {
    return reconcileQuirkydDecommission(options, plan)
  }
  if (plan.action === 'finish-commit') {
    await writeQuirkydActivationRecord(options, plan.record)
  }
  if (plan.action === 'stabilize-committed' || plan.action === 'finish-commit') {
    const activeVersion = plan.action === 'finish-commit' ? plan.record.active : plan.activeVersion
    if (!activeVersion) {
      throw new Error('The committed activation record has no active version.')
    }
    const identity = await resolveQuirkydSlotIdentity(options, activeVersion)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion,
      readiness: await ensureQuirkydSlotServing(options, identity)
    }
  }
  if (transaction.operation === 'activate' && plan.launchedVersion) {
    const readiness = await resumeInterruptedQuirkydCandidate(options, transaction)
    if (readiness && 'outcome' in readiness) {
      return readiness
    }
    if (readiness) {
      return {
        outcome: 'recovered',
        resolution: 'committed',
        activeVersion: transaction.candidateVersion,
        readiness
      }
    }
  }
  const recovery = await recoverQuirkydIncumbent(options, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: plan.launchedVersion,
    incumbent: plan.activeVersion
      ? await resolveQuirkydSlotIdentity(options, plan.activeVersion)
      : null,
    restoreState: plan.restoreState,
    launchedFromState: plan.launchedFromState
  })
  return recovery.outcome === 'refused'
    ? recovery
    : {
        outcome: 'recovered',
        resolution: 'restored-incumbent',
        activeVersion: plan.activeVersion,
        readiness: recovery.readiness
      }
}
