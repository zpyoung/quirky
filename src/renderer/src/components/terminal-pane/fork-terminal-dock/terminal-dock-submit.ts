import type { AgentType } from '../../../../../shared/agent-status-types'
import { isSlashCommandDraft } from '../../../../../shared/native-chat-slash-commands'
import type { StructuredAgentSessionAttachment } from '../../../../../shared/structured-agent-session-send-mutation'
import type { NativeChatResolvedTarget } from '../../native-chat/native-chat-composer-target'
import { sendNativeChatMessageWithImageAttachments } from '../../native-chat/native-chat-runtime-image-send'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand
} from '../../native-chat/native-chat-runtime-send'
import { isTerminalInputQuarantined } from '../terminal-input-quarantine'

/**
 * Types a docked-composer message into the agent's terminal through the per-PTY send queue.
 * Returns false, so the draft stays, when the terminal has no PTY or its input is quarantined
 * after a re-attach: those bytes would land on a different shell than the one they were typed for.
 */
export function submitToTerminalAgent(args: {
  agent: AgentType
  target: NativeChatResolvedTarget | null
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
}): boolean {
  const { agent, target, text, attachments } = args
  if (!target || isTerminalInputQuarantined(target.terminalTabId)) {
    return false
  }
  if (attachments.length > 0) {
    sendNativeChatMessageWithImageAttachments(
      agent,
      target,
      text,
      attachments.map((attachment) => attachment.path)
    )
    return true
  }
  if (agent === 'codex' && isSlashCommandDraft(text)) {
    sendNativeChatTypedCommand(target, text)
    return true
  }
  sendNativeChatMessage(target, text)
  return true
}
