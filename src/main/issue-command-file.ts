// Why: `.quirky/issue-command` is the per-user override; `quirky.yaml` is the tracked project default.
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadHooks } from './hooks'
import { resolveRepoConfigPath } from '../shared/repo-config-paths'
import type { GitRuntimeOptions } from './git/git-runtime-options'
import { checkIgnoredPaths } from './git/check-ignored-paths'

type IssueCommandGitOptions = GitRuntimeOptions | (() => GitRuntimeOptions)

const QUIRKY_DIR = '.quirky'
const ISSUE_COMMAND_FILENAME = 'issue-command'

export function getIssueCommandFilePath(repoPath: string): string {
  return join(repoPath, QUIRKY_DIR, ISSUE_COMMAND_FILENAME)
}

export function getSharedIssueCommand(repoPath: string): string | null {
  return loadHooks(repoPath)?.issueCommand?.trim() || null
}

export type ResolvedIssueCommand = {
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

/**
 * Resolve the GitHub issue command using local override first, then tracked repo config.
 */
export function readIssueCommand(repoPath: string): ResolvedIssueCommand {
  const filePath = getIssueCommandFilePath(repoPath)
  const configDir = resolveRepoConfigPath(repoPath, 'dir')
  const readPath = configDir ? join(configDir, ISSUE_COMMAND_FILENAME) : filePath
  let localContent: string | null = null

  if (existsSync(readPath)) {
    try {
      const content = readFileSync(readPath, 'utf-8').trim()
      localContent = content || null
    } catch {
      localContent = null
    }
  }

  const sharedContent = getSharedIssueCommand(repoPath)
  const effectiveContent = localContent ?? sharedContent

  return {
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath: filePath,
    source: localContent ? 'local' : sharedContent ? 'shared' : 'none'
  }
}

/**
 * Write the per-user issue command override to `{repoRoot}/.quirky/issue-command`.
 * Empty content deletes the override so the shared `quirky.yaml` command applies again.
 */
export async function writeIssueCommand(
  repoPath: string,
  content: string,
  options: IssueCommandGitOptions = {}
): Promise<void> {
  const filePath = getIssueCommandFilePath(repoPath)
  const trimmed = content.trim()

  try {
    if (!trimmed) {
      rmSync(filePath, { force: true })
      return
    }

    const quirkyDir = join(repoPath, QUIRKY_DIR)
    if (!existsSync(quirkyDir)) {
      mkdirSync(quirkyDir, { recursive: true })
    }
    if (!(await isIssueCommandIgnoredByGit(repoPath, options))) {
      ensureQuirkyDirIgnored(repoPath)
    }
    writeFileSync(filePath, `${trimmed}\n`, 'utf-8')
  } catch (err) {
    console.error('[hooks] Failed to write issue command:', err)
    // Why: re-throw so the IPC handler surfaces the write failure to the renderer's .catch().
    throw err
  }
}

/** Consult Git before changing shared ignore rules for a private override. */
async function isIssueCommandIgnoredByGit(
  repoPath: string,
  options: IssueCommandGitOptions = {}
): Promise<boolean> {
  try {
    const issueCommandPath = `${QUIRKY_DIR}/${ISSUE_COMMAND_FILENAME}`
    const ignored = await checkIgnoredPaths(
      repoPath,
      [issueCommandPath],
      // Runtime repair must not block saving or clearing the local override.
      typeof options === 'function' ? options() : options
    )
    return ignored.includes(issueCommandPath)
  } catch {
    // Preserve the existing ignore-file fallback if Git cannot inspect the rules.
    return false
  }
}

/** Ensure `.quirky` is in `.gitignore` so the per-user directory is never committed. */
function ensureQuirkyDirIgnored(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore')
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8')
      if (/^\.quirky\/?$/m.test(content)) {
        return
      }
      const separator = content.endsWith('\n') ? '' : '\n'
      writeFileSync(gitignorePath, `${content}${separator}.quirky\n`, 'utf-8')
    } else {
      writeFileSync(gitignorePath, '.quirky\n', 'utf-8')
    }
  } catch {
    console.warn('[hooks] Could not update .gitignore to exclude .quirky')
  }
}
