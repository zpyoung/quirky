import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import { seedPowerlevel10kWizardEnv } from '../../pty/powerlevel10k-wizard-env'
import {
  resolveSafePtyDefaultCwd,
  assertSafeAgentStartupCwd
} from '../../providers/pty-default-cwd'
import { resolveUnixShellPath } from '../../providers/local-pty-utils'
import { selectShellStartupFeatures } from '../../shell-startup-features'
import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from '../../../shared/agent-process-recognition'
import { getShellLaunchConfig, resolvePtyShellPath } from '../shell-ready'
import { finalizeDaemonPtyEnvironment, rescrubDaemonPtyEnvironment } from './spawn-environment'
import type { PtySubprocessOptions } from '../pty-subprocess'

export type PtyShellLaunchPlan = {
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
  startupAgentRecognition: RecognizedAgentProcess | null
}

export function createPtyShellLaunchPlan(
  opts: PtySubprocessOptions,
  env: Record<string, string>
): PtyShellLaunchPlan {
  let shellPath = opts.shellOverride || resolvePtyShellPath(env)
  const startupCommandDeliveredInShellArgs = false
  const startupAgentRecognition = recognizeAgentProcessFromCommandLine(opts.command)
  const requestedCwd = opts.cwd || resolveSafePtyDefaultCwd()
  if (opts.command && startupAgentRecognition) {
    assertSafeAgentStartupCwd(requestedCwd, opts.command)
  }
  const spawnCwd = requestedCwd
  const validationCwd = spawnCwd

  rescrubDaemonPtyEnvironment(env, opts)
  const preferredShellPath = shellPath
  shellPath = resolveUnixShellPath(shellPath)
  if (shellPath !== preferredShellPath) {
    env.SHELL = shellPath
    console.warn(
      `[daemon/pty] Preferred shell "${preferredShellPath}" is unavailable, fell back to "${shellPath}"`
    )
  }
  const waitsForShellReady =
    Boolean(opts.command) &&
    (startupAgentRecognition?.agent !== 'codex' ||
      shouldUseShellReadyStartupDelivery({
        command: opts.command,
        startupCommandDelivery: opts.startupCommandDelivery,
        shellPath
      }))
  delete env.ORCA_SHELL_FEATURES
  const userShellArgs = !opts.command && !opts.launchAgent ? opts.terminalShellArgs : undefined
  const shellLaunch = getShellLaunchConfig(
    shellPath,
    selectShellStartupFeatures({
      shellPath,
      env,
      hasStartupCommand: Boolean(opts.command),
      waitsForShellReady,
      emitsStartupIdentity: waitsForShellReady
    }),
    {
      hasStartupCommand: Boolean(opts.command),
      inheritedXdgDataDirs: env.XDG_DATA_DIRS,
      shellArgs: userShellArgs
    }
  )
  Object.assign(env, shellLaunch.env)
  const shellArgs = userShellArgs ?? shellLaunch.args ?? ['-l']

  seedPowerlevel10kWizardEnv(env, { envToDelete: opts.envToDelete })
  finalizeDaemonPtyEnvironment(env, opts.env)

  return {
    shellPath,
    shellArgs,
    spawnCwd,
    validationCwd,
    startupCommandDeliveredInShellArgs,
    startupAgentRecognition
  }
}
