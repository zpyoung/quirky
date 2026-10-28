import type { MobilePageBridge, MobilePageInit, MobileRoute } from '../contracts'

export type PanelRoute =
  | { kind: 'source-control'; worktreeId: string; tab?: 'changes' | 'pull-request' | 'commits' }
  | { kind: 'review'; worktreeId: string; path?: string }
  | { kind: 'files'; worktreeId: string; path?: string }
  | { kind: 'file-preview'; worktreeId: string; path: string }
  | { kind: 'tasks' }
  | { kind: 'accounts' }
  | { kind: 'agent-history'; worktreeId: string }
  | { kind: 'notifications'; worktreeId?: string }

export type PhoneRoute = MobileRoute | PanelRoute | { kind: 'home' }
export type PanelBridge = Omit<MobilePageBridge, 'init' | 'navigate'> & {
  readonly init: Omit<MobilePageInit, 'route'> & { route: MobileRoute | PanelRoute }
  navigate(route: PhoneRoute): Promise<void>
}
export type PanelProps = { bridge: PanelBridge; route: PanelRoute }
