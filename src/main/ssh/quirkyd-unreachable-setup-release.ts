/**
 * Recovers a host an earlier build stranded: a conversion fenced it and registered its managed
 * server, but the host's sshd refuses the forward that server is reached by, so nothing was ever
 * staged there. The source still holds every row, so the server is unregistered and the fence
 * released through the undeployed-fence path, and the relay serves the host again. An quirkyd the
 * setup did activate is stopped first, so a later conversion starts fresh rather than deferring.
 */
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeManagedQuirkydEnvironment } from '../../shared/runtime-environment-managed-quirkyd-store'
import { findQuirkydMigrationSourceCutoverForTarget } from './quirkyd-migration-cutover-journal'
import { releaseUndeployedMigrationFence } from './quirkyd-migration-source-fence'
import { closeQuirkydManagedTunnel } from '../managed-server/lifecycle/quirkyd-managed-tunnel'
import type { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'
import { withQuirkydActivationLock } from '../managed-server/activation/quirkyd-activation-lock'
import { withDeactivatedVersionCommitted } from '../managed-server/activation/quirkyd-activation-record'
import {
  readQuirkydActivationRecord,
  writeQuirkydActivationRecord
} from '../managed-server/activation/quirkyd-activation-record-store'
import { managedQuirkydSlot } from '../managed-server/lifecycle/quirkyd-managed-runtime-context'
import { resolveQuirkydRemoteContext } from '../managed-server/install/quirkyd-remote-context'
import { quirkydStopFreedTheHost } from '../managed-server/install/quirkyd-remote-process-control'
import { quirkydSlotDir, stopQuirkydSlot } from './quirkyd-recovery-slot'
import { sshQuirkydHostTransport } from './quirkyd-ssh-host-transport'
import { getSshConnectionManager, getSshTargetRegistryStore } from './targets/ssh-target-registry'
import { errorMessage } from '../../shared/error-message'

export async function releaseUnreachableQuirkydSetup(args: {
  userDataPath: string
  claims: SshTargetQuirkydClaims
  targetId: string
  signal?: AbortSignal
}): Promise<void> {
  const cutover = findQuirkydMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Why only this phase: a staged or committed destination holds state only it can account for.
  if (cutover?.phase !== 'source-fenced') {
    return
  }
  const environmentId = cutover.destinationEnvironmentId
  await closeQuirkydManagedTunnel(environmentId).catch(() => undefined)
  await stopStrandedQuirkyd(args.targetId, args.signal).catch((error: unknown) => {
    console.warn(`[quirkyd] Could not stop the unreachable setup's server: ${errorMessage(error)}`)
  })
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  // Unregister first: a crash after it leaves an undeployed fence, which the same path releases.
  if (isRegistered(environmentId)) {
    removeManagedQuirkydEnvironment(args.userDataPath, environmentId)
  }
  await releaseUndeployedMigrationFence({
    userDataPath: args.userDataPath,
    claims: args.claims,
    targetId: args.targetId,
    isDestinationRegistered: isRegistered,
    signal: args.signal
  })
}

/** Clears `active` only once the slot is proven exited; its daemon and terminals outlive it. */
async function stopStrandedQuirkyd(targetId: string, signal?: AbortSignal): Promise<void> {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  const connectionManager = getSshConnectionManager()
  if (!target || !connectionManager) {
    return
  }
  const context = await resolveQuirkydRemoteContext(
    target,
    sshQuirkydHostTransport(await connectionManager.connect(target)),
    signal
  )
  if (!context.activationRecord.active) {
    return
  }
  // The port only matters for a launch, which this never does.
  const slot = managedQuirkydSlot(context, 0, signal)
  await withQuirkydActivationLock(
    slot,
    async () => {
      const record = await readQuirkydActivationRecord(slot)
      if (!record.active) {
        return
      }
      const stopped = await stopQuirkydSlot(slot, quirkydSlotDir(slot, record.active), false)
      if (quirkydStopFreedTheHost(stopped)) {
        await writeQuirkydActivationRecord(slot, withDeactivatedVersionCommitted(record))
      }
    },
    () => undefined
  )
}
