import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { formatTimestamp } from './format'

type Props = { context: UiPluginContext; input?: unknown }
const VIEW_STYLE = { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', padding: '1rem', gap: '0.75rem', color: 'var(--text, inherit)' } as const
const BUTTON_STYLE = { font: 'inherit', color: 'inherit', cursor: 'pointer' } as const

function initialQuery(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('query' in input)) return ''
  const query = input.query
  return typeof query === 'string' ? query : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSessionEvent(type: string): boolean {
  return type === 'quirky.session/changed' || type === 'quirky.session/removed' || type === 'quirky.session-info/changed'
}

export function HistoryView({ context, input }: Props) {
  const [query, setQuery] = useState(() => initialQuery(input))
  const [records, setRecords] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const requestRef = useRef(0)
  const aliveRef = useRef(true)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(async (value: string) => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await context.call('quirky.session-info/history', value.trim() === '' ? {} : { query: value }) as Session[]
      if (request !== requestRef.current) return
      setRecords(result)
      setLoading(false)
    } catch (cause) {
      if (request !== requestRef.current) return
      setLoading(false)
      setError(messageOf(cause))
    }
  }, [context])

  useEffect(() => {
    void load(query)
    return () => { requestRef.current++ }
  }, [load, query, refreshVersion])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (isSessionEvent(event.type)) setRefreshVersion((version) => version + 1)
    })
    return unsubscribe
  }, [context])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      requestRef.current++
      clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const runAction = useCallback(async (name: 'resume' | 'fork' | 'copy-resume-command', session: string) => {
    const key = `${session}:${name}`
    setActionErrors((current) => ({ ...current, [key]: '' }))
    try {
      await context.executeCommand(`command:quirky.session-info/${name}`, { session })
      if (name === 'copy-resume-command' && aliveRef.current) {
        setCopied(session)
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = undefined
          setCopied(null)
        }, 1500)
      }
    } catch (cause) {
      if (aliveRef.current) setActionErrors((current) => ({ ...current, [key]: messageOf(cause) }))
    }
  }, [context])

  return (
    <main aria-label="Session history" style={VIEW_STYLE}>
      <header>
        <h1 style={{ margin: '0 0 0.65rem', fontSize: '1.1rem' }}>Session history</h1>
        <label style={{ display: 'grid', gap: '0.3rem' }}>
          <span>Search sessions</span>
          <input aria-label="Search session history" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
      </header>
      {loading && <p role="status">Searching session history…</p>}
      {error && <div role="alert"><p>Could not load session history: {error}</p><button type="button" aria-label="Retry" style={BUTTON_STYLE} onClick={() => void load(query)}>Retry</button></div>}
      {!loading && !error && records.length === 0 && <p role="status">No matching sessions.</p>}
      {!loading && !error && records.length > 0 && <ol aria-label="Session results" style={{ overflowY: 'auto', minHeight: '0', margin: 0, paddingLeft: '1.5rem' }}>
        {records.map((record) => <li key={record.id} data-session={record.id} style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--border, #2b2f3a)' }}>
          <article>
            <h2 style={{ margin: '0 0 0.25rem', fontSize: '0.95rem', overflowWrap: 'anywhere' }}>{record.title || record.agent}</h2>
            <p style={{ margin: '0.2rem 0', color: 'var(--muted, #8a909e)' }}>{record.agent} · {record.status}{formatTimestamp(record.lastActivityAt) ? ` · ${formatTimestamp(record.lastActivityAt)}` : ''}</p>
            <p style={{ margin: '0.2rem 0', overflowWrap: 'anywhere' }}>Quirky ID: {record.id}</p>
            {record.providerSession?.id && <p style={{ margin: '0.2rem 0', overflowWrap: 'anywhere' }}>Provider ID: {record.providerSession.id}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', paddingTop: '0.45rem' }}>
              <button type="button" aria-label={`Resume ${record.id}`} style={BUTTON_STYLE} onClick={() => void runAction('resume', record.id)}>Resume</button>
              <button type="button" aria-label={`Fork ${record.id}`} style={BUTTON_STYLE} onClick={() => void runAction('fork', record.id)}>Fork</button>
              <button type="button" aria-label={`Copy resume command ${record.id}`} style={BUTTON_STYLE} onClick={() => void runAction('copy-resume-command', record.id)}>{copied === record.id ? 'Copied' : 'Copy resume command'}</button>
            </div>
            {(['resume', 'fork', 'copy-resume-command'] as const).map((name) => {
              const rowError = actionErrors[`${record.id}:${name}`]
              return rowError ? <p key={name} role="alert">{rowError}</p> : null
            })}
          </article>
        </li>)}
      </ol>}
    </main>
  )
}
