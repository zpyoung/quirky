import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Badge, Button, Dialog, FormRow, SectionHeader } from '@quirky/ui'
import { ledgerStyles } from './styles'
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
  return <dl style={ledgerStyles.definitionList}>
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
  const revertId = useId()
  const [revertTo, setRevertTo] = useState('')
  const summary = `Revision ${entry.revision} · sequence ${entry.sequence} · updated ${new Date(entry.updatedAt).toLocaleString()}`
  return createPortal(
    <Dialog
      open
      scrollBody
      title={`Ledger entry ${entry.id}`}
      closeOnBackdrop={false}
      onClose={onClose}
      actions={
        <div style={ledgerStyles.actions}>
          <Button disabled={busy} onClick={onEdit}>Edit</Button>
          <Button disabled={busy || entry.reviewed} onClick={onReview}>{entry.reviewed ? 'Reviewed' : 'Review'}</Button>
          {(['open', 'resolved', 'archived'] as LedgerState[]).map((state) => (
            <Button key={state} disabled={busy || entry.state === state} onClick={() => onState(state)}>
              {state[0]!.toUpperCase() + state.slice(1)}
            </Button>
          ))}
          <FormRow label="Revert to revision" htmlFor={revertId}>
            <select id={revertId} className="ui-text-field__input" value={revertTo} onChange={(event) => setRevertTo(event.target.value)} disabled={busy}>
              <option value="">Choose revision</option>
              {entry.history.filter((change) => change.revision !== entry.revision).map((change) => (
                <option key={change.revision} value={change.revision}>Revision {change.revision}</option>
              ))}
            </select>
          </FormRow>
          <Button disabled={busy || !revertTo} onClick={() => onRevert(Number(revertTo))}>Revert</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div style={ledgerStyles.stack}>
        <p style={ledgerStyles.meta}>{summary}</p>
        {error && <p role="alert" style={ledgerStyles.error}>{error}</p>}
        <section aria-label="Entry" style={ledgerStyles.section}>
          <SectionHeader title="Entry" />
          <p>{TYPE_NAMES[entry.type]} · {entry.state} · <Badge tone={entry.reviewed ? 'accent' : 'needs-you'}>{entry.reviewed ? 'Reviewed' : 'Unreviewed'}</Badge></p>
        </section>
        <section aria-label="Origin" style={ledgerStyles.section}>
          <SectionHeader title="Origin" />
          <dl style={ledgerStyles.definitionList}>
            <div><dt>Workspace</dt><dd>{entry.origin.workspaceId ?? 'Not recorded'}</dd></div>
            <div><dt>Owner</dt><dd>{entry.origin.owner ? `${entry.origin.owner.tier} ${entry.origin.owner.id}` : 'Not recorded'}</dd></div>
            <div><dt>Branch</dt><dd>{entry.origin.branch ?? 'Not recorded'}</dd></div>
            <div><dt>Host</dt><dd>{entry.origin.host ?? 'Not recorded'}</dd></div>
            <div><dt>Baseline revision</dt><dd>{entry.origin.revision ?? 'Not recorded'}</dd></div>
            <div><dt>Observed</dt><dd>{entry.origin.observedAt ?? 'Not recorded'}</dd></div>
          </dl>
        </section>
        <section aria-label="Content" style={ledgerStyles.section}>
          <SectionHeader title="Content" />
          <Content content={entry.content} />
        </section>
        <section aria-label="Latest content actor" style={ledgerStyles.section}>
          <SectionHeader title="Latest content actor" />
          <p>{actorLabel(entry.latestContentActor)}</p>
        </section>
        <section aria-label="Full history" style={ledgerStyles.section}>
          <SectionHeader title={`Full history · ${entry.history.length} revisions`} />
          {entry.history.map((change) => (
            <details style={ledgerStyles.history} key={change.revision} open={change.revision === entry.revision}>
              <summary>Revision {change.revision} · {new Date(change.at).toLocaleString()} · {actorLabel(change.actor)}</summary>
              <p>Changed: {change.changedFields.join(', ') || 'created'}</p>
              <details><summary>Before</summary><pre style={ledgerStyles.code}>{JSON.stringify(change.before, null, 2)}</pre></details>
              <details><summary>After</summary><pre style={ledgerStyles.code}>{JSON.stringify(change.after, null, 2)}</pre></details>
            </details>
          ))}
        </section>
      </div>
    </Dialog>,
    document.body
  )
}
