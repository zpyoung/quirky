/**
 * The locked half of a deploy: stop, snapshot, start and commit, journaled at every step.
 *
 * The journal is durable before the first mutation, so a crash at any point leaves enough on
 * the host for `recoverInterruptedQuirkydActivation` to finish or undo it. A run that ends with
 * the host provably back on one slot drops the fence; one that cannot prove it keeps it.
 */
import { quirkydRemoteBaseDir } from '../managed-server/install/quirkyd-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { QuirkydDeployOptions, QuirkydDeployResult } from './quirkyd-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import {
  withActivatedVersion,
  type QuirkydActivationRecord,
  type QuirkydStateSnapshot
} from '../managed-server/activation/quirkyd-activation-record'
import {
  readQuirkydActivationRecord,
  writeQuirkydActivationRecord
} from '../managed-server/activation/quirkyd-activation-record-store'
import { launchAndJudgeQuirkydSlot } from './quirkyd-candidate-launch-verdict'
import { planQuirkydUpdate } from './quirkyd-update-plan'
import {
  QUIRKYD_UPDATE_ADMISSION_STOP_BY_MS,
  type QuirkydTerminalCensus
} from '../../shared/quirkyd-terminal-census'
import { CURRENT_QUIRKYD_DAEMON_PROTOCOL } from './quirkyd-daemon-protocol-crossing'
import { QUIRKYD_LOG_FILENAME } from '../managed-server/install/quirkyd-remote-host-support'
import { quirkydSnapshotFailureReason } from '../managed-server/host-state/quirkyd-state-snapshot-space'
import {
  QUIRKYD_SNAPSHOT_SPACE_INSUFFICIENT_CODE,
  quirkydSnapshotRoomRefusal,
  quirkydSnapshotsRoot
} from './quirkyd-snapshot-room'
import {
  captureQuirkydStateSnapshotCommand,
  quirkydSnapshotDirName,
  parseQuirkydSnapshotCapture
} from '../managed-server/host-state/quirkyd-state-snapshot'
import { joinRemotePath } from './ssh-remote-platform'
import { computeLocalQuirkydBuildHash } from './quirkyd-local-build-hash'
import { preflightInstalledQuirkyd } from '../managed-server/install/quirkyd-remote-preflight'
import type { QuirkydActivationLockControl } from '../managed-server/activation/quirkyd-activation-lock'
import type { QuirkydActivateTransaction } from '../managed-server/activation/quirkyd-activation-transaction'
import {
  createQuirkydActivationTransaction,
  withQuirkydActivationCandidateReady,
  withQuirkydActivationIncumbentStopped,
  withQuirkydActivationSnapshot
} from '../managed-server/activation/quirkyd-activation-transaction-transitions'
import { writeQuirkydActivationTransaction } from '../managed-server/activation/quirkyd-activation-transaction-store'
import {
  execQuirkydRemoteOr,
  withoutAbortSignal
} from '../managed-server/install/quirkyd-remote-runtime-control'
import { execQuirkydStateMutationOr } from '../managed-server/host-state/quirkyd-state-mutation-exec'
import {
  initialQuirkydActivationAdmissionCommand,
  parseInitialQuirkydActivationAdmission
} from './quirkyd-initial-activation-admission'
import {
  quirkydSlotDir,
  resolveQuirkydSlotIdentity,
  type QuirkydSlotIdentity
} from './quirkyd-recovery-slot'
import { quirkydSnapshotPath } from './quirkyd-incumbent-recovery'
import {
  restartAfterSnapshotFailure,
  restoreAfterRejectedCandidate,
  stopTransactionIncumbent
} from './quirkyd-transaction-incumbent'
import { withQuirkydLogTail } from '../managed-server/install/quirkyd-remote-log-tail'
import { quirkydCandidateLaunchFailureCode } from '../quirkyd/quirkyd-host-unavailable'
import { errorMessage } from '../../shared/error-message'

type Outcome = Extract<QuirkydDeployResult, { outcome: 'installed-not-activated' }>

/** The caller's `admitRecord` refused the record found under the fence; nothing was touched. */
export const QUIRKYD_ACTIVATION_POLICY_REFUSED_CODE = 'quirkyd_activation_policy_refused'

const UNVERIFIABLE_CENSUS: QuirkydTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

/** Once the recount closed it; a failed reopen only leaves the fence to lapse on its own. */
async function reopenIncumbentAdmission(options: QuirkydDeployOptions): Promise<void> {
  await options.releaseIncumbentAdmission().catch(() => {})
}

function countedLockedRecord(
  options: QuirkydDeployOptions,
  record: QuirkydActivationRecord
): boolean {
  const counted = options.censusRecord
  return (
    !counted || (counted.active === record.active && counted.activatedAt === record.activatedAt)
  )
}

/** A census counted against another incumbent says nothing about this one's terminals. */
function censusForLockedRecord(
  options: QuirkydDeployOptions,
  record: QuirkydActivationRecord
): QuirkydTerminalCensus {
  return countedLockedRecord(options, record) ? options.census : UNVERIFIABLE_CENSUS
}

export async function activateInstalledQuirkyd(
  options: QuirkydDeployOptions & { localQuirkydDir: string },
  fullVersion: string,
  remoteDir: string,
  lock: QuirkydActivationLockControl
): Promise<QuirkydDeployResult> {
  const now = options.now ?? ((): Date => new Date())
  const notActivated = (code: string, reason: string): Outcome => ({
    outcome: 'installed-not-activated',
    fullVersion,
    code,
    reason
  })
  const record = await readQuirkydActivationRecord(options)
  const plan = planQuirkydUpdate({
    record,
    candidateVersion: fullVersion,
    census: censusForLockedRecord(options, record),
    candidateDaemonProtocol: CURRENT_QUIRKYD_DAEMON_PROTOCOL,
    ...(options.force !== undefined ? { force: options.force } : {})
  })
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  const refusal = options.admitRecord?.(record, fullVersion)
  if (refusal) {
    return notActivated(QUIRKYD_ACTIVATION_POLICY_REFUSED_CODE, refusal)
  }
  if (plan.action === 'defer') {
    return notActivated(plan.code, plan.reason)
  }

  try {
    await preflightInstalledQuirkyd({
      ...options,
      remoteInstallDir: remoteDir,
      fullVersion
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    return notActivated(
      'quirkyd_candidate_preflight_failed',
      `Candidate profile preflight failed; the incumbent was not stopped: ${errorMessage(error)}`
    )
  }

  let incumbent: QuirkydSlotIdentity | null = null
  if (record.active) {
    try {
      incumbent = await resolveQuirkydSlotIdentity(options, record.active)
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return notActivated(
        'quirkyd_incumbent_identity_unverifiable',
        `The active quirkyd ${record.active} build identity could not be verified before ` +
          `stopping it: ${errorMessage(error)} Nothing was stopped.`
      )
    }
  } else {
    const admission = parseInitialQuirkydActivationAdmission(
      await execQuirkydRemoteOr(
        options,
        initialQuirkydActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    if (admission.decision === 'defer') {
      return notActivated(admission.code, admission.reason)
    }
  }

  // Before the recount: a slow scan must not outdate the census that admits the stop.
  const roomless = await quirkydSnapshotRoomRefusal(options, record, fullVersion)
  if (roomless) {
    return notActivated(QUIRKYD_SNAPSHOT_SPACE_INSUFFICIENT_CODE, roomless)
  }

  // Last check before anything stops: the census above may predate a long upload.
  const recountedAt = now().getTime()
  if (incumbent) {
    const recount = planQuirkydUpdate({
      record,
      candidateVersion: fullVersion,
      census: countedLockedRecord(options, record)
        ? await options.recountCensus().catch(() => UNVERIFIABLE_CENSUS)
        : UNVERIFIABLE_CENSUS,
      candidateDaemonProtocol: CURRENT_QUIRKYD_DAEMON_PROTOCOL,
      ...(options.force !== undefined ? { force: options.force } : {})
    })
    if (recount.action === 'defer') {
      await reopenIncumbentAdmission(options)
      return notActivated(recount.code, recount.reason)
    }
  }

  const startedAt = now()
  let transaction: QuirkydActivateTransaction = createQuirkydActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion: fullVersion,
    appVersion: options.appVersion,
    recordBefore: record,
    snapshotDirName: quirkydSnapshotDirName(fullVersion, startedAt.getTime()),
    now: startedAt
  })
  try {
    await writeQuirkydActivationTransaction(options, transaction)
  } catch (error) {
    // Nothing stopped, so the incumbent keeps serving and must take terminals again.
    if (incumbent) {
      await reopenIncumbentAdmission(options)
    }
    throw error
  }
  // The recount's fence lapses on its own; a stop after that could kill a terminal admitted since.
  if (incumbent && now().getTime() - recountedAt > QUIRKYD_UPDATE_ADMISSION_STOP_BY_MS) {
    await reopenIncumbentAdmission(options)
    return notActivated(
      'quirkyd_update_terminal_census_unavailable',
      'The terminal count went stale before the current server could be stopped, so nothing ' +
        'was stopped. Quirky will try the update again.'
    )
  }
  lock.retainOnError()
  // Past the first mutation a cancel would strand a stopped host, so the run finishes or rolls back.
  options = withoutAbortSignal(options)

  const unstopped = incumbent ? await stopTransactionIncumbent(options, incumbent, lock) : null
  if (unstopped) {
    // A stop that may still land keeps admission closed; one never sent leaves the server serving.
    if (!unstopped.stopMayBeUnderway) {
      await reopenIncumbentAdmission(options)
    }
    return notActivated(
      'quirkyd_outgoing_stop_incomplete',
      `${unstopped.reason} No snapshot was taken and the candidate was not started. Quirky requires ` +
        'matching runtime readiness before signaling an incumbent and confirmed exit before ' +
        'snapshotting.'
    )
  }
  transaction = withQuirkydActivationIncumbentStopped(transaction, now())
  await writeQuirkydActivationTransaction(options, transaction)

  // A live SQLite WAL is not a backup boundary, so the snapshot waits for confirmed exit.
  const snapshotDir = quirkydSnapshotPath(options, transaction.snapshot.dirName)
  const captureOutput = await execQuirkydStateMutationOr(
    options,
    captureQuirkydStateSnapshotCommand(
      options.host,
      options.userDataDir,
      snapshotDir,
      quirkydRemoteBaseDir(options.host, options.remoteHome),
      {
        snapshotsRoot: quirkydSnapshotsRoot(options),
        keep: [transaction.snapshot.dirName, ...(record.snapshot ? [record.snapshot.dirName] : [])]
      }
    ),
    'FAILED'
  )
  const capture = parseQuirkydSnapshotCapture(captureOutput)
  if (capture === 'failed') {
    const reason = quirkydSnapshotFailureReason(captureOutput)
    const restarted = incumbent
      ? ` The incumbent was stopped before snapshotting; ${await restartAfterSnapshotFailure(options, incumbent, lock)}`
      : ''
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}` +
        `${reason ? `: ${reason}` : ''}. Quirky's persisted state carries no schema version, so ` +
        'without a snapshot a rollback has no way back. Refusing to activate. Fix what stops ' +
        `the copy (often a full disk or quota on ${quirkydRemoteBaseDir(options.host, options.remoteHome)}), ` +
        `then reconnect.${restarted}`
    )
  }
  const snapshot: QuirkydStateSnapshot | null =
    capture === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: fullVersion,
          readableByVersion: record.active,
          takenAt: startedAt.toISOString()
        }
      : null
  transaction = withQuirkydActivationSnapshot(transaction, capture, now())
  await writeQuirkydActivationTransaction(options, transaction)

  const { verdict, launchError } = await launchAndJudgeQuirkydSlot(options, {
    remoteInstallDir: remoteDir,
    fullVersion,
    buildHash: computeLocalQuirkydBuildHash(options.localQuirkydDir)
  })
  if (verdict.decision === 'reject') {
    const [code, reason] =
      launchError === undefined
        ? [verdict.code, verdict.reason]
        : [
            quirkydCandidateLaunchFailureCode(launchError),
            `The candidate failed while starting: ${errorMessage(launchError)}`
          ]
    const restored = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: quirkydSlotDir(options, transaction.candidateVersion),
      launchedVersion: transaction.candidateVersion,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: transaction.snapshot
    })
    const located =
      `${reason} Candidate stderr is at ` +
      `${joinRemotePath(options.host, remoteDir, QUIRKYD_LOG_FILENAME)}. ${restored}`
    return notActivated(code, await withQuirkydLogTail(options, remoteDir, located))
  }

  const recordAfter = withActivatedVersion(record, fullVersion, snapshot, now(), options.appVersion)
  transaction = withQuirkydActivationCandidateReady(transaction, recordAfter, now())
  await writeQuirkydActivationTransaction(options, transaction)
  await writeQuirkydActivationRecord(options, recordAfter)
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}
