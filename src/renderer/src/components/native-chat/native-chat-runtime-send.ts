// Runtime send for native chat: clear any unsubmitted TUI line, write the framed
// body, then Enter as a SEPARATE delayed pty write. Kept apart from the pure
// byte builders in native-chat-send.ts so those stay IO-free and unit-testable.

import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from '../terminal-pane/terminal-input-quarantine'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { runBodyAcceptedThen } from './pty-send/native-chat-runtime-send-acceptance'
import { enqueueNativeChatBodySend } from './pty-send/native-chat-body-send'
import type { SendOutcome } from './pty-send/native-chat-send-outcome'
import {
  sendNativeChatAskAnswerQueued,
  sendNativeChatMessageVerifiedQueued
} from './pty-send/native-chat-runtime-send-queued'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import {
  cancelNativeChatPtySends,
  invalidateNativeChatPtySends,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'
import { clearConfirmDurationMs } from './pty-send/native-chat-runtime-clear'
import type { NativeChatSendOptions as NativeChatDeliveryOptions } from './native-chat-input-clear'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { invalidateNativeChatPtySends, resetNativeChatPtySendQueuesForTests }
export {
  sendNativeChatTypedCommand,
  typeNativeChatCommand
} from './pty-send/native-chat-typed-command-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

/** Upstream's options, including its per-write delivery callbacks, plus the fork's outcome. */
export type NativeChatSendOptions = NativeChatDeliveryOptions & {
  /**
   * Observed check, after the submit CR, of whether the TUI's input line
   * emptied. Absent means the send is unobservable, not failed.
   */
  confirmSubmitted?: () => boolean
  /** Reports the post-send outcome exactly once per send; see `SendOutcome`. */
  onOutcome?: (outcome: SendOutcome) => void
}

/** Cancels an in-flight send's pending pty writes (the delayed Enter, and any
 *  later question bodies/Enters). Safe to call after the send completes. */
export type NativeChatSendHandle = {
  /** `keepInput` skips the unsubmitted-input clear, e.g. while a dialog owns the agent's input. */
  cancel: (keepInput?: boolean) => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
}

const NOOP_NATIVE_CHAT_SEND_HANDLE: NativeChatSendHandle = {
  cancel: () => {},
  settleAfterMs: 0
}

function rejectQuarantinedNativeChatSend(options?: NativeChatSendOptions): NativeChatSendHandle {
  options?.onWriteRejected?.()
  options?.onDeliverySettled?.(false)
  options?.onOutcome?.('may-not-have-sent')
  return NOOP_NATIVE_CHAT_SEND_HANDLE
}

/**
 * Chat message path:
 *   1. clear any unsubmitted TUI line
 *   2. write framed body
 *   3. delayed Enter (separate write — same-write CR can be swallowed by paste)
 *
 * Serialized per PTY so rapid sends cannot glue before Enter.
 */
export function sendNativeChatMessage(
  target: NativeChatResolvedTarget,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (isTerminalInputQuarantined(target.terminalTabId)) {
    return rejectQuarantinedNativeChatSend(options)
  }
  return enqueueNativeChatBodySend({
    target,
    options,
    durationMs: NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options),
    chunks: [buildNativeChatPasteBytes(text)]
  })
}

/**
 * Session-option / slash command path (model switch, /effort, …).
 *
 * Does not pre-clear the line (model-switch confirmation watches the PTY).
 * Cancels any in-flight chat clear/body/Enter on this PTY first so a delayed
 * chat Enter cannot dismiss Claude's "Switch model?" dialog, then queues its
 * own body+Enter on the same per-PTY sequence (r5-3) so a card's selector
 * write cannot land mid-body or mid-Enter of this command.
 */
export async function sendNativeChatMessageVerified(
  target: NativeChatResolvedTarget,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  let invalidated = false
  const unsubscribe = subscribeTerminalInputQuarantine(target.terminalTabId, (armed) => {
    if (armed) {
      invalidated = true
    }
  })
  try {
    if (signal?.aborted || invalidated) {
      return false
    }
    // Why: chat sends hold a delayed Enter for 500ms. Opening the model picker in
    // that window used to let that Enter hit Claude's confirmation UI, so
    // verification timed out with "Could not verify the model change".
    cancelNativeChatPtySends(target.ptyId)
    await waitForNativeChatPtyIdle(target.ptyId)
    if (signal?.aborted || invalidated) {
      return false
    }
    return await sendNativeChatMessageVerifiedQueued(target, text, signal)
  } finally {
    unsubscribe()
  }
}

export function sendNativeChatMessageWithImageAttachments(
  target: NativeChatResolvedTarget,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  return sendNativeChatImagePastes(
    target,
    text,
    imagePaths.map(buildNativeChatImagePasteBytes),
    options
  )
}

/** Image pastes already framed for the target agent, then the text body and Enter. */
export function sendNativeChatImagePastes(
  target: NativeChatResolvedTarget,
  text: string,
  imagePastes: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (isTerminalInputQuarantined(target.terminalTabId)) {
    return rejectQuarantinedNativeChatSend(options)
  }
  if (imagePastes.length === 0) {
    return sendNativeChatMessage(target, text, options)
  }
  const trimmedText = text.trim()
  return enqueueNativeChatBodySend({
    target,
    options,
    durationMs:
      (trimmedText.length > 0
        ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
        : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options),
    chunks: imagePastes,
    afterAccepted: ({
      isCancelled,
      markSubmitted,
      reportOutcome,
      delayGuarded,
      delivery,
      submit
    }) => {
      if (trimmedText.length === 0) {
        submit()
        return
      }
      delayGuarded(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
        runBodyAcceptedThen(
          target.ptyId,
          [buildNativeChatPasteBytes(text)],
          isCancelled,
          markSubmitted,
          reportOutcome,
          submit,
          delivery
        )
      })
    }
  })
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(target: NativeChatResolvedTarget): void {
  if (!isTerminalInputQuarantined(target.terminalTabId)) {
    sendRuntimePtyInput(target.ptyId, NATIVE_CHAT_SUBMIT, 'driving')
  }
}

export { sendNativeChatAskAnswerQueued as sendNativeChatAskAnswer }
