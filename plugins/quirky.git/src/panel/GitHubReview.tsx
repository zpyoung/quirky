import { useEffect, useRef, useState } from 'react'
import { RpcErrorCode, type GitStatus, type UiPluginContext } from '@quirky/protocol'
import { Badge, Button } from '@quirky/ui'
import type { FixAction } from '../ai/types'

export type GitHubReviewTarget = { worktree: string; branch: string; head: string }
type ReviewSummary = { number: number; url: string; state: 'open' | 'draft' | 'closed' | 'merged' }
export type GitHubReviewResult =
  | { kind: 'unsupported'; target: GitHubReviewTarget }
  | { kind: 'unavailable'; target: GitHubReviewTarget; message: string }
  | { kind: 'no-review'; target: GitHubReviewTarget }
  | { kind: 'found'; target: GitHubReviewTarget; review: ReviewSummary }
export type GitHubReviewLookup = { kind: 'waiting' } | { kind: 'loading'; target: GitHubReviewTarget } | GitHubReviewResult

type StoredLookup = { key: string; value: GitHubReviewResult }

function targetKey(target: GitHubReviewTarget): string {
  return `${target.worktree}\0${target.branch}\0${target.head}`
}


function errorReason(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  if ('data' in error && typeof error.data === 'object' && error.data !== null && !Array.isArray(error.data) &&
    'reason' in error.data && typeof error.data.reason === 'string') return error.data.reason
  return 'reason' in error && typeof error.reason === 'string' ? error.reason : null
}

function errorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  return 'code' in error && typeof error.code === 'number' ? error.code : null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'object' && error !== null && !Array.isArray(error) &&
    'message' in error && typeof error.message === 'string' ? error.message : 'The GitHub pull-request lookup failed.'
}

function parseLookup(value: unknown, target: GitHubReviewTarget): GitHubReviewResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('kind' in value) || typeof value.kind !== 'string') {
    return { kind: 'unavailable', target, message: 'GitHub returned an invalid pull-request lookup.' }
  }
  if (value.kind === 'no-review') return { kind: 'no-review', target }
  if (value.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      target,
      message: 'message' in value && typeof value.message === 'string' && value.message !== ''
        ? value.message
        : 'The lookup could not be completed.'
    }
  }
  const review = 'review' in value ? value.review : null
  if (value.kind !== 'found' || typeof review !== 'object' || review === null || Array.isArray(review) ||
    !('number' in review) || !Number.isSafeInteger(review.number) || (review.number as number) < 1 ||
    !('url' in review) || typeof review.url !== 'string' || !('state' in review) ||
    !['open', 'draft', 'closed', 'merged'].includes(String(review.state))) {
    return { kind: 'unavailable', target, message: 'GitHub returned an invalid pull-request identity.' }
  }
  let url: URL
  try {
    url = new URL(review.url)
  } catch {
    return { kind: 'unavailable', target, message: 'GitHub returned an invalid pull-request link.' }
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    return { kind: 'unavailable', target, message: 'GitHub returned an unsafe pull-request link.' }
  }
  return {
    kind: 'found',
    target,
    review: {
      number: review.number as number,
      url: url.href,
      state: review.state as ReviewSummary['state']
    }
  }
}
function cachedLookup(value: unknown, target: GitHubReviewTarget): GitHubReviewResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    !('workspaces' in value) || !Array.isArray(value.workspaces)) return null
  let workspace: unknown
  for (const candidate of value.workspaces) {
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) &&
      'worktreeId' in candidate && candidate.worktreeId === target.worktree) {
      workspace = candidate
      break
    }
  }
  if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace) ||
    !('branch' in workspace) || workspace.branch !== target.branch ||
    !('headOid' in workspace) || workspace.headOid !== target.head ||
    !('stale' in workspace) || workspace.stale !== false) return null
  if ('error' in workspace && typeof workspace.error === 'string' && workspace.error !== '') {
    return { kind: 'unavailable', target, message: workspace.error }
  }
  if (!('review' in workspace)) return null
  if (workspace.review === null) return { kind: 'no-review', target }
  return parseLookup({ kind: 'found', review: workspace.review }, target)
}

/** Read the canonical GitHub lookup for this exact registered worktree branch and HEAD. */
export async function readGitHubReview(context: UiPluginContext, target: GitHubReviewTarget): Promise<GitHubReviewResult> {
  try {
    const result = await context.call('quirky.hosting/forBranch', {
      worktree: target.worktree,
      branch: target.branch,
      headOid: target.head
    })
    return parseLookup(result, target)
  } catch (error) {
    if (errorCode(error) === RpcErrorCode.MethodNotFound || errorReason(error) === 'unsupported_provider')
      return { kind: 'unsupported', target }
    return { kind: 'unavailable', target, message: errorMessage(error) }
  }
}

/** Lookup state is keyed by registered worktree, branch and HEAD; responses for prior keys are discarded. */
export function useGitHubReview(context: UiPluginContext, worktree: string, status: GitStatus | null): GitHubReviewLookup {
  const branch = status?.branch ?? null
  const head = status?.head ?? null
  const key = branch !== null && branch !== '' && head !== null && head !== ''
    ? targetKey({ worktree, branch, head })
    : null
  const currentKey = useRef(key)
  currentKey.current = key
  const requestSequence = useRef(0)
  const [stored, setStored] = useState<StoredLookup | null>(null)

  useEffect(() => {
    const sequence = ++requestSequence.current
    if (branch === null || branch === '' || head === null || head === '') {
      setStored(null)
      return
    }
    let active = true
    const requested = { worktree, branch, head }
    const isCurrent = (request: number, target: GitHubReviewTarget) =>
      active && requestSequence.current === request && currentKey.current === targetKey(target)
    const store = (request: number, value: GitHubReviewResult, target: GitHubReviewTarget) => {
      if (isCurrent(request, target)) setStored({ key: targetKey(target), value })
    }
    const readStatus = async (): Promise<GitHubReviewTarget | null> => {
      const fresh = await context.call('quirky.git/status', { worktree })
      if (typeof fresh !== 'object' || fresh === null || Array.isArray(fresh) ||
        !('branch' in fresh) || typeof fresh.branch !== 'string' || fresh.branch === '' ||
        !('head' in fresh) || typeof fresh.head !== 'string' || fresh.head === '') return null
      const target = { worktree, branch: fresh.branch, head: fresh.head }
      return currentKey.current === targetKey(target) ? target : null
    }
    const refreshFromCanonicalCache = async (request: number, target: GitHubReviewTarget) => {
      if (!isCurrent(request, target)) return
      try {
        const cached = await context.call('quirky.hosting/cachedReviews', { worktrees: [worktree] })
        if (!isCurrent(request, target)) return
        const value = cachedLookup(cached, target)
        if (value !== null) {
          store(request, value, target)
          return
        }
      } catch {
        // Fall through to the public live lookup if the cache-only read is unavailable.
      }
      if (isCurrent(request, target)) store(request, await readGitHubReview(context, target), target)
    }
    const unsubscribe = context.subscribe((event) => {
      if (!active || event.type !== 'quirky.hosting/reviewCacheChanged' ||
        typeof event.data !== 'object' || event.data === null || Array.isArray(event.data) ||
        !('worktreeId' in event.data) || event.data.worktreeId !== worktree ||
        currentKey.current !== targetKey(requested)) return
      const request = ++requestSequence.current
      setStored(null)
      void readStatus().then((target) => {
        if (target && isCurrent(request, target)) return refreshFromCanonicalCache(request, target)
        return undefined
      }).catch((error: unknown) => {
        store(request, { kind: 'unavailable', target: requested, message: errorMessage(error) }, requested)
      })
    })
    const read = async () => {
      try {
        const target = await readStatus()
        if (target && isCurrent(sequence, target)) {
          store(sequence, await readGitHubReview(context, target), target)
        }
      } catch (error) {
        store(sequence, { kind: 'unavailable', target: requested, message: errorMessage(error) }, requested)
      }
    }
    void read()
    return () => {
      active = false
      unsubscribe()
    }
  }, [context, worktree, branch, head])

  if (key === null || branch === null || head === null) return { kind: 'waiting' }
  if (stored?.key !== key) return { kind: 'loading', target: { worktree, branch, head } }
  return stored.value
}

type HostingAiAction = Extract<FixAction, 'branchSummary' | 'pullRequestDetails' | 'pullRequestReview' | 'reviewConversation'>
type HostingAiFlow = { action: HostingAiAction; label: string }

const BRANCH_FLOW: HostingAiFlow = { action: 'branchSummary', label: 'Summarize branch with AI' }
const PR_FLOWS: readonly HostingAiFlow[] = [
  { action: 'pullRequestDetails', label: 'Read pull request details with AI' },
  { action: 'pullRequestReview', label: 'Review pull request with AI' },
  { action: 'reviewConversation', label: 'Draft conversation reply with AI' }
]

type GitHubReviewStatusProps = {
  context: UiPluginContext
  lookup: GitHubReviewLookup
  aiEnabled?: boolean
  busy?: boolean
  onLaunch?(action: HostingAiAction): void
}

/** Current branch review link and status; AI actions launch against this exact branch/PR source. */
export function GitHubReviewStatus({ context, lookup, aiEnabled = false, busy = false, onLaunch }: GitHubReviewStatusProps) {
  if (lookup.kind === 'waiting') return null
  const actions = (pullRequest: boolean) => {
    if (!aiEnabled || !onLaunch) return null
    const flows = pullRequest ? [BRANCH_FLOW, ...PR_FLOWS] : [BRANCH_FLOW]
    return (
      <div className="ui-cluster">
        {flows.map(({ action, label }) => (
          <Button key={action} disabled={busy} onClick={() => onLaunch(action)}>
            {label}
          </Button>
        ))}
      </div>
    )
  }
  if (lookup.kind === 'unsupported') return actions(false)
  if (lookup.kind === 'loading') {
    return (
      <div className="ui-stack">
        <p role="status" style={{ margin: 0 }}>
          <Badge tone="neutral">
            <span data-scm-review-status data-state="loading">Checking for a pull request…</span>
          </Badge>
        </p>
        {actions(false)}
      </div>
    )
  }
  if (lookup.kind === 'unavailable') {
    return (
      <div className="ui-stack">
        <p role="status" data-scm-review-status data-state="unavailable" className="ui-text-muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
          GitHub pull-request lookup unavailable: {lookup.message}
        </p>
        {actions(false)}
      </div>
    )
  }
  if (lookup.kind === 'no-review') {
    return (
      <div className="ui-stack">
        <p role="status" data-scm-review-status data-state="no-review" className="ui-text-muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
          No pull request is linked to this branch.
        </p>
        {actions(false)}
      </div>
    )
  }

  const label = lookup.review.state === 'open' ? 'Open'
    : lookup.review.state === 'draft' ? 'Draft'
      : lookup.review.state === 'closed' ? 'Closed' : 'Merged'
  const tone = lookup.review.state === 'merged' ? 'accent'
    : lookup.review.state === 'draft' ? 'needs-you'
      : lookup.review.state === 'closed' ? 'neutral' : 'working'
  const openReview = async () => {
    try {
      await context.call('quirky.reviews/openLink', { url: lookup.review.url })
    } catch (error) {
      context.toast('Could not open pull request', errorMessage(error))
    }
  }
  return (
    <div className="ui-stack">
      <p className="ui-cluster" role="status" style={{ margin: 0 }}>
        <Badge tone={tone}>
          <span data-scm-review-status data-state="found">Pull request #{lookup.review.number} · {label}</span>
        </Badge>
      </p>
      <div className="ui-cluster">
        <Button aria-label={`Open pull request #${lookup.review.number}`} onClick={() => void openReview()}>
          Open PR #{lookup.review.number}
        </Button>
        {actions(true)}
      </div>
    </div>
  )
}
