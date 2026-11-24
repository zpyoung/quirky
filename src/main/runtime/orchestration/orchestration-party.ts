// The one place an orchestration address becomes a party, so no two sites can disagree on who it names.
import {
  formatQuirkySessionAddress,
  isQuirkySessionId,
  parseQuirkySessionAddress,
  type QuirkySessionId
} from '../../../shared/quirky-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  isRecordedStructuredWorkerSession,
  resolveStructuredWorkerIdentity,
  resolveStructuredWorkerIdentityForRoot
} from '../structured-worker-authority'
import { canonicalQuirkySessionId } from './canonical-quirky-session-id'
import type { OrchestrationDb } from './db'
import { mailboxAddressOf, type OrchestrationCallerIdentity } from './orchestration-caller-identity'
import { OrchestrationError } from './orchestration-error'

/** A party as Run binding and mail routing match it; `address` is its one mailbox address. */
export type OrchestrationParty = OrchestrationCallerIdentity

/** A party named by an Quirky session id: a structured worker, or a chat. */
export type OrchestrationSessionParty = OrchestrationParty &
  Readonly<{ quirkySessionId: QuirkySessionId }>

const NO_EFFECTS = { effectsApplied: false } as const

/** Every param naming a party other than the caller; a new one is added here with its own test. */
export const ORCHESTRATION_TARGET_PARAM: Readonly<
  Record<string, 'to' | 'terminal' | 'sessionId' | 'address'>
> = {
  'orchestration.send': 'to',
  'orchestration.ask': 'to',
  'orchestration.dispatch': 'to',
  'orchestration.inbox': 'terminal',
  'orchestration.sessionAddress': 'sessionId',
  'orchestration.partyLocation': 'address',
  'orchestration.workerStart': 'terminal'
}

/** The party an Quirky session id names. Throws when it is a worker this host lost the identity of. */
export function resolveQuirkySessionParty(
  quirkySessionId: QuirkySessionId,
  db: OrchestrationDb | null | undefined
): OrchestrationSessionParty {
  const id = canonicalQuirkySessionId(quirkySessionId)
  const worker = resolveStructuredWorkerIdentityForRoot(id, db)
  if (!worker && db && isRecordedStructuredWorkerSession(id, db)) {
    // Why: handle-less, it would split one worker into two parties and bind like a chat.
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${id} is a structured worker whose worker identity this host no longer has, so orchestration cannot address it. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const key = { terminalHandle: worker?.handle ?? null, quirkySessionId: id }
  return {
    ...key,
    address: mailboxAddressOf(key) ?? formatQuirkySessionAddress(id),
    paneKey: worker?.paneKey ?? null
  }
}

/** The party an address names; a PTY handle is itself and costs no lookup. */
export function resolveOrchestrationParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const quirkySessionId = parseQuirkySessionAddress(address)
  if (quirkySessionId) {
    return resolveQuirkySessionParty(quirkySessionId, db)
  }
  const worker = resolveStructuredWorkerIdentity(address, db)
  return {
    address,
    terminalHandle: address,
    paneKey: worker?.paneKey ?? null,
    quirkySessionId:
      worker && isQuirkySessionId(worker.sessionId)
        ? canonicalQuirkySessionId(worker.sessionId)
        : null
  }
}

/** How a preamble names a party: a session by its Quirky session ID (its `/clear` root), else its handle. */
export function quirkySessionIdOrHandle(
  address: string,
  db: OrchestrationDb | null | undefined
): string {
  const { quirkySessionId } = resolveOrchestrationParty(address, db)
  return quirkySessionId === null ? address : formatQuirkySessionAddress(quirkySessionId)
}

/** A caller named by a param: naming a chat's address proves nothing, unlike its own session id. */
export function resolveDeclaredCallerParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const party = resolveOrchestrationParty(address, db)
  if (party.terminalHandle === null) {
    throw new OrchestrationError(
      CODES.chatNotDeclarable,
      `Agent session ${party.quirkySessionId} is a chat, and a chat is identified only by the Quirky session ID its own environment sends, never by naming it. No effects were applied.`,
      NO_EFFECTS
    )
  }
  return party
}

/**
 * A Dispatch assignee: a terminal, a structured worker, or a chat named by its Quirky session ID. A
 * chat's party is its `/clear` root address, which its own session id resolves to when it reports.
 */
export function resolveDispatchAssigneeParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  return resolveOrchestrationParty(address, db)
}
