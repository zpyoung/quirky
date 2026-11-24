/**
 * Updating, rolling back and recovering a managed quirkyd, on T6-2's deploy, rollback and recovery.
 * Every step reads the terminal census through the server's tunnel first; an unanswered census
 * is unverifiable, never zero, so an update over live or uncounted terminals defers (D7).
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { refreshManagedQuirkydPairing } from '../../shared/runtime-environment-managed-quirkyd-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type {
  QuirkydManagedDeployResult,
  QuirkydManagedRecoveryResult,
  QuirkydManagedRollbackResult
} from '../../shared/quirkyd-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'
import type { ServeReadiness } from '../server/serve-readiness'
import { recoverInterruptedQuirkydActivation } from '../managed-server/activation/quirkyd-activation-recovery'
import { probeActiveQuirkydReadiness } from './quirkyd-active-readiness'
import { materializeQuirkydArtifact } from '../quirkyd/quirkyd-artifact-materializer'
import { CURRENT_QUIRKYD_DAEMON_PROTOCOL } from './quirkyd-daemon-protocol-crossing'
import { rebuildQuirkydManagedTunnel } from '../managed-server/lifecycle/quirkyd-managed-tunnel'
import { wakeAlreadyActiveQuirkyd } from './quirkyd-already-active-wake'
import {
  clearManagedQuirkydUpdateDeferral,
  recordManagedQuirkydUpdateDeferral
} from '../managed-server/lifecycle/quirkyd-managed-update-deferrals'
import {
  isForceableQuirkydDeferral,
  managedQuirkydInstallDir,
  managedQuirkydSlot,
  probeManagedQuirkydReadiness,
  requireManagedQuirkydEnvironment,
  resolveLinkedQuirkydContext
} from '../managed-server/lifecycle/quirkyd-managed-runtime-context'
import type { QuirkydRemoteContext } from '../managed-server/install/quirkyd-remote-context'
import { readRemoteQuirkydBuildHash } from '../managed-server/install/quirkyd-remote-build-hash'
import { deployQuirkyd, type QuirkydDeployOptions } from './quirkyd-remote-deploy'
import { QUIRKYD_ACTIVATION_POLICY_REFUSED_CODE } from './quirkyd-installed-activation'
import { pruneManagedQuirkydVersions } from '../managed-server/lifecycle/quirkyd-managed-version-gc'
import { rollbackQuirkyd } from '../managed-server/install/quirkyd-remote-rollback'
import { collectManagedTerminalCensus } from './quirkyd-terminal-census-client'
import { updateTerminalCounts } from './quirkyd-update-terminal-counts'
import { findIncompleteManagedQuirkydMigration } from '../managed-server/lifecycle/quirkyd-managed-migration-status'
import { latestQuirkydMigrationInto } from './quirkyd-migration-rollback-mark'
import { tunneledQuirkydPairingCode } from './quirkyd-tunneled-pairing'

type LifecycleArgs = { selector: string; signal?: AbortSignal }

export function withManagedQuirkydLifecycle<T>(
  userDataPath: string,
  selector: string,
  run: (managed: ReturnType<typeof requireManagedQuirkydEnvironment>) => Promise<T>
): Promise<T> {
  const { environment, deployment } = requireManagedQuirkydEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    // Re-read under the queue: a reconciliation or stop may have won the race for it.
    const current = requireManagedQuirkydEnvironment(userDataPath, environment.id)
    assertRuntimeEnvironmentNotReconciling(current.environment)
    return run(current)
  })
}

function refreshPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  readiness: ServeReadiness,
  localPort: number
): KnownRuntimeEnvironment {
  return refreshManagedQuirkydPairing(
    userDataPath,
    environment.id,
    tunneledQuirkydPairingCode(readiness, localPort)
  )
}

/** A launched slot may bind another port than the forward in use, so forward anew. */
async function followLaunchedServerPort(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  try {
    await rebuildQuirkydManagedTunnel(userDataPath, environmentId)
  } catch (error) {
    // Why not fail: the server already launched; a rebuild that got past its drop leaves no
    // forward, so the next connect forwards to the bound port.
    console.warn('[ssh] Could not forward to the relaunched managed Quirky server:', error)
  }
}

export function updateManagedQuirkydEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { force?: boolean }
): Promise<QuirkydManagedDeployResult> {
  return withManagedQuirkydLifecycle(userDataPath, args.selector, async (managed) =>
    runManagedQuirkydUpdate(
      userDataPath,
      managed,
      await resolveLinkedQuirkydContext(managed.environment, managed.deployment, args.signal),
      args
    )
  )
}

/** The Managed servers update, run inside the target's lifecycle queue with a resolved context. */
export async function runManagedQuirkydUpdate(
  userDataPath: string,
  { environment, deployment }: ReturnType<typeof requireManagedQuirkydEnvironment>,
  context: QuirkydRemoteContext,
  args: {
    force?: boolean
    signal?: AbortSignal
    localQuirkydDir?: string
    admitRecord?: QuirkydDeployOptions['admitRecord']
  }
): Promise<QuirkydManagedDeployResult> {
  const { countFirst, ...recount } = updateTerminalCounts((options) =>
    collectManagedTerminalCensus(
      userDataPath,
      environment,
      context.activationRecord,
      undefined,
      options
    )
  )
  const census = await countFirst()
  const localQuirkydDir =
    args.localQuirkydDir ??
    (await materializeQuirkydArtifact(context.serverTarget, { signal: args.signal }))
  const slot = managedQuirkydSlot(context, deployment.remotePort, args.signal)
  const result = await deployQuirkyd({
    ...slot,
    localQuirkydDir,
    target: context.serverTarget,
    census,
    ...recount,
    censusRecord: context.activationRecord,
    force: args.force,
    appVersion: getAppEnvironment().getVersion(),
    ...(args.admitRecord ? { admitRecord: args.admitRecord } : {})
  })
  if (result.outcome === 'installed-not-activated') {
    const deferral = {
      outcome: 'deferred' as const,
      candidateVersion: result.fullVersion,
      code: result.code,
      reason: result.reason,
      forceable: isForceableQuirkydDeferral(result.code)
    }
    // A policy refusal is a decision about this host, not an update waiting to be retried.
    if (result.code !== QUIRKYD_ACTIVATION_POLICY_REFUSED_CODE) {
      recordManagedQuirkydUpdateDeferral(environment.id, deferral)
    }
    return deferral
  }
  clearManagedQuirkydUpdateDeferral(environment.id)
  const started = result.outcome === 'already-active' && (await wakeAlreadyActiveQuirkyd(slot))
  const readiness = await probeManagedQuirkydReadiness(
    context,
    localQuirkydDir,
    result.fullVersion,
    args.signal
  )
  await pruneManagedQuirkydVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: result.fullVersion,
    readiness
  })
  const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
  if (started || result.outcome !== 'already-active') {
    await followLaunchedServerPort(userDataPath, environment.id)
  }
  return {
    outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
    environment: redactRuntimeEnvironment(updated),
    activeVersion: result.fullVersion
  }
}

export function rollbackManagedQuirkydEnvironment(
  userDataPath: string,
  args: LifecycleArgs
): Promise<QuirkydManagedRollbackResult> {
  return withManagedQuirkydLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedQuirkydContext(environment, deployment, args.signal)
      const record = context.activationRecord
      const target = record.previous
      if (!target) {
        return {
          outcome: 'refused',
          code: 'quirkyd_rollback_no_target',
          reason: 'This server has no previous version to roll back to.'
        }
      }
      const crossing = migrationRollbackRefusal(userDataPath, environment, record.activatedAt)
      if (crossing) {
        return crossing
      }
      const census = await collectManagedTerminalCensus(
        userDataPath,
        environment,
        record,
        undefined,
        {
          releaseFinishedAutomationTerminals: true
        }
      )
      // Why idle only: this client cannot read the older build's daemon protocol, so it cannot show
      // that build would reach terminals that are still running.
      if (census.liveSessions !== 0) {
        return {
          outcome: 'refused',
          code:
            census.liveSessions === null
              ? 'quirkyd_rollback_census_unavailable'
              : 'quirkyd_rollback_terminals_running',
          reason:
            census.liveSessions === null
              ? 'The server did not answer how many terminals it runs. Retry when it answers.'
              : 'Close the terminals running on this server before rolling it back.'
        }
      }
      const slot = managedQuirkydSlot(context, deployment.remotePort, args.signal)
      const targetDir = managedQuirkydInstallDir(context, target)
      const targetBuildHash = await readRemoteQuirkydBuildHash(slot, targetDir)
      const result = await rollbackQuirkyd({
        ...slot,
        record,
        census,
        targetBuildHash,
        targetDaemonProtocol: CURRENT_QUIRKYD_DAEMON_PROTOCOL
      })
      if (result.outcome !== 'rolled-back') {
        return result
      }
      const readiness = await probeActiveQuirkydReadiness(
        { ...slot, remoteInstallDir: targetDir },
        { buildHash: targetBuildHash, fullVersion: result.target }
      )
      const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
      await followLaunchedServerPort(userDataPath, environment.id)
      return {
        outcome: 'rolled-back',
        environment: redactRuntimeEnvironment(updated),
        activeVersion: result.target,
        discarded: result.discarded
      }
    }
  )
}

/** Finishes or undoes an interrupted activation, rollback or decommission on the host. */
export function recoverManagedQuirkydEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { acceptChangedState?: boolean }
): Promise<QuirkydManagedRecoveryResult> {
  return withManagedQuirkydLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedQuirkydContext(environment, deployment, args.signal)
      const result = await recoverInterruptedQuirkydActivation({
        ...managedQuirkydSlot(context, deployment.remotePort, args.signal),
        acceptChangedState: args.acceptChangedState === true
      })
      if (result.outcome !== 'recovered') {
        return result
      }
      const updated = result.readiness
        ? refreshPairing(userDataPath, environment, result.readiness, deployment.localPort)
        : environment
      if (result.activeVersion) {
        await followLaunchedServerPort(userDataPath, environment.id)
      }
      return {
        outcome: 'recovered',
        resolution: result.resolution,
        activeVersion: result.activeVersion,
        environment: redactRuntimeEnvironment(updated)
      }
    }
  )
}

/**
 * A rollback restores the snapshot taken when the current version activated. If a migration
 * began after that, the snapshot predates the imported catalog and restoring it would drop it.
 */
function migrationRollbackRefusal(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  activatedAt: string | null
): QuirkydManagedRollbackResult | null {
  if (findIncompleteManagedQuirkydMigration(userDataPath, environment.id)) {
    return {
      outcome: 'refused',
      code: 'quirkyd_rollback_migration_in_progress',
      reason: 'A migration into this server is still running. Finish it before rolling back.'
    }
  }
  const migratedAt = latestQuirkydMigrationInto(userDataPath, environment)
  if (migratedAt && (activatedAt === null || Date.parse(activatedAt) < Date.parse(migratedAt))) {
    return {
      outcome: 'refused',
      code: 'quirkyd_rollback_crosses_migration',
      reason:
        "The previous version's state predates the projects migrated onto this server; " +
        'rolling back would lose them. Deploy forward instead.'
    }
  }
  return null
}
