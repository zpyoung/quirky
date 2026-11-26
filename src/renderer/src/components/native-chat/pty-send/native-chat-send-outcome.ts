// Post-send outcome contract for native chat: the exactly-once outcome
// reporter, the throw-safe queue-release guard, and the bounded post-CR
// observation poll. Split out of native-chat-runtime-send.ts to keep that
// file's clear/body/Enter sequencing at a readable size.

import {
  sendRuntimePtyInputAcceptance,
  sendRuntimePtyInputDelivery
} from '@/runtime/runtime-terminal-inspection'
import type { NativeChatSendOptions } from '../native-chat-runtime-send'
import { NATIVE_CHAT_SUBMIT } from '../native-chat-send'

/**
 * Best-effort read of whether a send's submit CR landed. Never proof of
 * delivery — the TUI screen can lag or redraw between the write and the
 * observation, so a negative reading alone must never trigger a resend.
 */
export type SendOutcome = 'observed-cleared' | 'unobservable' | 'may-not-have-sent'

/** Reads taken while polling the post-send observation. */
export const NATIVE_CHAT_SUBMIT_OBSERVATION_MAX_READS = 4

/** Gap between each observation poll; keeps the total window under the ~3s
 *  bound while giving a lagging TUI redraw more than one chance to catch up. */
export const NATIVE_CHAT_SUBMIT_OBSERVATION_POLL_MS = 900

/**
 * Upstream's per-write delivery reporting for one send. Present only when the
 * caller asked for it; without it a lost acknowledgment reads as a failed write.
 */
export type NativeChatDeliveryObserver = {
  /** The host refused a write; nothing after it is sent. */
  rejected: () => void
  /** A write's acknowledgment was lost. The send continues past it, never resending it. */
  unconfirmed: () => void
  /** Every write has settled; reports whether all of them were acknowledged. */
  settled: () => void
  /** The send was invalidated mid-flight: it settles unacknowledged without claiming a refusal. */
  abandoned: () => void
  /** Whether the caller waits on settlement, so each write asks the host for the provider's ack. */
  settlesWrites: boolean
}

export function createDeliveryObserver(
  options: NativeChatSendOptions | undefined
): NativeChatDeliveryObserver | undefined {
  if (!options?.onWriteRejected && !options?.onWriteUnconfirmed && !options?.onDeliverySettled) {
    return undefined
  }
  let acknowledged = true
  let reportedUnconfirmed = false
  let settled = false
  const settle = (delivered: boolean): void => {
    if (settled) {
      return
    }
    settled = true
    options.onDeliverySettled?.(delivered)
  }
  return {
    rejected: () => {
      options.onWriteRejected?.()
      settle(false)
    },
    unconfirmed: () => {
      acknowledged = false
      if (!reportedUnconfirmed) {
        reportedUnconfirmed = true
        options.onWriteUnconfirmed?.()
      }
    },
    settled: () => settle(acknowledged),
    abandoned: () => settle(false),
    settlesWrites: options.onDeliverySettled !== undefined
  }
}

/** One observed write: true when the send may continue past it. */
export async function sendObservedWrite(
  ptyId: string,
  data: string,
  isCancelled: (() => boolean) | undefined,
  delivery: NativeChatDeliveryObserver | undefined
): Promise<boolean> {
  // Why: the submit CR is never cancelled once its delay fires, so it carries no check.
  const cancelArgs = isCancelled ? ([isCancelled] as const) : ([] as const)
  if (!delivery) {
    return sendRuntimePtyInputAcceptance(ptyId, data, 'driving', ...cancelArgs)
  }
  const result = await sendRuntimePtyInputDelivery(
    ptyId,
    data,
    'driving',
    isCancelled,
    delivery.settlesWrites ? { requireWriteSettlement: true } : undefined
  )
  if (isCancelled?.()) {
    return false
  }
  if (result === 'unverifiable') {
    delivery.unconfirmed()
    return true
  }
  if (result === 'refused') {
    delivery.rejected()
    return false
  }
  return true
}

/** Wraps an optional `onOutcome` so it reports at most once per send. */
export function createOutcomeReporter(
  onOutcome: ((outcome: SendOutcome) => void) | undefined
): (outcome: SendOutcome) => void {
  let fired = false
  return (outcome) => {
    if (fired || !onOutcome) {
      return
    }
    fired = true
    onOutcome(outcome)
  }
}

/**
 * Runs `fn` and, on throw, releases the queue entry and reports
 * 'may-not-have-sent' — a throw inside a delayed pty write would otherwise
 * escape its timer, leaving the per-PTY queue blocked for every later send.
 */
export function runOutcomeGuarded(
  markSubmitted: () => void,
  reportOutcome: (outcome: SendOutcome) => void,
  fn: () => void
): void {
  try {
    fn()
  } catch {
    markSubmitted()
    reportOutcome('may-not-have-sent')
  }
}

/** Wraps `delay` so every callback scheduled through it runs under `runOutcomeGuarded`. */
export function guardedDelay(
  delay: (ms: number, fn: () => void) => void,
  markSubmitted: () => void,
  reportOutcome: (outcome: SendOutcome) => void
): (ms: number, fn: () => void) => void {
  return (ms, fn) => delay(ms, () => runOutcomeGuarded(markSubmitted, reportOutcome, fn))
}

/**
 * Poll `confirmSubmitted` for a bounded window after the submit CR. The first
 * `true` ends the observation immediately; if every read comes back `false`
 * the observation concludes negative. This never writes to the pty — a
 * negative read is not proof the send failed (the screen can lag or redraw),
 * so nothing here may retry the CR or the body.
 */
function observeSendOutcome(
  confirmSubmitted: (() => boolean) | undefined,
  reportOutcome: (outcome: SendOutcome) => void
): void {
  if (!confirmSubmitted) {
    reportOutcome('unobservable')
    return
  }
  let attempt = 0
  const poll = (): void => {
    attempt += 1
    let cleared = false
    try {
      cleared = confirmSubmitted()
    } catch {
      // An unreadable terminal reads as unconfirmed for this attempt only.
    }
    if (cleared) {
      reportOutcome('observed-cleared')
      return
    }
    if (attempt >= NATIVE_CHAT_SUBMIT_OBSERVATION_MAX_READS) {
      reportOutcome('may-not-have-sent')
      return
    }
    setTimeout(poll, NATIVE_CHAT_SUBMIT_OBSERVATION_POLL_MS)
  }
  poll()
}

/**
 * Write Enter as the delayed, separate pty write, mark the queue entry
 * submitted, then run the post-send observation. `markSubmitted` always runs,
 * even when the write rejects or throws, so a dead transport reports
 * 'may-not-have-sent' instead of stalling every later send queued behind it
 * on this pty. Routes through the acceptance-aware transport so a remote CR
 * rejection is never mistaken for a landed submit — a rejected CR reports
 * 'may-not-have-sent' directly and never starts the observation poll that
 * could otherwise upgrade it to 'observed-cleared'.
 */
export async function submitAndObserve(
  ptyId: string,
  markSubmitted: () => void,
  reportOutcome: (outcome: SendOutcome) => void,
  confirmSubmitted: (() => boolean) | undefined,
  delivery?: NativeChatDeliveryObserver
): Promise<void> {
  let sent = true
  try {
    sent = await sendObservedWrite(ptyId, NATIVE_CHAT_SUBMIT, undefined, delivery)
  } catch {
    sent = false
  } finally {
    markSubmitted()
  }
  if (!sent) {
    reportOutcome('may-not-have-sent')
    return
  }
  delivery?.settled()
  observeSendOutcome(confirmSubmitted, reportOutcome)
}
