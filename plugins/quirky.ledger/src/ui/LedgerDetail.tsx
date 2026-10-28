import { useState } from 'react'
import type { LedgerActor, LedgerEntry, LedgerState, LedgerType } from './types'

const TYPE_NAMES: Record<LedgerType, string> = {
  bug: 'Bug',
  deferred: 'Deferred',
  'test-gap': 'Test gap',
  proposal: 'Proposal',
  decision: 'Decision'
}

function actorLabel(actor: LedgerActor | null | undefined): string {
  if (!actor) return 'Unknown actor'
  const identity = [actor.kind, actor.model, actor.providerSessionId, actor.tool].filter((value) => typeof value === 'string' && value !== '').join(' · ') || 'Unknown actor'
  return actor.initiator ? `${identity} · initiated by ${actorLabel(actor.initiator)}` : identity
}

function locationText(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string') return null
  const location = value as { path: string; line?: number; base?: { kind?: string; id?: string }; host?: string; external?: boolean }
  return [
    `${location.path}${typeof location.line === 'number' ? `:${location.line}` : ''}`,
    location.base ? `${location.base.kind ?? 'base'} ${location.base.id ?? ''}`.trim() : '',
    location.host ?? '',
    location.external ? 'external' : ''
  ].filter(Boolean).join(' · ')
}

function Content({ content }: { content: Record<string, unknown> }) {
  return <dl className="ledger-content-list">
    {Object.entries(content).map(([key, value]) => {
      const location = locationText(value)
      return <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{location ?? (typeof value === 'string' ? value : JSON.stringify(value))}</dd></div>
    })}
  </dl>
}

export function LedgerDetail({
  entry,
  busy,
  error,
  onEdit,
  onReview,
  onState,
  onRevert,
  onClose
}: {
  entry: LedgerEntry
  busy: boolean
  error?: string
  onEdit(): void
  onReview(): void
  onState(state: LedgerState): void
  onRevert(revision: number): void
  onClose(): void
}) {
  const [revertTo, setRevertTo] = useState('')
  const summary = `Revision ${entry.revision} · sequence ${entry.sequence} · updated ${new Date(entry.updatedAt).toLocaleString()}`
  return (
    <div className="ledger-modal-backdrop" role="presentation">
      <section className="ledger-dialog ledger-detail-dialog" role="dialog" aria-modal="true" aria-label={`Ledger entry ${entry.id}`}>
        <header className="ledger-dialog-header">
          <h2>{entry.id}</h2>
          <p>{summary}</p>
          {error && <p role="alert" className="ledger-error">{error}</p>}
        </header>
        <div className="ledger-detail-body">
          <section aria-label="Entry">
            <h3>Entry</h3>
            <p>{TYPE_NAMES[entry.type]} · {entry.state} · {entry.reviewed ? 'Reviewed' : 'Unreviewed'}</p>
          </section>
          <section aria-label="Origin">
            <h3>Origin</h3>
            <dl>
              <div><dt>Workspace</dt><dd>{entry.origin.workspaceId ?? 'Not recorded'}</dd></div>
              <div><dt>Owner</dt><dd>{entry.origin.owner ? `${entry.origin.owner.tier} ${entry.origin.owner.id}` : 'Not recorded'}</dd></div>
              <div><dt>Branch</dt><dd>{entry.origin.branch ?? 'Not recorded'}</dd></div>
              <div><dt>Host</dt><dd>{entry.origin.host ?? 'Not recorded'}</dd></div>
              <div><dt>Baseline revision</dt><dd>{entry.origin.revision ?? 'Not recorded'}</dd></div>
              <div><dt>Observed</dt><dd>{entry.origin.observedAt ?? 'Not recorded'}</dd></div>
            </dl>
          </section>
          <section aria-label="Content">
            <h3>Content</h3>
            <Content content={entry.content} />
          </section>
          <section aria-label="Latest content actor">
            <h3>Latest content actor</h3>
            <p>{actorLabel(entry.latestContentActor)}</p>
          </section>
          <section aria-label="Full history">
            <h3>Full history · {entry.history.length} revisions</h3>
            {entry.history.map((change) => (
              <details className="ledger-history-revision" key={change.revision} open={change.revision === entry.revision}>
                <summary>Revision {change.revision} · {new Date(change.at).toLocaleString()} · {actorLabel(change.actor)}</summary>
                <p>Changed: {change.changedFields.join(', ') || 'created'}</p>
                <details><summary>Before</summary><pre>{JSON.stringify(change.before, null, 2)}</pre></details>
                <details><summary>After</summary><pre>{JSON.stringify(change.after, null, 2)}</pre></details>
              </details>
            ))}
          </section>
        </div>
        <footer className="ledger-dialog-actions ledger-detail-actions">
          <button type="button" disabled={busy} onClick={onEdit}>Edit</button>
          <button type="button" disabled={busy || entry.reviewed} onClick={onReview}>{entry.reviewed ? 'Reviewed' : 'Review'}</button>
          {(['open', 'resolved', 'archived'] as LedgerState[]).map((state) => (
            <button type="button" key={state} disabled={busy || entry.state === state} onClick={() => onState(state)}>
              {state[0]!.toUpperCase() + state.slice(1)}
            </button>
          ))}
          <label className="ledger-revert-control">
            <span>Revert to revision</span>
            <select value={revertTo} onChange={(event) => setRevertTo(event.target.value)} disabled={busy}>
              <option value="">Choose revision</option>
              {entry.history.filter((change) => change.revision !== entry.revision).map((change) => (
                <option key={change.revision} value={change.revision}>Revision {change.revision}</option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !revertTo} onClick={() => onRevert(Number(revertTo))}>Revert</button>
          <button type="button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  )
}
