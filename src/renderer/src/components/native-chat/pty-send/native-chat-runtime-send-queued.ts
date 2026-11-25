// Queue-serialized writes for the session-option/slash-command path and the
// stepped ask-answer path (r5-3): both used to write directly to the pty
// outside the per-PTY queue, so a card's selector write could land mid-body
// or mid-Enter of an in-flight option command's write. Routing both through
// `enqueueNativeChatPtySend` gives them the same ordering guarantee chat
// sends already have.

import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../../shared/native-chat-answer-stepping'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from '../native-chat-send'
import { enqueueNativeChatPtySend } from '../native-chat-pty-send-queue'
import { sendNativeChatAskAnswer as sendNativeChatAskAnswerRaw } from './native-chat-ask-answer-send'
import type { AskAnswerKeyGroup } from '../native-chat-interactive-prompt'
import type { NativeChatSendHandle } from '../native-chat-runtime-send'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'

/**
 * Body + delayed Enter for the session-option/slash-command path, queued like
 * a chat send. Callers must cancel and drain prior sends first so a delayed
 * chat Enter cannot land on a confirmation dialog this write opens.
 */
export function sendNativeChatMessageVerifiedQueued(
  target: NativeChatResolvedTarget,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let accepted = false
    const handle = enqueueNativeChatPtySend(
      target.ptyId,
      NATIVE_CHAT_SUBMIT_DELAY_MS,
      ({ isCancelled, delay, markSubmitted }) => {
        if (isCancelled() || signal?.aborted) {
          markSubmitted()
          return
        }
        sendRuntimePtyInputVerified(target.ptyId, buildNativeChatPasteBytes(text), 'driving', {
          isCancelled: () => isCancelled() || signal?.aborted === true
        })
          .then((bodyAccepted) => {
            if (!bodyAccepted || isCancelled() || signal?.aborted) {
              markSubmitted()
              return
            }
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
              if (isCancelled() || signal?.aborted) {
                markSubmitted()
                return
              }
              sendRuntimePtyInputVerified(target.ptyId, NATIVE_CHAT_SUBMIT, 'driving', {
                isCancelled: () => isCancelled() || signal?.aborted === true
              })
                .then((sent) => {
                  accepted = sent
                  markSubmitted()
                })
                .catch(markSubmitted)
            })
          })
          .catch(markSubmitted)
      },
      { terminalTabId: target.terminalTabId }
    )
    // Why: resolve through the queue's own settlement, not our promise chain
    // above — a cancel mid-write must still resolve `false` exactly once.
    const onAbort = (): void => handle.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    void handle.settled.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(accepted)
    })
  })
}

/**
 * Claude/Codex stepped selector answer, queued like `sendNativeChatMessage`.
 * A cancel while still queued behind another send never reaches the paced
 * writes, so it reports `onSettled(false)` here instead of dropping the
 * answer silently (mirrors the chat-send queued-cancel outcome).
 */
export function sendNativeChatAskAnswerQueued(
  target: NativeChatResolvedTarget,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  const durationMs =
    (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
  let inner: NativeChatSendHandle | null = null
  let settleReported = false
  const reportSettled = (delivered: boolean): void => {
    if (settleReported) {
      return
    }
    settleReported = true
    onSettled?.(delivered)
  }
  const handle = enqueueNativeChatPtySend(
    target.ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        markSubmitted()
        return
      }
      const finish = (delivered: boolean): void => {
        markSubmitted()
        reportSettled(delivered)
      }
      inner = sendNativeChatAskAnswerRaw(target, groups, onSettled ? finish : undefined)
      if (!onSettled) {
        delay(durationMs, markSubmitted)
      }
    },
    {
      terminalTabId: target.terminalTabId,
      onCancelUnsubmitted: () => inner?.cancel(),
      onInvalidate: () => {
        inner?.cancel()
        reportSettled(false)
      }
    }
  )
  return {
    cancel: () => {
      const startedBeforeCancel = handle.bodyStarted()
      inner?.cancel()
      handle.cancel()
      if (!startedBeforeCancel) {
        reportSettled(false)
      }
    },
    settleAfterMs: handle.settleAfterMs,
    settled: handle.settled
  }
}
