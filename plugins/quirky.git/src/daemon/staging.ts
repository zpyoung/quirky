import { gitApi, hasConflictMarkers, NotAllowedError } from '@quirky/git'
import type { GitStatusEntry, Worktree } from '@quirky/protocol'
import { describeDiscardText, type DiscardArea } from '../shared/discard-text'
import type { DaemonEnv, Handler } from './env'
import { containedPath } from './paths'

const AREAS: readonly DiscardArea[] = ['staged', 'unstaged', 'untracked']

/** Whether `inner` is `outer` or lies under it. */
const isUnder = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}/`)

function exactlyOne(env: DaemonEnv, a: unknown, b: unknown, names: string): void {
  if ((a === undefined) === (b === undefined)) throw env.context.error('invalid-params', `Pass exactly one of ${names}.`)
}

function nonEmpty(env: DaemonEnv, paths: unknown): void {
  if (Array.isArray(paths) && paths.length === 0) throw env.context.error('invalid-params', 'paths must not be empty.')
}

/** Throws `not-stageable` for a submodule root or a conflict whose working file still has markers. */
async function refuseUnstageable(env: DaemonEnv, worktree: Worktree, paths: string[]): Promise<void> {
  const { entries } = await env.readStatus(worktree)
  for (const path of paths) {
    if (entries.some((entry) => entry.path === path && entry.submodule)) {
      throw env.errors.reasoned('invalid-params', 'not-stageable', 'Stage inside submodule')
    }
    if (!entries.some((entry) => entry.path === path && entry.area === 'conflicts' && entry.conflict?.state === 'unresolved')) continue
    const file = await gitApi()
      .readConflictFile(worktree.path, path)
      .catch((error) => {
        // a binary or symlinked conflict has no text markers to leave behind
        if (error instanceof NotAllowedError) return { content: null }
        throw error
      })
    if (file.content !== null && hasConflictMarkers(file.content)) {
      throw env.errors.reasoned('invalid-params', 'not-stageable', `Resolve the conflict markers in ${path} before staging it.`)
    }
  }
}

/** Stages `paths` or a whole scope; a staged conflict stops being unmerged once its markers are gone. */
export function stage(env: DaemonEnv): Handler {
  return async (params, caller) => {
    exactlyOne(env, params.paths, params.scope, 'paths or scope')
    nonEmpty(env, params.paths)
    const worktree = await env.resolve(params, caller)
    if (params.scope !== undefined) {
      await gitApi().stageScope(worktree.path, params.scope, await env.sharedSymlinks(worktree))
    } else {
      await refuseUnstageable(env, worktree, params.paths)
      await gitApi().stagePaths(worktree.path, params.paths)
    }
    env.changed(worktree)
    return { ok: true }
  }
}

/** Unstages `paths`, adding the old path of every staged rename whose new path is listed. */
export function unstage(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const paths: string[] = params.paths
    const { entries } = await env.readStatus(worktree)
    const renamedFrom = entries
      .filter((entry) => entry.area === 'staged' && entry.oldPath !== undefined && paths.includes(entry.path))
      .map((entry) => entry.oldPath!)
    await gitApi().unstagePaths(worktree.path, [...new Set([...paths, ...renamedFrom])])
    env.changed(worktree)
    return { ok: true }
  }
}

/** The reason `path` must not be discarded, or null. */
function discardRefusal(entries: GitStatusEntry[], operation: string, path: string): string | null {
  if (entries.some((entry) => entry.area === 'conflicts' && isUnder(path, entry.path))) {
    return `${path} has merge conflicts. Resolve them or abort the ${operation} first.`
  }
  if (entries.some((entry) => entry.submodule && isUnder(path, entry.path))) {
    return `${path} is a submodule. Discard its changes inside the submodule.`
  }
  return null
}

/** Paths of a whole section, leaving out conflicts and submodule roots; a staged rename lists both of its paths. */
function sectionPaths(entries: GitStatusEntry[], area: DiscardArea): string[] {
  const protectedRow = (entry: GitStatusEntry) =>
    entry.submodule !== undefined || entries.some((other) => other.area === 'conflicts' && other.path === entry.path)
  const picked = entries.filter((entry) => entry.area === area && !protectedRow(entry))
  return [...new Set(picked.flatMap((entry) => (area === 'staged' && entry.oldPath ? [entry.path, entry.oldPath] : [entry.path])))]
}

/** Discards `paths` or a whole `area`; staged changes are unstaged first so they are reverted too. */
export function discard(env: DaemonEnv): Handler {
  return async (params, caller) => {
    exactlyOne(env, params.paths, params.area, 'paths or area')
    nonEmpty(env, params.paths)
    const worktree = await env.resolve(params, caller)
    const status = await env.readStatus(worktree)

    let targets: string[]
    if (params.paths !== undefined) {
      targets = []
      for (const path of params.paths as string[]) targets.push((await containedPath(worktree.path, path)).rel)
      for (const path of targets) {
        const refusal = discardRefusal(status.entries, status.operation, path)
        if (refusal) throw env.errors.reasoned('invalid-params', 'not-discardable', refusal)
      }
    } else {
      targets = sectionPaths(status.entries, params.area)
    }

    if (params.area === 'staged') await gitApi().unstagePaths(worktree.path, targets)
    const { failures } = await gitApi().discardPaths(worktree.path, targets)
    if (failures.length > 0) {
      throw env.errors.reasoned('conflict', 'failed', `Failed to discard ${failures.length} file(s)`, { failures })
    }
    env.changed(worktree)
    return { ok: true }
  }
}

/** The question asked before `discard`: Orca's dialog title and body for what the call would discard. */
export function describeDiscard(env: DaemonEnv): Handler {
  return async (params, caller) => {
    exactlyOne(env, params.paths, params.area, 'paths or area')
    if (params.area !== undefined && !AREAS.includes(params.area)) {
      throw env.context.error('invalid-params', 'area must be staged, unstaged or untracked.')
    }
    const worktree = await env.resolve(params, caller)
    const { entries } = await env.readStatus(worktree)
    return describeDiscardText({ paths: params.paths, area: params.area, entries })
  }
}
