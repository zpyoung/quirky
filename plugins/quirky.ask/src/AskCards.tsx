import { useSyncExternalStore } from 'react'
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

export function AskCards({ store, context }: { store: AskStore; context: UiPluginContext }) {
  const asks = useSyncExternalStore(store.subscribe, store.get)
  const flashes = useSyncExternalStore(store.subscribe, store.flashes)
  return (
    <div className="ask-stack" style={{ position: 'static', width: 'auto', maxHeight: 'none', overflowY: 'visible' }}>
      {flashes.map(({ ask }) => (
        <article className="ask-result" data-ask-result={ask.id} role="status" aria-live="polite" aria-label={`${ask.spec.title ?? 'Question'}: ${RESULT_LABELS[ask.envelope.status]}`} key={`result:${ask.id}`}>
          <h3>{ask.spec.title ?? 'Question'}</h3>
          <p><strong>{RESULT_LABELS[ask.envelope.status]}</strong></p>
          {ask.envelope.summary && <p style={{ whiteSpace: 'pre-wrap' }}>{ask.envelope.summary}</p>}
          {ask.envelope.status === 'unavailable' && <p>{ask.envelope.reason}</p>}
        </article>
      ))}
      {asks.length === 0 ? (
        <p className="muted">No pending questions.</p>
      ) : (
        asks.map((ask) => (
          <AskCard key={ask.id} ask={ask} context={context} onResolved={store.resolve} />
        ))
      )}
    </div>
  )
}
