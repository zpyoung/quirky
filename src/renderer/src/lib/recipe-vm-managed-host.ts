import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  getManagedQuirkydSshTargetId,
  type ManagedQuirkydEnvironmentSummary
} from '../../../shared/managed-quirkyd-execution-host'

/** The hidden SSH target of the recipe VM whose managed server is `hostId`, or null. */
export function getRecipeVmSshTargetForHost(
  environments: readonly ManagedQuirkydEnvironmentSummary[],
  hostId: string | null | undefined
): string | null {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  const environment = environments.find((entry) => entry.id === host.environmentId)
  const targetId = environment ? getManagedQuirkydSshTargetId(environment) : null
  return targetId && isRuntimeOwnedSshTargetId(targetId) ? targetId : null
}
