import { createContext, useContext } from 'react'

export type ViewRuntime = {
  /** Sends the action to the agent; resolves false, after telling the person, when it could not be sent. */
  send(name: string, source: 'button' | 'field', data?: Record<string, unknown>): Promise<boolean>
  /** Asks the person to confirm before the link opens. */
  openLink(href: string): void
}

const INERT: ViewRuntime = { send: async () => false, openLink: () => {} }

export const RuntimeContext = createContext<ViewRuntime>(INERT)

export const useRuntime = (): ViewRuntime => useContext(RuntimeContext)
