import { Badge, Button, FormRow } from '@quirky/ui'
import { Markdown } from '../issue/Markdown'
import { nonnegativeInteger, object, optionalLogins, relativeTime, reviewAuthors, reviewState, type ListItem, type MergeMetadata } from './model'

export type ReviewerOptions = { recentlyActive: string[]; suggestions: string[] }

export type PrDetailProps = {
  item: ListItem
  /** False when the row isn't on the loaded page; the description is omitted then, since only the merge metadata is known. */
  onPage: boolean
  metadata: MergeMetadata | undefined
  metadataLoading: boolean
  metadataError: string | undefined
  check: { label: string; tone: string }
  busy: boolean
  linkedName: string | null
  merge: {
    open: boolean
    onToggle(): void
    onMerge(method: string, action: 'direct' | 'queue'): void
    onToggleAutoMerge(): void
  }
  reviewers: {
    open: boolean
    text: string
    options: ReviewerOptions | undefined
    onToggle(): void
    onTextChange(value: string): void
    onAddOption(login: string): void
    onSave(action: 'add' | 'remove'): void
    onClose(): void
  }
  onReview(tab: 'conversation' | 'checks'): void
  onLoadChecks(): void
  onRetryMetadata(): void
  onWorkspace(action: 'start' | 'resume', newWorkspace?: boolean): void
  onOpenLink(url: string): void
}

const REVIEW_VERBS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'had a review dismissed',
  PENDING: 'has a pending review'
}

function reviewLines(reviews: unknown): string[] {
  if (!Array.isArray(reviews)) return []
  const lines = reviews.flatMap((entry) => {
    const review = object(entry)
    if (!review || typeof review.state !== 'string') return []
    const state = review.state.toUpperCase()
    const author = typeof review.author === 'string' && review.author !== '' ? review.author : 'Someone'
    return [`${author} ${REVIEW_VERBS[state] ?? state.toLowerCase().replace(/_/gu, ' ')}`]
  })
  return lines.reverse()
}

function checkTone(tone: string): 'failing' | 'needs-you' | 'working' | 'neutral' {
  return tone === 'danger' ? 'failing' : tone === 'warning' ? 'needs-you' : tone === 'success' ? 'working' : 'neutral'
}

function changesLabel(additions: number | undefined, deletions: number | undefined, files: number | undefined): string | null {
  if (additions === undefined && deletions === undefined && files === undefined) return null
  const lines = [additions !== undefined ? `+${additions}` : '', deletions !== undefined ? `−${deletions}` : ''].filter(Boolean).join(' ')
  const count = files !== undefined ? `${files} files` : ''
  return [lines, count].filter(Boolean).join(' · ')
}

/**
 * The expanded Tasks view's pull-request pane. Presentational: the list owns every read and
 * mutation and passes them in, so the merge and reviewer safety rules stay in one place.
 */
export function PrDetail({ item, onPage, metadata, metadataLoading, metadataError, check, busy, linkedName, merge, reviewers, onReview, onLoadChecks, onRetryMetadata, onWorkspace, onOpenLink }: PrDetailProps) {
  const review = metadata?.review
  const displayState = item.state === 'unknown' ? reviewState(review?.state) ?? item.state : item.state
  const reviewDraft = typeof review?.isDraft === 'boolean' ? review.isDraft : reviewState(review?.state) === 'draft' ? true : undefined
  const isDraft = reviewDraft ?? item.isDraft
  const title = onPage ? item.title : typeof review?.title === 'string' ? review.title : `Pull request #${item.number}`
  const url = onPage ? item.url : typeof review?.url === 'string' && review.url !== '' ? review.url : item.url
  const additions = typeof item.additions === 'number' ? item.additions : nonnegativeInteger(review?.additions)
  const deletions = typeof item.deletions === 'number' ? item.deletions : nonnegativeInteger(review?.deletions)
  const changedFiles = typeof item.changedFiles === 'number' ? item.changedFiles : nonnegativeInteger(review?.changedFiles)
  const reviewDecision = typeof item.reviewDecision === 'string' ? item.reviewDecision : typeof review?.reviewDecision === 'string' ? review.reviewDecision : undefined
  const requestedReviewers = optionalLogins(review?.requestedReviewers)
  const reviewHistoryAuthors = reviewAuthors(review?.reviews)
  const pullRequestAssignees = optionalLogins(review?.assignees)
  const reviewerLabel = requestedReviewers === null
    ? 'Requested reviewers unavailable'
    : requestedReviewers?.length
      ? requestedReviewers.join(', ')
      : reviewDecision && reviewDecision !== 'NONE' ? reviewDecision : 'Reviewers'
  const reviewerInfoUnknown = requestedReviewers === null || reviewHistoryAuthors === null || pullRequestAssignees === null
  const recentReviewers = [...new Set([...(reviewers.options?.recentlyActive ?? []), ...(reviewHistoryAuthors ?? [])])].filter((login) => !requestedReviewers?.includes(login))
  const suggestedReviewers = [...new Set([...(reviewers.options?.suggestions ?? []), ...(pullRequestAssignees ?? [])])].filter((login) => !recentReviewers.includes(login) && !requestedReviewers?.includes(login))
  const assignees = pullRequestAssignees === null ? null : pullRequestAssignees ?? item.assignees
  const timeline = reviewLines(review?.reviews)
  const changes = changesLabel(additions, deletions, changedFiles)
  const autoMergeAvailable = metadata?.autoMergeEnabled === true || metadata?.autoMergeEnableEligible === true
  const when = relativeTime(item.updatedAt)
  const branches = item.headRefName && item.baseRefName ? `${item.author ?? 'someone'} wants to merge ${item.headRefName} into ${item.baseRefName}` : item.author ?? null

  return (
    <article className="tasks-pr" aria-label={`Pull request #${item.number}`}>
      <header className="tasks-pr__header">
        <div className="tasks-pr__heading">
          <h2 className="tasks-pr__title">{title}</h2>
          {displayState !== 'open' && !isDraft ? <Badge tone={displayState === 'closed' ? 'neutral' : 'accent'}>{displayState}</Badge> : null}
          {isDraft ? <Badge>Draft</Badge> : null}
        </div>
        <p className="tasks-pr__meta">PR #{item.number}{onPage && branches ? ` · ${branches}` : ''}{onPage ? ` · ${when.label}` : ''}</p>
        <div className="tasks-pr__actions">
          <Button type="button" variant="primary" onClick={() => onReview('conversation')}>Review</Button>
          <Button type="button" disabled={busy} onClick={() => onWorkspace(linkedName ? 'resume' : 'start')}>{linkedName ? 'Resume' : 'Start'}</Button>
          {linkedName ? <Button type="button" onClick={() => onWorkspace('start', true)}>Start new</Button> : null}
          <div className="tasks-pr__anchor">
            <Button type="button" aria-haspopup="menu" aria-expanded={merge.open} aria-label={metadataError ? `Merge metadata unavailable for PR #${item.number}` : `Merge actions for PR #${item.number}`} onClick={merge.onToggle} disabled={busy}>{metadataError ? 'Merge metadata unavailable' : displayState === 'merged' ? 'Merged' : metadata?.queueEligible ? 'Merge when ready' : metadata?.mergeEligible ? 'Merge' : 'Check merge safety'} ▾</Button>
            {merge.open ? <div role="menu" aria-label={`Merge PR #${item.number}`} className="tasks-pr__popover">
              {metadataLoading ? <span role="status">Loading merge metadata…</span> : null}
              {!metadataLoading && !metadata && !metadataError ? <span role="status">Review metadata has not loaded.</span> : null}
              {metadata?.mergeQueueRequired === true && metadata.queueEligible ? metadata.queueMethods.map((method) => <Button key={method} type="button" role="menuitem" disabled={busy} onClick={() => merge.onMerge(method, 'queue')}>{`Merge when ready (${method})`}</Button>) : null}
              {metadata?.mergeQueueRequired === false && metadata.mergeEligible ? metadata.directMethods.map((method) => <Button key={method} type="button" role="menuitem" disabled={busy} onClick={() => merge.onMerge(method, 'direct')}>{method === 'squash' ? 'Squash and merge' : method === 'merge' ? 'Create merge commit' : 'Rebase and merge'}</Button>) : null}
              {metadata && !metadata.mergeMetadataKnown ? <span>GitHub has not confirmed merge-queue safety metadata.</span> : null}
              {metadata?.mergeMetadataKnown && metadata.mergeQueueRequired === null ? <span>Merge-queue requirement is unknown; refresh before merging.</span> : null}
              {metadata?.mergeQueueRequired === false && !metadata.mergeEligible ? <span>Direct merge is not confirmed safe.</span> : null}
              {metadata && !metadata.autoMergeEnabled && metadata.autoMergeAllowed === null ? <span>Auto-merge capability is unknown.</span> : null}
              {metadata?.autoMergeAllowed === false && !metadata.autoMergeEnabled ? <span>GitHub has disabled auto-merge for this repository.</span> : null}
              {autoMergeAvailable ? <Button type="button" role="menuitem" onClick={merge.onToggleAutoMerge}>{metadata?.autoMergeEnabled ? 'Disable auto-merge' : metadata?.mergeQueueRequired ? 'Merge when ready' : 'Enable auto-merge'}</Button> : null}
              <Button type="button" role="menuitem" onClick={() => onOpenLink(url)}>Open on GitHub</Button>
            </div> : null}
          </div>
          <Button type="button" aria-label={`Open pull request #${item.number} on GitHub`} onClick={() => onOpenLink(url)}>↗ GitHub</Button>
        </div>
        {metadataError ? <span role="status" className="tasks-pr__notice">Review metadata unavailable: {metadataError} <Button type="button" onClick={onRetryMetadata}>Retry</Button></span> : null}
      </header>

      <div className="tasks-pr__layout">
        <div className="tasks-pr__main">
          {onPage ? <div className="tasks-pr__description"><Markdown source={item.body} /></div> : null}
          {timeline.length > 0 ? (
            <section className="tasks-pr__timeline" aria-label="Timeline">
              <h3 className="tasks-pr__section-title">Timeline</h3>
              <ul>{timeline.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>
            </section>
          ) : null}
        </div>

        <div className="tasks-pr__aside">
          <section className="tasks-pr__fact">
            <h3 className="tasks-pr__section-title">Checks</h3>
            <Button className="tasks-pr__checks" type="button" aria-label={`Checks for PR #${item.number}: ${check.label}`} onMouseEnter={onLoadChecks} onFocus={onLoadChecks} onClick={() => onReview('checks')}><Badge tone={checkTone(check.tone)}>{check.label}</Badge></Button>
          </section>

          <section className="tasks-pr__fact">
            <h3 className="tasks-pr__section-title">Reviewers</h3>
            <div className="tasks-pr__anchor">
              <Button type="button" aria-haspopup="dialog" aria-expanded={reviewers.open} onClick={reviewers.onToggle}>{reviewerLabel}</Button>
              {reviewers.open ? <div role="dialog" aria-label={`Reviewers for PR #${item.number}`} className="tasks-pr__popover">
                {requestedReviewers === null ? <span role="status">Requested reviewers are unavailable.</span> : requestedReviewers?.length ? <span>Currently requested: {requestedReviewers.join(', ')}</span> : null}
                {review?.reviews === null ? <span role="status">Review history is unavailable.</span> : null}
                {review?.assignees === null ? <span role="status">Pull-request assignees are unavailable.</span> : null}
                {review?.participantsTruncated === true ? <span role="status">Recent reviewer activity is incomplete.</span> : null}
                {!reviewers.options ? <span role="status">Loading reviewer suggestions…</span> : null}
                {recentReviewers.length > 0 ? <fieldset><legend>Recently active in this pull request</legend>{recentReviewers.map((login) => <Button key={login} type="button" onClick={() => reviewers.onAddOption(login)}>{login}</Button>)}</fieldset> : null}
                {suggestedReviewers.length > 0 ? <fieldset><legend>Suggestions</legend>{suggestedReviewers.map((login) => <Button key={login} type="button" onClick={() => reviewers.onAddOption(login)}>{login}</Button>)}</fieldset> : null}
                {reviewers.options && recentReviewers.length === 0 && suggestedReviewers.length === 0 && !reviewerInfoUnknown ? <span role="status">No matching reviewers.</span> : null}
                <FormRow label="Everyone else" htmlFor={`tasks-list-reviewer-text-${item.number}`}>
                  <textarea id={`tasks-list-reviewer-text-${item.number}`} className="ui-text-field__input tasks-pr__reviewer-input" aria-label="Type or choose a reviewer" value={reviewers.text} onChange={(event) => reviewers.onTextChange(event.currentTarget.value)} placeholder="Type or choose a user" />
                </FormRow>
                <Button type="button" disabled={busy} onClick={() => reviewers.onSave('add')}>Request reviewers</Button>
                <Button type="button" disabled={busy} onClick={() => reviewers.onSave('remove')}>Remove reviewers</Button>
                <Button type="button" onClick={reviewers.onClose}>Close</Button>
              </div> : null}
            </div>
          </section>

          <section className="tasks-pr__fact">
            <h3 className="tasks-pr__section-title">Assignees</h3>
            <p>{assignees === null ? 'Unavailable' : assignees.length > 0 ? assignees.join(', ') : 'No one assigned'}</p>
          </section>

          <section className="tasks-pr__fact">
            <h3 className="tasks-pr__section-title">Labels</h3>
            {item.labels.length > 0 ? <div className="tasks-pr__labels">{item.labels.map((label) => <Badge key={label}>{label}</Badge>)}</div> : <p>None</p>}
          </section>

          <section className="tasks-pr__fact">
            <h3 className="tasks-pr__section-title">Worktree</h3>
            <p>{linkedName ?? 'None linked yet'}</p>
          </section>

          {changes ? (
            <section className="tasks-pr__fact">
              <h3 className="tasks-pr__section-title">Changes</h3>
              <p>{changes}</p>
            </section>
          ) : null}
        </div>
      </div>
    </article>
  )
}
