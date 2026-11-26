import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type NativeChatViewProps = {
  tabId: string
  groupId?: string
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  /** This pane's split group holds focus; a revealed sibling column must not take the caret. */
  isFocusedGroup: boolean
}
