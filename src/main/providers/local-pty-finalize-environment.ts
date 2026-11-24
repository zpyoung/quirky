import { shouldUseShellReadyStartupDelivery } from '../../shared/codex-startup-delivery'
import { dropInheritedOrcaFishHistory } from '../fish-history-session'
import { dropIncoherentCondaActivationEnv } from '../pty/conda-activation-env'
import { stripLegacyTerminalShimEnv } from '../pty/legacy-terminal-shim-dir'
import { seedPowerlevel10kWizardEnv } from '../pty/powerlevel10k-wizard-env'
import {
  POSIX_SHELL_STARTUP_COMMAND_ENV,
  supportsPosixShellStartupCommand
} from '../pty/posix-shell-startup-command'
import { resolvePathEnvKey } from '../pty/windows-path-segment-merge'
import { selectShellStartupFeatures } from '../shell-startup-features'
import {
  injectHistoryEnv,
  logHistoryInjection,
  type HistoryInjectionResult
} from '../terminal-history'
import { dropInheritedOrcaHistFile } from '../worktree-history-file-path'
import { promoteAgentTeamsShimPath } from './local-pty-launch-helpers'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import { getShellLaunchConfig } from './local-pty-shell-ready'
import type { PtySpawnOptions } from './pty-provider-contract'

export function finalizeLocalPtySpawnEnvironment(args: {
  spawn: PtySpawnOptions
  getOptions: () => LocalPtyProviderOptions
  plan: LocalPtyLaunchPlan
  env: Record<string, string>
}): HistoryInjectionResult | null {
  const { spawn, getOptions, plan, env } = args
  seedPowerlevel10kWizardEnv(env, { envToDelete: spawn.envToDelete })
  const requestedEnv = spawn.env
  promoteAgentTeamsShimPath(
    env,
    requestedEnv ? requestedEnv[resolvePathEnvKey(requestedEnv, process.platform)] : undefined
  )
  // Why: raw requested PATH promotion runs after the host-env scrub.
  stripLegacyTerminalShimEnv(env, process.platform)
  // Why after every deletion pass: an envToDelete of CONDA_PREFIX must not leave the sentinel behind.
  dropIncoherentCondaActivationEnv(env, process.platform)

  // Why: worktree-scoped HISTFILE — without it worktrees share one global history (terminal-history-scope-design §7–§10).
  const worktreeId = spawn.worktreeId
  const historyEnabled = worktreeId && (getOptions().isHistoryEnabled?.() ?? true)
  let historyResult: ReturnType<typeof injectHistoryEnv> | null = null
  if (historyEnabled) {
    historyResult = injectHistoryEnv(env, worktreeId, plan.shellPath, plan.cwd)
    logHistoryInjection(worktreeId, historyResult)
  } else {
    // Why: injectHistoryEnv is what normally clears it, so when history is off
    // an inherited ORCA_HISTFILE would still reach the wrapper. Credit: #11146.
    delete env.ORCA_HISTFILE
    // Same for an exported `fish_history` from the fish pane that launched this
    // Orca: history off means fish's own default, not another worktree's file.
    dropInheritedOrcaFishHistory(env)
    // And for an exported HISTFILE: history off means the shell's own default,
    // not the history file of the worktree this Orca was launched from.
    dropInheritedOrcaHistFile(env)
  }

  // Why after history injection: the wrapper is what repairs a worktree
  // HISTFILE that the system zshrc clobbers, so the decision to wrap has to
  // see whether this spawn actually injected one.
  const isCodexStartupCommand = plan.startupAgentRecognition?.agent === 'codex'
  const codexStartupCommand = isCodexStartupCommand ? spawn.command : undefined
  const codexRequiresShellReady =
    codexStartupCommand !== undefined &&
    shouldUseShellReadyStartupDelivery({
      command: codexStartupCommand,
      startupCommandDelivery: spawn.startupCommandDelivery
    })
  // Why delete: ORCA_SHELL_FEATURES is Orca-owned, and only the launch
  // config below may name features for this shell.
  delete env.ORCA_SHELL_FEATURES
  delete env[POSIX_SHELL_STARTUP_COMMAND_ENV]
  // Why captured now: the launch env below prefixes XDG_DATA_DIRS.
  const fishLaunch = {
    inheritedXdgDataDirs: env.XDG_DATA_DIRS,
    shellArgs: plan.shellArgs
  }
  plan.getFallbackShellReadyConfig = (shell) => {
    const wrapperStartupCommand =
      codexStartupCommand !== undefined && supportsPosixShellStartupCommand(shell)
        ? codexStartupCommand
        : undefined
    // Why no line-editor widening here (unlike the daemon and relay): a Codex
    // startup command this provider wraps is run by the wrapper's own prompt
    // hook, never written into the PTY, so there is no early write to double-echo.
    const waitsForShellReady =
      Boolean(spawn.command) && (!isCodexStartupCommand || codexRequiresShellReady)
    return getShellLaunchConfig(
      shell,
      selectShellStartupFeatures({
        shellPath: shell,
        env,
        hasStartupCommand: Boolean(spawn.command),
        waitsForShellReady,
        // Why identical: the identity marker exists so the readiness
        // handshake can bind output to the right shell PID.
        emitsStartupIdentity: waitsForShellReady
      }),
      wrapperStartupCommand,
      fishLaunch
    )
  }
  const shellLaunch = plan.getFallbackShellReadyConfig(plan.shellPath)
  plan.primaryPreLaunchEnv = Object.fromEntries(
    Object.keys(shellLaunch.env).map((key) => [key, env[key]])
  )
  Object.assign(env, shellLaunch.env)
  plan.shellArgs = shellLaunch.args ?? plan.shellArgs
  plan.shellReadyLaunch = spawn.command ? shellLaunch : null
  return historyResult
}
