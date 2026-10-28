import { isAbsolute } from 'node:path'
import type { Worktree, WorkspaceViewOwner } from '@quirky/protocol'
import { matchWorktrees } from '../../selector'
import type { WorktreeControl } from '../control-types'

export type WorkspaceViewOwnerResolution =
  | { kind: 'owned'; owner: WorkspaceViewOwner }
  | { kind: 'unrelated' }
  | { kind: 'unknown' }

const WORKSPACE_VIEW_IDS: Record<string, true> = {
  'view:quirky.session/worktree': true,
  'view:quirky.git/diff': true
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function resolveSelector(worktrees: WorktreeControl[], selector: string): Worktree | null {
  try {
    const matches = matchWorktrees(worktrees, selector)
    return matches.length === 1 ? matches[0]! : null
  } catch {
    return null
  }
}

/** Resolve only view kinds owned by worktrees; malformed or non-unique workspace inputs remain unknown. */
export function resolveWorkspaceViewOwner(viewValue: unknown, worktrees: WorktreeControl[]): WorkspaceViewOwnerResolution {
  if (viewValue === null || viewValue === undefined) return { kind: 'unrelated' }
  const view = recordOf(viewValue)
  if (!view) return { kind: 'unknown' }
  if (typeof view.id !== 'string' || !WORKSPACE_VIEW_IDS[view.id]) return { kind: 'unrelated' }

  const input = recordOf(view.input)
  if (!input) return { kind: 'unknown' }

  const selectors: string[] = []
  if ('worktree' in input) {
    if (typeof input.worktree !== 'string' || input.worktree.trim() === '') return { kind: 'unknown' }
    selectors.push(input.worktree)
  }
  if (typeof input.path === 'string' && isAbsolute(input.path)) {
    selectors.push(`path:${input.path}`)
  } else if (selectors.length === 0) {
    return { kind: 'unknown' }
  }

  let owner: Worktree | null = null
  for (const selector of selectors) {
    const match = resolveSelector(worktrees, selector)
    if (!match || (owner && (owner.id !== match.id || owner.instanceId !== match.instanceId))) return { kind: 'unknown' }
    owner = match
  }
  if (!owner) return { kind: 'unknown' }
  return { kind: 'owned', owner: { worktreeId: owner.id, instanceId: owner.instanceId } }
}
