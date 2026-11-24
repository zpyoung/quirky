/**
 * Stopping a managed quirkyd and unlinking it, on T6-4's journaled decommission. The server stays
 * linked — its SSH claim, tunnel and deployment record — unless the host proves quirkyd exited.
 */
import type {
  QuirkydManagedCancelStopResult,
  QuirkydManagedForgetResult,
  QuirkydManagedStopResult
} from '../../../shared/quirkyd-managed-runtime'
import type { QuirkydDaemonRetirementVerdict } from '../../../shared/quirkyd-stop-request'
import { removeManagedQuirkydEnvironment } from '../../../shared/runtime-environment-managed-quirkyd-store'
import type {
  KnownRuntimeEnvironment,
  QuirkydSshDeploymentLink
} from '../../../shared/runtime-environments'
import { recoverInterruptedQuirkydActivation } from '../activation/quirkyd-activation-recovery'
import { withStaleQuirkydActivationRecoveryLock } from '../activation/quirkyd-activation-lock'
import { readQuirkydActivationTransaction } from '../activation/quirkyd-activation-transaction-store'
import { reconcileQuirkydDecommission } from './quirkyd-decommission-recovery'
import { cancelRemoteQuirkydManagedStop } from './quirkyd-managed-remote-stop'
import {
  managedQuirkydSlot,
  requireManagedQuirkydInfrastructure,
  resolveLinkedQuirkydContext
} from './quirkyd-managed-runtime-context'
import { closeQuirkydManagedTunnel, ensureQuirkydManagedTunnel } from './quirkyd-managed-tunnel'
import { clearManagedQuirkydUpdateDeferral } from './quirkyd-managed-update-deferrals'
import { removeQuirkydMigrationJournalsForDestination } from '../../ssh/quirkyd-migration-cutover-journal'
import { decommissionRemoteQuirkyd } from '../install/quirkyd-remote-decommission'
import { withManagedQuirkydLifecycle } from '../../ssh/quirkyd-runtime-maintenance'
import { collectManagedTerminalCensus } from '../../ssh/quirkyd-terminal-census-client'
import { RemoteInstallLockBusyError } from '../install/remote-install-lock'

export type ManagedQuirkydStopPolicy = {
  isActiveEnvironment: (environmentId: string) => boolean
  /** Invalidates the server's transport and retires its client-side state once it is unlinked. */
  retireLocalState: (environmentId: string) => Promise<void> | void
}

type Refusal = Extract<QuirkydManagedStopResult, { outcome: 'refused' }>
type Stopped = { version: string | null; retirement: QuirkydDaemonRetirementVerdict | null }

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

export function stopManagedQuirkydEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  policy: ManagedQuirkydStopPolicy
): Promise<QuirkydManagedStopResult> {
  return withManagedQuirkydLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'quirkyd_stop_active_environment',
        'This server is the default host for new projects. Choose another one under New projects open on before stopping it.'
      )
    }
    const stopped = await stopRemote(userDataPath, environment, deployment, args.signal)
    if ('outcome' in stopped) {
      return stopped
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId,
      stoppedVersion: stopped.version,
      retirement: stopped.retirement
    }
  })
}

/**
 * Stop's local half alone, for a host that can no longer answer (P1-E). Nothing on the host is
 * touched or assumed: a server still running there keeps running, and a later connect relinks it.
 */
export function forgetManagedQuirkydEnvironment(
  userDataPath: string,
  args: { selector: string },
  policy: ManagedQuirkydStopPolicy
): Promise<QuirkydManagedForgetResult> {
  return withManagedQuirkydLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'quirkyd_forget_active_environment',
        'This server is the default host for new projects. Choose another one under New projects open on before forgetting it.'
      )
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'forgotten',
      verdict: 'unverifiable',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId
    }
  })
}

/** Proven exit, or the refusal that keeps the server linked. */
async function stopRemote(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: QuirkydSshDeploymentLink,
  signal?: AbortSignal,
  retried = false
): Promise<Stopped | Refusal> {
  const context = await resolveLinkedQuirkydContext(environment, deployment, signal)
  const slot = managedQuirkydSlot(context, deployment.remotePort, signal)
  const transaction = await readQuirkydActivationTransaction(slot)
  if (transaction?.operation === 'decommission') {
    // An earlier stop was interrupted: its journal decides, so finish exactly that one.
    const recovered = await recoverInterruptedQuirkydActivation(slot)
    if (recovered.outcome === 'recovered' && recovered.activeVersion === null) {
      return { version: transaction.activeVersion, retirement: null }
    }
    if (recovered.outcome === 'refused') {
      return refuse(recovered.verdict, recovered.code, recovered.reason)
    }
    if (recovered.outcome === 'pending') {
      return refuse('unverifiable', recovered.code, recovered.reason)
    }
    // Another run settled the journal first; start over from what it left, never assume live.
    if (recovered.outcome === 'none') {
      return retried
        ? refuse(
            'unverifiable',
            'quirkyd_stop_journal_changed',
            'Another run on this server changed its stop while this one waited. Refresh and retry.'
          )
        : stopRemote(userDataPath, environment, deployment, signal, true)
    }
    return refuse(
      'live',
      'quirkyd_stop_withdrawn',
      'The interrupted stop was withdrawn and the server keeps serving. Stop it again.'
    )
  }
  if (transaction) {
    return refuse(
      'unverifiable',
      'quirkyd_activation_recovery_required',
      'An earlier update on this server was interrupted. Recover it before stopping.'
    )
  }
  const record = context.activationRecord
  if (!record.active) {
    // Only a proven exit (or a deploy that never activated) leaves the record without a version.
    return { version: null, retirement: null }
  }
  const census = await collectManagedTerminalCensus(userDataPath, environment, record)
  const result = await decommissionRemoteQuirkyd({ ...slot, record, census })
  if (result.outcome === 'refused') {
    return refuse(result.verdict, result.code, result.reason)
  }
  return { version: result.version, retirement: result.retirement }
}

async function unlinkEnvironmentLocally(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: QuirkydSshDeploymentLink,
  policy: ManagedQuirkydStopPolicy
): Promise<void> {
  // Environment first: a crash before the claim is released leaves a hidden target to resume,
  // never a linked server whose SSH target was already handed back.
  removeManagedQuirkydEnvironment(userDataPath, environment.id)
  await policy.retireLocalState(environment.id)
  await closeQuirkydManagedTunnel(environment.id)
  const { claims } = requireManagedQuirkydInfrastructure()
  claims.release(deployment.sshTargetId, environment.id)
  clearManagedQuirkydUpdateDeferral(environment.id)
  await claims.flush()
  // After the fence: a crash between leaves a stale journal a later conversion clears.
  removeQuirkydMigrationJournalsForDestination(userDataPath, deployment.sshTargetId, environment.id)
}

/** Withdraws a stop quirkyd has not acted on yet; the server then keeps serving. */
export function cancelManagedQuirkydStop(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<QuirkydManagedCancelStopResult> {
  return withManagedQuirkydLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    const context = await resolveLinkedQuirkydContext(environment, deployment, args.signal)
    const slot = managedQuirkydSlot(context, deployment.remotePort, args.signal)
    let result: QuirkydManagedCancelStopResult
    try {
      result = await withStaleQuirkydActivationRecoveryLock(slot, async (lock) => {
        const transaction = await readQuirkydActivationTransaction(slot)
        if (transaction?.operation !== 'decommission') {
          if (transaction) {
            lock.retain()
          }
          return { outcome: 'none' }
        }
        if (transaction.phase === 'process-exited') {
          lock.retain()
          return { outcome: 'already-stopped' }
        }
        if (transaction.request) {
          const cancellation = await cancelRemoteQuirkydManagedStop(slot, transaction.request)
          if (cancellation.outcome !== 'canceled') {
            lock.retain()
            return {
              outcome: 'refused',
              verdict: 'live',
              code: 'quirkyd_stop_already_dispatched',
              reason:
                'quirkyd already acted on the stop and is shutting down; it cannot be canceled.'
            }
          }
        }
        const kept = await reconcileQuirkydDecommission(slot, {
          action: 'keep-serving',
          version: transaction.activeVersion
        })
        if (kept.outcome !== 'recovered' || !kept.activeVersion) {
          lock.retain()
          return {
            outcome: 'refused',
            verdict: 'unverifiable',
            code: 'quirkyd_stop_cancel_unverifiable',
            reason: 'The stop was withdrawn but the server could not be shown to be serving.'
          }
        }
        return { outcome: 'canceled', activeVersion: kept.activeVersion }
      })
    } catch (error) {
      if (error instanceof RemoteInstallLockBusyError) {
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'quirkyd_stop_still_running',
          reason: 'A stop on this server may still be running. Retry after it settles.'
        }
      }
      throw error
    }
    if (result.outcome === 'canceled') {
      await ensureQuirkydManagedTunnel(userDataPath, environment.id)
    }
    return result
  })
}
