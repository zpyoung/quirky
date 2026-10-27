import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { gitApi } from '@quirky/git'
import type { GitStatus, GitStatusEntry, PluginCaller, PluginContext, Worktree } from '@quirky/protocol'
import { createErrors, type Errors } from './errors'
import { createLock, type WorktreeLock } from './lock'
import { OpenedConflicts } from './opened'

export type WorktreeParams = { worktree?: string }

/** A method implementation; `params` have passed the manifest schema. */
export type Handler = (params: Record<string, any>, caller: PluginCaller) => unknown

/** What every handler of the daemon half shares. */
export type DaemonEnv = {
  context: PluginContext
  errors: Errors
  lock: WorktreeLock
  opened: OpenedConflicts
  /** The worktree `params.worktree` selects for `caller`; folder workspaces are refused. */
  resolve(params: WorktreeParams, caller: PluginCaller): Promise<Worktree>
  /** Announces `quirky.git/changed` for a successful mutation. */
  changed(worktree: Worktree): void
  /**
   * The status snapshot the panel shows: `statusV2` without the project's shared-directory
   * symlinks, plus `resolved_locally` conflict entries and the held lock as `busy`.
   */
  readStatus(worktree: Worktree): Promise<GitStatus>
  /** The project's shared-directory symlinks that are untracked in the worktree, relative to its root. */
  sharedSymlinks(worktree: Worktree): Promise<string[]>
}

export function createEnv(context: PluginContext): DaemonEnv {
  const errors = createErrors(context)
  const lock = createLock(errors)
  const opened = new OpenedConflicts()

  async function resolve(params: WorktreeParams, caller: PluginCaller): Promise<Worktree> {
    const identity = caller.role === 'plugin' ? {} : { cwd: caller.cwd, worktreeId: caller.worktreeId }
    const worktree = (await context.call('quirky.worktree/resolve', {
      selector: params.worktree ?? 'current',
      ...identity
    })) as Worktree
    if (worktree.kind === 'folder') {
      throw Object.assign(
        context.error('invalid-params', 'Opened as folder. Git features are unavailable for this workspace.'),
        { data: { reason: 'folder-workspace' } }
      )
    }
    return worktree
  }

  async function configuredSharedDirectories(worktree: Worktree): Promise<string[]> {
    try {
      const details = (await context.call('quirky.repo/show', { repo: worktree.repoId })) as {
        hooks?: { sharedDirectories?: string[] }
      }
      return (details.hooks?.sharedDirectories ?? []).map((directory) => directory.replace(/\/+$/, ''))
    } catch {
      return []
    }
  }

  async function sharedSymlinks(worktree: Worktree): Promise<string[]> {
    const links: string[] = []
    for (const directory of await configuredSharedDirectories(worktree)) {
      const info = await lstat(join(worktree.path, directory)).catch(() => null)
      if (!info?.isSymbolicLink()) continue
      // `show :<path>` finds nothing for a path the index does not hold
      if ((await gitApi().showFile(worktree.path, '', directory)) === null) links.push(directory)
    }
    return links
  }

  async function readStatus(worktree: Worktree): Promise<GitStatus> {
    const git = gitApi()
    const snapshot = await git.statusV2(worktree.path, { sharedSymlinks: await configuredSharedDirectories(worktree) })
    let entries = snapshot.entries
    if (!snapshot.capped) {
      if (snapshot.operation === 'none') opened.clear(worktree.id)
      else {
        const head = await git.operationHead(worktree.path)
        const listed = new Set(entries.filter((entry) => entry.area === 'conflicts').map((entry) => entry.path))
        const resolved: GitStatusEntry[] = opened
          .list(worktree.id, snapshot.operation, head)
          .filter(({ path }) => !listed.has(path))
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(({ path, kind }) => ({
            path,
            area: 'conflicts',
            status: 'modified',
            conflict: { kind, state: 'resolved_locally' }
          }))
        const unresolved = entries.filter((entry) => entry.area === 'conflicts')
        entries = [...unresolved, ...resolved, ...entries.filter((entry) => entry.area !== 'conflicts')]
      }
    }
    return { ...snapshot, entries, busy: lock.heldBy(worktree.id) }
  }

  return {
    context,
    errors,
    lock,
    opened,
    resolve,
    changed: (worktree) => context.emit('changed', { worktreeId: worktree.id }),
    readStatus,
    sharedSymlinks
  }
}
