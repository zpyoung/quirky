import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { removeManagedQuirkydEnvironment } from '../shared/runtime-environment-managed-quirkyd-store'
import { listEnvironments, removeEnvironment } from '../shared/runtime-environment-store'
import { getQuirkydSshDeployment } from '../shared/runtime-environments'

/** Forgets the servers a destroyed VM ran; a managed one's tunnel would otherwise keep redialing. */
export async function releaseEphemeralVmRuntimeEnvironments(
  userDataPath: string,
  runtime: Pick<EphemeralVmRuntimeRecord, 'runtimeEnvironmentId' | 'sshTargetId'>
): Promise<void> {
  // Why the target too: a relay-era VM converted on connect never recorded its server's id.
  const environments = listEnvironments(userDataPath).filter(
    (entry) =>
      entry.id === runtime.runtimeEnvironmentId ||
      (runtime.sshTargetId !== undefined &&
        getQuirkydSshDeployment(entry)?.sshTargetId === runtime.sshTargetId)
  )
  for (const environment of environments) {
    if (!environment.quirkydDeployment) {
      removeEnvironment(userDataPath, environment.id)
      continue
    }
    const { closeQuirkydManagedTunnel } =
      await import('./managed-server/lifecycle/quirkyd-managed-tunnel')
    await closeQuirkydManagedTunnel(environment.id).catch(() => undefined)
    removeManagedQuirkydEnvironment(userDataPath, environment.id)
  }
}
