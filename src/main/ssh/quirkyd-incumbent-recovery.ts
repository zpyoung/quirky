/**
 * Putting a host back to the slot and state it had before an activation or rollback.
 *
 * Shared by the in-flight failure paths and by crash recovery, so both apply one rule: state
 * a launched slot may have changed is replaced only after that slot is proven exited, and only
 * when an operator accepts it — the slot exposed RPC, and with it stopped nothing on the host
 * can count the terminals it started, so the snapshot may no longer describe them.
 */
import { execQuirkydStateMutation } from '../managed-server/host-state/quirkyd-state-mutation-exec'
import { quirkydRemoteBaseDir } from '../managed-server/install/quirkyd-remote-windows-node'
import type { ServeReadiness } from '../server/serve-readiness'
import { RELAY_REMOTE_DIR } from './remote-exec/remote-frame-protocol'
import { QUIRKYD_STATE_SNAPSHOT_DIR } from '../managed-server/activation/quirkyd-activation-record'
import type { QuirkydSnapshotVerdict } from '../managed-server/activation/quirkyd-activation-transaction'
import {
  clearQuirkydStateSnapshotMembersCommand,
  compareQuirkydStateSnapshotCommand,
  quirkydSnapshotIsUnchanged,
  parseQuirkydSnapshotRestore,
  restoreQuirkydStateSnapshotCommand
} from '../managed-server/host-state/quirkyd-state-snapshot'
import { execQuirkydRemote } from '../managed-server/install/quirkyd-remote-runtime-control'
import {
  ensureQuirkydSlotServing,
  launchQuirkydSlot,
  quiesceInterruptedQuirkydSlot,
  type QuirkydSlotIdentity,
  type QuirkydSlotOptions
} from './quirkyd-recovery-slot'
import { joinRemotePath } from './ssh-remote-platform'
import { QUIRKYD_RECOVERY_CHANGED_STATE_CODE } from '../../shared/quirkyd-managed-runtime'

export type QuirkydIncumbentRecoveryOptions = QuirkydSlotOptions & {
  /** The operator accepted restoring the snapshot over state a launched build changed. */
  acceptChangedState?: boolean
}

export type QuirkydIncumbentRecovery =
  | { outcome: 'restored'; readiness: ServeReadiness | null }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

export function quirkydSnapshotPath(options: QuirkydSlotOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    QUIRKYD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

/** Throws when a step cannot be verified; the caller keeps the fence. */
export async function recoverQuirkydIncumbent(
  options: QuirkydIncumbentRecoveryOptions,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: QuirkydSlotIdentity | null
    restoreState: QuirkydSnapshotVerdict | null
    /** The state the launched slot started from, when that is not `restoreState` (a rollback). */
    launchedFromState?: QuirkydSnapshotVerdict | null
    /** This run itself proved both slots exited, so no fresh liveness probe is needed. */
    slotsProvenExited?: boolean
  }
): Promise<QuirkydIncumbentRecovery> {
  const quiescence =
    input.slotsProvenExited || !input.restoreState
      ? 'exited'
      : await quiesceInterruptedQuirkydSlot(options, input.launchedVersion, input.incumbent)
  // With no incumbent there is no older reader to protect; the record names nothing to serve.
  if (quiescence === 'exited' && input.restoreState && input.incumbent) {
    const decision = input.launchedVersion
      ? await decideChangedStateRestore(options, input.launchedFromState ?? input.restoreState)
      : 'restore'
    if (decision !== 'restore' && decision !== 'unchanged') {
      return decision
    }
    // A launched slot that left its starting state untouched still sits on a root to replace.
    if (decision === 'restore' || input.launchedFromState) {
      await restoreState(options, input.restoreState)
    }
  }
  if (!input.incumbent) {
    return { outcome: 'restored', readiness: null }
  }
  return {
    outcome: 'restored',
    readiness: input.slotsProvenExited
      ? await launchQuirkydSlot(options, input.incumbent)
      : await ensureQuirkydSlotServing(options, input.incumbent)
  }
}

async function decideChangedStateRestore(
  options: QuirkydIncumbentRecoveryOptions,
  state: QuirkydSnapshotVerdict
): Promise<'unchanged' | 'restore' | Extract<QuirkydIncumbentRecovery, { outcome: 'refused' }>> {
  if (state.state === 'captured') {
    const snapshotDir = quirkydSnapshotPath(options, state.dirName)
    // Read-only, so a lost answer is just "changed".
    const comparison = await execQuirkydRemote(
      options,
      compareQuirkydStateSnapshotCommand(
        options.host,
        options.userDataDir,
        snapshotDir,
        quirkydRemoteBaseDir(options.host, options.remoteHome)
      )
    ).catch(() => '')
    if (quirkydSnapshotIsUnchanged(comparison)) {
      return 'unchanged'
    }
  }
  if (options.acceptChangedState) {
    return 'restore'
  }
  const retained =
    state.state === 'captured' ? ` at ${quirkydSnapshotPath(options, state.dirName)}` : ''
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: QUIRKYD_RECOVERY_CHANGED_STATE_CODE,
    reason:
      'The launched build is stopped, but it changed profile state (or the change could not be ' +
      'checked), so the previous build was not restarted against it and this host serves ' +
      'nothing. Recover to restore the prelaunch snapshot' +
      `${retained} and restart the previous build; terminals the launched build started keep ` +
      'running but drop out of the restored state.'
  }
}

async function restoreState(
  options: QuirkydSlotOptions,
  state: QuirkydSnapshotVerdict
): Promise<void> {
  if (state.state === 'pending') {
    throw new Error('The interrupted transaction has no durable snapshot verdict.')
  }
  const command =
    state.state === 'captured'
      ? restoreQuirkydStateSnapshotCommand(
          options.host,
          options.userDataDir,
          quirkydSnapshotPath(options, state.dirName),
          quirkydRemoteBaseDir(options.host, options.remoteHome)
        )
      : clearQuirkydStateSnapshotMembersCommand(
          options.host,
          options.userDataDir,
          quirkydRemoteBaseDir(options.host, options.remoteHome)
        )
  const restored = parseQuirkydSnapshotRestore(await execQuirkydStateMutation(options, command))
  if (restored !== 'restored') {
    throw new Error(`The prelaunch state could not be restored (${restored}).`)
  }
}
