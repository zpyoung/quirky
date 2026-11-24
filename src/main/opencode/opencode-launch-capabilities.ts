import {
  getOpenCodeCliCapabilities,
  type OpenCodeCliCapabilities
} from '../../shared/opencode-cli-version'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { probeOpenCodeCliVersion } from './opencode-cli-version'
import {
  getAgentLaunchCommandToken,
  getAgentLaunchExecutableName
} from '../../shared/agent-command-line-intent'

export function getOpenCodeLaunchExecutable(
  command: string | undefined,
  agent?: TuiAgent
): string | null {
  const executable = getAgentLaunchCommandToken(command)
  const name = getAgentLaunchExecutableName(command)
  return agent === 'opencode' ||
    agent === 'opencode2' ||
    (!agent && (name === 'opencode' || name === 'opencode2'))
    ? executable || null
    : null
}

export async function probeOpenCodeLaunchCapabilities(options: {
  command: string | undefined
  agent?: TuiAgent
  env: NodeJS.ProcessEnv
  cwd?: string
  hostIdentity?: string
  resolveExecutable?: (executable: string) => Promise<string | null>
}): Promise<OpenCodeCliCapabilities | null> {
  const executable = getOpenCodeLaunchExecutable(options.command, options.agent)
  if (!executable) {
    return null
  }
  const executablePath = options.resolveExecutable
    ? await options.resolveExecutable(executable)
    : await resolveCommandOnLocalPath(executable, {
        env: options.env,
        cwd: options.cwd
      })
  return executablePath
    ? probeOpenCodeCliVersion({
        executablePath,
        env: options.env,
        cwd: options.cwd,
        hostIdentity: options.hostIdentity
      })
    : getOpenCodeCliCapabilities(null)
}
