import type { MobilePageBridge, MobileRoute } from '../contracts'

export type PanelRoute =
  | { kind: 'source-control'; worktreeId: string; tab?: 'changes' | 'pull-request' | 'commits' }
  | { kind: 'review'; worktreeId: string; path?: string }
  | { kind: 'files'; worktreeId: string; path?: string }
  | { kind: 'file-preview'; worktreeId: string; path: string }
  | { kind: 'terminal-artifacts'; worktreeId: string; sessionId: string }
  | { kind: 'terminal-artifact'; worktreeId: string; sessionId: string; artifactId: string; grant: string }
  | { kind: 'tasks' }
  | { kind: 'accounts' }
  | { kind: 'agent-history'; worktreeId: string }
  | { kind: 'notifications'; worktreeId?: string }

export type PhoneRoute = MobileRoute | { kind: 'home' }
export type PanelBridge = MobilePageBridge
export type PanelProps = { bridge: PanelBridge; route: PanelRoute }
