import { describe, expect, test } from 'bun:test'
import {
  toastFor,
  type RemoteAction,
  type RemoteErrorReason,
  type ToastCopy
} from '../../src/panel/remote-messages'

const sentence = (toast: ToastCopy | null): string | null => (toast === null ? null : [`${toast.title}.`, toast.body].filter(Boolean).join(' '))

describe('toastFor, Orca copy', () => {
  test('push rejected', () => {
    expect(sentence(toastFor('push', 'non-fast-forward', 'daemon text'))).toBe(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
  })

  test('force push rejected', () => {
    expect(sentence(toastFor('force-push', 'stale-lease', 'daemon text'))).toBe(
      'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    )
  })

  test('sync failed because the remote moved', () => {
    expect(sentence(toastFor('sync', 'non-fast-forward', 'x'))).toBe('Sync failed — remote moved while syncing. Try again.')
    expect(sentence(toastFor('sync', 'stale-lease', 'x'))).toBe('Sync failed — remote moved while syncing. Try again.')
  })

  test('pull and sync that stop on conflicts say to continue the merge', () => {
    const merge = 'Pull stopped with merge conflicts. Resolve them in Source Control, then continue the merge.'
    expect(sentence(toastFor('pull', 'conflicts', 'x'))).toBe(merge)
    expect(sentence(toastFor('sync', 'conflicts', 'x'))).toBe(merge)
  })

  test('rebase that stops on conflicts', () => {
    expect(sentence(toastFor('rebase', 'conflicts', 'x'))).toBe(
      'Rebase stopped with conflicts. Resolve them in Source Control, then continue the rebase.'
    )
  })

  test('pull blocked by local changes', () => {
    const blocked = 'Pull blocked — commit or stash your local changes first.'
    expect(sentence(toastFor('pull', 'local-changes', 'x'))).toBe(blocked)
    expect(sentence(toastFor('sync', 'local-changes', 'x'))).toBe(blocked)
  })

  test('fetch, fast-forward and rebase failures carry the detail', () => {
    expect(sentence(toastFor('fetch', 'network', 'Network error. Check your connection.'))).toBe(
      'Fetch failed. Network error. Check your connection.'
    )
    expect(sentence(toastFor('fast-forward', 'failed', 'not possible'))).toBe('Fast-forward failed. not possible')
    expect(sentence(toastFor('rebase', 'invalid-base', 'Rebase needs a remote base branch (like origin/main).'))).toBe(
      'Rebase failed. Rebase needs a remote base branch (like origin/main).'
    )
  })

  test('the detail is capped at 200 characters', () => {
    const long = 'x'.repeat(500)
    for (const action of ['fetch', 'fast-forward', 'rebase'] as const) {
      const toast = toastFor(action, 'failed', long)!
      expect(toast.body).toBe('x'.repeat(200))
    }
  })

  test('a short detail is not altered', () => {
    expect(toastFor('fetch', 'failed', 'x'.repeat(200))!.body).toHaveLength(200)
  })
})

describe('toastFor, fallbacks', () => {
  test('other reasons show the daemon message under the action', () => {
    expect(toastFor('push', 'auth', 'Authentication failed. Check your remote credentials.')).toEqual({
      title: 'Push failed',
      body: 'Authentication failed. Check your remote credentials.'
    })
    expect(toastFor('force-push', 'network', 'Network error. Check your connection.')).toEqual({
      title: 'Force push failed',
      body: 'Network error. Check your connection.'
    })
    expect(toastFor('pull', 'divergent-policy', 'Choose how to reconcile.')).toEqual({
      title: 'Pull failed',
      body: 'Choose how to reconcile.'
    })
    expect(toastFor('pull', 'untracked-overwrite', 'Pull would overwrite untracked files.')).toEqual({
      title: 'Pull failed',
      body: 'Pull would overwrite untracked files.'
    })
    expect(toastFor('sync', 'no-upstream', 'Branch has no upstream. Publish the branch first.')!.title).toBe('Sync failed')
    expect(toastFor('push', 'detached', 'Check out a branch first.')).toEqual({
      title: 'Push failed',
      body: 'Check out a branch first.'
    })
  })

  test('busy shows the message as is under the action', () => {
    expect(toastFor('fetch', 'busy', 'A push is already running in this worktree.')).toEqual({
      title: 'Fetch failed',
      body: 'A push is already running in this worktree.'
    })
  })

  test('continue and abort name the operation when given', () => {
    expect(toastFor('abort', 'failed', 'boom', 'merge')).toEqual({ title: 'Abort merge failed', body: 'boom' })
    expect(toastFor('abort', 'failed', 'boom', 'rebase')!.title).toBe('Abort rebase failed')
    expect(toastFor('continue', 'failed', 'boom', 'merge')!.title).toBe('Continue merge failed')
    expect(toastFor('abort', 'failed', 'boom')!.title).toBe('Abort failed')
  })

  test('hook and lint failures produce no toast, the window shows a card', () => {
    for (const action of ['push', 'force-push', 'sync'] as RemoteAction[]) {
      expect(toastFor(action, 'hook', 'x')).toBeNull()
      expect(toastFor(action, 'lint', 'x')).toBeNull()
    }
  })

  test('every action and reason yields a toast or an explicit null', () => {
    const actions: RemoteAction[] = ['push', 'force-push', 'pull', 'fast-forward', 'fetch', 'sync', 'rebase', 'continue', 'abort']
    const reasons: RemoteErrorReason[] = [
      'non-fast-forward', 'stale-lease', 'auth', 'network', 'no-upstream', 'detached', 'divergent-policy',
      'local-changes', 'untracked-overwrite', 'conflicts', 'hook', 'lint', 'invalid-base', 'busy', 'failed'
    ]
    for (const a of actions) {
      for (const r of reasons) {
        const t = toastFor(a, r, 'msg')
        if (r === 'hook' || r === 'lint') expect(t).toBeNull()
        else {
          expect(t!.title).not.toBe('')
          expect(typeof t!.body).toBe('string')
        }
      }
    }
  })
})
