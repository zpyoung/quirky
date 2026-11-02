import type { GitStatusEntry, ReviewFile, UiPluginContext } from '@quirky/protocol'
import { discardText, type DiscardText } from '../shared/discard-text'
import { messageOf, splitPath } from './format'

/**
 * How Revert file undoes one file. `discard` throws away its uncommitted changes (unstaging them
 * first when staged) and deletes a file that is new to the worktree. `base` rewrites a file whose
 * changes are all committed with its content at the merge base, which leaves an uncommitted edit.
 * A file with both committed and uncommitted changes only loses the uncommitted ones.
 */
export type RevertPlan =
  | { kind: 'discard'; text: DiscardText; unstage: string[]; paths: string[] }
  | { kind: 'base'; text: DiscardText; path: string }
  | { kind: 'blocked'; reason: string }

export type Revertable = Exclude<RevertPlan, { kind: 'blocked' }>

/** Plans Revert file for `file` given the status rows that describe its uncommitted changes. */
export function revertPlan(file: ReviewFile, entries: readonly GitStatusEntry[], base: string): RevertPlan {
  const rows = entries.filter((entry) => entry.path === file.path)
  if (file.conflict !== undefined || rows.some((entry) => entry.area === 'conflicts')) {
    return { kind: 'blocked', reason: 'Resolve the conflict before reverting this file' }
  }
  if (file.submodule !== undefined) return { kind: 'blocked', reason: 'Revert changes inside the submodule instead' }

  const { name } = splitPath(file.path)
  if (rows.length === 0) {
    if (file.uncommitted) return { kind: 'blocked', reason: 'Git status is still loading' }
    if (file.status === 'A' || file.status === 'R') {
      return { kind: 'blocked', reason: `A ${file.status === 'A' ? 'new' : 'renamed'} file committed on this branch can't be reverted here` }
    }
    return {
      kind: 'base',
      path: file.path,
      text: {
        title: `Revert "${name}"?`,
        body: `This replaces the file with its version on ${base}. The branch commits keep the change.`,
        confirm: 'Revert'
      }
    }
  }

  const staged = rows.find((entry) => entry.area === 'staged')
  const untracked = rows.some((entry) => entry.area === 'untracked')
  const unstage = staged === undefined ? [] : [file.path, ...(staged.oldPath === undefined ? [] : [staged.oldPath])]
  const paths = [file.path, ...(staged?.oldPath === undefined ? [] : [staged.oldPath])]
  const newToWorktree = untracked || (staged?.status === 'added' && !rows.some((entry) => entry.area === 'unstaged'))
  const text: DiscardText = newToWorktree
    ? discardText({ kind: 'file', path: file.path, area: 'untracked', status: 'untracked' })
    : file.status === 'D'
      ? discardText({ kind: 'file', path: file.path, area: 'unstaged', status: 'deleted' })
      : staged !== undefined
        ? { title: `Discard changes to "${name}"?`, body: 'This will unstage and revert the changes to this file. This cannot be undone.', confirm: 'Discard' }
        : discardText({ kind: 'file', path: file.path, area: 'unstaged', status: 'modified' })
  return { kind: 'discard', text, unstage, paths }
}

type BaseDiff = { original: string; modifiedHash?: string | null; modifiedDeleted?: boolean; kind?: string; binary?: boolean }

/** Carries out a plan from `revertPlan`; rejects with the daemon's message when a step fails. */
export async function applyRevert(context: UiPluginContext, worktree: string, plan: Revertable): Promise<void> {
  if (plan.kind === 'discard') {
    if (plan.unstage.length > 0) await context.call('quirky.git/unstage', { worktree, paths: plan.unstage })
    await context.call('quirky.git/discard', { worktree, paths: plan.paths, yes: true })
    return
  }
  const diff = (await context.call('quirky.git/diff', { worktree, path: plan.path, source: 'review', against: 'base' })) as BaseDiff
  if (diff.binary === true || (diff.kind !== undefined && diff.kind !== 'text')) {
    throw new Error(`${splitPath(plan.path).name} is not a text file, so its base version can't be restored here.`)
  }
  const expected = diff.modifiedDeleted === true || typeof diff.modifiedHash !== 'string' ? {} : { expected: diff.modifiedHash }
  await context.call('quirky.git/save', { worktree, path: plan.path, content: diff.original, ...expected })
}

/** What stopped a sequence of reverts: the file and the daemon's message. */
export type RevertFailure = { path: string; message: string }

/**
 * Reverts `items` one after another, in the order given, and stops at the first failure. Files
 * already reverted stay reverted; `done` counts them. The caller reports the failure.
 */
export async function revertInOrder(
  items: readonly { path: string; run(): Promise<void> }[]
): Promise<{ done: number; failure: RevertFailure | null }> {
  let done = 0
  for (const item of items) {
    try {
      await item.run()
    } catch (error) {
      return { done, failure: { path: item.path, message: messageOf(error) } }
    }
    done += 1
  }
  return { done, failure: null }
}
