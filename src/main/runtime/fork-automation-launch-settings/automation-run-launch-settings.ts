import type { Automation } from '../../../shared/automations-types'
import {
  buildAutomationRunLaunchSettings,
  type AutomationRunLaunchSettings
} from '../../../shared/fork-automation-launch-settings/automation-run-launch-settings'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from '../../../shared/agent-startup-plan-inputs'
import { hasExtraAgentArgs } from '../../../shared/automation-extra-agent-args'
import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

/** Snapshot effective automation launch settings for a resolved execution host. */
export function resolveAutomationRunLaunchSettings(args: {
  automation: Automation
  settings: AgentStartupSettings
  platform: NodeJS.Platform
  isRemote: boolean
  /** The shell the launch's PTY will be, when the host resolved one. */
  shell?: AgentStartupShell
}): AutomationRunLaunchSettings | null {
  const shell =
    args.shell ??
    resolveStartupShell(
      args.platform,
      resolveLocalWindowsAgentStartupShell({
        platform: args.platform,
        isRemote: args.isRemote,
        terminalWindowsShell: args.settings.terminalWindowsShell
      })
    )
  const inheritedAgentArgs = resolveTuiAgentLaunchArgs(
    args.automation.agentId,
    args.settings.agentDefaultArgs
  )
  let effectiveAgentArgs = inheritedAgentArgs
  if (hasExtraAgentArgs(args.automation.extraAgentArgs)) {
    try {
      effectiveAgentArgs =
        resolveAgentStartupPlanInputs({
          agent: args.automation.agentId,
          settings: args.settings,
          platform: args.platform,
          isRemote: args.isRemote,
          shell,
          extraAgentArgs: args.automation.extraAgentArgs
        }).agentArgs ?? inheritedAgentArgs
    } catch {
      // the launch itself reports invalid extras; the snapshot keeps the inherited arguments
    }
  }
  return buildAutomationRunLaunchSettings({
    agentId: args.automation.agentId,
    overrides: args.automation.launchOverrides,
    effectiveAgentArgs,
    agentArgsSource: hasExtraAgentArgs(args.automation.extraAgentArgs) ? 'explicit' : 'inherited',
    shell
  })
}
