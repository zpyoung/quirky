/**
 * Agent/tool preflight detection. Split out of `ipc/preflight.ts` so the Quirky
 * runtime — which calls `detectInstalledAgentsWithShellPathHydration`
 * during normal operation — can reach this logic without
 * dragging `ipcMain` into its module graph. The Electron handler registration
 * stays in `ipc/preflight.ts` and imports from here.
 */
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../shared/shell-path-hydration-types'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { _resetKnownHostsCache } from '../gitlab/gl-utils'
import type { PreflightRuntimeContext } from '../ipc/preflight-runtime-target'

export type { PreflightRuntimeContext }
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import {
  execLocalPreflightCommandOrThrow,
  findRunnableLocalCommand
} from '../ipc/preflight-command-exec'
import {
  detectRemoteWindowsTerminalCapabilities,
  type RemoteWindowsTerminalCapabilities
} from '../ipc/preflight-remote-windows-terminal-capabilities'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import { detectAgentCommandsOnHost } from './agent-command-detection'
export { detectAgentCommandsOnHost } from './agent-command-detection'

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
  // Why: optional so existing renderer call sites that only render git/gh
  // status keep typechecking. Consumers that surface GitLab-specific
  // affordances (the GitLab tab in the source picker, MR list, etc.)
  // gate on `glab?.authenticated`.
  glab?: { installed: boolean; authenticated: boolean }
}

export { detectRemoteWindowsTerminalCapabilities }
export type { RemoteWindowsTerminalCapabilities }

// Why: cache the result so repeated Landing mounts don't re-spawn processes.
// The check only runs once per app session — relaunch to re-check.
let cached: PreflightStatus | null = null
// Collapses concurrent callers (several panes mounting at once) onto one probe
// set instead of one full set each before the first result lands.
let preflightInFlight: Promise<PreflightStatus> | null = null

// Why a generation: two runs can overlap (a forced refresh started while a
// slower probe is still out). Without this the slower one settles last and
// writes its older result over the newer one, so the next caller reads staler
// status than the refresh it asked for. The epoch does the same for
// `_resetPreflightCache`, which integrations call on credential changes: a
// probe already in flight must not repopulate the cache it cleared.
let latestPreflightRun = 0
let preflightRunCounter = 0
let preflightCacheEpoch = 0

/** @internal - tests need a clean preflight cache between cases. */
export function _resetPreflightCache(): void {
  cached = null
  preflightInFlight = null
  latestPreflightRun = 0
  // Why bump rather than just clear: a probe already in flight would otherwise
  // settle after this and repopulate the cache an integration just invalidated.
  preflightCacheEpoch += 1
}

/** A CLI verdict and, on the local path, the exact copy that produced it. */
type CommandRuntime = { installed: boolean; binary?: string }

async function detectCommandRuntime(command: string): Promise<CommandRuntime> {
  // Pin auth to the copy that passed --version, so PATH cannot select the dead shim again.
  const probe = await findRunnableLocalCommand(command)
  return probe.status === 'available'
    ? { installed: true, binary: probe.binary }
    : { installed: false }
}

export async function detectInstalledAgents(context?: PreflightRuntimeContext): Promise<string[]> {
  const commands = getTuiAgentDetectionProbeCommands(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    process.platform
  )
  return resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    await detectAgentCommandsOnHost(commands, { context }),
    process.platform
  )
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context)
}

export type RefreshAgentsResult = {
  /** Agents detected after hydrating PATH from the user's login shell. */
  agents: string[]
  /** PATH segments that were added this refresh (empty if nothing new). */
  addedPathSegments: string[]
  /** True when the shell spawn succeeded. False = relied on existing PATH. */
  shellHydrationOk: boolean
  /** Whether `detectInstalledAgents` ran against shell-hydrated PATH or only
   *  the seed list from `patchPackagedProcessPath`. Drives the on_path:false
   *  triage in tile A on dashboard 1562016. */
  pathSource: PathSource
  /** Why hydration failed (or `'none'` on success). Typed against the shared
   *  alias so the IPC boundary stays in lockstep with the renderer-visible
   *  enum on `onboardingAgentPickedSchema`. */
  pathFailureReason: ShellHydrationFailureReason
}

/**
 * Re-spawn the user's login shell to refresh process.env.PATH, then re-run
 * agent detection. Called by the Agents settings pane when the user clicks
 * Refresh — handles the "installed a new CLI, Quirky doesn't see it yet" case
 * without requiring an app restart.
 */
export async function refreshShellPathAndDetectAgents(
  context?: PreflightRuntimeContext
): Promise<RefreshAgentsResult> {
  const hydration = await hydrateShellPath({ force: true })
  const added = hydration.ok ? mergePathSegments(hydration.segments) : []
  const agents = await detectInstalledAgents(context)
  return {
    agents,
    addedPathSegments: added,
    shellHydrationOk: hydration.ok,
    pathSource: hydration.ok ? 'shell_hydrate' : 'sync_seed_only',
    pathFailureReason: hydration.failureReason
  }
}

// Why the probe object rather than the bare command name: on the local path
// `binary` is the copy that just passed `--version`, which on a shim-shadowed
// host is not what PATH would resolve (#22975).
async function isGhAuthenticated(probe: CommandRuntime): Promise<boolean> {
  try {
    await execLocalPreflightCommandOrThrow(probe.binary ?? 'gh', ['auth', 'status'])
    // Why: for plain-text `gh auth status`, exit 0 means gh did not detect any
    // authentication issues for the checked hosts/accounts.
    return true
  } catch (error) {
    // Why: some environments may surface partial command output on the thrown
    // error object. Keep a compatibility fallback so we avoid a false auth
    // warning if success markers are present despite a non-zero result.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

// Why: parallel to isGhAuthenticated for the glab CLI. glab writes auth
// status to stderr in some versions and stdout in others; check both.
async function isGlabAuthenticated(probe: CommandRuntime): Promise<boolean> {
  try {
    await execLocalPreflightCommandOrThrow(probe.binary ?? 'glab', ['auth', 'status'])
    return true
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in')
  }
}

export async function runPreflightCheck(
  force = false,
  context?: PreflightRuntimeContext
): Promise<PreflightStatus> {
  if (!force) {
    if (cached) {
      return cached
    }
    if (preflightInFlight) {
      return preflightInFlight
    }
  }

  const runId = ++preflightRunCounter
  const epochAtStart = preflightCacheEpoch
  latestPreflightRun = runId

  const run = executePreflightCheck(force, context)
  preflightInFlight = run
  try {
    const result = await run
    // Superseded by a newer run, or the cache was reset while this was out:
    // return what we probed, but do not let it become the cached answer.
    if (latestPreflightRun === runId && epochAtStart === preflightCacheEpoch) {
      cached = result
    }
    return result
  } finally {
    // Why the identity check: a concurrent force run replaces this entry, and
    // that newer run must stay joinable after this one settles.
    if (preflightInFlight === run) {
      preflightInFlight = null
    }
  }
}

async function executePreflightCheck(
  force: boolean,
  context: PreflightRuntimeContext | undefined
): Promise<PreflightStatus> {
  await hydrateShellPathForAgentDetection(context, force)

  if (force) {
    // Why: the GitLab known-hosts cache (gl-utils) is populated lazily on the
    // first GitLab request and never invalidated within a session. A user who
    // runs `glab auth login` for a self-hosted host after Quirky starts would
    // otherwise see "No GitLab project found" until app relaunch. The Re-check
    // path in IntegrationsPane forces preflight, so piggyback on that signal
    // to refresh the host list too.
    _resetKnownHostsCache()
  }

  const [gitProbe, ghProbe, glabProbe] = await Promise.all([
    detectCommandRuntime('git'),
    detectCommandRuntime('gh'),
    detectCommandRuntime('glab')
  ])

  const [ghAuthenticated, glabAuthenticated] = await Promise.all([
    ghProbe.installed ? isGhAuthenticated(ghProbe) : Promise.resolve(false),
    glabProbe.installed ? isGlabAuthenticated(glabProbe) : Promise.resolve(false)
  ])

  return {
    git: { installed: gitProbe.installed },
    gh: { installed: ghProbe.installed, authenticated: ghAuthenticated },
    glab: { installed: glabProbe.installed, authenticated: glabAuthenticated }
  }
}
