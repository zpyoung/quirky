import { gitApi, type DiffRequest } from '@quirky/git'
import type { GitDiffSource } from '@quirky/protocol'
import { readCompare } from './compare'
import type { DaemonEnv, Handler } from './env'
import { containedPath } from './paths'

declare global {
  /** Test-only replacement for Finder's `open -R`; production never sets it. */
  var __QUIRKY_TEST_REVEAL__: ((path: string) => void | Promise<void>) | undefined
}

const OID = /^[0-9a-f]{40}$/

function oidParam(env: DaemonEnv, name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !OID.test(value)) throw env.context.error('invalid-params', `${name} must be a full 40-character commit id.`)
  return value
}

/**
 * Both sides of a file diff for a source: staged, unstaged, branch (merge base to head, defaulting
 * to the current compare) or commit (first parent to commit). A diff git cannot read fails with
 * git's message instead of looking like "no changes".
 */
export function diff(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const source: GitDiffSource = params.source ?? (params.staged ? 'staged' : 'unstaged')
    const worktree = await env.resolve(params, caller)
    const { rel } = await containedPath(worktree.path, params.path)
    const oldPath = params.oldPath === undefined ? undefined : (await containedPath(worktree.path, params.oldPath)).rel
    const request: DiffRequest = { path: rel, source, ...(oldPath !== undefined && { oldPath }) }

    if (source === 'branch') {
      request.mergeBase = oidParam(env, 'mergeBase', params.mergeBase)
      request.head = oidParam(env, 'head', params.head)
      if (request.mergeBase === undefined || request.head === undefined) {
        const current = await readCompare(env, worktree)
        if (current.status !== 'ready') throw env.context.error('invalid-params', current.message ?? 'The branch compare is not available.')
        request.mergeBase ??= current.mergeBase!
        request.head ??= current.headOid!
      }
    } else if (source === 'commit') {
      const commit = oidParam(env, 'commit', params.commit)
      if (commit === undefined) throw env.context.error('invalid-params', 'commit is required for source commit.')
      request.commit = commit
      request.parent = oidParam(env, 'parent', params.parent)
      if (request.parent === undefined) {
        const { parent } = await gitApi().commitFiles(worktree.path, commit)
        request.parent = parent
      }
    }
    return gitApi().diffSource(worktree.path, request)
  }
}

/** Writes a working file atomically; with `expected` it refuses when the file changed on disk. */
export function save(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { rel } = await containedPath(worktree.path, params.path)
    const result = await gitApi().saveWorkingFile(worktree.path, rel, params.content, params.expected)
    env.changed(worktree)
    return result
  }
}

/** The status entries inside a submodule that the worktree's own status lists as changed. */
export function submoduleStatus(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { rel, absolute } = await containedPath(worktree.path, params.path)
    const { entries } = await env.readStatus(worktree)
    if (!entries.some((entry) => entry.path === rel && entry.submodule)) {
      throw env.errors.reasoned('invalid-params', 'not-allowed', `${rel} is not a changed submodule.`)
    }
    const inside = await gitApi().statusV2(absolute)
    return { entries: inside.entries }
  }
}

/** Dependency and build folders at the worktree root that git does not ignore. */
export function hugeFolders(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return { folders: await gitApi().hugeFolders(worktree.path) }
  }
}

/** Adds an allowlisted folder to the worktree's `.gitignore`. */
export function ignoreFolder(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { added } = await gitApi().appendIgnore(worktree.path, params.folder)
    env.changed(worktree)
    return { ok: true, added }
  }
}

async function openInFinder(absolute: string): Promise<boolean> {
  const proc = Bun.spawn(['open', '-R', absolute], { stdout: 'ignore', stderr: 'ignore' })
  return (await proc.exited) === 0
}

/** Shows a file in Finder. */
export function reveal(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { absolute } = await containedPath(worktree.path, params.path)
    const hook = globalThis.__QUIRKY_TEST_REVEAL__
    if (hook) await hook(absolute)
    else if (!(await openInFinder(absolute))) throw env.errors.reasoned('conflict', 'failed', `Could not reveal ${params.path} in Finder.`)
    return { ok: true }
  }
}
