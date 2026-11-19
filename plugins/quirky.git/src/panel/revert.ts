import type { GitStatusEntry, ReviewFile, UiPluginContext } from '@quirky/protocol'
import { discardText, type DiscardText } from '../shared/discard-text'
import { reviewViewFor } from '../review/open'
import { messageOf, splitPath } from './format'

/**
 * How Revert file undoes one file. `discard` throws away its uncommitted changes (unstaging them
 * first when staged) and deletes a file that is new to the worktree. `base` rewrites a file whose
 * changes are all committed with its content at the merge base, which leaves an uncommitted edit.
 * A file with both committed and uncommitted changes only loses the uncommitted ones. `remove`
 * deletes a file the branch commits added; `rename` deletes the renamed file and restores the old
 * path from the merge base. Both leave the branch commits alone.
 */
export type RevertPlan =
  | { kind: 'discard'; text: DiscardText; unstage: string[]; paths: string[] }
  | { kind: 'base'; text: DiscardText; path: string }
  | { kind: 'remove'; text: DiscardText; path: string }
  | { kind: 'rename'; text: DiscardText; path: string; oldPath: string }
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
    if (file.status === 'A') {
      return {
        kind: 'remove',
        path: file.path,
        text: {
          title: `Delete "${name}"?`,
          body: `This file was added on this branch, so reverting it moves it to the Trash. The branch commits keep it.`,
          confirm: 'Delete'
        }
      }
    }
    if (file.status === 'R') {
      if (file.oldPath === undefined) return { kind: 'blocked', reason: "The original name of this renamed file isn't known" }
      return {
        kind: 'rename',
        path: file.path,
        oldPath: file.oldPath,
        text: {
          title: `Revert the rename of "${name}"?`,
          body: `This moves "${file.path}" to the Trash and restores "${file.oldPath}" from ${base}. The branch commits keep the rename.`,
          confirm: 'Revert'
        }
      }
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

type BaseDiff = { original: string; modifiedHash?: string | null; modifiedDeleted?: boolean; kind?: string; binary?: boolean; tooLarge?: unknown }

function hashOfDiff(diff: BaseDiff, path: string): string | null {
  if (diff.modifiedDeleted === true || diff.modifiedHash === null) return null
  if (typeof diff.modifiedHash === 'string') return diff.modifiedHash
  throw new Error(`${splitPath(path).name} can't be checked against the version you saw, so it was left alone.`)
}

/**
 * The disk-side hash of `path` that a guarded write should expect: the one the open Review card
 * shows when it has loaded one, else the one in a fresh review diff against the base (`null` for a
 * file that is deleted on disk). Rejects when no hash can be determined, so a write is never sent
 * unguarded.
 */
export async function shownHash(context: UiPluginContext, worktree: string, path: string, diff?: BaseDiff): Promise<string | null> {
  const loaded = reviewViewFor(worktree)?.loadedHash?.(path)
  if (loaded !== undefined) return loaded
  const read = diff ?? ((await context.call('quirky.git/diff', { worktree, path, source: 'review', against: 'base' })) as BaseDiff)
  return hashOfDiff(read, path)
}

function assertText(diff: BaseDiff, path: string): void {
  if (diff.binary === true || (diff.kind !== undefined && diff.kind !== 'text')) {
    throw new Error(`${splitPath(path).name} is not a text file, so its base version can't be restored here.`)
  }
  if (diff.tooLarge !== undefined) {
    throw new Error(`${splitPath(path).name} is too large to restore its base version here, so it was left alone.`)
  }
}

async function holdsBase(context: UiPluginContext, worktree: string, path: string, base: string): Promise<boolean> {
  try {
    const current = (await context.call('quirky.git/diff', { worktree, path, source: 'review', against: 'base' })) as BaseDiff & { modified?: string }
    return current.modifiedDeleted !== true && current.kind === 'text' && current.tooLarge === undefined && current.modified === base
  } catch {
    return false
  }
}

/** Carries out a plan from `revertPlan`; rejects with the daemon's message when a step fails. */
export async function applyRevert(context: UiPluginContext, worktree: string, plan: Revertable): Promise<void> {
  if (plan.kind === 'discard') {
    if (plan.unstage.length > 0) await context.call('quirky.git/unstage', { worktree, paths: plan.unstage })
    await context.call('quirky.git/discard', { worktree, paths: plan.paths, yes: true })
    return
  }
  if (plan.kind === 'remove') {
    await context.call('quirky.editor/mutate', { worktree, action: 'delete', path: plan.path, yes: true })
    return
  }
  if (plan.kind === 'rename') {
    const diff = (await context.call('quirky.git/diff', {
      worktree,
      path: plan.path,
      oldPath: plan.oldPath,
      source: 'review',
      against: 'base'
    })) as BaseDiff
    assertText(diff, plan.oldPath)
    // restore first so a failure leaves the new path in place; a retry after a failed delete finds the old path already restored
    try {
      await context.call('quirky.git/save', { worktree, path: plan.oldPath, content: diff.original, expected: null })
    } catch (error) {
      if (!(await holdsBase(context, worktree, plan.oldPath, diff.original))) throw error
    }
    await context.call('quirky.editor/mutate', { worktree, action: 'delete', path: plan.path, yes: true })
    return
  }
  const diff = (await context.call('quirky.git/diff', { worktree, path: plan.path, source: 'review', against: 'base' })) as BaseDiff
  assertText(diff, plan.path)
  const expected = await shownHash(context, worktree, plan.path, diff)
  await context.call('quirky.git/save', { worktree, path: plan.path, content: diff.original, expected })
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
