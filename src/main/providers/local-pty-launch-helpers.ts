import { basename, delimiter, win32 as pathWin32 } from 'node:path'
import { resolvePathEnvKey } from '../pty/windows-path-segment-merge'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { resolveSafePtyDefaultCwd } from './pty-default-cwd'
import { QUIRKY_OUTPUT_ENV } from '../../shared/agent-session-caller-env'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/quirkyd-managed-launch-env'

const PANE_IDENTITY_ENV_KEYS = [
  'QUIRKY_PANE_KEY',
  'QUIRKY_TAB_ID',
  'QUIRKY_WORKTREE_ID',
  'QUIRKY_AGENT_LAUNCH_TOKEN',
  'JCODE_RUNTIME_DIR',
  // A server's own launch marker; a user's `quirkyd` in this shell is not client-managed.
  QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV
] as const

export function getDefaultCwd(): string {
  return resolveSafePtyDefaultCwd()
}

export function removeUnspecifiedPaneIdentityEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of PANE_IDENTITY_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
  // the launch token is only minted for agent launches, so it is what tells them from plain shells
  if (explicitEnv && Object.hasOwn(explicitEnv, 'QUIRKY_AGENT_LAUNCH_TOKEN')) {
    env[QUIRKY_OUTPUT_ENV] = 'json'
  }
}

export function promoteAgentTeamsShimPath(
  env: Record<string, string>,
  requestedPath: string | undefined
): void {
  if (!env.QUIRKY_AGENT_TEAMS_TEAM_ID || !requestedPath) {
    return
  }
  const normalizedRequestedPath =
    process.platform === 'win32'
      ? expandWindowsEnvironmentVariables(requestedPath, env)
      : requestedPath
  const pathDelimiter = process.platform === 'win32' ? ';' : delimiter
  const shimDir = normalizedRequestedPath.split(pathDelimiter)[0]
  if (!shimDir) {
    return
  }
  const pathKey = resolvePathEnvKey(env, process.platform)
  const currentParts = env[pathKey]?.split(pathDelimiter).filter(Boolean) ?? []
  env[pathKey] = [shimDir, ...currentParts.filter((part) => part !== shimDir)].join(pathDelimiter)
}

export function normalizeLocalCallerSessionId(
  sessionId: string | undefined,
  allowNumeric = false
): string | null {
  const requested = sessionId?.trim()
  return !requested || (!allowNumeric && /^\d+$/.test(requested)) ? null : requested
}

export function normalizeForegroundProcessName(
  processName: string | null | undefined
): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  return !trimmed || trimmed === 'xterm-256color' ? null : trimmed.split(/[\\/]/).pop() || null
}

export function resolveForegroundFallbackProcess(
  processName: string | null | undefined,
  shellName: string | undefined
): string | null {
  if (process.platform !== 'win32' || normalizeForegroundProcessName(processName)) {
    return processName || null
  }
  return shellName ?? processName ?? null
}

/** Basename of the spawned shell path, parsed for the *target* platform.
 *  Why: POSIX `basename` won't split a Windows `\` path (non-Windows host/CI), so it'd break the foreground comparison. */
export function getSpawnedShellName(shellPath: string): string {
  return process.platform === 'win32' ? pathWin32.basename(shellPath) : basename(shellPath)
}
