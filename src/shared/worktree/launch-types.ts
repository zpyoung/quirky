import type { StartupCommandDelivery } from '../codex-startup-delivery'
import type { AgentKind, LaunchSource, RequestKind } from '../agent-kind'
import type { SleepingAgentLaunchConfig } from '../agent-session-resume'
import type { SetupRunnerShell } from '../setup-runner-command'
import type { QuirkyDefaultTabTemplate } from '../quirky-yaml-hook-types'
import type { TuiAgent } from '../tui-agent'

export type WorktreeSetupLaunch = {
  runnerScriptPath: string
  envVars: Record<string, string>
  shell?: SetupRunnerShell
  command?: string
  waitForAgentStartup?: boolean
}

export type WorktreeStartupLaunch = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  startupCommandDelivery?: StartupCommandDelivery
  telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
}

export type WorktreeDefaultTabsLaunch = {
  tabs: QuirkyDefaultTabTemplate[]
  runCommands: boolean
}
