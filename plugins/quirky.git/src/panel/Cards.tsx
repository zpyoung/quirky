import { useEffect, useState } from 'react'
import type { GitOperation } from '@quirky/protocol'
import { Badge, Button, EmptyState, InlineAgentCard } from '@quirky/ui'
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
    <Button disabled={busy} onClick={onAbort}>{`Abort ${operation}`}</Button>
  )
  if (unresolved > 0) {
    return (
      <div role="status">
        <InlineAgentCard
          title={`${title} conflicts: ${unresolved} unresolved`}
          status="needs-you"
          description={
            <div className="ui-stack">
              <p>Resolved files move back to normal changes after they leave the live conflict state.</p>
              <div className="ui-cluster">
                <Button variant="primary" onClick={onReview}>Review conflicts</Button>
                {fix && <FixSplitButton {...fix} />}
                {abort}
              </div>
            </div>
          }
        />
      </div>
    )
  }
  return (
    <div role="status">
      <InlineAgentCard
        title={`${title} in progress`}
        status="working"
        description={abort}
        action={{ label: `Continue ${operation}`, onAction: onContinue, disabled: busy }}
      />
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
    <div role="status">
      <InlineAgentCard
        title="Too many changes detected. Only the first 1000 are shown."
        status="needs-you"
        description={
          <Button disabled={retrying} onClick={() => void retry()}>
            {slow ? <span role="status" aria-label="Refreshing">◌</span> : 'Retry'}
          </Button>
        }
        action={{ label: 'Stage All', onAction: onStageAll }}
      />
    </div>
  )
}

type BlockedProps = {
  title: 'Commit blocked' | 'Push blocked'
  pill: 'Lint' | 'Hook' | 'Failed'
  summary: string
  /** Null when the summary says everything the output does. */
  onDetails: (() => void) | null
  /** AI Fix for the failure. */
  fix?: FixButtonProps
}

/** The card for a commit or push a hook refused, or a commit failure, with its summary and Details when available. */
export function BlockedCard({ title, pill, summary, onDetails, fix }: BlockedProps) {
  return (
    <div role="alert">
      <InlineAgentCard
        title={title}
        status="failing"
        description={
          <div className="ui-stack">
            <div className="ui-cluster">
              <Badge tone="failing" label={pill}>{pill}</Badge>
              <span>{summary}</span>
            </div>
            {(fix || onDetails) && (
              <div className="ui-cluster">
                {fix && <FixSplitButton {...fix} />}
                {onDetails && <Button onClick={onDetails}>Details</Button>}
              </div>
            )}
          </div>
        }
      />
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

export function CompareUnavailable({ message, standalone, onChangeBase, onRetry }: UnavailableProps) {
  const controls = (
    <div className="ui-cluster">
      <Button onClick={onChangeBase}>Change base ref</Button>
      <Button onClick={onRetry}>Retry</Button>
    </div>
  )
  if (!standalone) {
    return (
      <div className="ui-stack" role="status">
        <p>{message}</p>
        {controls}
      </div>
    )
  }
  return (
    <div role="status">
      <InlineAgentCard
        title="Branch compare unavailable"
        status="failing"
        description={
          <div className="ui-stack">
            <p>{message}</p>
            {controls}
          </div>
        }
      />
    </div>
  )
}

/** The clean-workspace message. */
export function CleanState({ onOpenTerminal }: { onOpenTerminal(): void }) {
  return <EmptyState message="No changes" action={{ label: 'Open terminal', onAction: onOpenTerminal }} />
}
