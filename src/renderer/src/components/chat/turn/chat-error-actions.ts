import { createContext, createElement, useContext, type ReactNode } from 'react'

/** The recovery actions an error row offers; an action without a handler is not drawn. */
export type ChatErrorActions = {
  onRestart?: () => void
  onOpenInTerminal?: () => void
}

export const ChatErrorActionsContext = createContext<ChatErrorActions | null>(null)

export function ChatErrorActionsProvider({
  actions,
  children
}: {
  actions: ChatErrorActions
  children: ReactNode
}): React.JSX.Element {
  return createElement(ChatErrorActionsContext.Provider, { value: actions }, children)
}

export function useChatErrorActions(): ChatErrorActions | null {
  return useContext(ChatErrorActionsContext)
}
