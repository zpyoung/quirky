import type { GitStatus, UiPluginContext } from '@quirky/protocol'
import type { DiffViewInput } from '../shared/view-input'
import { activateHostedDiff, findHostedDiff, openHostedDiff } from '../view/hosted-tabs'
import {
  clearDeferredReview,
  deferReview,
  reviewViewFor,
  type DeferredReview,
  type ReviewScope,
  type ReviewViewHandle,
  type ScopeOutcome
} from '../view/registry'

export type ReviewSource = 'staged' | 'unstaged'
export type ReviewRequest = {
  worktree: string
  reveal?: string
  commit?: string | null
  noteId?: string
  source?: ReviewSource
  focus?: boolean
  acknowledge?: boolean
}
export type ReviewOpenResult = {
  worktree: string
  tabId: string
  created: boolean
  focused: boolean
  source: ReviewSource | null
  reveal: string | null
  statusComplete: boolean | null
}

export { registerReviewView, reviewViewFor, type ReviewViewHandle } from '../view/registry'


async function currentWindowId(context: UiPluginContext): Promise<number> {
  const value = await context.call('ui.window.self', {})
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'connId' in value) {
    const connId = value.connId
    if (typeof connId === 'number' && Number.isSafeInteger(connId) && connId > 0) return connId
  }
  throw new Error('ui.window.self returned an invalid connection identity.')
}

async function statusCompleteness(context: UiPluginContext, worktree: string): Promise<boolean> {
  const status = await context.call('quirky.git/status', { worktree }) as GitStatus
  return !status.capped
}

function scopeFor(commit: string | null | undefined, source: ReviewSource | null): ReviewScope {
  if (commit) return { commit }
  return source === null ? null : { source }
}

function reviewResult(
  input: { worktree: string; source: ReviewSource | null; reveal?: string },
  values: { tabId: string; created: boolean; focused: boolean; statusComplete: boolean | null }
): ReviewOpenResult {
  return {
    worktree: input.worktree,
    tabId: values.tabId,
    created: values.created,
    focused: values.focused,
    source: input.source,
    reveal: input.reveal ?? null,
    statusComplete: values.statusComplete
  }
}

function revealReview(handle: ReviewViewHandle, path?: string, noteId?: string): void {
  if (path !== undefined) handle.reveal(path, noteId)
  else handle.scrollToTop()
}

function deferredRequest(input: {
  reveal?: string
  noteId?: string
  commit?: string | null
  source: ReviewSource | null
}): DeferredReview {
  return {
    ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
    ...(input.noteId === undefined ? {} : { noteId: input.noteId }),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.source === null ? {} : { source: input.source })
  }
}

async function navigateToReview(context: UiPluginContext, worktree: string, window: number): Promise<void> {
  await context.call('quirky.worktree/navigate', {
    worktree: `id:${worktree}`,
    target: 'terminal',
    window
  })
}

function scopeFailure(outcome: ScopeOutcome): Error | null {
  if (outcome === 'dirty') return new Error('The Review has unsaved edits; save or discard them before showing another scope.')
  if (outcome === 'busy') return new Error('The Review is already asking about unsaved edits.')
  if (outcome === 'cancelled') return new Error("The unsaved edits were kept, so the Review's scope did not change.")
  return null
}

/**
 * Shows the worktree's one Review tab. Background requests are deferred without changing an
 * existing tab; acknowledged focused requests apply scope, activate, navigate and then reveal.
 */
export async function openReview(context: UiPluginContext, input: ReviewRequest): Promise<ReviewOpenResult> {
  const { worktree, reveal: path, commit, noteId } = input
  const focus = input.focus ?? true
  const acknowledge = input.acknowledge === true
  const source = commit ? null : input.source ?? null
  const request: DiffViewInput = {
    worktree,
    mode: 'review',
    ...(path === undefined ? {} : { reveal: path }),
    ...(commit ? { commit } : {}),
    ...(source === null ? {} : { source }),
    ...(noteId === undefined ? {} : { noteId })
  }
  const window = acknowledge && focus ? await currentWindowId(context) : null
  if (focus) clearDeferredReview(worktree)
  const statusComplete = source === null ? null : await statusCompleteness(context, worktree)
  const existingTabId = await findHostedDiff(context, request)
  const created = existingTabId === null
  const handle = reviewViewFor(worktree)

  if (!focus) {
    if (existingTabId === null) {
      clearDeferredReview(worktree)
      const opened = await openHostedDiff(context, request, { activate: false, showWorktree: false })
      if (opened.tabId === undefined) throw new Error('Terminal did not return the diff tab identity.')
      return reviewResult({ worktree, source, reveal: path }, {
        tabId: opened.tabId,
        created,
        focused: false,
        statusComplete
      })
    }
    deferReview(worktree, deferredRequest({ reveal: path, noteId, commit, source }))
    return reviewResult({ worktree, source, reveal: path }, {
      tabId: existingTabId,
      created: false,
      focused: false,
      statusComplete
    })
  }

  if (acknowledge) {
    if (handle?.applyScope && existingTabId !== null) {
      const outcome = await handle.applyScope(scopeFor(commit, source), 'refuse')
      const error = scopeFailure(outcome)
      if (error) throw error
      const tabId = await activateHostedDiff(context, request)
      if (tabId === null) throw new Error('The Review tab is no longer available.')
      await navigateToReview(context, worktree, window!)
      revealReview(handle, path, noteId)
      return reviewResult({ worktree, source, reveal: path }, {
        tabId,
        created: false,
        focused: true,
        statusComplete
      })
    }

    const opened = await openHostedDiff(context, request, { activate: true, showWorktree: false })
    if (opened.tabId === undefined) throw new Error('Terminal did not return the diff tab identity.')
    await navigateToReview(context, worktree, window!)
    return reviewResult({ worktree, source, reveal: path }, {
      tabId: opened.tabId,
      created,
      focused: true,
      statusComplete
    })
  }

  if (handle && existingTabId !== null) {
    const tabId = await activateHostedDiff(context, request)
    if (tabId !== null) {
      handle.setScope(commit ?? null)
      revealReview(handle, path, noteId)
      return reviewResult({ worktree, source, reveal: path }, {
        tabId,
        created: false,
        focused: true,
        statusComplete
      })
    }
  }

  const opened = await openHostedDiff(context, request)
  if (opened.tabId === undefined) throw new Error('Terminal did not return the diff tab identity.')
  return reviewResult({ worktree, source, reveal: path }, {
    tabId: opened.tabId,
    created,
    focused: true,
    statusComplete
  })
}
