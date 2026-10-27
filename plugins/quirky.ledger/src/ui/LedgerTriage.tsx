import type { LedgerCandidate, LedgerSelection, LedgerState } from './types'

export function LedgerTriage({
  candidates,
  selections,
  conflict,
  error,
  busy,
  onToggle,
  onApprove,
  onBulkState,
  onRetry,
  onClose
}: {
  candidates: LedgerCandidate[]
  selections: LedgerSelection[]
  conflict: string
  error: string
  busy: boolean
  onToggle(candidate: LedgerCandidate): void
  onApprove(): void
  onBulkState(state: Extract<LedgerState, 'resolved' | 'archived'>): void
  onRetry(): void
  onClose(): void
}) {
  const selected = new Set(selections.map((selection) => `${selection.id}@${selection.revision}`))
  return (
    <div className="ledger-modal-backdrop" role="presentation">
      <section className="ledger-dialog" role="dialog" aria-modal="true" aria-label="Operation review">
        <header className="ledger-dialog-header">
          <h2>Operation review</h2>
          <p>Advisory triage for the selected runtime, target, and filters. No entries are auto-resolved.</p>
          {conflict && <p className="ledger-form-conflict" role="alert">Review changed while you were acting: {conflict}. Revisions changed; review the refreshed candidates before confirming again.</p>}
          {error && <p className="ledger-error" role="alert">Could not load review candidates: {error} <button type="button" onClick={onRetry}>Retry</button></p>}
        </header>
        <div className="ledger-dialog-body">
          {candidates.length === 0 ? <p className="ledger-empty">{busy ? 'Loading review candidates…' : 'No review candidates match these filters.'}</p> : (
            <ul className="ledger-candidate-list">
              {candidates.map((candidate) => {
                const entry = candidate.entry
                const key = `${entry.id}@${entry.revision}`
                return (
                  <li className="ledger-candidate-row" key={key}>
                    <label className="ledger-check-row">
                      <input type="checkbox" checked={selected.has(key)} onChange={() => onToggle(candidate)} />
                      <span><strong>{entry.id}</strong> · {String(entry.content.title ?? '')}</span>
                    </label>
                    <p className="ledger-row-meta">
                      <span>{entry.type}</span> · <span>{entry.state}</span> · revision {entry.revision} · updated {new Date(entry.updatedAt).toLocaleString()}
                    </p>
                    <p>Reason: {candidate.reason} · {candidate.stale ? <span className="ledger-badge stale">stale</span> : 'fresh'}</p>
                    {candidate.evidence && <div className="ledger-evidence">
                      <div>Origin baseline: {candidate.evidence.baselineRevision ?? 'unavailable'} · current: {candidate.evidence.observedRevision ?? 'unavailable'}</div>
                      <div>Recorded file: {candidate.evidence.fileExists === undefined ? 'unavailable' : candidate.evidence.fileExists ? 'present' : 'missing'}</div>
                      <div>Evidence: {candidate.evidence.note ?? (candidate.evidence.available ? 'Evidence available.' : 'Evidence unavailable.')}</div>
                    </div>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <footer className="ledger-dialog-actions">
          <button type="button" disabled={busy || selections.length === 0} onClick={onApprove}>Approve review ({selections.length})</button>
          <button type="button" disabled={busy || selections.length === 0} onClick={() => onBulkState('resolved')}>Resolve</button>
          <button type="button" disabled={busy || selections.length === 0} onClick={() => onBulkState('archived')}>Archive</button>
          <button type="button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  )
}
