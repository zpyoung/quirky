import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { currentRevisionOf, errorMessage, ledgerRequest } from './api'
import { LEDGER_CSS } from './styles'
import type { LedgerResponse } from './types'

function repoIdFrom(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('repoId' in input) || typeof input.repoId !== 'string') return ''
  return input.repoId
}

export function LedgerSettings({ context, input, report }: { context: UiPluginContext; input?: unknown; report?(state: unknown): void }) {
  const repoId = repoIdFrom(input)
  useEffect(() => report?.({ view: 'settings', target: repoId ? { owner: { tier: 'project', id: repoId } } : undefined, scope: null, filters: {}, sort: 'activity', selection: [], dialog: 'settings' }), [report, repoId])
  const [response, setResponse] = useState<LedgerResponse | null>(null)
  const [days, setDays] = useState('90')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const load = useCallback(async () => {
    const current = ++generation.current
    setError('')
    if (!repoId) {
      setError('A repository is required to load ledger settings.')
      setResponse(null)
      return
    }
    try {
      const next = await ledgerRequest(context, { operation: 'list', target: { owner: { tier: 'project', id: repoId } } })
      if (generation.current !== current) return
      setResponse(next)
      setDays(String(next.ledger?.staleAfterDays ?? 90))
    } catch (reason) {
      if (generation.current === current) {
        setError(errorMessage(reason))
        setResponse(null)
      }
    }
  }, [context, repoId])

  useEffect(() => {
    void load()
    return () => { generation.current++ }
  }, [load])
  useEffect(() => context.subscribe((event) => {
    if (event.type.startsWith('quirky.ledger/')) void load()
  }), [context, load])

  const save = async () => {
    if (!response?.ledger) return
    if (!days.trim()) {
      setError('Enter an integer from 0 to 3650 days.')
      return
    }
    const value = Number(days)
    if (!Number.isSafeInteger(value) || value < 0 || value > 3650) {
      setError('Enter an integer from 0 to 3650 days.')
      return
    }
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      const next = await ledgerRequest(context, {
        operation: 'settings',
        target: { owner: { tier: 'project', id: repoId } },
        ifLedgerRevision: response.ledger.revision,
        staleAfterDays: value
      })
      setResponse(next)
      setDays(String(next.ledger?.staleAfterDays ?? value))
      setSaved(true)
    } catch (reason) {
      const currentRevision = currentRevisionOf(reason)
      setError(currentRevision === null ? errorMessage(reason) : `Ledger settings changed at revision ${currentRevision}. Reload before saving.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ledger-root ledger-settings" aria-label="Ledger settings">
      <style>{LEDGER_CSS}</style>
      <h2>Ledger Staleness</h2>
      {!response && !error && <p className="ledger-muted">Loading ledger settings…</p>}
      {error && <p role="alert" className="ledger-error">{error}</p>}
      {response?.ledger ? <>
        <p className="ledger-muted">Days without activity before an entry is flagged stale. The default is 90 days.</p>
        <label>
          <span>Ledger Staleness</span>
          <input type="number" min="0" max="3650" step="1" value={days} onChange={(event) => { setDays(event.target.value); setSaved(false) }} />
        </label>
        <div className="ledger-settings-actions">
          <button type="button" className="primary" disabled={busy || days === String(response.ledger.staleAfterDays)} onClick={() => void save()}>Save</button>
          {saved && <span role="status">Saved</span>}
          {error && <button type="button" onClick={() => void load()}>Reload</button>}
        </div>
      </> : response && <p className="ledger-muted">This project has no ledger yet. File an entry to create one.</p>}
      {error && !response && <button type="button" onClick={() => void load()}>Retry</button>}
    </section>
  )
}
