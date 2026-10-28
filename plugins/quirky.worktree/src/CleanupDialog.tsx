import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { CleanupCandidate, CleanupRemovalResult, CleanupSelection } from './control-types'
import { Dialog } from './Dialog'

type Preview = { generatedAt: number; candidates: CleanupCandidate[] }
type Props = { context: UiPluginContext; onClose(): void }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CleanupDialog({ context, onClose }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [results, setResults] = useState<CleanupRemovalResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const candidates = preview?.candidates ?? []
  const ignoredCount = useMemo(() => candidates.filter((candidate) => candidate.ignored).length, [candidates])
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.eligible && !candidate.ignored && selected.has(candidate.worktreeId)),
    [candidates, selected]
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await context.call('quirky.worktree/cleanupPreview') as Preview
      setPreview(next)
      setSelected((current) => new Set([...current].filter((id) => next.candidates.some((candidate) => candidate.worktreeId === id && candidate.eligible && !candidate.ignored))))
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [context])

  useEffect(() => { void refresh() }, [refresh])

  const toggleSelected = (candidate: CleanupCandidate, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(candidate.worktreeId)
      else next.delete(candidate.worktreeId)
      return next
    })
  }

  const ignore = async (candidate: CleanupCandidate) => {
    setBusy(true)
    try {
      await context.call('quirky.worktree/cleanupIgnore', { worktreeId: candidate.worktreeId, fingerprint: candidate.fingerprint })
      setResults([])
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    setBusy(true)
    try {
      await context.call('quirky.worktree/cleanupRestoreIgnored')
      setResults([])
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  const removeSelected = async () => {
    if (selectedCandidates.length === 0) return
    const names = selectedCandidates.map((candidate) => candidate.name).join(', ')
    const accepted = await context.confirm({
      title: 'Delete selected worktrees?',
      body: `This permanently removes ${names} through the normal safe worktree removal path. No force-delete or unverified-session bypass will be used.`,
      confirmLabel: 'Delete selected'
    })
    if (!accepted) return
    const selection: CleanupSelection[] = selectedCandidates.map(({ worktreeId, fingerprint }) => ({ worktreeId, fingerprint }))
    setBusy(true)
    try {
      const response = await context.call('quirky.worktree/cleanupRemove', { selection, confirmed: true, yes: true }) as { results: CleanupRemovalResult[] }
      setResults(response.results)
      setSelected(new Set(response.results.filter((result) => !result.removed).map((result) => result.worktreeId)))
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Review worktree cleanup" onClose={() => { if (!busy) onClose() }} wide>
      <section className="cleanup-dialog">
        <header>
          <p>Inspect current blockers before permanently deleting selected local worktrees.</p>
        </header>
        <div className="cleanup-actions">
          <button type="button" disabled={busy || ignoredCount === 0} onClick={() => void restore()}>Restore ignored suggestions</button>
          <button type="button" disabled={busy || loading} onClick={() => void refresh()}>Refresh preview</button>
        </div>
        {loading && <p className="muted" role="status">Checking current worktree safety…</p>}
        {error && <p className="cleanup-error" role="alert">{error}</p>}
        {!loading && !error && candidates.length === 0 && <p className="muted">No idle cleanup candidates.</p>}
        <ul className="cleanup-candidates">
          {candidates.map((candidate) => (
            <li key={candidate.worktreeId} className={candidate.eligible ? 'cleanup-candidate eligible' : 'cleanup-candidate blocked'}>
              <label className="cleanup-candidate-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${candidate.name}`}
                  checked={selected.has(candidate.worktreeId)}
                  disabled={busy || loading || !candidate.eligible || candidate.ignored}
                  onChange={(event) => toggleSelected(candidate, event.currentTarget.checked)}
                />
                <span className="cleanup-candidate-name">{candidate.name}</span>
              </label>
              <span className="cleanup-candidate-reason">{candidate.reason === 'idle-clean' ? 'Idle for at least 30 days' : candidate.reason}</span>
              {candidate.blockers.length > 0 && (
                <ul className="cleanup-blockers">
                  {candidate.blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}><strong>{blocker.code}</strong>: {blocker.detail}</li>)}
                </ul>
              )}
              {candidate.ignored
                ? <span className="cleanup-ignored">Ignored</span>
                : <button type="button" disabled={busy || loading} onClick={() => void ignore(candidate)}>Ignore {candidate.name}</button>}
            </li>
          ))}
        </ul>
        {results.length > 0 && (
          <ul className="cleanup-results" aria-label="Cleanup results">
            {results.map((result) => (
              <li key={result.worktreeId} className={result.removed ? 'cleanup-result removed' : 'cleanup-result failed'}>
                {result.removed ? `Removed ${result.worktreeId}` : `Kept ${result.worktreeId}: ${result.error ?? 'not removed'}`}
              </li>
            ))}
          </ul>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>Close</button>
          <button type="button" disabled={busy || selectedCandidates.length === 0} onClick={() => void removeSelected()}>
            Delete selected
          </button>
        </footer>
      </section>
    </Dialog>
  )
}
