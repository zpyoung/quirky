// Typed slash-command sends: keys are written one at a time so a TUI that only
// autocompletes typed input (Codex) opens its command palette, instead of
// receiving one pasted line it treats as literal text.

import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../../shared/agent-tui-command-typing'
import { subscribeTerminalInputQuarantine } from '../../terminal-pane/terminal-input-quarantine'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  waitForNativeChatPtyIdle
} from '../native-chat-pty-send-queue'
import { clearUnsubmittedAgentInput } from './native-chat-runtime-clear'
import type { NativeChatSendHandle } from '../native-chat-runtime-send'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'

/** Types a slash command as individual keys so Codex opens its command palette. */
export async function typeNativeChatCommand(
  target: NativeChatResolvedTarget,
  command: string,
  signal?: AbortSignal
): Promise<boolean> {
  let invalidated = false
  const unsubscribe = subscribeTerminalInputQuarantine(target.terminalTabId, (armed) => {
    if (armed) {
      invalidated = true
    }
  })
  try {
    if (invalidated || signal?.aborted) {
      return false
    }
    cancelNativeChatPtySends(target.ptyId)
    await waitForNativeChatPtyIdle(target.ptyId)
    if (invalidated || signal?.aborted) {
      return false
    }
    const outcome = await typeAgentTuiCommand({
      command,
      signal,
      write: async (key) => {
        if (invalidated) {
          return 'rejected'
        }
        return (await sendRuntimePtyInputVerified(target.ptyId, key, 'driving', {
          isCancelled: () => invalidated || signal?.aborted === true
        }))
          ? 'accepted'
          : 'rejected'
      }
    })
    return outcome === 'accepted'
  } finally {
    unsubscribe()
  }
}

/** Queues a typed slash command with composer sends on the same PTY. */
export function sendNativeChatTypedCommand(
  target: NativeChatResolvedTarget,
  command: string
): NativeChatSendHandle {
  const controller = new AbortController()
  return enqueueNativeChatPtySend(
    target.ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
    ({ isCancelled, delay, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        if (!isCancelled() && outcome !== 'accepted') {
          void clearUnsubmittedAgentInput(target.ptyId, undefined, delay).then(
            markSubmitted,
            markSubmitted
          )
          return
        }
        markSubmitted()
      }
      void typeAgentTuiCommand({
        command,
        signal: controller.signal,
        write: async (key) => {
          if (isCancelled()) {
            return 'rejected'
          }
          return (await sendRuntimePtyInputVerified(target.ptyId, key, 'driving', {
            isCancelled: () => isCancelled() || controller.signal.aborted
          }))
            ? 'accepted'
            : 'rejected'
        }
      }).then(finish, () => finish('rejected'))
    },
    {
      terminalTabId: target.terminalTabId,
      onCancelUnsubmitted: (cleanupDelay) => {
        controller.abort()
        return clearUnsubmittedAgentInput(target.ptyId, undefined, cleanupDelay)
      },
      onInvalidate: () => controller.abort()
    }
  )
}
