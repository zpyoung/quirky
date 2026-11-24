import { isAgentSessionId } from './agent-session-record'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from './structured-worker-handle'
import { QUIRKY_SESSION_ADDRESS_PREFIX } from './quirky-session-address-prefix'

/**
 * The Quirky session id is the id Quirky minted for a structured session (its session record id, the
 * value of `QUIRKY_AGENT_SESSION_ID`), never the provider's own session id. Orchestration stores,
 * bare, the one the agent is addressed by: for a `/clear`ed chat, its lineage root's, not the live
 * session's. Mail addresses the session as `quirky_session_id:<id>`, beside `run:<id>` and `dispatch:<id>`,
 * and derives that spelling here rather than storing it.
 *
 * Where the session runs is not part of the id; it is read from the session record when needed. PTY
 * agents have none today, and never a pane-keyed one: a pane outlives the agent in it, so such an id
 * would be inherited by the pane's next occupant.
 */
export { QUIRKY_SESSION_ADDRESS_PREFIX }

declare const quirkySessionIdBrand: unique symbol
declare const quirkySessionAddressBrand: unique symbol

/** A bare Quirky session id; only `isQuirkySessionId` and `parseQuirkySessionAddress` produce one. */
export type QuirkySessionId = string & { readonly [quirkySessionIdBrand]: true }
/** An `quirky_session_id:<id>` mail address; only `formatQuirkySessionAddress` produces one. */
export type QuirkySessionAddress = string & { readonly [quirkySessionAddressBrand]: true }

// Terminal handles (`term_` from the PTY runtime, `structworker_` from structured-worker-identity)
// share the session-id charset. A handle is never a session, so one handed over by mistake must not
// become a durable Quirky session id.
const TERMINAL_HANDLE_PREFIXES = ['term_', STRUCTURED_WORKER_HANDLE_PREFIX] as const

export function isQuirkySessionId(id: string): id is QuirkySessionId {
  return isAgentSessionId(id) && !TERMINAL_HANDLE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

export function formatQuirkySessionAddress(quirkySessionId: QuirkySessionId): QuirkySessionAddress {
  const address = `${QUIRKY_SESSION_ADDRESS_PREFIX}${quirkySessionId}`
  // Always true for a checked id; the check brands the address without a type assertion.
  if (!isQuirkySessionAddress(address)) {
    throw new Error(`Not an Quirky session id: ${quirkySessionId}`)
  }
  return address
}

/** The bare Quirky session id of an `quirky_session_id:<id>` address; anything else reads as null. */
export function parseQuirkySessionAddress(
  address: string | null | undefined
): QuirkySessionId | null {
  if (!address?.startsWith(QUIRKY_SESSION_ADDRESS_PREFIX)) {
    return null
  }
  const id = address.slice(QUIRKY_SESSION_ADDRESS_PREFIX.length)
  return isQuirkySessionId(id) ? id : null
}

function isQuirkySessionAddress(address: string): address is QuirkySessionAddress {
  return parseQuirkySessionAddress(address) !== null
}
