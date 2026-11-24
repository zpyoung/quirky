import {
  formatQuirkySessionAddress,
  isQuirkySessionId
} from '../../../shared/quirky-session-address'
import type { OrchestrationSessionAddressResult } from '../../../shared/orchestration-caller-status'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/**
 * A chat's Quirky session ID: its `/clear` root's, which the host derives from the session records.
 * Null for an id that is not an Quirky session id.
 */
export async function resolveStructuredSessionQuirkySessionId(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<string | null> {
  if (!isQuirkySessionId(sessionId)) {
    return null
  }
  try {
    const result = await callRuntimeRpc<OrchestrationSessionAddressResult>(
      target,
      'orchestration.sessionAddress',
      { sessionId }
    )
    return result.quirkySessionId
  } catch (error) {
    // Why: a host that predates the method routes the current session's ID to the same chat.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return formatQuirkySessionAddress(sessionId)
    }
    throw error
  }
}
