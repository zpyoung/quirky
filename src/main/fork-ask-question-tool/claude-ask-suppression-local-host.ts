import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import { resolveStartupShell } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { execLocalPreflightCommandOrThrow } from '../ipc/preflight-command-exec'
import type { AskGateHostKey } from './claude-ask-suppression-gate'

/** The settings fields that decide which binary a managed local Claude launch actually runs. */
export type LocalClaudeHostSettings = {
  agentCmdOverrides?: Partial<Record<string, string>> | null
  terminalWindowsShell?: string | null
  terminalWindowsWslDistro?: string | null
}

/** Changing any of these changes the answer, so the cached verdict must be discarded with them. */
export const LOCAL_CLAUDE_HOST_SETTINGS_KEYS = [
  'agentCmdOverrides',
  'terminalWindowsShell',
  'terminalWindowsWslDistro'
] as const

/**
 * Describes the host a managed local Claude launch will run on, with a probe that reaches the same
 * binary that launch will. On Windows the terminal shell decides that: a `wsl.exe` shell puts the
 * agent inside the distro, so probing the Windows PATH would measure a different Claude — or none.
 */
export function buildLocalClaudeAskGateHost(
  settings: LocalClaudeHostSettings,
  platform: NodeJS.Platform = process.platform
): AskGateHostKey {
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
  )
  const distro =
    platform === 'win32' && isWslShellName(settings.terminalWindowsShell ?? undefined)
      ? (settings.terminalWindowsWslDistro?.trim() ?? '')
      : undefined
  const commandOverride = settings.agentCmdOverrides?.claude?.trim()
  return {
    kind: 'local',
    ...(distro === undefined ? {} : { wslDistro: distro }),
    shell,
    ...(commandOverride ? { commandOverride } : {}),
    probe: async (argv) => {
      const [command, ...rest] = argv
      const { stdout } = await execLocalPreflightCommandOrThrow(command, [...rest])
      return stdout
    }
  }
}
