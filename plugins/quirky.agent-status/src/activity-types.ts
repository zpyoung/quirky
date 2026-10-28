import type { AgentDisplayState, Child } from './types'

/** Retained Activity projection; its turn token fences delayed read receipts. */
export type ActivityThread = {
  sessionId: string
  worktreeId: string
  worktreeName: string
  sessionName: string
  agent: string
  turn: string
  turnStartedAt: number
  updatedAt: number
  display: AgentDisplayState
  label: string
  prompt: string
  detail: string
  children: Child[]
  unread: boolean
  live: boolean
}

export type ActivityQuery = { worktree?: string; text?: string; unreadOnly?: boolean }
export type ActivityAcknowledgment = { session?: string; turn?: string; all?: boolean }
