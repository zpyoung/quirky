import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { UsageError, flagString, type ParsedArgs } from '../args'
import type { Context } from './types'

/** Rejects missing or surplus positionals; `names` labels the required ones for the error message. */
export function takePositionals(args: ParsedArgs, names: string[], optional = 0): string[] {
  const { positionals } = args
  if (positionals.length < names.length) {
    throw new UsageError(`missing <${names[positionals.length]}>`)
  }
  if (positionals.length > names.length + optional) {
    throw new UsageError(`unexpected argument "${positionals[names.length + optional]}"`)
  }
  return positionals
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args, name)
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`)
  return value
}

function pathForms(path: string): string[] {
  const forms = [path]
  try {
    const real = realpathSync(path)
    if (real !== path) forms.push(real)
  } catch {
    // a worktree path that no longer exists can still be matched textually
  }
  return forms
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * The worktree id to act on: `--worktree`, else `QUIRKY_WORKTREE_ID`, else the worktree whose
 * path contains the cwd (the longest such path, so nested worktrees resolve to the inner one).
 */
export async function resolveWorktreeId(args: ParsedArgs, ctx: Context): Promise<string> {
  const explicit = flagString(args, 'worktree') ?? ctx.env.QUIRKY_WORKTREE_ID
  if (explicit) return explicit
  const cwdForms = pathForms(resolve(ctx.cwd))
  const worktrees = await ctx.rpc.call('worktree.list', {})
  let best: { id: string; length: number } | null = null
  for (const worktree of worktrees) {
    for (const path of pathForms(worktree.path)) {
      if (cwdForms.some((cwd) => contains(path, cwd)) && (!best || path.length > best.length)) {
        best = { id: worktree.id, length: path.length }
      }
    }
  }
  if (!best) {
    throw new UsageError(
      `no worktree contains ${ctx.cwd}; pass --worktree <id> or set QUIRKY_WORKTREE_ID`
    )
  }
  return best.id
}

export function sessionIdOr(explicit: string | undefined, ctx: Context): string {
  const id = explicit ?? ctx.env.QUIRKY_SESSION_ID
  if (!id) throw new UsageError('no session id; pass <sessionId> or set QUIRKY_SESSION_ID')
  return id
}
