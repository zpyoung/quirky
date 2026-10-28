import { Badge, Button, EmptyState, ListRow, SectionHeader, ToolPanelFrame } from '@quirky/ui'
import '@quirky/ui/styles.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { DispatchId } from '../contracts'
import type { WorkerReadParams, WorkerReadResult } from '../worker-contracts'
import { isRecord } from '../federation/guards'

const PAGE_LIMIT = 40
const POLL_INTERVAL_MS = 2_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The worker output response contains an invalid string field.')
  return value
}

function nullableString(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value
  throw new Error('The worker output response contains an invalid nullable string field.')
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('The worker output response contains an invalid boolean field.')
  return value
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value === 'string') {
    const found = values.find((candidate) => candidate === value)
    if (found !== undefined) return found
  }
  throw new Error('The worker output response contains an unsupported enum value.')
}

function parseRemoteRead(value: unknown, dispatchId: DispatchId): WorkerReadResult {
  if (!isRecord(value) || !isRecord(value.clipping) || !isRecord(value.agentLiveness) || !isRecord(value.remote)) {
    throw new Error('The worker output response is not a remote output result.')
  }
  const responseDispatchId = requiredString(value.dispatchId)
  const sourceIdentity = requiredString(value.sourceIdentity)
  if (responseDispatchId !== dispatchId || sourceIdentity.length === 0 || !dispatchId.startsWith('ctx_')) {
    throw new Error('The requested Dispatch is not an attached remote worker output source.')
  }
  if (typeof value.clipping.maxBytes !== 'number' || !Number.isSafeInteger(value.clipping.maxBytes) || value.clipping.maxBytes < 0) {
    throw new Error('The worker output response contains invalid clipping metadata.')
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === 'string')) {
    throw new Error('The worker output response contains invalid warnings.')
  }
  return {
    dispatchId,
    sessionId: nullableString(value.sessionId),
    source: oneOf(value.source, ['transcript', 'terminal', 'structured'] as const),
    archived: requiredBoolean(value.archived),
    sourceExact: requiredBoolean(value.sourceExact),
    fallbackReason: value.fallbackReason === null ? null : oneOf(value.fallbackReason, [
      'provider_unsupported', 'session_not_reported', 'transcript_empty', 'transcript_missing',
      'transcript_unreadable', 'transcript_parse_failed', 'remote_capability_unavailable'
    ] as const),
    content: requiredString(value.content),
    contentComplete: requiredBoolean(value.contentComplete),
    clipping: {
      clipped: requiredBoolean(value.clipping.clipped),
      maxBytes: value.clipping.maxBytes
    },
    nextCursor: nullableString(value.nextCursor),
    terminalLiveness: oneOf(value.terminalLiveness, ['live', 'unverifiable', 'exited', 'missing', 'unattached', 'identity_changed'] as const),
    agentLiveness: {
      status: oneOf(value.agentLiveness.status, ['live', 'exited', 'unverifiable'] as const),
      reason: nullableString(value.agentLiveness.reason)
    },
    warnings: value.warnings,
    sourceIdentity,
    remote: {
      peerId: requiredString(value.remote.peerId),
      bindingId: requiredString(value.remote.bindingId),
      hostDispatchId: requiredString(value.remote.hostDispatchId),
      hostIncarnation: requiredString(value.remote.hostIncarnation)
    }
  }
}

function parseRemoteOutputInput(value: unknown): DispatchId | null {
  if (!isRecord(value) || !('dispatchId' in value) || typeof value.dispatchId !== 'string' || !value.dispatchId.startsWith('ctx_')) {
    return null
  }
  return value.dispatchId as DispatchId
}

type Props = { context: UiPluginContext; input: unknown }

export function RemoteWorkerOutputView({ context, input }: Props) {
  const dispatchId = parseRemoteOutputInput(input)
  const [pages, setPages] = useState<WorkerReadResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pageCount = useRef(0)

  useEffect(() => { pageCount.current = pages.length }, [pages])

  const readPage = useCallback(async (cursor?: string): Promise<WorkerReadResult> => {
    if (!dispatchId) throw new Error('Remote output view requires a home Dispatch ID.')
    const params: WorkerReadParams & Record<string, unknown> = { dispatchId, source: 'auto', limit: PAGE_LIMIT }
    if (cursor !== undefined) params.cursor = cursor
    return parseRemoteRead(await context.call('quirky.orchestration/workerRead', params), dispatchId)
  }, [context, dispatchId])

  const refresh = useCallback(async (): Promise<void> => {
    if (!dispatchId || inFlight.current) return
    inFlight.current = true
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const page = await readPage()
      if (!mounted.current || generation.current !== request) return
      setPages([page])
      pageCount.current = 1
    } catch (cause) {
      if (!mounted.current || generation.current !== request) return
      setPages([])
      pageCount.current = 0
      setError(errorText(cause))
    } finally {
      inFlight.current = false
      if (mounted.current && generation.current === request) setLoading(false)
    }
  }, [dispatchId, readPage])

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = pages.at(-1)?.nextCursor
    if (!cursor || inFlight.current) return
    inFlight.current = true
    const request = generation.current
    setLoading(true)
    setError(null)
    try {
      const page = await readPage(cursor)
      if (!mounted.current || generation.current !== request) return
      if (page.sourceIdentity !== pages[0]?.sourceIdentity) throw new Error('The pinned remote output source changed; refresh to restart reading.')
      setPages((current) => [...current, page])
      pageCount.current += 1
    } catch (cause) {
      if (mounted.current && generation.current === request) setError(errorText(cause))
    } finally {
      inFlight.current = false
      if (mounted.current && generation.current === request) setLoading(false)
    }
  }, [pages, readPage])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => {
      if (pageCount.current <= 1) void refresh()
    }, POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      generation.current += 1
      clearInterval(timer)
    }
  }, [refresh])

  if (!dispatchId) {
    return (
      <section role="alert">
        <ToolPanelFrame title="Remote worker output">
          <EmptyState message="Remote output view requires a home Dispatch ID." />
        </ToolPanelFrame>
      </section>
    )
  }

  const first = pages[0]
  return (
    <section aria-label="Remote worker output" className="ui-stack" style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'auto' }}>
      <ToolPanelFrame
        title="Remote worker output"
        actions={
          <div className="ui-cluster">
            <Button onClick={() => void refresh()} disabled={loading}>Refresh</Button>
            {first?.nextCursor ? <Button onClick={() => void loadMore()} disabled={loading}>Load older output</Button> : null}
          </div>
        }
      >
        {error && <div role="alert" className="ui-error-text">{error}</div>}
        {first ? (
          <div className="ui-stack">
            <div className="ui-stack">
              <ListRow title="Host" description={first.remote ? first.remote.peerId : 'Resolving'} />
              <ListRow
                title="Source"
                description={first.source}
                trailing={first.archived ? <Badge tone="accent">Archived</Badge> : undefined}
              />
              <ListRow
                title="Agent liveness"
                description={first.agentLiveness.reason ? `${first.agentLiveness.status} · ${first.agentLiveness.reason}` : first.agentLiveness.status}
              />
              <ListRow
                title="Terminal liveness"
                description={first.terminalLiveness}
              />
              {first.remote && <ListRow title="Host Dispatch" description={`${first.remote.hostDispatchId} · incarnation ${first.remote.hostIncarnation}`} />}
            </div>
            {!first.sourceExact && <p className="ui-text-muted">Host output source is not exact; content is shown with its host-provided uncertainty.</p>}
            {first.fallbackReason && <p className="ui-text-muted">Output fallback: {first.fallbackReason}</p>}
            {first.warnings.map((warning, index) => <ListRow key={`${warning}-${index}`} title="Warning" status="needs-you" description={warning} />)}
            <SectionHeader title="Output" />
            <div className="ui-stack">
              {pages.map((page, index) => <pre key={`${page.sourceIdentity}-${index}`} className="ui-readout">{page.content}</pre>)}
            </div>
            {first.clipping.clipped && <p className="ui-text-muted">Output page clipped at {first.clipping.maxBytes} bytes.</p>}
          </div>
        ) : loading ? (
          <EmptyState message="Reading output from the paired host…" />
        ) : error ? null : (
          <EmptyState message="No output is currently available." />
        )}
      </ToolPanelFrame>
    </section>
  )
}
