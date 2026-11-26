/**
 * The Quirky-minted agent session id, injected into a structured session's own child processes. When
 * it is present it IS the orchestration caller: the CLI sends it in the orchestration envelope and
 * the host resolves the session it names, so no terminal is resolved or guessed on its behalf.
 *
 * Identity by session id assumes one machine and one user. A host boundary (SSH, a paired peer,
 * WSL) re-opens that decision: the host refuses a claim that arrives across one, and the SSH
 * passthrough never carries the id.
 */
import { QUIRKY_SESSION_ADDRESS_PREFIX } from './quirky-session-address-prefix'
import { isStructuredWorkerHandle } from './structured-worker-handle'

export const QUIRKY_AGENT_SESSION_ID_ENV = 'QUIRKY_AGENT_SESSION_ID'

/** Set to `json` in an agent's environment so every CLI call answers machine-readably without `--json`. */
export const QUIRKY_OUTPUT_ENV = 'QUIRKY_OUTPUT'

/** The spawn token a structured session's child echoes, so the owner probe can tell a live child
 *  of that reservation from a same-pid stranger. */
export const QUIRKY_AGENT_SESSION_SPAWN_TOKEN_ENV = 'QUIRKY_AGENT_SESSION_SPAWN_TOKEN'

export function readInjectedAgentSessionId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const value = env[QUIRKY_AGENT_SESSION_ID_ENV]?.trim()
  return value ? value : undefined
}

/**
 * The address the host gives this session (`mailboxAddressOf` on its resolved party): a structured
 * worker keeps the handle it was minted, any other session is `quirky_session_id:<id>`. Only for text that
 * must match what the host writes; the CLI spells it without the host resolver.
 */
export function injectedSessionAddress(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const sessionId = readInjectedAgentSessionId(env)
  if (!sessionId) {
    return undefined
  }
  const ownHandle = env.QUIRKY_TERMINAL_HANDLE
  return isStructuredWorkerHandle(ownHandle)
    ? ownHandle
    : `${QUIRKY_SESSION_ADDRESS_PREFIX}${sessionId}`
}
