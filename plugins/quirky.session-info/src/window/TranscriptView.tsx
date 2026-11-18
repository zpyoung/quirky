import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { EmptyState, InlineError, ListRow, NoticeLine, ToolPanelFrame } from '@quirky/ui'

type Props = { context: UiPluginContext; input?: unknown }
type TranscriptResult = { path: string; text: string }
type ViewState = { kind: 'loading' } | { kind: 'ready'; transcript: TranscriptResult } | { kind: 'error'; message: string }
const VIEW_STYLE = { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', overflowY: 'auto', overflowWrap: 'anywhere' } as const
const CONTENT_STYLE = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: '0', overflowWrap: 'anywhere' } as const

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
  const requestRef = useRef(0)

  async function load(): Promise<void> {
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
  }

  useEffect(() => {
    void load()
    return () => { requestRef.current++ }
  }, [context, session])

  return (
    <main aria-label="Session transcript" style={VIEW_STYLE}>
      <ToolPanelFrame title="Session transcript">
        <div style={CONTENT_STYLE}>
          {view.kind === 'loading' && <NoticeLine>Loading transcript…</NoticeLine>}
          {view.kind === 'error' && <InlineError message={`Could not load transcript: ${view.message}`} action={{ label: 'Retry', onAction: () => void load() }} />}
          {view.kind === 'ready' && view.transcript.text === '' && <EmptyState message="This transcript has no entries yet." />}
          {view.kind === 'ready' && view.transcript.text !== '' && <>
            <ListRow title="Transcript path" description={view.transcript.path} />
            <pre aria-label="Transcript content" style={{ flex: '1', minHeight: '0', overflow: 'auto', margin: '0', padding: 'var(--ui-space-12)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--ui-surface)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)' }}>{view.transcript.text}</pre>
          </>}
        </div>
      </ToolPanelFrame>
    </main>
  )
}
