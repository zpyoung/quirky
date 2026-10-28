import { createPortal } from 'react-dom'
import { Badge, Button, Dialog, EmptyState } from '@quirky/ui'
import { ledgerStyles } from './styles'
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
  return createPortal(
    <Dialog
      open
      scrollBody
      title="Operation review"
      closeOnBackdrop={false}
      onClose={onClose}
      actions={
        <div style={ledgerStyles.actions}>
          <Button variant="primary" disabled={busy || selections.length === 0} onClick={onApprove}>Approve review ({selections.length})</Button>
          <Button disabled={busy || selections.length === 0} onClick={() => onBulkState('resolved')}>Resolve</Button>
          <Button disabled={busy || selections.length === 0} onClick={() => onBulkState('archived')}>Archive</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div style={ledgerStyles.stack}>
        <p>Advisory triage for the selected runtime, target, and filters. No entries are auto-resolved.</p>
        {conflict && <p style={ledgerStyles.error} role="alert">Review changed while you were acting: {conflict}. Revisions changed; review the refreshed candidates before confirming again.</p>}
        {error && <p style={ledgerStyles.error} role="alert">Could not load review candidates: {error} <Button onClick={onRetry}>Retry</Button></p>}
        {candidates.length === 0 ? <EmptyState message={busy ? 'Loading review candidates…' : 'No review candidates match these filters.'} /> : (
          <ul style={ledgerStyles.list}>
            {candidates.map((candidate) => {
              const entry = candidate.entry
              const key = `${entry.id}@${entry.revision}`
              return (
                <li style={ledgerStyles.row} key={key}>
                  <label style={ledgerStyles.check}>
                    <input type="checkbox" style={ledgerStyles.checkbox} checked={selected.has(key)} onChange={() => onToggle(candidate)} />
                    <span><strong>{entry.id}</strong> · {String(entry.content.title ?? '')}</span>
                  </label>
                  <p style={ledgerStyles.meta}>
                    <span>{entry.type}</span> · <span>{entry.state}</span> · revision {entry.revision} · updated {new Date(entry.updatedAt).toLocaleString()}
                  </p>
                  <p>Reason: {candidate.reason} · <Badge tone={candidate.stale ? 'needs-you' : 'neutral'}>{candidate.stale ? 'stale' : 'fresh'}</Badge></p>
                  {candidate.evidence && <div style={ledgerStyles.stack}>
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
    </Dialog>,
    document.body
  )
}
