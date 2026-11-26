import { ChatSession } from '../chat/session/ChatSession'
import type { NativeChatViewProps } from './native-chat-view-types'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'

export type { NativeChatViewProps } from './native-chat-view-types'

/** A structured chat tab: the chat view inside the pane's file drop surface. */
export default function NativeChatView(props: NativeChatViewProps): React.JSX.Element {
  return (
    <NativeChatPaneFileDropSurface className="relative flex h-full min-h-0 min-w-0 w-full">
      <ChatSession
        key={props.sessionId}
        tabId={props.tabId}
        groupId={props.groupId}
        sessionId={props.sessionId}
        target={props.target}
        agent={props.agent}
        isVisible={props.isVisible}
        isFocusedGroup={props.isFocusedGroup}
      />
    </NativeChatPaneFileDropSurface>
  )
}
