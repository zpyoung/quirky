import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'

/** Where an agent child this runtime spawns and supervises itself can run: on this machine, outside
 *  WSL. */
export function supportsSupervisedProviderChildLocation(
  location: AgentSessionExecutionLocation
): boolean {
  return location.executionHostId === LOCAL_EXECUTION_HOST_ID && location.wslDistro === null
}
