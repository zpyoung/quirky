import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Menu, SectionHeader, StatusDot } from '@quirky/ui'
import type { ReviewsSurfaceProps, ReviewData } from '../contracts'
import { directMergeAllowed, queueMergeAllowed, reviewMethods } from './methods'
import { isRecord, parseReviewStackResult, reviewContext, safeHttpUrl, sameRepo, workspaceLinkFor, type ReviewContext, type ReviewStackEntry, type ReviewStackResult, type WorkspaceLink } from './data'
export type ReviewActionsProps = ReviewsSurfaceProps & { surface: 'detail' | 'checks' }

type MergeMethod = 'squash' | 'merge' | 'rebase'
type MergeAction = 'direct' | 'queue'

type WorkspaceRemoval = { status: 'loading' | 'ready' | 'error'; link: WorkspaceLink | null; error: string | null }
type WorkspaceRemovalTarget = {
  surface: ReviewContext['surface']
  worktree: string
  number: number
  repo: ReviewContext['repo']
  head: string
  url: string
  link: WorkspaceLink
}

const methodLabels: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create merge commit',
  rebase: 'Rebase and merge',
}

function hasAutoMerge(review: ReviewData): boolean {
  return review.autoMergeRequest !== null && review.autoMergeRequest !== undefined && review.autoMergeRequest !== false
}

function mergeStateLabel(review: ReviewData): string {
  if (review.state === 'merged') return 'Merged'
  if (review.state === 'closed') return 'Closed'
  if (review.state === 'draft') return 'Draft'
  if (review.reviewDecision === 'REVIEW_REQUIRED') return 'Approval required'
  if (review.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested'
  if (review.mergeQueueRequired === true) return hasAutoMerge(review) ? 'Auto-merge on' : 'Merge when ready'
  if (review.mergeMetadataKnown === false) return 'Checking merge metadata'
  if (review.mergeable === 'CONFLICTING' || review.mergeStateStatus === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY') return 'Conflicts'
  if (review.mergeStateStatus === 'BEHIND') return 'Behind'
  if (review.mergeStateStatus === 'BLOCKED') return 'Blocked'
  if (review.mergeable === 'MERGEABLE' || review.mergeStateStatus === 'CLEAN') {
    if (review.checksStatus === 'failure') return 'Checks failed'
    if (review.checksStatus === 'pending') return 'Checks pending'
    return 'Able to merge'
  }
  if (review.checksStatus === 'success') return 'Checks passed'
  return 'Checking'
}

function stackRecord(details: unknown, review: ReviewData): ReviewStackResult | null {
  const raw = isRecord(details) && details.reviewStack !== undefined ? details.reviewStack : review.stackDetails
  return raw === undefined ? null : parseReviewStackResult(raw, review.number)
}

function stackEntries(stack: ReviewStackResult | null, review: ReviewData): ReviewStackEntry[] {
  if (stack?.available !== true || stack.truncated || stack.stack === null) return []
  const included = stack.stack.entries.filter((entry) => entry.position <= stack.stack!.position).sort((left, right) => left.position - right.position)
  if (included.length !== stack.stack.position || !included.some((entry) => entry.number === review.number)) return []
  return included
}

function stackIsComplete(review: ReviewData, stack: ReviewStackResult | null): boolean {
  if (review.stack === null || review.stack === undefined) return true
  return stackEntries(stack, review).length > 0
}

function statusLine(review: ReviewData): string {
  const decision = review.reviewDecision
  const reason = typeof review.mergeStateStatus === 'string' ? review.mergeStateStatus.replaceAll('_', ' ').toLowerCase() : ''
  if (decision === 'REVIEW_REQUIRED') return 'An approving review is required before merging.'
  if (decision === 'CHANGES_REQUESTED') return 'A reviewer requested changes before merging.'
  if (review.mergeable === 'CONFLICTING' || review.mergeStateStatus === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY') return 'Conflicts block this pull request.'
  if (review.mergeStateStatus === 'BEHIND') return 'The pull request branch is behind its base branch.'
  if (review.mergeStateStatus === 'BLOCKED') return 'The provider reports that merging is blocked.'
  if (review.mergeMetadataKnown === false) return 'Merge metadata is unavailable; no merge method is assumed.'
  if (reason !== '' && review.mergeStateStatus !== 'CLEAN') return `Provider merge state: ${reason}.`
  return 'Merge availability follows the current provider state.'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameWorkspaceRemovalTarget(left: WorkspaceRemovalTarget, right: WorkspaceRemovalTarget | null): boolean {
  return right !== null
    && left.surface === right.surface
    && left.worktree === right.worktree
    && left.number === right.number
    && sameRepo(left.repo, right.repo)
    && left.head.toLowerCase() === right.head.toLowerCase()
    && left.url === right.url
    && left.link.worktree === right.link.worktree
    && left.link.name === right.link.name
    && left.link.url === right.link.url
    && left.link.repoId === right.link.repoId
}


export function ReviewActions(props: ReviewActionsProps) {
  const owner = reviewContext(props.state, props.surface)
  const review = owner?.review ?? null
  const safeUrl = review === null ? null : safeHttpUrl(review.url)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaceRemoval, setWorkspaceRemoval] = useState<WorkspaceRemoval>({ status: 'loading', link: null, error: null })
  const [workspaceRemoveBusy, setWorkspaceRemoveBusy] = useState(false)
  const workspaceRequest = useRef(0)
  const workspaceRemovalTarget = useRef<WorkspaceRemovalTarget | null>(null)
  const workspaceBusyRef = useRef(false)
  const busyRef = useRef(false)
  const stack = useMemo(() => review === null ? null : stackRecord(props.surface === 'detail' ? props.state.detail.details : props.state.checks.conflicts, review),
    [review, props.surface, props.state.detail.details, props.state.checks.conflicts])
  const included = useMemo(() => review === null ? [] : stackEntries(stack, review), [review, stack])
  useEffect(() => {
    const request = ++workspaceRequest.current
    if (review?.state !== 'merged') {
      setWorkspaceRemoval({ status: 'ready', link: null, error: null })
      return
    }
    if (safeUrl === null) {
      setWorkspaceRemoval({ status: 'error', link: null, error: 'The merged pull request URL is unavailable.' })
      return
    }
    setWorkspaceRemoval({ status: 'loading', link: null, error: null })
    void props.context.call('quirky.tasks/state').then((value: unknown) => {
      if (request !== workspaceRequest.current) return
      if (!isRecord(value)) throw new Error('Tasks workspace link state is unavailable.')
      setWorkspaceRemoval({ status: 'ready', link: workspaceLinkFor(value, safeUrl), error: null })
    }).catch((cause: unknown) => {
      if (request === workspaceRequest.current) setWorkspaceRemoval({ status: 'error', link: null, error: errorText(cause) })
    })
  }, [props.context, review?.number, review?.state, safeUrl])
  const removalLink = workspaceRemoval.status === 'ready' ? workspaceRemoval.link : null
  workspaceRemovalTarget.current = review?.state === 'merged' && owner !== null && safeUrl !== null && removalLink !== null
    ? {
      surface: props.surface,
      worktree: owner.worktree,
      number: owner.number,
      repo: owner.repo,
      head: review.headRefOid,
      url: safeUrl,
      link: removalLink,
    }
    : null

  if (review === null || owner === null) return <section className="ui-stack"><SectionHeader title="Pull request" /><p className="ui-text-muted">Review actions are unavailable until a pull request is selected.</p></section>

  const policy = reviewMethods(review)
  const allowed = policy.allowed.filter((method): method is MergeMethod => method === 'squash' || method === 'merge' || method === 'rebase')
  const orderedMethods = [...allowed].sort((left, right) => left === policy.defaultMethod ? -1 : right === policy.defaultMethod ? 1 : 0)
  const primaryMethod = (orderedMethods.includes(policy.defaultMethod as MergeMethod) ? policy.defaultMethod : orderedMethods[0]) as MergeMethod | undefined
  const stackPresent = review.stack !== null && review.stack !== undefined
  const stackComplete = stackIsComplete(review, stack)
  const expectedHead = review.headRefOid
  const directAllowed = directMergeAllowed(review) && stackComplete && primaryMethod !== undefined && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(expectedHead)
  const queueAllowed = queueMergeAllowed(review) && stackComplete && primaryMethod !== undefined && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(expectedHead)
  const activeAutoMerge = hasAutoMerge(review)
  const hasConflict = review.mergeable === 'CONFLICTING' || review.mergeStateStatus === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY'
  const validHead = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(expectedHead)
  const autoMergeAllowed = activeAutoMerge
    ? review.state === 'open' && validHead
    : review.state === 'open' && !hasConflict && review.mergeStateStatus !== 'UNSTABLE'
      && review.autoMergeAllowed !== false && policy.known
      && (!directAllowed || review.reviewDecision === 'REVIEW_REQUIRED' || review.mergeQueueRequired === true)
      && primaryMethod !== undefined && validHead
  const target = {
    surface: props.surface,
    worktree: owner.worktree,
    number: owner.number,
    ...(owner.repo === null ? {} : { prRepo: owner.repo }),
  }
  const busyFromState = props.surface === 'detail' && props.state.detail.pending.length > 0
  const openState = review.state === 'open' || review.state === 'draft'

  const setErrorMessage = (error: unknown) => {
    const message = errorText(error)
    setError(message)
    props.context.toast('Review action failed', message)
  }

  const runCall = async (method: string, params: Record<string, unknown>, successTitle: string, successBody: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await props.context.call(method, params)
      props.context.toast(successTitle, successBody)
    } catch (error) {
      setErrorMessage(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const openMergeBox = async () => {
    if (safeUrl === null) {
      setError('The pull request URL is unavailable.')
      return
    }
    try {
      await props.context.call('quirky.reviews/openLink', { url: safeUrl, worktree: owner.worktree })
    } catch (error) {
      setErrorMessage(error)
    }
  }

  const confirmMerge = async (method: MergeMethod, action: MergeAction) => {
    if (!stackComplete || busyRef.current) {
      setError('Stack membership is unavailable or incomplete. Open the provider merge box to review the included pull requests.')
      return
    }
    const actionLabel = action === 'queue' ? 'Merge when ready' : methodLabels[method]
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const confirmation = await props.context.call('quirky.reviews/detailMergeConfirmation', {
        ...target, expectedHead, method, action,
      })
      if (typeof confirmation !== 'string') throw new Error('The review method returned an invalid merge confirmation.')
      const confirmed = await props.context.confirm({
        title: `${actionLabel} PR #${review.number}?`,
        body: confirmation,
        confirmLabel: actionLabel,
      })
      if (!confirmed) return
      const result = await props.context.call('quirky.reviews/detailMerge', {
        ...target, expectedHead, method, action, yes: true,
      })
      if (!isRecord(result) || result.number !== review.number || !['merged', 'enqueued', 'pending'].includes(String(result.state))) {
        throw new Error('The hosting API did not confirm the merge state.')
      }
      if (result.state === 'merged') props.context.toast('Pull request merged', `PR #${review.number} is merged.`)
      else if (result.state === 'enqueued') props.context.toast('Pull request queued', `PR #${review.number} was accepted by the merge queue; it is not yet merged.`)
      else props.context.toast('Merge pending', `PR #${review.number} remains open while the provider processes the merge.`)
    } catch (error) {
      setErrorMessage(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const changeReviewState = async (action: 'close' | 'reopen') => {
    if (busyRef.current) return
    const label = action === 'close' ? 'Close' : 'Reopen'
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const confirmed = await props.context.confirm({
        title: `${label} PR #${review.number}?`,
        body: `This will ${action} the pull request on GitHub.`,
        confirmLabel: label,
      })
      if (!confirmed) return
      await props.context.call(action === 'close' ? 'quirky.reviews/detailCloseReview' : 'quirky.reviews/detailReopenReview', {
        ...target,
        yes: true,
      })
      props.context.toast(action === 'close' ? 'Pull request closed' : 'Pull request reopened', `Pull request #${review.number} is ${action === 'close' ? 'closed' : 'open'}.`)
    } catch (error) {
      setErrorMessage(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const toggleAutoMerge = async () => {
    if (!activeAutoMerge && primaryMethod === undefined) {
      setError('No allowed merge method is available from current repository metadata.')
      return
    }
    await runCall('quirky.reviews/detailSetAutoMerge', {
      ...target,
      expectedHead,
      enabled: !activeAutoMerge,
      ...(activeAutoMerge || primaryMethod === undefined ? {} : { method: primaryMethod }),
    }, activeAutoMerge ? 'Auto-merge disabled' : review.mergeQueueRequired === true ? 'Pull request added to merge queue' : 'Auto-merge enabled',
    activeAutoMerge ? `Auto-merge is disabled for PR #${review.number}.` : `Auto-merge was requested for PR #${review.number}.`)
  }

  const markReady = async () => {
    await runCall('quirky.reviews/detailMarkReady', target, 'Pull request ready', `PR #${review.number} is ready for review.`)
  }

  const openFixDialog = async () => {
    try {
      await props.context.call('quirky.reviews/checksSetAgentDialog', { surface: props.surface, action: 'fix' })
    } catch (error) {
      setErrorMessage(error)
    }
  }

  const removeWorkspace = async () => {
    if (workspaceBusyRef.current) return
    const target = workspaceRemovalTarget.current
    if (target === null) return
    workspaceBusyRef.current = true
    setWorkspaceRemoveBusy(true)
    setError(null)
    try {
      const confirmed = await props.context.confirm({
        title: `Delete workspace ${target.link.name}?`,
        body: `Pull request #${target.number} is merged. Remove workspace ${target.link.name} (${target.link.worktree}) through Quirky? Uncommitted changes will not be force-discarded.`,
        confirmLabel: 'Delete workspace',
      })
      if (!confirmed) return
      if (!sameWorkspaceRemovalTarget(target, workspaceRemovalTarget.current)) {
        setError('The selected pull request or linked workspace changed before deletion.')
        return
      }
      const state = await props.context.call('quirky.tasks/state')
      if (!isRecord(state)) throw new Error('Tasks workspace link state is unavailable.')
      const currentLink = workspaceLinkFor(state, target.url)
      if (currentLink === null || !sameWorkspaceRemovalTarget(target, { ...target, link: currentLink })) {
        throw new Error('The linked workspace changed before deletion; refresh before retrying.')
      }
      if (!sameWorkspaceRemovalTarget(target, workspaceRemovalTarget.current)) {
        setError('The selected pull request or linked workspace changed before deletion.')
        return
      }
      const result = await props.context.call('quirky.worktree/remove', { worktree: target.link.worktree, yes: true })
      if (!isRecord(result) || result.ok !== true || !Array.isArray(result.removed) || !result.removed.includes(target.link.worktree)) {
        throw new Error('Quirky did not confirm removal of the linked workspace.')
      }
      let unlinkError: string | null = null
      try {
        await props.context.call('quirky.tasks/workspace', {
          action: 'unlink',
          target: {
            worktree: target.worktree,
            kind: 'pullRequest',
            number: target.number,
            url: target.url,
            ...(target.repo === null ? {} : { host: target.repo.host, owner: target.repo.owner, repo: target.repo.repo }),
          },
          worktree: target.link.worktree,
        })
      } catch (cause) {
        unlinkError = errorText(cause)
      }
      if (sameWorkspaceRemovalTarget(target, workspaceRemovalTarget.current)) {
        setWorkspaceRemoval({ status: 'ready', link: null, error: unlinkError })
        setError(unlinkError)
      }
      if (unlinkError === null) {
        props.context.toast('Workspace deleted', `Removed ${target.link.name} from merged pull request #${target.number}.`)
      } else {
        props.context.toast('Workspace removed; link cleanup failed', `${target.link.name}: ${unlinkError}`)
      }
    } catch (cause) {
      const message = errorText(cause)
      if (sameWorkspaceRemovalTarget(target, workspaceRemovalTarget.current)) setError(message)
      props.context.toast('Could not delete workspace', `${target.link.name}: ${message}`)
    } finally {
      workspaceBusyRef.current = false
      setWorkspaceRemoveBusy(false)
    }
  }

  const mergeLabel = directAllowed && primaryMethod !== undefined
    ? methodLabels[primaryMethod]
    : queueAllowed ? 'Merge when ready' : mergeStateLabel(review)
  const mergeMenuItems = [
    ...(activeAutoMerge ? [{ id: 'disable-auto-merge', label: 'Disable auto-merge', disabled: busy || busyFromState || !autoMergeAllowed, onAction: () => { void toggleAutoMerge() } }] : []),
    ...(!directAllowed && !activeAutoMerge && autoMergeAllowed ? [{ id: 'enable-auto-merge', label: review.mergeQueueRequired === true ? 'Merge when ready' : 'Enable auto-merge', disabled: busy || busyFromState, onAction: () => { void toggleAutoMerge() } }] : []),
    ...orderedMethods.map((method) => ({
      id: method,
      label: `${methodLabels[method]}${method === policy.defaultMethod ? ' (default)' : ''}`,
      disabled: busy || busyFromState || !directAllowed,
      onAction: () => { void confirmMerge(method, 'direct') },
    })),
    ...(queueAllowed && primaryMethod ? [{ id: 'merge-when-ready', label: `Merge when ready (${methodLabels[primaryMethod]})`, disabled: busy || busyFromState, onAction: () => { void confirmMerge(primaryMethod, 'queue') } }] : []),
    { id: 'provider-merge-box', label: 'Open provider merge box', disabled: safeUrl === null, onAction: () => { void openMergeBox() } },
  ]

  return <section className="ui-stack" aria-label="Pull request actions">
    <SectionHeader title="Pull request" />
    <Badge tone={review.state === 'open' ? 'working' : review.state === 'merged' ? 'accent' : 'neutral'}>{review.state === 'open' ? 'Open' : review.state === 'draft' ? 'Draft' : review.state === 'closed' ? 'Closed' : 'Merged'}</Badge>
    <span title={statusLine(review)}><Badge tone={review.checksStatus === 'failure' || hasConflict ? 'failing' : review.reviewDecision === 'REVIEW_REQUIRED' || review.reviewDecision === 'CHANGES_REQUESTED' ? 'needs-you' : review.checksStatus === 'success' ? 'working' : 'neutral'}>{mergeStateLabel(review)}</Badge></span>
    <p className="ui-text-muted">{statusLine(review)}</p>
    {stackPresent ? <section className="ui-stack" aria-label="Pull request stack">
      <strong>{stackComplete ? `Stack ${stack?.stack?.number}: ${included.length} pull requests included` : 'Stack membership unavailable'}</strong>
      {stackComplete ? <ol>{included.map((entry) => <li key={`${entry.position}:${entry.number}`}>#{entry.number} {entry.title}</li>)}</ol> : <p role="alert"><StatusDot status="failing" label="Error" /> {stack?.reason ?? 'The complete stack could not be verified.'} Open the provider merge box to review stack state.</p>}
    </section> : null}

    {openState ? <div className="ui-cluster">
      <Button variant="primary" disabled={busy || busyFromState || (!directAllowed && !queueAllowed)} title={statusLine(review)}
        onClick={() => primaryMethod && void confirmMerge(primaryMethod, queueAllowed && !directAllowed ? 'queue' : 'direct')}>
        {busy ? 'Working…' : mergeLabel}
      </Button>
      <Menu label="More merge actions" items={mergeMenuItems} />
    </div> : null}

    {review.state === 'draft' ? <Button disabled={busy || busyFromState} onClick={() => void markReady()}>Mark ready for review</Button> : null}
    {review.state === 'open' || review.state === 'draft' ? <Button variant="destructive" disabled={busy || busyFromState} onClick={() => void changeReviewState('close')}>Close pull request</Button> : null}
    {review.state === 'merged' ? <>
      {workspaceRemoval.status === 'loading' ? <p role="status" className="ui-text-muted">Checking for a linked workspace…</p> : null}
      {workspaceRemoval.error ? <p role="alert"><StatusDot status="failing" label="Error" /> {workspaceRemoval.error}</p> : null}
      {workspaceRemoval.status === 'ready' && workspaceRemoval.link === null && workspaceRemoval.error === null
        ? <p>No workspace is linked to this merged pull request.</p>
        : null}
      {workspaceRemoval.status === 'ready' && workspaceRemoval.link !== null ? <Button variant="destructive"
      disabled={busy || busyFromState || workspaceRemoveBusy}
      onClick={() => void removeWorkspace()}>{workspaceRemoveBusy ? 'Deleting workspace…' : `Delete workspace · ${workspaceRemoval.link.name}`}</Button> : null}
    </> : null}
    {review.checksStatus === 'failure' ? <Button variant="primary" disabled={busy} onClick={() => void openFixDialog()}>Fix broken checks</Button> : null}
    {error ? <p role="alert"><StatusDot status="failing" label="Error" /> {error}</p> : null}
  </section>
}