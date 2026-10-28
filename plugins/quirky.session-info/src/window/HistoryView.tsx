import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { Button, EmptyState, ListRow, TextField, ToolPanelFrame } from '@quirky/ui'
import { formatTimestamp } from './format'

type Props = { context: UiPluginContext; input?: unknown }
const VIEW_STYLE = { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflowY: 'auto', overflowWrap: 'anywhere' } as const
const CONTENT_STYLE = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-12)', minWidth: '0', overflowWrap: 'anywhere' } as const
const ACTIONS_STYLE = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4)', minWidth: '0' } as const
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
      <ToolPanelFrame title="Session history">
        <div style={CONTENT_STYLE}>
          <TextField
            id="session-history-search"
            aria-label="Search session history"
            label="Search sessions"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {loading && <p role="status">Searching session history…</p>}
          {error && <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: '0', overflowWrap: 'anywhere' }}>
            <p>Could not load session history: {error}</p>
            <Button aria-label="Retry" onClick={() => void load(query)}>Retry</Button>
          </div>}
          {!loading && !error && records.length === 0 && <EmptyState message="No matching sessions." />}
          {!loading && !error && records.length > 0 && <ol aria-label="Session results" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', listStyle: 'none', margin: '0', minWidth: '0', padding: '0' }}>
            {records.map((record) => <li key={record.id} data-session={record.id} style={{ minWidth: '0' }}>
              <article style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: '0' }}>
                <ListRow
                  title={record.title || record.agent}
                  description={<span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-2)', minWidth: '0', overflowWrap: 'anywhere' }}>
                    <span>{record.agent} · {record.status}{formatTimestamp(record.lastActivityAt) ? ` · ${formatTimestamp(record.lastActivityAt)}` : ''}</span>
                    <span>Quirky ID: {record.id}</span>
                    {record.providerSession?.id && <span>Provider ID: {record.providerSession.id}</span>}
                  </span>}
                />
                <div style={ACTIONS_STYLE}>
                  <Button aria-label={`Resume ${record.id}`} variant="primary" onClick={() => void runAction('resume', record.id)}>Resume</Button>
                  <Button aria-label={`Fork ${record.id}`} onClick={() => void runAction('fork', record.id)}>Fork</Button>
                  <Button aria-label={`Copy resume command ${record.id}`} onClick={() => void runAction('copy-resume-command', record.id)}>{copied === record.id ? 'Copied' : 'Copy resume command'}</Button>
                </div>
                {(['resume', 'fork', 'copy-resume-command'] as const).map((name) => {
                  const rowError = actionErrors[`${record.id}:${name}`]
                  return rowError ? <p key={name} role="alert" style={{ overflowWrap: 'anywhere' }}>{rowError}</p> : null
                })}
              </article>
            </li>)}
          </ol>}
        </div>
      </ToolPanelFrame>
    </main>
  )
}
