/**
 * Deploys quirkyd onto an empty SSH host and pairs this client with it through a loopback tunnel.
 * The target claim is the resume point: an interrupted deploy leaves the target owned by the
 * environment id it was creating, and the next deploy of that target finishes the same one.
 */
import { getAppEnvironment } from '../../../shared/app-environment'
import { randomUUID } from 'node:crypto'
import { assertRuntimeEnvironmentNotReconciling } from '../../../shared/runtime-environment-reconciliation-record'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { addManagedQuirkydEnvironment } from '../../../shared/runtime-environment-managed-quirkyd-store'
import {
  getQuirkydSshDeployment,
  redactRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  QUIRKYD_MANAGED_REMOTE_PORT,
  type QuirkydManagedDeferral,
  type QuirkydManagedDeployResult
} from '../../../shared/quirkyd-managed-runtime'
import { getManagedQuirkydFenceEnvironmentId } from '../../../shared/managed-quirkyd-ssh-owner'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { materializeQuirkydArtifact } from '../../quirkyd/quirkyd-artifact-materializer'
import {
  closeQuirkydManagedTunnel,
  ensureQuirkydManagedTunnel,
  startQuirkydManagedTunnel
} from './quirkyd-managed-tunnel'
import { recoverInterruptedQuirkydActivation } from '../activation/quirkyd-activation-recovery'
import { wakeAlreadyActiveQuirkyd } from '../../ssh/quirkyd-already-active-wake'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import {
  resolveQuirkydRemoteContext,
  type QuirkydRemoteContext
} from '../install/quirkyd-remote-context'
import { deployQuirkyd } from '../../ssh/quirkyd-remote-deploy'
import {
  adoptRunningQuirkydVersion,
  type QuirkydRunningAdoption
} from '../../ssh/quirkyd-running-version-adoption'
import { readLocalFullVersion } from '../install/remote-versioned-install'
import { sshQuirkydHostTransport } from '../../ssh/quirkyd-ssh-host-transport'
import { QUIRKYD_ACTIVATION_POLICY_REFUSED_CODE } from '../../ssh/quirkyd-installed-activation'
import { pruneManagedQuirkydVersions } from './quirkyd-managed-version-gc'
import { tunneledQuirkydPairingCode } from '../../ssh/quirkyd-tunneled-pairing'
import { resolveQuirkydMigrationFence } from '../../ssh/quirkyd-migration-source-fence'
import type { SshTarget } from '../../../shared/ssh-types'
import { findCollidingEnvironmentName } from '../../../shared/runtime-environment-name-collision'
import { deployedQuirkydTunnelChecks } from './quirkyd-managed-tunnel-identity'
import {
  isForceableQuirkydDeferral,
  managedQuirkydDeployPolicy,
  managedQuirkydSlot,
  probeManagedQuirkydReadiness,
  requireManagedQuirkydInfrastructure
} from './quirkyd-managed-runtime-context'

export async function createManagedQuirkydEnvironment(
  userDataPath: string,
  args: {
    name: string
    sshTargetId: string
    force?: boolean
    signal?: AbortSignal
    /** Deploying into a target fenced by a migration journal rather than claiming an empty one. */
    migration?: boolean
  }
): Promise<QuirkydManagedDeployResult> {
  return runTargetLifecycle(args.sshTargetId, async () => {
    const { connectionManager, targetStore, claims } = requireManagedQuirkydInfrastructure()
    const environmentId =
      getManagedQuirkydFenceEnvironmentId(targetStore.getTarget(args.sshTargetId)) ?? randomUUID()
    const environments = listEnvironments(userDataPath)
    const registered = environments.find((entry) => entry.id === environmentId)
    if (registered) {
      assertRuntimeEnvironmentNotReconciling(registered)
      if (getQuirkydSshDeployment(registered)?.sshTargetId !== args.sshTargetId) {
        throw new Error('The SSH target is owned by a server that is not deployed on it.')
      }
    }
    const namesake = findCollidingEnvironmentName(
      environments.filter((entry) => entry.id !== environmentId),
      args.name
    )
    if (namesake) {
      throw new Error(`A server named "${namesake.name}" already exists.`)
    }
    const current = targetStore.getTarget(args.sshTargetId)
    if (args.migration) {
      assertMigrationFence(userDataPath, current, environmentId, args.name)
    }
    const claimed = claims.claim(args.sshTargetId, environmentId, {
      // A migration records itself in its journal, not as a provisioning intent.
      ...(args.migration ? {} : { deployName: args.name }),
      // Why: this deploy's own claim left a provisioning intent or a journal, or registered a server.
      ownerRecorded:
        Boolean(args.migration) || Boolean(current?.quirkydProvisioning) || Boolean(registered)
    })
    await claims.flush(args.signal)
    const targetGeneration = claimed.generation
    if (targetGeneration === undefined) {
      throw new Error(
        'The SSH registration for this host’s Quirky server has no durable generation.'
      )
    }
    if (
      registered &&
      getQuirkydSshDeployment(registered)?.sshTargetGeneration !== targetGeneration
    ) {
      throw new Error('The saved Quirky server for this host has a stale SSH target generation.')
    }
    let environmentRegistered = false
    try {
      const connection = await connectionManager.connect(claimed)
      let context = await resolveQuirkydRemoteContext(
        claimed,
        sshQuirkydHostTransport(connection),
        args.signal
      )
      const slot = managedQuirkydSlot(context, QUIRKYD_MANAGED_REMOTE_PORT, args.signal)
      const recovery = await recoverInterruptedQuirkydActivation(slot)
      if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
        throw new Error(recovery.reason)
      }
      if (recovery.outcome === 'recovered') {
        context = { ...context, activationRecord: await readQuirkydActivationRecord(slot) }
      }
      if (registered) {
        environmentRegistered = true
        const current = await ensureQuirkydManagedTunnel(userDataPath, registered.id)
        const activeVersion = context.activationRecord.active
        if (!activeVersion) {
          throw new Error('This host’s Quirky server has no active runtime version.')
        }
        return {
          outcome: 'already-current',
          environment: redactRuntimeEnvironment(current),
          activeVersion
        }
      }
      const localQuirkydDir = await materializeQuirkydArtifact(context.serverTarget, {
        signal: args.signal
      })
      // Before any upload, so a host another version serves is left exactly as it was. A migration
      // adopts too: only the paired server can count its terminals, so its own deploy would defer.
      const localVersion = readLocalFullVersion(localQuirkydDir)
      const adopted = args.force
        ? null
        : await adoptRunningQuirkydVersion(slot, context.activationRecord, localVersion)
      const { active } = context.activationRecord
      if (!adopted && !args.force && active && active !== localVersion) {
        // The wake re-read a record another desktop changed; the census policy follows it.
        context = { ...context, activationRecord: await readQuirkydActivationRecord(slot) }
      }
      const serving: DeployedQuirkyd | QuirkydManagedDeferral =
        adopted ??
        (await deployOwnQuirkyd(context, { ...slot, conn: connection }, localQuirkydDir, args))
      if ('outcome' in serving) {
        return serving
      }
      // Why read back: quirkyd binds another port when the preferred one is taken on the host.
      const tunnel = deployedQuirkydTunnelChecks(serving.readiness, serving.reprobe)
      const localPort = await startQuirkydManagedTunnel(
        environmentId,
        claimed,
        connection,
        tunnel.remotePort,
        { ...tunnel, preferredPort: QUIRKYD_MANAGED_REMOTE_PORT }
      )
      const environment = addManagedQuirkydEnvironment(userDataPath, {
        id: environmentId,
        name: args.name,
        pairingCode: tunneledQuirkydPairingCode(tunnel.readiness(), localPort),
        quirkydDeployment: {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          localPort,
          remotePort: QUIRKYD_MANAGED_REMOTE_PORT
        }
      })
      environmentRegistered = true
      return {
        // An adopted server keeps its version; the linked update check may replace it later.
        outcome: serving.created ? 'created' : 'already-current',
        environment: redactRuntimeEnvironment(environment),
        activeVersion: serving.version
      }
    } finally {
      if (!environmentRegistered) {
        await closeQuirkydManagedTunnel(environmentId).catch(() => undefined)
      }
    }
  })
}

type DeployedQuirkyd = QuirkydRunningAdoption & { created?: true }

async function deployOwnQuirkyd(
  context: QuirkydRemoteContext<SshTarget>,
  slot: ReturnType<typeof managedQuirkydSlot>,
  localQuirkydDir: string,
  args: { force?: boolean; signal?: AbortSignal }
): Promise<DeployedQuirkyd | QuirkydManagedDeferral> {
  const appVersion = getAppEnvironment().getVersion()
  const deployResult = await deployQuirkyd({
    ...slot,
    localQuirkydDir,
    target: context.serverTarget,
    ...managedQuirkydDeployPolicy(context, appVersion, args.force),
    force: args.force,
    appVersion
  })
  if (deployResult.outcome === 'installed-not-activated') {
    return {
      outcome: 'deferred',
      candidateVersion: deployResult.fullVersion,
      code: deployResult.code,
      reason: deployResult.reason,
      forceable:
        isForceableQuirkydDeferral(deployResult.code) ||
        deployResult.code === QUIRKYD_ACTIVATION_POLICY_REFUSED_CODE
    }
  }
  if (deployResult.outcome === 'already-active') {
    await wakeAlreadyActiveQuirkyd(slot)
  }
  const reprobe = () =>
    probeManagedQuirkydReadiness(context, localQuirkydDir, deployResult.fullVersion, args.signal)
  const readiness = await reprobe()
  await pruneManagedQuirkydVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployResult.fullVersion,
    readiness
  })
  return {
    version: deployResult.fullVersion,
    readiness,
    reprobe,
    ...(deployResult.outcome === 'already-active' ? {} : { created: true as const })
  }
}

function assertMigrationFence(
  userDataPath: string,
  target: SshTarget | undefined,
  environmentId: string,
  name: string
): void {
  const fence = target ? resolveQuirkydMigrationFence(userDataPath, target) : null
  if (
    fence?.state !== 'fenced' ||
    fence.cutover.destinationEnvironmentId !== environmentId ||
    fence.cutover.destinationName !== name
  ) {
    throw new Error('quirkyd_migration_fence_required')
  }
}
