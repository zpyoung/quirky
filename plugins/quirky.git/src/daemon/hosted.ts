import type { Handler } from './env'
import { DIFF_VIEW_ID, diffViewKey, type DiffViewInput } from '../shared/view-input'
import { isRecord } from './validation'

/** Refuses terminal tab removal while this hosted diff contains an unsaved modified-side draft. */
export function diffCloseGuard(): Handler {
  return async (params) => {
    if (params.closeViewId !== DIFF_VIEW_ID || typeof params.worktree !== 'string' ||
      typeof params.tabId !== 'string' || typeof params.closeViewKey !== 'string' || params.dirty !== false) return false
    if (!isRecord(params.closeViewInput)) return false
    const input = params.closeViewInput as unknown as DiffViewInput
    return input.worktree === params.worktree && input.tabId === params.tabId && diffViewKey(input) === params.closeViewKey
  }
}
