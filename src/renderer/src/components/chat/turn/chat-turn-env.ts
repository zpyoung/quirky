import { createContext, useContext } from 'react'
import type { AgentSessionPromptResponse } from '../../../../../shared/agent-session-question-answer'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/structured-agent-session-subagent-roster'
import type { StructuredPromptItem } from '../../native-chat/use-structured-agent-session'
import type { NativeChatRewindSurface } from '../../native-chat/use-native-chat-rewind'
import type { ChatMarkdownAssets } from '../markdown'

/** What the blocks of a turn need from the chat around them, supplied once by `ChatView`. */
export type ChatTurnEnv = {
  sessionId: string
  target: RuntimeClientTarget
  roster: StructuredAgentSubagentRoster
  rewind: NativeChatRewindSurface | undefined
  /** Ids of the asks the person can answer now; any other ask draws as history. */
  answerableAskIds: ReadonlySet<string>
  respond: (item: StructuredPromptItem, response: AgentSessionPromptResponse) => Promise<unknown>
  cancelAsk: (item: StructuredPromptItem) => void
  markdown: { assets: ChatMarkdownAssets | undefined; onOpenLink: (href: string) => void }
  onOpenPlan: ((version: number) => void) | undefined
  onOpenVisual: ((viewId: string) => void) | undefined
  /** Sends the composed comments; false when the chat refused them, which keeps them. */
  onSendComments: ((text: string) => boolean) | undefined
  /** The host serves `agentSession.turnDiff` and `agentSession.fork`. */
  hostServesV1ChatMethods: boolean
}

export const ChatTurnEnvContext = createContext<ChatTurnEnv | null>(null)

export function useChatTurnEnv(): ChatTurnEnv {
  const env = useContext(ChatTurnEnvContext)
  if (!env) {
    throw new Error('Chat blocks render inside ChatView')
  }
  return env
}
