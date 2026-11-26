// Delivery of AskUserQuestion answers: paced keystroke-group writes, split out
// of native-chat-runtime-send.ts (which owns the clear/body/Enter message and
// image-attachment paths) to keep that file at a readable size.

import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { AskAnswerKeyGroup } from '../native-chat-interactive-prompt'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../../shared/native-chat-answer-stepping'
import { buildNativeChatPasteBytes } from '../native-chat-send'
import type { NativeChatSendHandle } from '../native-chat-runtime-send'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'

/**
 * Answer Claude's AskUserQuestion by writing its keystroke groups (built by
 * `buildAskAnswerKeys`) to the PTY, one group per `NATIVE_CHAT_QUESTION_STEP_MS`
 * step so the arrow-navigate selector applies each before the next.
 */
export function sendNativeChatAskAnswer(
  target: NativeChatResolvedTarget,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  const timers: ReturnType<typeof setTimeout>[] = []
  let cancelled = false
  const settleAfterMs =
    (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
  const bytesAt = (index: number): string => {
    const group = groups[index]
    return 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text)
  }
  if (!onSettled) {
    groups.forEach((_group, index) => {
      timers.push(
        setTimeout(() => {
          sendRuntimePtyInput(target.ptyId, bytesAt(index), 'driving')
        }, index * NATIVE_CHAT_QUESTION_STEP_MS)
      )
    })
  } else {
    // Why: each group waits for the provider's acknowledgment of the one before, so a slow body
    // cannot be overtaken by the selector's Enter, and an unacknowledged group stops the answer
    // instead of answering a question the user never saw.
    const writeAt = (index: number): void => {
      if (cancelled) {
        return
      }
      if (index >= groups.length) {
        timers.push(setTimeout(() => !cancelled && onSettled(true), NATIVE_CHAT_SUBMIT_DELAY_MS))
        return
      }
      void sendRuntimePtyInputVerified(target.ptyId, bytesAt(index), 'driving', {
        isCancelled: () => cancelled,
        requireWriteSettlement: true
      })
        .catch(() => false)
        .then((delivered) => {
          if (cancelled) {
            return
          }
          if (!delivered) {
            onSettled(false)
            return
          }
          if (index + 1 < groups.length) {
            timers.push(setTimeout(() => writeAt(index + 1), NATIVE_CHAT_QUESTION_STEP_MS))
          } else {
            writeAt(index + 1)
          }
        })
    }
    writeAt(0)
  }
  return {
    cancel: () => {
      cancelled = true
      timers.forEach((timer) => clearTimeout(timer))
    },
    // Hold the card until the last keystroke has fired and its submit gap passed.
    settleAfterMs
  }
}
