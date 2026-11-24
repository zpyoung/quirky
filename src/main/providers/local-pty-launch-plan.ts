import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { resolveUnixPaneShellPath } from '../daemon/shell-ready'
import { getDefaultCwd } from './local-pty-launch-helpers'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { getShellLaunchConfig } from './local-pty-shell-ready'
import { ensureNodePtySpawnHelperExecutable } from './local-pty-utils'
import { assertSafeAgentStartupCwd } from './pty-default-cwd'
import type { PtySpawnOptions } from './pty-provider-contract'

export type LocalPtyLaunchPlan = {
  startupAgentRecognition: ReturnType<typeof recognizeAgentProcessFromCommandLine>
  defaultCwd: string
  cwd: string
  shellPath: string
  shellArgs: string[]
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
  shellReadyLaunch: ReturnType<typeof getShellLaunchConfig> | null
  getFallbackShellReadyConfig:
    | ((shell: string) => ReturnType<typeof getShellLaunchConfig>)
    | undefined
  // Why hoisted: a fallback shell must undo the primary's launch env, and
  // re-deriving the key names would re-run wrapper generation.
  primaryPreLaunchEnv: Record<string, string | undefined>
}

export function createLocalPtyLaunchPlan(
  args: PtySpawnOptions,
  getOptions: () => LocalPtyProviderOptions
): LocalPtyLaunchPlan {
  const startupAgentRecognition = args.command
    ? recognizeAgentProcessFromCommandLine(args.command)
    : null

  const defaultCwd = getDefaultCwd()
  const cwd = args.cwd || defaultCwd
  // Why: gate on the effective cwd, not raw args.cwd — an omitted cwd becomes a safe default and must not be rejected as root-like.
  if (args.command && startupAgentRecognition) {
    assertSafeAgentStartupCwd(cwd, args.command)
  }
  const shellPath = resolveUnixPaneShellPath(
    args.env ?? {},
    args.shellOverride,
    getOptions().getDefaultShell?.()
  )
  ensureNodePtySpawnHelperExecutable()
  return {
    startupAgentRecognition,
    defaultCwd,
    cwd,
    shellPath,
    // Why: shellOverride here is already resolved from the setting, so it cannot
    // distinguish a one-off shell pick; the spawn path only sends args for the profile.
    shellArgs:
      !args.command && !args.launchAgent && args.terminalShellArgs !== undefined
        ? args.terminalShellArgs
        : ['-l'],
    effectiveCwd: cwd,
    validationCwd: cwd,
    startupCommandDeliveredInShellArgs: false,
    shellReadyLaunch: null,
    getFallbackShellReadyConfig: undefined,
    primaryPreLaunchEnv: {}
  }
}
