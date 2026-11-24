import {
  parseQuirkySessionAddress,
  type QuirkySessionId
} from '../../../shared/quirky-session-address'
import { structuredWorkerQuirkySessionIdForIncarnation } from '../structured-worker-identity'
import { canonicalQuirkySessionId } from './canonical-quirky-session-id'

/**
 * The Quirky session id a Dispatch row stores for its assignee: the structured worker its process
 * incarnation names, or the chat its `quirky_session_id:` handle names. A PTY has none.
 */
export function dispatchAssigneeQuirkySessionId(assignee: {
  handle: string
  processIncarnation: string | null | undefined
}): QuirkySessionId | null {
  const quirkySessionId =
    structuredWorkerQuirkySessionIdForIncarnation(assignee.processIncarnation) ??
    parseQuirkySessionAddress(assignee.handle)
  return quirkySessionId === null ? null : canonicalQuirkySessionId(quirkySessionId)
}
