import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { probeManagedQuirkydTunnel } from './quirkyd-managed-tunnel-resume'
import { ensureManagedQuirkydServing } from './quirkyd-managed-serving'
import { QuirkydManagedTunnelManager } from './quirkyd-managed-tunnel-manager'
import { getRemoteRuntimeSharedControlAnsweredAt } from '../../ipc/runtime-environments/runtime-environment-shared-control-answers'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import {
  MANAGED_QUIRKYD_TUNNEL_TARGETING,
  type QuirkydTunnelStartChecks
} from './quirkyd-managed-tunnel-target'
import {
  liveManagedQuirkydPairingRepairDeps,
  ManagedQuirkydPairingRepairs,
  pairingRevisionOf
} from './quirkyd-managed-pairing-repair'
import {
  buildWithPairingRepair,
  type ManagedQuirkydPairingRecovery
} from './quirkyd-managed-tunnel-pairing-recovery'

const managedTunnels = new QuirkydManagedTunnelManager({
  getConnectionManager: getSshConnectionManager,
  getTargetStore: getSshTargetRegistryStore,
  targeting: MANAGED_QUIRKYD_TUNNEL_TARGETING,
  ensureServing: (input) =>
    ensureManagedQuirkydServing({
      ...input,
      probe: probeManagedQuirkydTunnel,
      answeredAt: getRemoteRuntimeSharedControlAnsweredAt
    })
})

const pairingRepairs = new Map<string, ManagedQuirkydPairingRepairs>()

function pairingRecovery(userDataPath: string): ManagedQuirkydPairingRecovery {
  let repairs = pairingRepairs.get(userDataPath)
  if (!repairs) {
    repairs = new ManagedQuirkydPairingRepairs(liveManagedQuirkydPairingRepairDeps(userDataPath))
    pairingRepairs.set(userDataPath, repairs)
  }
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    repairs,
    ensure: (environment) =>
      managedTunnels.ensure(environment, () =>
        resolveEnvironmentOrNull(userDataPath, environment.id)
      )
  }
}

/** Returns the environment as stored once the tunnel stands: a re-pair replaces its credentials. */
export async function ensureQuirkydManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  const { id } = resolveEnvironment(userDataPath, selector)
  await buildWithPairingRepair(pairingRecovery(userDataPath), id, (environment) =>
    managedTunnels.ensure(environment, () => resolveEnvironmentOrNull(userDataPath, id))
  )
  return resolveEnvironment(userDataPath, id)
}

/** After a redeploy: the reused forward may target the port the previous server bound. */
export async function rebuildQuirkydManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<'built' | 'repaired'> {
  const { id } = resolveEnvironment(userDataPath, selector)
  return buildWithPairingRepair(pairingRecovery(userDataPath), id, (environment) =>
    managedTunnels.rebuild(environment, () => resolveEnvironmentOrNull(userDataPath, id))
  )
}

/**
 * A socket through a standing tunnel had its token refused. Forwarding anew re-proves which
 * server answers, so only our own server's refusal re-pairs; a foreign one fails as foreign.
 */
export function recoverRefusedManagedQuirkydPairing(
  userDataPath: string,
  environmentId: string
): Promise<'built' | 'repaired'> {
  return rebuildQuirkydManagedTunnel(userDataPath, environmentId)
}

/** Whether a failed re-pair stands for the pairing stored now; one for an older pairing judges nothing current. */
export function managedQuirkydPairingFailureStands(
  userDataPath: string,
  environmentId: string
): boolean {
  const environment = resolveEnvironmentOrNull(userDataPath, environmentId)
  return (
    environment !== null &&
    (pairingRepairs
      .get(userDataPath)
      ?.standingFailure(environmentId, pairingRevisionOf(environment)) ?? null) !== null
  )
}

/** An explicit connect is the user asking again, so recent failed re-pairs must not answer it. */
export function forgetFailedManagedQuirkydPairingRepair(
  userDataPath: string,
  environmentId: string
): void {
  pairingRepairs.get(userDataPath)?.forgetFailures(environmentId)
}

function resolveEnvironmentOrNull(userDataPath: string, id: string) {
  try {
    return resolveEnvironment(userDataPath, id)
  } catch {
    return null
  }
}

export function verifyManagedTunnelServing(environment: KnownRuntimeEnvironment) {
  return managedTunnels.verifyServing(environment)
}

export function disposeQuirkydManagedTunnels(): void {
  managedTunnels.dispose()
}

/** Why on quit: a system-ssh tunnel is its own `ssh -L` process and would outlive Quirky. */
export function shutdownQuirkydManagedTunnels(): Promise<void> {
  return managedTunnels.shutdown()
}

export function recoverQuirkydManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return managedTunnels.recoverAfterHostResume({
    ...options,
    resolveEnvironment: (environmentId) => resolveEnvironmentOrNull(userDataPath, environmentId)
  })
}

export function startQuirkydManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number,
  checks?: QuirkydTunnelStartChecks
): Promise<number> {
  return managedTunnels.start(environmentId, target, connection, remotePort, checks)
}

export function closeQuirkydManagedTunnel(environmentId: string): Promise<void> {
  return managedTunnels.close(environmentId)
}

/** Part of the SSH session's teardown, so a Disconnect leaves no managed `ssh -L` listening. */
export function closeQuirkydManagedTunnelsForTarget(targetId: string): Promise<void> {
  return managedTunnels.closeTarget(targetId)
}
