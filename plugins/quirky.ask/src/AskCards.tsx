import { useSyncExternalStore } from 'react'
import { Badge, EmptyState, SectionHeader, StatusDot, type UiStatus, type UiTone } from '@quirky/ui'
import type { AskEnvelope, UiPluginContext } from '@quirky/protocol'
import { AskCard } from './AskCard'
import type { AskStore } from './store'

const RESULT_LABELS: Record<AskEnvelope['status'], string> = {
  pending: 'Pending',
  answered: 'Answered',
  partial: 'Partially answered',
  declined: 'Declined',
  timed_out: 'Timed out',
  unavailable: 'Unavailable'
}

const RESULT_STATUSES: Record<AskEnvelope['status'], UiStatus> = {
  pending: 'needs-you',
  answered: 'done',
  partial: 'done',
  declined: 'idle',
  timed_out: 'idle',
  unavailable: 'failing'
}

const RESULT_TONES: Record<AskEnvelope['status'], UiTone> = {
  pending: 'needs-you',
  answered: 'accent',
  partial: 'accent',
  declined: 'neutral',
  timed_out: 'neutral',
  unavailable: 'failing'
}

const STACK_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-12)',
  width: '100%',
  minWidth: 0,
  maxHeight: '100%',
  overflowY: 'auto',
  padding: 'var(--ui-space-12)',
  boxSizing: 'border-box'
} as const

const RESULT_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  minWidth: 0,
  padding: 'var(--ui-space-12)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-surface)'
} as const

const STATUS_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-6)',
  minWidth: 0
} as const

const SUMMARY_STYLE = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const

export function AskCards({ store, context }: { store: AskStore; context: UiPluginContext }) {
  const asks = useSyncExternalStore(store.subscribe, store.get)
  const flashes = useSyncExternalStore(store.subscribe, store.flashes)
  return (
    <div style={STACK_STYLE}>
      {flashes.map(({ ask }) => (
        <article
          data-ask-result={ask.id}
          role="status"
          aria-live="polite"
          aria-label={`${ask.spec.title ?? 'Question'}: ${RESULT_LABELS[ask.envelope.status]}`}
          key={`result:${ask.id}`}
          style={RESULT_STYLE}
        >
          <SectionHeader title={ask.spec.title ?? 'Question'} />
          <div style={STATUS_STYLE}>
            <StatusDot status={RESULT_STATUSES[ask.envelope.status]} />
            <Badge tone={RESULT_TONES[ask.envelope.status]}>{RESULT_LABELS[ask.envelope.status]}</Badge>
          </div>
          {ask.envelope.summary && (
            <p style={SUMMARY_STYLE}>{ask.envelope.summary}</p>
          )}
          {ask.envelope.status === 'unavailable' && <p>{ask.envelope.reason}</p>}
        </article>
      ))}
      {asks.length === 0 ? (
        <EmptyState message="No pending questions." />
      ) : (
        asks.map((ask) => (
          <AskCard key={ask.id} ask={ask} context={context} onResolved={store.resolve} />
        ))
      )}
    </div>
  )
}
