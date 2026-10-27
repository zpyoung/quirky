import { basename, isAbsolute, resolve } from 'node:path'
import type { Worktree } from '@quirky/protocol'
import { contains, pathForms } from './paths'

/** A selector that cannot be evaluated at all, as opposed to one that matches nothing. */
export class SelectorSyntaxError extends Error {}

/** What `current` and relative `path:` selectors are read against. */
export type CallerIdentity = { cwd?: string; worktreeId?: string }

/**
 * The workspaces `text` names: those with that name, else those whose folder has that name (their
 * identity on disk, which a display name doesn't hide). Folder workspaces of one project share a
 * folder, so the exact name goes first or the primary's own name would turn ambiguous.
 */
function named(worktrees: Worktree[], text: string): Worktree[] {
  const byName = worktrees.filter((worktree) => worktree.name === text)
  return byName.length > 0 ? byName : worktrees.filter((worktree) => basename(worktree.path) === text)
}

function innermost(worktrees: Worktree[], path: string): Worktree[] {
  const targets = pathForms(path)
  let best: { worktree: Worktree; length: number } | null = null
  for (const worktree of worktrees) {
    for (const form of pathForms(worktree.path)) {
      if (targets.some((target) => contains(form, target)) && (!best || form.length > best.length)) {
        best = { worktree, length: form.length }
      }
    }
  }
  return best ? [best.worktree] : []
}

function current(worktrees: Worktree[], identity: CallerIdentity): Worktree[] {
  if (identity.worktreeId) return worktrees.filter((worktree) => worktree.id === identity.worktreeId)
  if (identity.cwd) return innermost(worktrees, resolve(identity.cwd))
  return []
}

/**
 * The worktrees a selector names: `id:`, `name:`, `branch:`, `path:` (the innermost worktree
 * containing the path), `current` or `active` (the session's worktree, else the one containing the
 * cwd), or a bare value matched as an exact ID, then a name, then a branch. A name with no exact match
 * falls back to workspaces whose folder has that name, so a display name doesn't hide it. Throws
 * SelectorSyntaxError for an empty selector or value, or a relative `path:` with no cwd to read it against.
 */
export function matchWorktrees(worktrees: Worktree[], selector: string, identity: CallerIdentity = {}): Worktree[] {
  const text = selector.trim()
  if (text === '') throw new SelectorSyntaxError('selector must not be empty')
  if (text === 'current' || text === 'active') return current(worktrees, identity)

  const prefixed = /^(id|name|branch|path):(.*)$/s.exec(text)
  if (!prefixed) {
    const byId = worktrees.filter((worktree) => worktree.id === text)
    if (byId.length > 0) return byId
    const byName = named(worktrees, text)
    return byName.length > 0 ? byName : worktrees.filter((worktree) => worktree.branch === text)
  }
  const [, form, value] = prefixed
  if (value === '') throw new SelectorSyntaxError(`${form}: needs a value`)
  if (form === 'id') return worktrees.filter((worktree) => worktree.id === value)
  if (form === 'name') return named(worktrees, value!)
  if (form === 'branch') return worktrees.filter((worktree) => worktree.branch === value)
  if (!isAbsolute(value!) && !identity.cwd) throw new SelectorSyntaxError('path: needs an absolute path')
  return innermost(worktrees, resolve(identity.cwd ?? '/', value!))
}
