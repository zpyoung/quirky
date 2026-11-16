import { useEffect } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { requestGitUiControl, useGitUiControl, type GitUiControl } from '../ui-control'
import { messageOf } from './data'

export const DIFF_SURFACE = 'view:quirky.git/diff'
let generationSequence = 0
const mounts = new WeakMap<UiPluginContext, { count: number }>()

/** Gives each view scope and dialog session a fresh control address. */
export function viewControlGeneration(): string {
  generationSequence += 1
  return `view-${generationSequence}`
}

/** Addresses a mode within its worktree and optional hosted tab without parsing paths. */
export function viewTarget(
  kind: 'review' | 'conflicts' | 'conflict-file' | 'close-dialog',
  input: { worktree: string; tabId?: string; path?: string }
): string {
  return `${kind}:${input.worktree}${input.tabId === undefined ? '' : `:${input.tabId}`}${kind === 'conflict-file' ? `:${input.path}` : ''}`
}

/** Publishes committed controls using the latest handler and mount-scoped cleanup. */
export function useViewControl(
  context: UiPluginContext,
  address: { target: string; generation: string; actions: string[] } | null,
  handler: (control: GitUiControl) => boolean
): void {
  useEffect(() => {
    const mount = mounts.get(context) ?? { count: 0 }
    mounts.set(context, mount)
    mount.count += 1
    return () => {
      mount.count -= 1
      if (mount.count === 0) mounts.delete(context)
    }
  }, [context])
  useGitUiControl(context, address === null ? null : { surface: DIFF_SURFACE, ...address }, handler)
}

/** Delivers one exact-window action without fallback or a late toast after unmount. */
export async function requestViewControl(
  context: UiPluginContext,
  control: { target: string; generation: string; action: string; data?: Record<string, unknown> }
): Promise<boolean> {
  const mount = mounts.get(context)
  try {
    const result = await requestGitUiControl(context, { surface: DIFF_SURFACE, ...control })
    if (!result.delivered) throw new Error('The source control action is no longer available.')
    return true
  } catch (error) {
    if (mount === undefined || mount.count > 0) {
      context.toast('Could not run Source Control action', messageOf(error), { kind: 'error' })
    }
    return false
  }
}
