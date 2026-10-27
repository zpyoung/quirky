import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

type Props = { context: UiPluginContext; input?: unknown }
type TranscriptResult = { path: string; text: string }
type ViewState = { kind: 'loading' } | { kind: 'ready'; transcript: TranscriptResult } | { kind: 'error'; message: string }
const VIEW_STYLE = { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', padding: '1rem', gap: '0.75rem', color: 'var(--text, inherit)' } as const
const BUTTON_STYLE = { font: 'inherit', color: 'inherit', cursor: 'pointer' } as const

function sessionFrom(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('session' in input)) return null
  return typeof input.session === 'string' && input.session !== '' ? input.session : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TranscriptView({ context, input }: Props) {
  const session = sessionFrom(input)
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [requestVersion, setRequestVersion] = useState(0)
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    if (!session) {
      setView({ kind: 'error', message: 'No session was selected for this transcript.' })
      return
    }
    setView({ kind: 'loading' })
    try {
      const transcript = await context.call('quirky.session-info/transcript', { session }) as TranscriptResult
      if (request === requestRef.current) setView({ kind: 'ready', transcript })
    } catch (error) {
      if (request === requestRef.current) setView({ kind: 'error', message: messageOf(error) })
    }
  }, [context, session])

  useEffect(() => {
    void load()
    return () => { requestRef.current++ }
  }, [load, requestVersion])

  return (
    <main aria-label="Session transcript" style={VIEW_STYLE}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <div><h1 style={{ margin: 0, fontSize: '1.1rem' }}>Session transcript</h1>{view.kind === 'ready' && <p style={{ margin: '0.3rem 0 0', overflowWrap: 'anywhere', color: 'var(--muted, #8a909e)' }}>{view.transcript.path}</p>}</div>
        {view.kind === 'error' && <button type="button" aria-label="Retry transcript" style={BUTTON_STYLE} onClick={() => setRequestVersion((version) => version + 1)}>Retry</button>}
      </header>
      {view.kind === 'loading' && <p role="status">Loading transcript…</p>}
      {view.kind === 'error' && <p role="alert">Could not load transcript: {view.message}</p>}
      {view.kind === 'ready' && <pre aria-label="Transcript content" style={{ flex: '1', minHeight: '0', overflow: 'auto', margin: 0, padding: '0.75rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--bg-raised, transparent)' }}>{view.transcript.text}</pre>}
    </main>
  )
}
