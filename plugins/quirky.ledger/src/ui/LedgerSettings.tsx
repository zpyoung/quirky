import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, EmptyState, InlineError, NoticeLine, TextField, SectionHeader } from '@quirky/ui'
import { currentRevisionOf, errorMessage, ledgerRequest } from './api'
import { ledgerStyles as styles } from './styles'
import type { LedgerResponse } from './types'

function repoIdFrom(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('repoId' in input) || typeof input.repoId !== 'string') return ''
  return input.repoId
}

function fetchLedgerSettings(context: UiPluginContext, repoId: string): Promise<LedgerResponse> {
  return ledgerRequest(context, { operation: 'list', target: { owner: { tier: 'project', id: repoId } } })
}

function saveLedgerSettings(context: UiPluginContext, repoId: string, revision: number, staleAfterDays: number): Promise<LedgerResponse> {
  return ledgerRequest(context, {
    operation: 'settings',
    target: { owner: { tier: 'project', id: repoId } },
    ifLedgerRevision: revision,
    staleAfterDays
  })
}

async function load(
  context: UiPluginContext,
  repoId: string,
  generation: { current: number },
  setError: (value: string) => void,
  setResponse: (value: LedgerResponse | null) => void,
  setDays: (value: string) => void
): Promise<void> {
  const current = ++generation.current
  setError('')
  if (!repoId) {
    setError('A repository is required to load ledger settings.')
    setResponse(null)
    return
  }
  try {
    const next = await fetchLedgerSettings(context, repoId)
    if (generation.current !== current) return
    setResponse(next)
    setDays(String(next.ledger?.staleAfterDays ?? 90))
  } catch (reason) {
    if (generation.current === current) {
      setError(errorMessage(reason))
      setResponse(null)
    }
  }
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
  useEffect(() => {
    void load(context, repoId, generation, setError, setResponse, setDays)
    return () => { generation.current++ }
  }, [context, repoId])
  useEffect(() => context.subscribe((event) => {
    if (event.type.startsWith('quirky.ledger/')) void load(context, repoId, generation, setError, setResponse, setDays)
  }), [context, repoId])

  async function save() {
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
      const next = await saveLedgerSettings(context, repoId, response.ledger.revision, value)
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
    <section style={{ ...styles.root, ...styles.settings }} aria-label="Ledger settings">
      <SectionHeader title="Ledger Staleness" />
      {!response && !error && <NoticeLine>Loading ledger settings…</NoticeLine>}
      {error && <InlineError message={error} action={{ label: response ? 'Reload' : 'Retry', onAction: () => void load(context, repoId, generation, setError, setResponse, setDays) }} />}
      {response?.ledger ? <>
        <TextField
          label="Ledger Staleness"
          help="Days without activity before an entry is flagged stale. The default is 90 days."
          type="number" min="0" max="3650" step="1" value={days}
          onChange={(event) => { setDays(event.target.value); setSaved(false) }}
        />
        <div style={styles.actions}>
          <Button variant="primary" disabled={busy || days === String(response.ledger.staleAfterDays)} onClick={() => void save()}>Save</Button>
          {saved && <span role="status">Saved</span>}
        </div>
      </> : response && <EmptyState message="This project has no ledger yet. File an entry to create one." />}
    </section>
  )
}
