import type { GitOperation } from '@quirky/protocol'

/** The remote or in-progress-operation calls whose failures the window toasts. */
export type RemoteAction = 'push' | 'force-push' | 'pull' | 'fast-forward' | 'fetch' | 'sync' | 'rebase' | 'continue' | 'abort'

/** The daemon's classification of a failed git call. */
export type RemoteErrorReason =
  | 'non-fast-forward'
  | 'stale-lease'
  | 'auth'
  | 'network'
  | 'no-upstream'
  | 'detached'
  | 'divergent-policy'
  | 'local-changes'
  | 'untracked-overwrite'
  | 'conflicts'
  | 'hook'
  | 'lint'
  | 'invalid-base'
  | 'busy'
  | 'failed'

/**
 * Toast text for `context.toast(title, body)`. Where Orca shows one sentence, the title is its
 * headline and the body the instruction; `${title}. ${body}` reproduces it (the body is empty
 * when the headline is the whole sentence).
 */
export type ToastCopy = { title: string; body: string }

const ACTION_NAMES: Readonly<Record<RemoteAction, string>> = {
  push: 'Push',
  'force-push': 'Force push',
  pull: 'Pull',
  'fast-forward': 'Fast-forward',
  fetch: 'Fetch',
  sync: 'Sync',
  rebase: 'Rebase',
  continue: 'Continue',
  abort: 'Abort'
}

const DETAIL_LIMIT = 200

const SOURCE_CONTROL = 'Resolve them in Source Control, then'

/**
 * The toast for a failed remote action, in Orca's renderer wording (the conflict pull text says
 * "continue the merge" because Quirky continues merges instead of asking for a commit).
 *
 * Returns null for the `hook` and `lint` reasons: the window shows a "blocked" card with the
 * hook output instead, and a toast on top would say the same thing twice. Reasons without
 * special wording fall back to "<Action> failed" with the daemon's `message` as the body;
 * fetch, fast-forward and rebase cap that message at 200 characters.
 *
 * `operation` only names the merge or rebase in the continue/abort titles ("Abort merge failed").
 */
export function toastFor(
  action: RemoteAction,
  reason: RemoteErrorReason,
  message: string,
  operation?: GitOperation
): ToastCopy | null {
  if (reason === 'hook' || reason === 'lint') return null
  switch (`${action}:${reason}`) {
    case 'push:non-fast-forward':
      return { title: 'Push rejected — remote has changes', body: 'Pull first, then try again.' }
    case 'force-push:stale-lease':
      return { title: 'Force push rejected — remote changed since last fetch', body: 'Fetch first, then try again.' }
    case 'sync:non-fast-forward':
    case 'sync:stale-lease':
      return { title: 'Sync failed — remote moved while syncing', body: 'Try again.' }
    case 'pull:conflicts':
    case 'sync:conflicts':
      return { title: 'Pull stopped with merge conflicts', body: `${SOURCE_CONTROL} continue the merge.` }
    case 'rebase:conflicts':
      return { title: 'Rebase stopped with conflicts', body: `${SOURCE_CONTROL} continue the rebase.` }
    case 'pull:local-changes':
    case 'sync:local-changes':
      return { title: 'Pull blocked — commit or stash your local changes first', body: '' }
  }
  const named = (action === 'abort' || action === 'continue') && (operation === 'merge' || operation === 'rebase' || operation === 'cherry-pick')
  const title = `${ACTION_NAMES[action]}${named ? ` ${operation}` : ''} failed`
  const capped = action === 'fetch' || action === 'fast-forward' || action === 'rebase'
  return { title, body: capped ? message.slice(0, DETAIL_LIMIT) : message }
}
