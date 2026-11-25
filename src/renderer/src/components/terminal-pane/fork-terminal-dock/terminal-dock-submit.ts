import type { AgentType } from '../../../../../shared/agent-status-types'
import { isSlashCommandDraft } from '../../../../../shared/native-chat-slash-commands'
import type { StructuredAgentSessionAttachment } from '../../../../../shared/structured-agent-session-send-mutation'
import type { NativeChatResolvedTarget } from '../../native-chat/native-chat-composer-target'
import { sendNativeChatMessageWithImageAttachments } from '../../native-chat/native-chat-runtime-image-send'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  type NativeChatSendOptions
} from '../../native-chat/native-chat-runtime-send'
import { isTerminalInputQuarantined } from '../terminal-input-quarantine'

function deliveryOutcome(start: (options: NativeChatSendOptions) => unknown): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    start({
      onDeliverySettled: resolve,
      onOutcome: (outcome) => {
        if (outcome === 'may-not-have-sent') {
          resolve(false)
        }
      }
    })
  })
}

/**
 * Types a docked-composer message into the agent's terminal through the per-PTY send queue.
 * Returns false, so the draft stays, when the terminal has no PTY or its input is quarantined
 * after a re-attach: those bytes would land on a different shell than the one they were typed for.
 * Otherwise resolves once delivery settles: true when the PTY accepted every write, false when it
 * refused one or the send was cancelled or invalidated first.
 */
export function submitToTerminalAgent(args: {
  agent: AgentType
  target: NativeChatResolvedTarget | null
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
}): boolean | Promise<boolean> {
  const { agent, target, text, attachments } = args
  if (!target || isTerminalInputQuarantined(target.terminalTabId)) {
    return false
  }
  if (attachments.length > 0) {
    const paths = attachments.map((attachment) => attachment.path)
    return deliveryOutcome((options) =>
      sendNativeChatMessageWithImageAttachments(agent, target, text, paths, options)
    )
  }
  if (agent === 'codex' && isSlashCommandDraft(text)) {
    return deliveryOutcome((options) => sendNativeChatTypedCommand(target, text, options))
  }
  return deliveryOutcome((options) => sendNativeChatMessage(target, text, options))
}
