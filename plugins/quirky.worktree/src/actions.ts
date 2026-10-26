import type { UiPluginContext, Worktree } from '@quirky/protocol'

export const SESSION_VIEW = 'view:quirky.session/worktree'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `RpcErrorCode.Conflict`, inlined so the module doesn't bundle the protocol's runtime; matched by code because `instanceof` can't see the window's `RpcError`. */
const CONFLICT = -32009

function isConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === CONFLICT
}

/** Adds the repository at `path`; true on success, else a toast says why. */
export async function addRepo(context: UiPluginContext, path: string): Promise<boolean> {
  try {
    await context.call('quirky.repo/add', { path })
    return true
  } catch (error) {
    context.toast('Could not add repo', messageOf(error))
    return false
  }
}

/** Creates a worktree and opens it; true on success, else a toast says why. */
export async function createWorktree(
  context: UiPluginContext,
  repoId: string,
  name: string,
  baseRef: string
): Promise<boolean> {
  try {
    const worktree = (await context.call('quirky.worktree/create', {
      repo: repoId,
      name,
      baseRef: baseRef || undefined
    })) as Worktree
    context.openView(SESSION_VIEW, { worktree: worktree.id })
    return true
  } catch (error) {
    context.toast('Could not create worktree', messageOf(error))
    return false
  }
}

/**
 * Removes a worktree after the window's own confirm dialog, passing `yes` so the kernel asks
 * nothing more. A Conflict (uncommitted changes) is offered again as a forced removal.
 */
export async function removeWorktree(context: UiPluginContext, worktree: Worktree): Promise<void> {
  const ok = await context.confirm({
    title: 'Remove worktree',
    body: `Remove worktree "${worktree.name}" and close its sessions? The directory ${worktree.path} will be deleted.`,
    confirmLabel: 'Remove'
  })
  if (!ok) return
  try {
    await context.call('quirky.worktree/remove', { worktree: worktree.id, yes: true })
    return
  } catch (error) {
    if (!isConflict(error)) {
      context.toast('Could not remove worktree', messageOf(error))
      return
    }
    const force = await context.confirm({
      title: 'Force remove',
      body: `${messageOf(error)}\n\nRemove it anyway?`,
      confirmLabel: 'Force remove'
    })
    if (!force) return
  }
  try {
    await context.call('quirky.worktree/remove', { worktree: worktree.id, yes: true, force: true })
  } catch (error) {
    context.toast('Could not remove worktree', messageOf(error))
  }
}
