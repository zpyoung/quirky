import { useEffect, useState } from 'react'
import type { GitOperation } from '@quirky/protocol'
import { FixSplitButton, type FixButtonProps } from '../ai/FixSplitButton'

type OperationName = Exclude<GitOperation, 'none'>

const OPERATION_TITLES: Readonly<Record<OperationName, string>> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick'
}

type OperationProps = {
  operation: OperationName
  /** Live conflicts; the card shows while any remain, the banner once none do. */
  unresolved: number
  busy: boolean
  onReview(): void
  onContinue(): void
  onAbort(): void
  /** Resolve with AI, shown on the conflict card only. */
  fix?: FixButtonProps
}

/**
 * The merge, rebase or cherry-pick in progress. With unresolved conflicts it is the conflict card
 * (Review conflicts, Abort); with none it is the banner with Continue. A cherry-pick has no Abort.
 */
export function OperationCard({ operation, unresolved, busy, onReview, onContinue, onAbort, fix }: OperationProps) {
  const title = OPERATION_TITLES[operation]
  const abort = operation === 'cherry-pick' ? null : (
    <button type="button" disabled={busy} onClick={onAbort}>{`Abort ${operation}`}</button>
  )
  if (unresolved > 0) {
    return (
      <div className="scm-card scm-card-conflict" role="status">
        <strong>{`${title} conflicts: ${unresolved} unresolved`}</strong>
        <p className="muted">Resolved files move back to normal changes after they leave the live conflict state.</p>
        <div className="scm-card-actions">
          {fix && <FixSplitButton {...fix} />}
          <button type="button" onClick={onReview}>
            Review conflicts
          </button>
          {abort}
        </div>
      </div>
    )
  }
  return (
    <div className="scm-card" role="status">
      <strong>{`${title} in progress`}</strong>
      <div className="scm-card-actions">
        <button type="button" className="primary" disabled={busy} onClick={onContinue}>{`Continue ${operation}`}</button>
        {abort}
      </div>
    </div>
  )
}

/** The banner for a status that stopped at its entry limit. */
export function HugeBanner({ onStageAll, onRetry }: { onStageAll(): void; onRetry(): Promise<void> }) {
  const [retrying, setRetrying] = useState(false)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!retrying) return setSlow(false)
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [retrying])
  const retry = async () => {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div className="scm-card scm-card-warning" role="status">
      <strong>Too many changes detected. Only the first 1000 are shown.</strong>
      <div className="scm-card-actions">
        <button type="button" onClick={onStageAll}>
          Stage All
        </button>
        <button type="button" disabled={retrying} onClick={() => void retry()}>
          {slow ? <span className="scm-spinner" aria-label="Refreshing" /> : 'Retry'}
        </button>
      </div>
    </div>
  )
}

type BlockedProps = {
  title: 'Commit blocked' | 'Push blocked'
  pill: 'Lint' | 'Hook'
  summary: string
  /** Null when the summary says everything the output does. */
  onDetails: (() => void) | null
  /** AI Fix for the failure. */
  fix?: FixButtonProps
}

/** The card for a commit or push a hook refused, with the hook's summary and a Details button. */
export function BlockedCard({ title, pill, summary, onDetails, fix }: BlockedProps) {
  return (
    <div className="scm-card scm-card-blocked" role="alert">
      <div className="scm-card-head">
        <strong>{title}</strong>
        <span className="scm-pill">{pill}</span>
      </div>
      <p className="scm-summary">{summary}</p>
      {(fix || onDetails) && (
        <div className="scm-card-actions">
          {fix && <FixSplitButton {...fix} />}
          {onDetails && (
            <button type="button" onClick={onDetails}>
              Details
            </button>
          )}
        </div>
      )}
    </div>
  )
}

type UnavailableProps = {
  message: string
  /** The standalone card shown when there are no uncommitted changes either. */
  standalone: boolean
  onChangeBase(): void
  onRetry(): void
}

/** Why branch compare cannot run, with Change base ref and Retry. */
export function CompareUnavailable({ message, standalone, onChangeBase, onRetry }: UnavailableProps) {
  return (
    <div className={standalone ? 'scm-card' : 'scm-note'} role="status">
      {standalone && <strong>Branch compare unavailable</strong>}
      <p className="muted">{message}</p>
      <div className="scm-card-actions">
        <button type="button" onClick={onChangeBase}>
          Change base ref
        </button>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}

/** The clean-workspace message. */
export function CleanState({ base }: { base: string | null }) {
  return (
    <div className="scm-empty">
      <strong>No changes on this branch</strong>
      <p className="muted">{`This workspace is clean and this branch has no changes ahead of ${base ?? 'its base'}`}</p>
    </div>
  )
}
