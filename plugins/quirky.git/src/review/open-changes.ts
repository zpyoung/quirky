import { RpcErrorCode, type GitStatus, type GitStatusEntry, type UiPluginContext } from '@quirky/protocol'
import { openReview, type ReviewOpenResult, type ReviewSource } from './open'

export type OpenChangesMode = 'edit' | 'diff' | 'both'
export const MAX_EDIT_FILES = 50

export type OpenChangesResult = {
  worktree: string
  mode: OpenChangesMode
  source: ReviewSource | null
  focused: boolean
  statusComplete: boolean
  review: ReviewOpenResult | null
  opened: Array<{ path: string; tabId: string; bufferId: string }>
  skipped: Array<{ path: string; reason: 'deleted' | 'missing' | 'failed'; message?: string }>
}

const encoder = new TextEncoder()

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return left.length - right.length
}

function sortPaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)]
  const bytes = new Map<string, Uint8Array>()
  for (const path of unique) bytes.set(path, encoder.encode(path))
  unique.sort((left, right) => compareBytes(bytes.get(left)!, bytes.get(right)!))
  return unique
}

function selected(entry: GitStatusEntry, source: ReviewSource | null): boolean {
  if (source === null) return true
  if (source === 'staged') return entry.area === 'staged'
  return entry.area === 'unstaged' || entry.area === 'untracked'
}

/** Selects the changed working-tree paths to open and those status marks say are deleted. */
export function editTargets(entries: readonly GitStatusEntry[], source: ReviewSource | null): { open: string[]; deleted: string[] } {
  const byPath = new Map<string, GitStatusEntry[]>()
  const candidates = new Set<string>()
  for (const entry of entries) {
    const rows = byPath.get(entry.path)
    if (rows) rows.push(entry)
    else byPath.set(entry.path, [entry])
    if (selected(entry, source)) candidates.add(entry.path)
  }

  const open: string[] = []
  const deleted: string[] = []
  for (const path of candidates) {
    const rows = byPath.get(path)!
    const hasUnstagedDelete = rows.some((entry) => entry.area === 'unstaged' && entry.status === 'deleted')
    const hasStagedDelete = rows.some((entry) => entry.area === 'staged' && entry.status === 'deleted')
    const hasWorkingCopy = rows.some((entry) => entry.area === 'unstaged' || entry.area === 'untracked')
    if (hasUnstagedDelete || (hasStagedDelete && !hasWorkingCopy)) deleted.push(path)
    else open.push(path)
  }

  return { open: sortPaths(open), deleted: sortPaths(deleted) }
}

function sortSkipped<T extends { path: string }>(skipped: T[]): T[] {
  const bytes = new Map<string, Uint8Array>()
  for (const { path } of skipped) bytes.set(path, encoder.encode(path))
  return skipped.sort((left, right) => compareBytes(bytes.get(left.path)!, bytes.get(right.path)!))
}

/** Opens changed files, the worktree Review, or both, with every reported step acknowledged. */
export async function openChanges(
  context: UiPluginContext,
  request: { worktree: string; mode: OpenChangesMode; source: ReviewSource | null; focus: boolean }
): Promise<OpenChangesResult> {
  const status = await context.call('quirky.git/status', { worktree: request.worktree }) as GitStatus
  const statusComplete = !status.capped

  if (request.mode !== 'diff' && !statusComplete) {
    throw new Error('git status stopped at its entry limit, so the changed-file list is incomplete; edit and both need the full list.')
  }

  const targets = request.mode === 'diff' ? { open: [], deleted: [] } : editTargets(status.entries, request.source)
  if (targets.open.length > MAX_EDIT_FILES) {
    throw new Error(`open-changes would open ${targets.open.length} files in the editor; edit and both open at most ${MAX_EDIT_FILES}.`)
  }

  const opened: OpenChangesResult['opened'] = []
  const skipped: OpenChangesResult['skipped'] = targets.deleted.map((path) => ({ path, reason: 'deleted' }))
  for (const path of targets.open) {
    try {
      const result = await context.call('quirky.editor/open', {
        worktree: request.worktree,
        path,
        focus: false
      }) as { id: string; openedTabId: string }
      opened.push({ path, tabId: result.openedTabId, bufferId: result.id })
    } catch (error) {
      skipped.push({
        path,
        reason: (error as { code?: unknown } | null)?.code === RpcErrorCode.NotFound ? 'missing' : 'failed',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  let review: ReviewOpenResult | null = null
  let focused = false
  if (request.mode === 'diff' || request.mode === 'both') {
    review = await openReview(context, {
      worktree: request.worktree,
      ...(request.source === null ? {} : { source: request.source }),
      focus: request.focus,
      acknowledge: true
    })
    focused = review.focused
  } else if (request.focus && opened.length > 0) {
    const self = await context.call('ui.window.self', {}) as { connId: string | number }
    await context.call('quirky.editor/open', {
      worktree: request.worktree,
      path: opened[0]!.path,
      focus: true,
      window: self.connId
    })
    focused = true
  }

  const complete = request.source !== null && review !== null
    ? review.statusComplete ?? statusComplete
    : statusComplete

  return {
    worktree: request.worktree,
    mode: request.mode,
    source: request.source,
    focused,
    statusComplete: complete,
    review,
    opened,
    skipped: sortSkipped(skipped)
  }
}
