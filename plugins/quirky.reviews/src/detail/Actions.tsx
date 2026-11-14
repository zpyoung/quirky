import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, EmptyState, InlineError, Menu, NoticeLine, SectionHeader } from '@quirky/ui'
import type { ReviewsSurfaceProps, ReviewData } from '../contracts'
import { CHECKS_PANEL, REVIEW_VIEW } from '../contracts'
import { registerReviewsUiControl, listReviewsUiControls, requestReviewsUiControl, type ReviewsUiControlRequest, type ReviewsUiControlResult } from '../checks/data'
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
type WorkspaceLookup = { key: string; removal: WorkspaceRemoval }
type ReviewActionsRegistration = { generation: number; changed(): void; dispose(): void }
type ReviewActionsLease = {
  identity: string
  target: string
  generation: number
  registration: ReviewActionsRegistration
  active: boolean
}
type ReviewActionRunner = (request: ReviewsUiControlRequest, isCurrent: () => boolean) => Promise<void>

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

function hasOnlyPayloadKeys(value: Record<string, unknown> | undefined, allowed: readonly string[]): boolean {
  return value === undefined || Object.keys(value).every((key) => allowed.includes(key))
}

function mergeMethodPayload(
  value: Record<string, unknown> | undefined,
  allowed: MergeMethod[],
  fallback: MergeMethod | undefined,
  expected?: MergeMethod
): MergeMethod | null {
  if (!hasOnlyPayloadKeys(value, ['method'])) return null
  if (value === undefined || !Object.hasOwn(value, 'method')) return fallback ?? null
  const method = value.method
  if (typeof method !== 'string' || !allowed.includes(method as MergeMethod) || expected !== undefined && method !== expected) return null
  return method as MergeMethod
}

function controlDeliveryError(result: Extract<ReviewsUiControlResult, { delivered: false }>): string {
  if (result.reason === 'disabled') return 'This action is not currently available.'
  if (result.reason === 'unknown-action') return 'This action is no longer supported by the mounted view.'
  return 'This control is no longer available.'
}


export function ReviewActions(props: ReviewActionsProps) {
  const owner = reviewContext(props.state, props.surface)
  const review = owner?.review ?? null
  const safeUrl = review === null ? null : safeHttpUrl(review.url)
  const surfaceId = props.surface === 'detail' ? REVIEW_VIEW : CHECKS_PANEL
  const repoOrNull = owner?.repo === null || owner?.repo === undefined
    ? null
    : `${owner.repo.host}/${owner.repo.owner}/${owner.repo.repo}`
  const headRefOidOrNull = typeof review?.headRefOid === 'string' && review.headRefOid.length > 0
    ? review.headRefOid
    : null
  const target = JSON.stringify([
    surfaceId,
    'review-actions',
    owner?.worktree ?? null,
    repoOrNull,
    owner?.number ?? null,
    headRefOidOrNull,
    null
  ])
  const active = review !== null && owner !== null
  const identity = JSON.stringify([target, owner?.generation ?? null])
  const identityRef = useRef(identity)
  identityRef.current = identity

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspaceLookup, setWorkspaceLookup] = useState<WorkspaceLookup>({
    key: '',
    removal: { status: 'loading', link: null, error: null }
  })
  const [workspaceRemoveBusy, setWorkspaceRemoveBusy] = useState(false)
  const [reported, setReported] = useState<{ identity: string; target: string; generation: number } | null>(null)
  const workspaceRequest = useRef(0)
  const mountedRef = useRef(false)
  const workspaceRemovalTarget = useRef<WorkspaceRemovalTarget | null>(null)
  const workspaceBusyRef = useRef(false)
  const workspaceBusyTokenRef = useRef<object | null>(null)
  const busyRef = useRef(false)
  const busyTokenRef = useRef<object | null>(null)
  const registrationRef = useRef<ReviewActionsLease | null>(null)
  const stack = useMemo(() => review === null
    ? null
    : stackRecord(props.surface === 'detail' ? props.state.detail.details : props.state.checks.conflicts, review),
  [review, props.surface, props.state.detail.details, props.state.checks.conflicts])
  const included = useMemo(() => review === null ? [] : stackEntries(stack, review), [review, stack])
  const workspaceKey = JSON.stringify([
    owner?.worktree ?? null,
    owner?.generation ?? null,
    review?.number ?? null,
    review?.state ?? null,
    safeUrl
  ])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      workspaceRequest.current += 1
    }
  }, [])

  useEffect(() => {
    const request = ++workspaceRequest.current
    const isCurrent = () => mountedRef.current && request === workspaceRequest.current
    const update = (removal: WorkspaceRemoval) => {
      if (isCurrent()) setWorkspaceLookup({ key: workspaceKey, removal })
    }
    if (review?.state !== 'merged') {
      update({ status: 'ready', link: null, error: null })
    } else if (safeUrl === null) {
      update({ status: 'error', link: null, error: 'The merged pull request URL is unavailable.' })
    } else {
      update({ status: 'loading', link: null, error: null })
      void props.context.call('quirky.tasks/state').then((value: unknown) => {
        if (!isCurrent()) return
        if (!isRecord(value)) throw new Error('Tasks workspace link state is unavailable.')
        update({ status: 'ready', link: workspaceLinkFor(value, safeUrl), error: null })
      }).catch((cause: unknown) => {
        if (isCurrent()) update({ status: 'error', link: null, error: errorText(cause) })
      })
    }
    return () => {
      if (workspaceRequest.current === request) workspaceRequest.current += 1
    }
  }, [props.context, owner?.worktree, owner?.generation, review?.number, review?.state, safeUrl, workspaceKey])

  const loadingWorkspaceRemoval: WorkspaceRemoval = { status: 'loading', link: null, error: null }
  const workspaceRemoval = workspaceLookup.key === workspaceKey ? workspaceLookup.removal : loadingWorkspaceRemoval
  const removalLink = workspaceRemoval.status === 'ready' ? workspaceRemoval.link : null
  workspaceRemovalTarget.current = review?.state === 'merged'
    && owner !== null
    && safeUrl !== null
    && removalLink !== null
    ? {
      surface: props.surface,
      worktree: owner.worktree,
      number: owner.number,
      repo: owner.repo,
      head: review.headRefOid,
      url: safeUrl,
      link: removalLink
    }
    : null

  const policy = review === null ? null : reviewMethods(review)
  const allowed = policy?.allowed.filter((method): method is MergeMethod =>
    method === 'squash' || method === 'merge' || method === 'rebase') ?? []
  const orderedMethods = [...allowed].sort((left, right) =>
    left === policy?.defaultMethod ? -1 : right === policy?.defaultMethod ? 1 : 0)
  const primaryMethod = (orderedMethods.includes(policy?.defaultMethod as MergeMethod)
    ? policy?.defaultMethod
    : orderedMethods[0]) as MergeMethod | undefined
  const stackPresent = review !== null && review.stack !== null && review.stack !== undefined
  const stackComplete = review !== null && stackIsComplete(review, stack)
  const expectedHead = review?.headRefOid ?? ''
  const validHead = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(expectedHead)
  const directAllowed = review !== null && directMergeAllowed(review)
    && stackComplete && primaryMethod !== undefined && validHead
  const queueAllowed = review !== null && queueMergeAllowed(review)
    && stackComplete && primaryMethod !== undefined && validHead
  const activeAutoMerge = review !== null && hasAutoMerge(review)
  const hasConflict = review !== null
    && (review.mergeable === 'CONFLICTING' || review.mergeStateStatus === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY')
  const autoMergeAllowed = review !== null && (activeAutoMerge
    ? review.state === 'open' && validHead
    : review.state === 'open' && !hasConflict && review.mergeStateStatus !== 'UNSTABLE'
      && review.autoMergeAllowed !== false && policy?.known === true
      && (!directAllowed || review.reviewDecision === 'REVIEW_REQUIRED' || review.mergeQueueRequired === true)
      && primaryMethod !== undefined && validHead)
  const rpcTarget = owner === null ? null : {
    surface: props.surface,
    worktree: owner.worktree,
    number: owner.number,
    ...(owner.repo === null ? {} : { prRepo: owner.repo })
  }
  const busyFromState = props.surface === 'detail' && props.state.detail.pending.length > 0
  const openState = review !== null && (review.state === 'open' || review.state === 'draft')
  const actionBusy = busy || busyRef.current
  const actionWorkspaceBusy = workspaceRemoveBusy || workspaceBusyRef.current

  const controlActions = active && review !== null ? [
    { action: 'merge', enabled: openState && !actionBusy && !busyFromState && directAllowed },
    { action: 'merge-when-ready', enabled: openState && !actionBusy && !busyFromState && queueAllowed && primaryMethod !== undefined },
    { action: 'enable-auto-merge', enabled: openState && !actionBusy && !busyFromState && !directAllowed && !activeAutoMerge && autoMergeAllowed },
    { action: 'disable-auto-merge', enabled: openState && !actionBusy && !busyFromState && activeAutoMerge && autoMergeAllowed },
    { action: 'provider-merge-box', enabled: safeUrl !== null },
    { action: 'mark-ready', enabled: review.state === 'draft' && !actionBusy && !busyFromState },
    { action: 'close', enabled: (review.state === 'open' || review.state === 'draft') && !actionBusy && !busyFromState },
    {
      action: 'delete-workspace',
      enabled: review.state === 'merged' && workspaceRemoval.status === 'ready' && workspaceRemoval.link !== null
        && !actionBusy && !busyFromState && !actionWorkspaceBusy
    },
    { action: 'fix-checks', enabled: review.checksStatus === 'failure' && !actionBusy }
  ] : []
  const actionsRef = useRef(controlActions)
  actionsRef.current = controlActions

  const leaseIsCurrent = (lease: ReviewActionsLease) => {
    return lease.active
      && registrationRef.current === lease
      && identityRef.current === lease.identity
      && listReviewsUiControls(props.context, surfaceId).some((descriptor) =>
        descriptor.target === lease.target && descriptor.generation === lease.generation)
  }
  const reportActionError = (cause: unknown, isCurrent: () => boolean, toast = true) => {
    if (!isCurrent()) return
    const message = errorText(cause)
    setError(message)
    if (toast) props.context.toast('Review action failed', message)
  }
  const beginBusy = (isCurrent: () => boolean) => {
    if (!isCurrent() || busyRef.current) return null
    const token = {}
    busyTokenRef.current = token
    busyRef.current = true
    setBusy(true)
    setError(null)
    return token
  }
  const finishBusy = (token: object, isCurrent: () => boolean) => {
    if (busyTokenRef.current !== token || !isCurrent()) return
    busyTokenRef.current = null
    busyRef.current = false
    setBusy(false)
  }

  const runCall = async (
    method: string,
    params: Record<string, unknown>,
    successTitle: string,
    successBody: string,
    isCurrent: () => boolean
  ) => {
    if (!isCurrent() || busyRef.current || busyFromState) return
    const token = beginBusy(isCurrent)
    if (token === null) return
    try {
      if (!isCurrent()) return
      await props.context.call(method, params)
      if (isCurrent()) props.context.toast(successTitle, successBody)
    } catch (cause) {
      reportActionError(cause, isCurrent)
    } finally {
      finishBusy(token, isCurrent)
    }
  }

  const confirmMerge = async (method: MergeMethod, action: MergeAction, isCurrent: () => boolean) => {
    if (!isCurrent() || busyRef.current || busyFromState) return
    if (!stackComplete) {
      reportActionError(
        'Stack membership is unavailable or incomplete. Open the provider merge box to review the included pull requests.',
        isCurrent,
        false
      )
      return
    }
    if (review === null || owner === null || rpcTarget === null) return
    const actionLabel = action === 'queue' ? 'Merge when ready' : methodLabels[method]
    const token = beginBusy(isCurrent)
    if (token === null) return
    try {
      if (!isCurrent()) return
      const confirmation = await props.context.call('quirky.reviews/detailMergeConfirmation', {
        ...rpcTarget, expectedHead, method, action
      })
      if (!isCurrent()) return
      if (typeof confirmation !== 'string') throw new Error('The review method returned an invalid merge confirmation.')
      const confirmed = await props.context.confirm({
        title: `${actionLabel} PR #${review.number}?`,
        body: confirmation,
        confirmLabel: actionLabel
      })
      if (!isCurrent() || !confirmed) return
      const result = await props.context.call('quirky.reviews/detailMerge', {
        ...rpcTarget, expectedHead, method, action, yes: true
      })
      if (!isCurrent()) return
      if (!isRecord(result) || result.number !== review.number || !['merged', 'enqueued', 'pending'].includes(String(result.state))) {
        throw new Error('The hosting API did not confirm the merge state.')
      }
      if (result.state === 'merged') props.context.toast('Pull request merged', `PR #${review.number} is merged.`)
      else if (result.state === 'enqueued') props.context.toast('Pull request queued', `PR #${review.number} was accepted by the merge queue; it is not yet merged.`)
      else props.context.toast('Merge pending', `PR #${review.number} remains open while the provider processes the merge.`)
    } catch (cause) {
      reportActionError(cause, isCurrent)
    } finally {
      finishBusy(token, isCurrent)
    }
  }

  const changeReviewState = async (action: 'close' | 'reopen', isCurrent: () => boolean) => {
    if (!isCurrent() || busyRef.current || busyFromState || review === null || rpcTarget === null) return
    const label = action === 'close' ? 'Close' : 'Reopen'
    const token = beginBusy(isCurrent)
    if (token === null) return
    try {
      if (!isCurrent()) return
      const confirmed = await props.context.confirm({
        title: `${label} PR #${review.number}?`,
        body: `This will ${action} the pull request on GitHub.`,
        confirmLabel: label
      })
      if (!isCurrent() || !confirmed) return
      await props.context.call(action === 'close' ? 'quirky.reviews/detailCloseReview' : 'quirky.reviews/detailReopenReview', {
        ...rpcTarget,
        yes: true
      })
      if (isCurrent()) {
        props.context.toast(
          action === 'close' ? 'Pull request closed' : 'Pull request reopened',
          `Pull request #${review.number} is ${action === 'close' ? 'closed' : 'open'}.`
        )
      }
    } catch (cause) {
      reportActionError(cause, isCurrent)
    } finally {
      finishBusy(token, isCurrent)
    }
  }

  const removeWorkspace = async (isCurrent: () => boolean) => {
    if (!isCurrent() || busyRef.current || busyFromState || workspaceBusyRef.current) return
    const capturedTarget = workspaceRemovalTarget.current
    if (capturedTarget === null) return
    const token = {}
    workspaceBusyTokenRef.current = token
    workspaceBusyRef.current = true
    setWorkspaceRemoveBusy(true)
    setError(null)
    const targetStillCurrent = () => isCurrent()
      && sameWorkspaceRemovalTarget(capturedTarget, workspaceRemovalTarget.current)
    try {
      if (!targetStillCurrent()) return
      const confirmed = await props.context.confirm({
        title: `Delete workspace ${capturedTarget.link.name}?`,
        body: `Pull request #${capturedTarget.number} is merged. Remove workspace ${capturedTarget.link.name} (${capturedTarget.link.worktree}) through Quirky? Uncommitted changes will not be force-discarded.`,
        confirmLabel: 'Delete workspace'
      })
      if (!isCurrent() || !confirmed) return
      if (!sameWorkspaceRemovalTarget(capturedTarget, workspaceRemovalTarget.current)) {
        if (isCurrent()) setError('The selected pull request or linked workspace changed before deletion.')
        return
      }
      if (!targetStillCurrent()) return
      const state = await props.context.call('quirky.tasks/state')
      if (!targetStillCurrent()) return
      if (!isRecord(state)) throw new Error('Tasks workspace link state is unavailable.')
      const currentLink = workspaceLinkFor(state, capturedTarget.url)
      if (currentLink === null || !sameWorkspaceRemovalTarget(capturedTarget, { ...capturedTarget, link: currentLink })) {
        throw new Error('The linked workspace changed before deletion; refresh before retrying.')
      }
      if (!targetStillCurrent()) return
      const result = await props.context.call('quirky.worktree/remove', {
        worktree: capturedTarget.link.worktree,
        yes: true
      })
      if (!isRecord(result) || result.ok !== true || !Array.isArray(result.removed)
        || !result.removed.includes(capturedTarget.link.worktree)) {
        throw new Error('Quirky did not confirm removal of the linked workspace.')
      }
      let unlinkError: string | null = null
      try {
        await props.context.call('quirky.tasks/workspace', {
          action: 'unlink',
          target: {
            worktree: capturedTarget.worktree,
            kind: 'pullRequest',
            number: capturedTarget.number,
            url: capturedTarget.url,
            ...(capturedTarget.repo === null ? {} : {
              host: capturedTarget.repo.host,
              owner: capturedTarget.repo.owner,
              repo: capturedTarget.repo.repo
            })
          },
          worktree: capturedTarget.link.worktree
        })
      } catch (cause) {
        unlinkError = errorText(cause)
      }
      if (targetStillCurrent()) {
        setWorkspaceLookup({
          key: workspaceKey,
          removal: { status: 'ready', link: null, error: unlinkError }
        })
        setError(unlinkError)
        if (unlinkError === null) {
          props.context.toast('Workspace deleted', `Removed ${capturedTarget.link.name} from merged pull request #${capturedTarget.number}.`)
        } else {
          props.context.toast('Workspace removed; link cleanup failed', `${capturedTarget.link.name}: ${unlinkError}`)
        }
      }
    } catch (cause) {
      if (targetStillCurrent()) {
        const message = errorText(cause)
        setError(message)
        props.context.toast('Could not delete workspace', `${capturedTarget.link.name}: ${message}`)
      }
    } finally {
      if (workspaceBusyTokenRef.current === token && isCurrent()) {
        workspaceBusyTokenRef.current = null
        workspaceBusyRef.current = false
        setWorkspaceRemoveBusy(false)
      }
    }
  }

  const openMergeBox = async (isCurrent: () => boolean) => {
    if (!isCurrent() || safeUrl === null || owner === null) return
    try {
      await props.context.call('quirky.reviews/openLink', { url: safeUrl, worktree: owner.worktree })
    } catch (cause) {
      reportActionError(cause, isCurrent)
    }
  }

  const openFixDialog = async (isCurrent: () => boolean) => {
    if (!isCurrent() || owner === null) return
    try {
      await props.context.call('quirky.reviews/checksSetAgentDialog', {
        surface: props.surface,
        ...(props.surface === 'checks' ? { worktree: owner.worktree } : {}),
        action: 'fix'
      })
    } catch (cause) {
      reportActionError(cause, isCurrent)
    }
  }

  const runAction: ReviewActionRunner = async (request, isCurrent) => {
    if (!isCurrent() || !active || review === null || owner === null || rpcTarget === null) return
    switch (request.action) {
      case 'merge': {
        const method = mergeMethodPayload(request.value, allowed, primaryMethod)
        if (method === null) throw new Error('The selected merge method is not allowed for this pull request.')
        await confirmMerge(method, 'direct', isCurrent)
        return
      }
      case 'merge-when-ready': {
        const method = mergeMethodPayload(request.value, allowed, primaryMethod, primaryMethod)
        if (method === null) throw new Error('Merge when ready must use the primary allowed merge method.')
        await confirmMerge(method, 'queue', isCurrent)
        return
      }
      case 'enable-auto-merge':
      case 'disable-auto-merge': {
        if (request.action === 'disable-auto-merge' && !hasOnlyPayloadKeys(request.value, [])) {
          throw new Error('This review action does not accept payload fields.')
        }
        let method: MergeMethod | undefined
        if (request.action === 'enable-auto-merge') {
          if (primaryMethod === undefined) {
            reportActionError('No allowed merge method is available from current repository metadata.', isCurrent, false)
            return
          }
          method = mergeMethodPayload(request.value, allowed, primaryMethod) ?? undefined
          if (method === undefined) throw new Error('The selected merge method is not allowed for this pull request.')
        }
        if (request.action === 'disable-auto-merge' && !activeAutoMerge) return
        if (request.action === 'enable-auto-merge' && activeAutoMerge) return
        const enabled = request.action === 'enable-auto-merge'
        const title = enabled
          ? review.mergeQueueRequired === true ? 'Pull request added to merge queue' : 'Auto-merge enabled'
          : 'Auto-merge disabled'
        const body = enabled
          ? `Auto-merge was requested for PR #${review.number}.`
          : `Auto-merge is disabled for PR #${review.number}.`
        await runCall('quirky.reviews/detailSetAutoMerge', {
          ...rpcTarget,
          expectedHead,
          enabled,
          ...(enabled && method !== undefined ? { method } : {})
        }, title, body, isCurrent)
        return
      }
      case 'provider-merge-box':
        if (!hasOnlyPayloadKeys(request.value, [])) throw new Error('This review action does not accept payload fields.')
        await openMergeBox(isCurrent)
        return
      case 'mark-ready':
        if (!hasOnlyPayloadKeys(request.value, [])) throw new Error('This review action does not accept payload fields.')
        await runCall('quirky.reviews/detailMarkReady', rpcTarget, 'Pull request ready', `PR #${review.number} is ready for review.`, isCurrent)
        return
      case 'close':
        if (!hasOnlyPayloadKeys(request.value, [])) throw new Error('This review action does not accept payload fields.')
        await changeReviewState('close', isCurrent)
        return
      case 'delete-workspace':
        if (!hasOnlyPayloadKeys(request.value, [])) throw new Error('This review action does not accept payload fields.')
        await removeWorkspace(isCurrent)
        return
      case 'fix-checks':
        if (!hasOnlyPayloadKeys(request.value, [])) throw new Error('This review action does not accept payload fields.')
        await openFixDialog(isCurrent)
        return
    }
  }
  const runRef = useRef<ReviewActionRunner | null>(null)
  runRef.current = runAction

  useLayoutEffect(() => {
    if (!active) {
      setReported(null)
      return
    }
    busyRef.current = false
    busyTokenRef.current = null
    workspaceBusyRef.current = false
    workspaceBusyTokenRef.current = null
    setBusy(false)
    setWorkspaceRemoveBusy(false)
    setError(null)
    let lease: ReviewActionsLease | null = null
    const registration = registerReviewsUiControl(props.context, {
      surface: surfaceId,
      slot: 'review-actions',
      target,
      actions: () => actionsRef.current,
      run: (request, isCurrent) => {
        const current = () => lease !== null
          && isCurrent()
          && lease.active
          && registrationRef.current === lease
          && identityRef.current === lease.identity
        if (lease === null || !current() || runRef.current === null) return
        void runRef.current(request, current).catch((cause) => reportActionError(cause, current))
      }
    })
    lease = {
      identity,
      target,
      generation: registration.generation,
      registration,
      active: true
    }
    registrationRef.current = lease
    setReported({ identity, target, generation: registration.generation })
    return () => {
      lease!.active = false
      registration.dispose()
      if (registrationRef.current === lease) {
        registrationRef.current = null
        busyTokenRef.current = null
        busyRef.current = false
        workspaceBusyTokenRef.current = null
        workspaceBusyRef.current = false
        setBusy(false)
        setWorkspaceRemoveBusy(false)
        setReported(null)
      }
    }
  }, [active, props.context, surfaceId, target, owner?.generation, identity])

  const actionsKey = JSON.stringify(controlActions)
  useEffect(() => {
    const lease = registrationRef.current
    if (active && lease?.identity === identity) lease.registration.changed()
  }, [active, actionsKey, identity])

  const requestControl = async (action: string, value?: Record<string, unknown>) => {
    const lease = registrationRef.current
    if (!active || lease === null || !leaseIsCurrent(lease)) return
    const isCurrent = () => leaseIsCurrent(lease)
    try {
      const result = await requestReviewsUiControl(props.context, {
        target: lease.target,
        generation: lease.generation,
        action,
        ...(value === undefined ? {} : { value })
      })
      if (!isCurrent()) return
      if (!result.delivered) reportActionError(controlDeliveryError(result), isCurrent)
    } catch (cause) {
      reportActionError(cause, isCurrent)
    }
  }

  const controlTarget = active && reported?.identity === identity ? reported.target : undefined
  const controlGeneration = active && reported?.identity === identity ? reported.generation : undefined
  if (review === null || owner === null) {
    return <section
      className="ui-stack"
      data-review-control-target={controlTarget}
      data-review-control-generation={controlGeneration}
    >
      <SectionHeader title="Pull request" />
      <EmptyState message="Review actions are unavailable until a pull request is selected." />
    </section>
  }

  const mergeLabel = directAllowed && primaryMethod !== undefined
    ? methodLabels[primaryMethod]
    : queueAllowed ? 'Merge when ready' : mergeStateLabel(review)
  const mergeMenuItems = [
    ...(activeAutoMerge ? [{
      id: 'disable-auto-merge',
      label: 'Disable auto-merge',
      disabled: busy || busyFromState || !autoMergeAllowed,
      onAction: () => { void requestControl('disable-auto-merge') }
    }] : []),
    ...(!directAllowed && !activeAutoMerge && autoMergeAllowed ? [{
      id: 'enable-auto-merge',
      label: review.mergeQueueRequired === true ? 'Merge when ready' : 'Enable auto-merge',
      disabled: busy || busyFromState,
      onAction: () => { void requestControl('enable-auto-merge', primaryMethod === undefined ? undefined : { method: primaryMethod }) }
    }] : []),
    ...orderedMethods.map((method) => ({
      id: method,
      label: `${methodLabels[method]}${method === policy?.defaultMethod ? ' (default)' : ''}`,
      disabled: busy || busyFromState || !directAllowed,
      onAction: () => { void requestControl('merge', { method }) }
    })),
    ...(queueAllowed && primaryMethod ? [{
      id: 'merge-when-ready',
      label: `Merge when ready (${methodLabels[primaryMethod]})`,
      disabled: busy || busyFromState,
      onAction: () => { void requestControl('merge-when-ready', { method: primaryMethod }) }
    }] : []),
    {
      id: 'provider-merge-box',
      label: 'Open provider merge box',
      disabled: safeUrl === null,
      onAction: () => { void requestControl('provider-merge-box') }
    }
  ]

  return <section
    className="ui-stack"
    aria-label="Pull request actions"
    data-review-control-target={controlTarget}
    data-review-control-generation={controlGeneration}
  >
    <SectionHeader title="Pull request" />
    <Badge tone={review.state === 'open' ? 'working' : review.state === 'merged' ? 'accent' : 'neutral'}>{review.state === 'open' ? 'Open' : review.state === 'draft' ? 'Draft' : review.state === 'closed' ? 'Closed' : 'Merged'}</Badge>
    <span title={statusLine(review)}><Badge tone={review.checksStatus === 'failure' || hasConflict ? 'failing' : review.reviewDecision === 'REVIEW_REQUIRED' || review.reviewDecision === 'CHANGES_REQUESTED' ? 'needs-you' : review.checksStatus === 'success' ? 'working' : 'neutral'}>{mergeStateLabel(review)}</Badge></span>
    <p className="ui-text-muted">{statusLine(review)}</p>
    {stackPresent ? <section className="ui-stack" aria-label="Pull request stack">
      <strong>{stackComplete ? `Stack ${stack?.stack?.number}: ${included.length} pull requests included` : 'Stack membership unavailable'}</strong>
      {stackComplete
        ? <ol>{included.map((entry) => <li key={`${entry.position}:${entry.number}`}>#{entry.number} {entry.title}</li>)}</ol>
        : <InlineError message={`${stack?.reason ?? 'The complete stack could not be verified.'} Open the provider merge box to review stack state.`} />}
    </section> : null}

    {openState ? <div className="ui-cluster">
      <Button
        variant="primary"
        disabled={busy || busyFromState || (!directAllowed && !queueAllowed)}
        title={statusLine(review)}
        onClick={() => {
          if (primaryMethod === undefined) return
          const action = queueAllowed && !directAllowed ? 'merge-when-ready' : 'merge'
          void requestControl(action, { method: primaryMethod })
        }}
      >
        {busy ? 'Working…' : mergeLabel}
      </Button>
      <Menu label="More merge actions" items={mergeMenuItems} />
    </div> : null}

    {review.state === 'draft'
      ? <Button disabled={busy || busyFromState} onClick={() => { void requestControl('mark-ready') }}>Mark ready for review</Button>
      : null}
    {review.state === 'open' || review.state === 'draft'
      ? <Button variant="destructive" disabled={busy || busyFromState} onClick={() => { void requestControl('close') }}>Close pull request</Button>
      : null}
    {review.state === 'merged' ? <>
      {workspaceRemoval.status === 'loading'
        ? <div role="status"><NoticeLine>Checking for a linked workspace…</NoticeLine></div>
        : null}
      {workspaceRemoval.error ? <InlineError message={workspaceRemoval.error} /> : null}
      {workspaceRemoval.status === 'ready' && workspaceRemoval.link === null && workspaceRemoval.error === null
        ? <EmptyState message="No workspace is linked to this merged pull request." />
        : null}
      {workspaceRemoval.status === 'ready' && workspaceRemoval.link !== null ? <Button
        variant="destructive"
        disabled={busy || busyFromState || workspaceRemoveBusy}
        onClick={() => { void requestControl('delete-workspace') }}
      >
        {workspaceRemoveBusy ? 'Deleting workspace…' : `Delete workspace · ${workspaceRemoval.link.name}`}
      </Button> : null}
    </> : null}
    {review.checksStatus === 'failure'
      ? <Button variant="primary" disabled={busy} onClick={() => { void requestControl('fix-checks') }}>Fix broken checks</Button>
      : null}
    {error ? <InlineError message={error} /> : null}
  </section>
}