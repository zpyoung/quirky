import type { AgentLaunchOptionSelection } from '../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { LaunchSource } from '../../../shared/agent-kind'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'

export type LaunchAgentBackgroundSessionArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  /** An automation's saved extras, merged over this host's default Arguments. */
  extraAgentArgs?: string
  launchOverrides?: AgentLaunchOptionSelection | null
  launchSource?: LaunchSource
  title?: string
  onData?: (chunk: string) => void
  onExit?: (ptyId: string, code: number) => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}

export type LaunchAgentBackgroundSessionResult = {
  tabId: string
  paneKey: string
  ptyId: string
  startupPlan: AgentStartupPlan
  startupShell: AgentStartupShell
  effectiveAgentArgs: string
  terminalOwnership: AutomationTerminalOwnership | null
  /** Ends a remote runtime's exit wait and data stream; a no-op for local/SSH PTYs. */
  releaseRuntimeObservers: () => void
}
