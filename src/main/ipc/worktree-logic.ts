import { resolve, relative, isAbsolute, posix, sep, win32 } from 'node:path'
import type { GlobalSettings, QuirkyWorkspaceLayout } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { isWindowsAbsolutePathLike, resolveRuntimePath } from '../../shared/cross-platform-path'
import { resolveWslRepoWorktreeBasePath } from '../../shared/wsl-paths'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  replaceKnownEmojiWithShortcodes,
  setEmojiShortcodeDatasetLoader
} from '../../shared/emoji-shortcode-catalog'
import { requireEmojiShortcodeDataset } from './deferred-emoji-shortcode-dataset'

setEmojiShortcodeDatasetLoader(requireEmojiShortcodeDataset)

type WorktreePathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'> & {
  /** Distro to mirror the workspace root into when the repo itself sits on a
   *  Windows drive but this project's git runs in WSL. Omitted = today's
   *  placement, so any caller that cannot resolve the runtime is unaffected. */
  wslMirrorDistro?: string
}
type WorktreeBasePathRepo = Pick<Repo, 'path' | 'worktreeBasePath'>

/**
 * Sanitize a worktree name for use in branch names and directory paths.
 * Strips unsafe characters and collapses runs of special chars to a single hyphen.
 */
export function sanitizeWorktreeName(input: string): string {
  // Why: keep Unicode letters/numbers (CJK, accented Latin, etc.) so users can
  // name workspaces in their own language. Git ref-format permits non-ASCII
  // bytes, and modern filesystems handle UTF-8 paths. Only strip characters
  // git or the filesystem actually rejects.
  const sanitized = replaceKnownEmojiWithShortcodes(input)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    // Why: git check-ref-format rejects any ref containing `..`, so a prompt
    // like "../../foo" that survives slugification as `..-..-foo` would
    // produce a branch name git refuses to create. Collapse runs of dots
    // to a single dot before the leading/trailing trim so internal `..`
    // sequences can't reach git.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized && containsEmoji(input)) {
    return 'workspace'
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}

function containsEmoji(input: string): boolean {
  return /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(
    input
  )
}

/**
 * Ensure a target path is within the workspace directory (prevent path traversal).
 */
export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = resolve(workspaceDir)
  const resolvedTargetPath = resolve(targetPath)
  const rel = relative(resolvedWorkspaceDir, resolvedTargetPath)

  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Invalid worktree path')
  }

  return resolvedTargetPath
}

/**
 * Compute the filesystem path where the worktree directory will be created.
 *
 * Why WSL special case: when the repo lives on a WSL filesystem, worktrees
 * must also live on the WSL filesystem. Creating them on the Windows side
 * (/mnt/c/...) would be extremely slow due to cross-filesystem I/O and
 * the terminal would open a Windows shell instead of WSL. We mirror the
 * Windows workspace layout inside ~/quirky/workspaces on the WSL filesystem
 * (e.g. \\wsl.localhost\Ubuntu\home\user\quirky\workspaces\repo\feature).
 */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreePathSettings,
  workspaceRoot?: string
): string {
  return computeWorktreePathFromWorkspaceRoot(
    sanitizedName,
    repoPath,
    workspaceRoot ?? computeWorkspaceRoot(repoPath, settings),
    settings.nestWorkspaces
  )
}

/** Layout half shared by both computeWorktreePath variants, so the sync and async paths cannot
 *  disagree on placement once the root is resolved. */
function computeWorktreePathFromWorkspaceRoot(
  sanitizedName: string,
  repoPath: string,
  workspaceRoot: string,
  nestWorkspaces: boolean
): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceRoot)
  if (nestWorkspaces) {
    const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
    return pathOps.join(workspaceRoot, repoName, sanitizedName)
  }
  return pathOps.join(workspaceRoot, sanitizedName)
}

/** Async twin of computeWorktreePath; returns the same result. */
export async function computeWorktreePathAsync(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreePathSettings
): Promise<string> {
  return computeWorktreePathFromWorkspaceRoot(
    sanitizedName,
    repoPath,
    await computeWorkspaceRootAsync(repoPath, settings),
    settings.nestWorkspaces
  )
}

/** Async twin of computeWorkspaceRoot; returns the same result. */
export async function computeWorkspaceRootAsync(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): Promise<string> {
  return computeWorkspaceRoot(repoPath, settings)
}

export function computeWorkspaceRoot(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): string {
  return resolveWorkspaceDirForRepo(repoPath, settings.workspaceDir)
}

export function computeRemoteWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreePathSettings,
  options: { useConfiguredAbsolutePath?: boolean } = {}
): string {
  if (
    options.useConfiguredAbsolutePath ||
    isWorkspaceDirRelativeToRepo(repoPath, settings.workspaceDir)
  ) {
    return computeWorktreePath(sanitizedName, repoPath, settings)
  }
  // Why: absolute global workspaceDir values belong to the desktop machine.
  // SSH falls back to repo-qualified sibling paths so origin/main is not shared.
  const pathOps = getRuntimePathOps(repoPath, repoPath)
  const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
  return pathOps.join(repoPath, '..', `${repoName}-${sanitizedName}`)
}

export function getWorktreePathSettings(
  repo: WorktreeBasePathRepo,
  settings: WorktreePathSettings,
  wslMirrorDistro?: string
): WorktreePathSettings {
  return {
    nestWorkspaces: settings.nestWorkspaces,
    workspaceDir: getEffectiveWorktreeBasePath(repo, settings),
    // Why pass it through rather than resolve here: placement has to agree
    // across create, allowed-roots and watch-targets, so the distro is
    // resolved once by the caller that owns the store and threaded down.
    ...(wslMirrorDistro ? { wslMirrorDistro } : {})
  }
}

export function getWorktreeCreationLayout(
  repo: WorktreeBasePathRepo,
  settings: WorktreePathSettings
): QuirkyWorkspaceLayout {
  return {
    path: getEffectiveWorktreeBasePath(repo, settings),
    nestWorkspaces: settings.nestWorkspaces
  }
}

export function hasRepoWorktreeBasePath(repo: Pick<Repo, 'worktreeBasePath'>): boolean {
  return getRepoWorktreeBasePath(repo) !== undefined
}

function getRuntimePathOps(
  repoPath: string,
  workspaceDir: string
): Pick<typeof posix, 'basename' | 'isAbsolute' | 'join' | 'normalize'> {
  return isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(workspaceDir)
    ? win32
    : posix
}

function resolveWorkspaceDirForRepo(repoPath: string, workspaceDir: string): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceDir)
  return pathOps.isAbsolute(workspaceDir)
    ? pathOps.normalize(workspaceDir)
    : resolveRuntimePath(repoPath, workspaceDir)
}

function isWorkspaceDirRelativeToRepo(repoPath: string, workspaceDir: string): boolean {
  return !getRuntimePathOps(repoPath, workspaceDir).isAbsolute(workspaceDir)
}

function getEffectiveWorktreeBasePath(
  repo: WorktreeBasePathRepo,
  settings: WorktreePathSettings
): string {
  const basePath = getRepoWorktreeBasePath(repo)
  if (basePath === undefined) {
    return settings.workspaceDir
  }
  return resolveWslRepoWorktreeBasePath(repo.path, basePath)
}

function getRepoWorktreeBasePath(repo: Pick<Repo, 'worktreeBasePath'>): string | undefined {
  const trimmed = repo.worktreeBasePath?.trim()
  return trimmed || undefined
}

/**
 * Determine whether a display name should be persisted.
 * A display name is set only when the user's requested name differs from
 * both the branch name and the sanitized name (i.e. it was modified).
 */
/**
 * Parse a composite worktreeId ("repoId::worktreePath") into its parts.
 */
export function parseWorktreeId(worktreeId: string): { repoId: string; worktreePath: string } {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    throw new Error(`Invalid worktreeId: ${worktreeId}`)
  }
  return parsed
}

/**
 * Check whether a git error indicates the worktree is no longer tracked by git.
 * This happens when a worktree's internal git tracking is removed (e.g. via
 * `git worktree prune`) but the directory still exists on disk.
 */
export function isOrphanedWorktreeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const msg = (error as { stderr?: string }).stderr || error.message
  return /is not a working tree/.test(msg)
}

export function isWindowsLongPathWorktreeRemovalError(
  error: unknown,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32' || typeof error !== 'object' || error === null) {
    return false
  }
  const errorWithDetails = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  const details = [errorWithDetails.stderr, errorWithDetails.stdout, errorWithDetails.message]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')

  // Why: Git for Windows has reported this failure through both stderr and the
  // thrown message, with wording that varies between "filename" and "path".
  return /(?:file ?name|path).{0,40}too long|too long.{0,40}(?:file ?name|path)/i.test(details)
}

export function isOrphanCompatiblePreflightError(error: unknown): boolean {
  if (isOrphanedWorktreeError(error)) {
    return true
  }
  if (!(error instanceof Error)) {
    return false
  }
  const errorWithDetails = error as Error & { code?: unknown; stderr?: string; stdout?: string }
  const details = [
    errorWithDetails.stderr,
    errorWithDetails.stdout,
    errorWithDetails.message,
    typeof errorWithDetails.code === 'string' ? errorWithDetails.code : undefined
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
  return /not a git repository/i.test(details) || /\bENOENT\b/i.test(details)
}

/**
 * Format a human-readable error message for worktree removal failures.
 */
export function formatWorktreeRemovalError(
  error: unknown,
  worktreePath: string,
  force: boolean
): string {
  const fallback = force
    ? `Failed to force delete worktree at ${worktreePath}.`
    : `Failed to delete worktree at ${worktreePath}.`

  if (!(error instanceof Error)) {
    return fallback
  }

  const errorWithStreams = error as Error & { stderr?: string; stdout?: string }
  const details = [errorWithStreams.stderr, errorWithStreams.stdout, error.message]
    .map((value) => value?.trim())
    .find(Boolean)

  return details ? `${fallback} ${details}` : fallback
}
