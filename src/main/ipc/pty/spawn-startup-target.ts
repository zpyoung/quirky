// Where a new PTY starts and in which shell/runtime, for both the window and the host spawn lane.

import type { LocalWindowsTerminalRuntimeOptions } from '../../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { TerminalStartupCwdMissingDirFallback } from '../../../shared/terminal-startup-cwd'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import {
  resolveLocalProjectRuntimeForWorktreeId,
  resolveLocalPtyOptions,
  type ProjectRuntimeResolutionStore
} from '../../local-project-runtime-resolution'
import { getCodexSelectionTargetForPty } from './host-env/codex-home'

// TEMPORARY (row 13b removes it): the window uses the renderer's runtime; the host reads the store.
export type PtySpawnProjectRuntimeSource =
  | { kind: 'sent'; projectRuntime: ProjectExecutionRuntimeResolution | undefined }
  | { kind: 'store'; store: ProjectRuntimeResolutionStore | undefined }

export type PtySpawnStartupTarget = {
  cwd: string | undefined
  /** Already proven to exist by the WSL probe. */
  prevalidatedCwd?: string
  startupCwdFallback?: { kind: 'worktree'; cwd: string }
  terminalRuntimeOptions: LocalWindowsTerminalRuntimeOptions
  expectedWslDistro: string | null
  codexSelectionTarget: CodexAccountSelectionTarget
}

type PtySpawnStartupArgs = {
  worktreeId: string | undefined
  cwd: string | undefined
  /** Its worktree can imply the WSL distro. */
  sessionId: string | undefined
  shellOverride: string | undefined
  /** The PTY an agent launch's command was quoted for. */
  plannedPty?: LocalWindowsTerminalRuntimeOptions
  projectRuntimeSource: PtySpawnProjectRuntimeSource
  /** TEMPORARY (row 13a removes it): only window starts fall back to the root of a missing cwd. */
  missingCwdFallback?: { directoryExists: (path: string) => Promise<boolean> }
  getSettings: (() => Parameters<typeof resolveLocalPtyOptions>[0]) | undefined
  resolveStartupCwd: (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ) => string | undefined
}

export async function resolvePtySpawnStartupTarget(
  args: PtySpawnStartupArgs
): Promise<PtySpawnStartupTarget> {
  const source = args.projectRuntimeSource
  const terminalRuntimeOptions =
    args.plannedPty ??
    resolveLocalPtyOptions(
      args.getSettings?.(),
      source.kind === 'sent'
        ? source.projectRuntime
        : resolveLocalProjectRuntimeForWorktreeId(source.store, args.worktreeId),
      args.shellOverride,
      process.env.COMSPEC || 'powershell.exe'
    )
  const startup = args.missingCwdFallback
    ? await resolveStartupCwdWithFallback(args, args.missingCwdFallback)
    : { cwd: args.resolveStartupCwd(args.worktreeId, args.cwd) }
  const expectedWslDistro = null
  return {
    ...startup,
    terminalRuntimeOptions,
    expectedWslDistro,
    codexSelectionTarget: getCodexSelectionTargetForPty(
      terminalRuntimeOptions.shellOverride,
      startup.cwd,
      expectedWslDistro
    )
  }
}

async function resolveStartupCwdWithFallback(
  { worktreeId, resolveStartupCwd, ...args }: PtySpawnStartupArgs,
  fallback: { directoryExists: (path: string) => Promise<boolean> }
): Promise<Pick<PtySpawnStartupTarget, 'cwd' | 'startupCwdFallback'>> {
  let didFallbackToWorkspaceRootCwd = false
  const probedDirectories = new Map<string, boolean>()
  let unprobedDirectory: string | undefined
  const missingDirFallback = (
    onFallbackToWorkspaceRoot?: () => void
  ): TerminalStartupCwdMissingDirFallback => ({
    directoryExists: (path) => {
      const exists = probedDirectories.get(path)
      if (exists === undefined) {
        unprobedDirectory ??= path
      }
      return exists ?? false
    },
    onFallbackToWorkspaceRoot
  })
  // Why replay: the shared resolver asks synchronously, so probe each folder it asks about off
  // the main thread, in its order, until a dry run asks about none it lacks.
  for (;;) {
    unprobedDirectory = undefined
    resolveStartupCwd(worktreeId, args.cwd, missingDirFallback())
    if (unprobedDirectory === undefined) {
      break
    }
    probedDirectories.set(unprobedDirectory, await fallback.directoryExists(unprobedDirectory))
  }
  const cwd = resolveStartupCwd(
    worktreeId,
    args.cwd,
    missingDirFallback(() => {
      didFallbackToWorkspaceRootCwd = true
    })
  )
  return {
    cwd,
    startupCwdFallback: didFallbackToWorkspaceRootCwd && cwd ? { kind: 'worktree', cwd } : undefined
  }
}
