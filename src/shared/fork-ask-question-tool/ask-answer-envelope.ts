/**
 * Answer-envelope shapes for `quirky ask` (logic.md § Answer contract). Dependency-free by
 * design: mobile mirrors this file verbatim as its own copy of the wire contract.
 */

export type AskSelectAnswer = {
  value: string
  label?: string
  note?: string
  source: 'option' | 'other' | 'default'
}

export type AskMultiselectAnswer = {
  values: string[]
  labels: string[]
  other?: string
  source: 'options' | 'default'
}

export type AskTextAnswer = { value: string; source: 'input' | 'default' }
export type AskNumberAnswer = { value: number; source: 'input' | 'default' }
/** `value` is an ISO 8601 calendar date, `YYYY-MM-DD`. */
export type AskDateAnswer = { value: string; source: 'input' | 'default' }
export type AskConfirmAnswer = { value: boolean; source: 'input' | 'default' }

export type AskAnswer =
  | AskSelectAnswer
  | AskMultiselectAnswer
  | AskTextAnswer
  | AskNumberAnswer
  | AskDateAnswer
  | AskConfirmAnswer

/** Keyed by question `id`; a skipped question is omitted here and listed in `skipped[]` instead. */
export type AskAnswers = Record<string, AskAnswer>

/**
 * All statuses an ask can report over the wire, including the non-terminal `registered` and
 * `pending` states. `pending` is wire-only: it is emitted when a chunked wait elapses
 * unanswered and is never written to the persisted `asks` row (see `PersistedAskStatus`).
 */
export type AskStatus =
  | 'registered'
  | 'pending'
  | 'answered'
  | 'partial'
  | 'declined'
  | 'timed_out'
  | 'unavailable'

/** Status values the `asks` table's `status` column may hold; `pending` never persists. */
export type PersistedAskStatus = Exclude<AskStatus, 'pending'>

/**
 * The terminal envelope body — present on every terminal transition and what the card's
 * collapsed read-only summary renders from (tech.md § Data models).
 */
export type AskResultBody = {
  answers: AskAnswers
  /** Question ids the user left unanswered; never also present in `answers`. */
  skipped: string[]
  /** One rendered human-readable line per question, for the model to quote verbatim. */
  summary: string
}

export type AskRegisteredEnvelope = { status: 'registered'; askId: string }
/** `instruction` is a human-readable instruction to resume blocking, e.g. `quirky ask wait --id <askId>`. */
export type AskPendingEnvelope = { status: 'pending'; askId: string; instruction: string }

export function pendingEnvelope(askId: string): AskPendingEnvelope {
  return { status: 'pending', askId, instruction: `quirky ask wait --id ${askId}` }
}
export type AskAnsweredEnvelope = { status: 'answered'; askId: string } & AskResultBody
export type AskPartialEnvelope = { status: 'partial'; askId: string } & AskResultBody
export type AskDeclinedEnvelope = { status: 'declined'; askId: string } & AskResultBody
export type AskTimedOutEnvelope = { status: 'timed_out'; askId: string } & AskResultBody
export type AskUnavailableEnvelope = {
  status: 'unavailable'
  askId: string
  reason: string
} & AskResultBody

export type AskEnvelope =
  | AskRegisteredEnvelope
  | AskPendingEnvelope
  | AskAnsweredEnvelope
  | AskPartialEnvelope
  | AskDeclinedEnvelope
  | AskTimedOutEnvelope
  | AskUnavailableEnvelope

const TERMINAL_ASK_STATUSES: ReadonlySet<AskStatus> = new Set([
  'answered',
  'partial',
  'declined',
  'timed_out',
  'unavailable'
])

/** True for exactly the five terminal statuses; false for `registered` and `pending`. */
export function isTerminalAskStatus(
  status: AskStatus
): status is Exclude<AskStatus, 'registered' | 'pending'> {
  return TERMINAL_ASK_STATUSES.has(status)
}

export function isTerminalAskEnvelope(
  envelope: AskEnvelope
): envelope is Exclude<AskEnvelope, AskRegisteredEnvelope | AskPendingEnvelope> {
  return isTerminalAskStatus(envelope.status)
}
