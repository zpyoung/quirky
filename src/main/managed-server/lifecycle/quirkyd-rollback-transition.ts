/** The locked, journaled half of `rollbackQuirkyd`. */
import { quirkydRemoteBaseDir } from '../install/quirkyd-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type {
  QuirkydRollbackOptions,
  QuirkydRollbackResult
} from '../install/quirkyd-remote-rollback'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { withRolledBackVersion } from '../activation/quirkyd-activation-record'
import { writeQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import { launchAndJudgeQuirkydSlot } from '../../ssh/quirkyd-candidate-launch-verdict'
import { assessQuirkydRollback } from '../../ssh/quirkyd-update-plan'
import { QUIRKYD_LOG_FILENAME } from '../install/quirkyd-remote-host-support'
import {
  captureQuirkydStateSnapshotCommand,
  quirkydRollbackRescueDirName,
  parseQuirkydSnapshotCapture,
  parseQuirkydSnapshotPresence,
  parseQuirkydSnapshotRestore,
  probeQuirkydStateSnapshotCommand,
  restoreQuirkydStateSnapshotCommand
} from '../host-state/quirkyd-state-snapshot'
import {
  newestStateMtimeCommand,
  parseNewestStateMtimeSeconds
} from '../host-state/quirkyd-state-newest-mtime'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import type { QuirkydActivationLockControl } from '../activation/quirkyd-activation-lock'
import {
  rollbackStartingState,
  type QuirkydRollbackTransaction
} from '../activation/quirkyd-activation-transaction'
import {
  createQuirkydRollbackTransaction,
  withQuirkydRollbackPhase,
  withQuirkydRollbackRescue
} from '../activation/quirkyd-activation-transaction-transitions'
import { writeQuirkydActivationTransaction } from '../activation/quirkyd-activation-transaction-store'
import { execQuirkydRemoteOr, withoutAbortSignal } from '../install/quirkyd-remote-runtime-control'
import { execQuirkydStateMutationOr } from '../host-state/quirkyd-state-mutation-exec'
import {
  quirkydSlotDir,
  resolveQuirkydSlotIdentity,
  type QuirkydSlotIdentity
} from '../../ssh/quirkyd-recovery-slot'
import { quirkydSnapshotPath } from '../../ssh/quirkyd-incumbent-recovery'
import {
  putTransactionIncumbentBack,
  restoreAfterRejectedCandidate
} from '../../ssh/quirkyd-transaction-incumbent'
import {
  readQuirkydRollbackBarrierTarget,
  rollbackBarrierRefusal,
  stopIncumbentBehindTerminalBarrier
} from './quirkyd-rollback-terminal-barrier'
import { withQuirkydLogTail } from '../install/quirkyd-remote-log-tail'
import { errorMessage } from '../../../shared/error-message'

async function stateWritesSinceActivation(
  options: QuirkydRollbackOptions
): Promise<boolean | null> {
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt ?? '') / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    await execQuirkydRemoteOr(
      options,
      newestStateMtimeCommand(
        options.host,
        options.userDataDir,
        quirkydRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function rollbackQuirkydLocked(
  options: QuirkydRollbackOptions,
  lock: QuirkydActivationLockControl
): Promise<QuirkydRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  const snapshot = options.record.snapshot
  const presence = snapshot
    ? parseQuirkydSnapshotPresence(
        await execQuirkydRemoteOr(
          options,
          probeQuirkydStateSnapshotCommand(
            options.host,
            quirkydSnapshotPath(options, snapshot.dirName),
            quirkydRemoteBaseDir(options.host, options.remoteHome)
          )
        )
      )
    : 'absent'
  const safety = assessQuirkydRollback({
    record: options.record,
    snapshotPresent: presence === 'unverifiable' ? null : presence === 'present',
    census: options.census,
    targetDaemonProtocol: options.targetDaemonProtocol,
    stateWritesSinceActivation: await stateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }
  if (!snapshot || !options.record.active) {
    return {
      outcome: 'refused',
      code: 'quirkyd_rollback_no_active',
      reason: 'No quirkyd version is active on this host, so there is nothing to roll back from.'
    }
  }
  let incumbent: QuirkydSlotIdentity
  try {
    incumbent = await resolveQuirkydSlotIdentity(options, options.record.active)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'quirkyd_rollback_active_identity_unverifiable',
      reason: `The active quirkyd identity could not be verified: ${errorMessage(error)} Nothing was changed.`
    }
  }

  const barrierTarget = await readQuirkydRollbackBarrierTarget(options, incumbent.version)
  if (barrierTarget.state === 'refused') {
    return { outcome: 'refused', code: barrierTarget.code, reason: barrierTarget.reason }
  }

  const startedAt = now()
  let transaction: QuirkydRollbackTransaction = createQuirkydRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: incumbent.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, startedAt),
    rescueDirName: quirkydRollbackRescueDirName(incumbent.version, startedAt.getTime()),
    now: startedAt
  })
  await writeQuirkydActivationTransaction(options, transaction)
  lock.retainOnError()
  // Past the first mutation a cancel would strand a stopped host, so the run finishes or rolls back.
  options = withoutAbortSignal(options)

  // The census above was taken while quirkyd admitted work; this stop is the proof that counts.
  const blocked = rollbackBarrierRefusal(
    await stopIncumbentBehindTerminalBarrier(
      options,
      transaction.transactionId,
      barrierTarget.context
    )
  )
  if (blocked) {
    if (blocked.retainFence) {
      lock.retain()
    }
    const recovered = blocked.restartIncumbent
      ? ` ${await putIncumbentBack(options, lock, transaction, incumbent)}`
      : ''
    return { outcome: blocked.outcome, code: blocked.code, reason: blocked.reason + recovered }
  }
  transaction = withQuirkydRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeQuirkydActivationTransaction(options, transaction)

  const rescue = parseQuirkydSnapshotCapture(
    await execQuirkydStateMutationOr(
      options,
      captureQuirkydStateSnapshotCommand(
        options.host,
        options.userDataDir,
        quirkydSnapshotPath(options, transaction.rescue.dirName),
        quirkydRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (rescue === 'failed') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'quirkyd_rollback_rescue_snapshot_failed',
      reason:
        'The current state could not be preserved in a rescue snapshot, so the data root was ' +
        `not replaced. ${recovered}`
    }
  }
  transaction = withQuirkydRollbackRescue(transaction, rescue, now())
  await writeQuirkydActivationTransaction(options, transaction)

  // Why between stop and start: the older build must never load the newer build's state.
  const restored = parseQuirkydSnapshotRestore(
    await execQuirkydStateMutationOr(
      options,
      restoreQuirkydStateSnapshotCommand(
        options.host,
        options.userDataDir,
        quirkydSnapshotPath(options, snapshot.dirName),
        quirkydRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (restored !== 'restored') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'quirkyd_rollback_restore_failed',
      reason: `The pre-activation snapshot could not be restored (${restored}). ${recovered}`
    }
  }
  transaction = withQuirkydRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeQuirkydActivationTransaction(options, transaction)

  const targetDir = quirkydSlotDir(options, safety.target)
  const { verdict, launchError } = await launchAndJudgeQuirkydSlot(options, {
    remoteInstallDir: targetDir,
    fullVersion: safety.target,
    buildHash: options.targetBuildHash
  })
  if (verdict.decision === 'reject') {
    const reason =
      launchError === undefined
        ? verdict.reason
        : `It failed while starting: ${errorMessage(launchError)}`
    const recovered = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: targetDir,
      launchedVersion: safety.target,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: rescueVerdict(transaction),
      launchedFromState: rollbackStartingState(transaction)
    })
    return {
      outcome: 'failed',
      code: launchError === undefined ? verdict.code : 'quirkyd_rollback_target_launch_failed',
      reason: await withQuirkydLogTail(
        options,
        targetDir,
        `The rollback target ${safety.target} did not come up healthy: ${reason} ${recovered} ` +
          `Its stderr is at ${joinRemotePath(options.host, targetDir, QUIRKYD_LOG_FILENAME)}.`
      )
    }
  }

  // The record is written last: until the target is proven serving, `active` still names the
  // version an operator would need to bring back.
  transaction = withQuirkydRollbackPhase(transaction, 'target-ready', now())
  await writeQuirkydActivationTransaction(options, transaction)
  await writeQuirkydActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict
  }
}

type RestoreState = Parameters<typeof putTransactionIncumbentBack>[2]['restoreState']

function rescueVerdict(transaction: QuirkydRollbackTransaction): RestoreState {
  return transaction.rescue.state === 'pending' ? null : transaction.rescue
}

/** Puts the rescued state back when it was replaced, then restarts the incumbent. */
async function putIncumbentBack(
  options: QuirkydRollbackOptions,
  lock: QuirkydActivationLockControl,
  transaction: QuirkydRollbackTransaction,
  incumbent: QuirkydSlotIdentity
): Promise<string> {
  const failure = await putTransactionIncumbentBack(options, lock, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: null,
    incumbent,
    restoreState: rescueVerdict(transaction)
  })
  return failure ?? `quirkyd ${incumbent.version} was restored and is serving again.`
}
