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

  if (!dispatchId) return <section role="alert">Remote output view requires a home Dispatch ID.</section>

  const first = pages[0]
  return <section aria-label="Remote worker output" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0, minHeight: 0, gap: 8, padding: 12, overflow: 'auto' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong>Remote worker output</strong>
      <span>{first?.remote ? `Host: ${first.remote.peerId}` : 'Host: resolving'}</span>
      <span>{first ? `Source: ${first.source}${first.archived ? ' (archived)' : ''}` : ''}</span>
      <span>{first ? `Liveness: ${first.agentLiveness.status}` : ''}</span>
      <button type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      {first?.nextCursor ? <button type="button" onClick={() => void loadMore()} disabled={loading}>Load older output</button> : null}
    </header>
    {error ? <div role="alert">{error}</div> : null}
    {first ? <>
      {!first.sourceExact ? <p>Host output source is not exact; content is shown with its host-provided uncertainty.</p> : null}
      {first.fallbackReason ? <p>Output fallback: {first.fallbackReason}</p> : null}
      {first.remote ? <p>Host Dispatch: {first.remote.hostDispatchId} · incarnation {first.remote.hostIncarnation}</p> : null}
      {first.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{warning}</p>)}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pages.map((page, index) => <pre key={`${page.sourceIdentity}-${index}`} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{page.content}</pre>)}
      </div>
      {first.clipping.clipped ? <p>Output page clipped at {first.clipping.maxBytes} bytes.</p> : null}
    </> : loading ? <p>Reading output from the paired host…</p> : error ? null : <p>No output is currently available.</p>}
  </section>
}
