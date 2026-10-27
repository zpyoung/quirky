import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { Context as ContextInfo, FilesTouched, Inspection, LiveActivity, PanelState, SectionId, Usage } from '../types'
import { contextThreshold, formatCount, formatPercentage, formatTimestamp } from './format'
import { subscribeCopyFeedback, type CopyFeedback } from './feedback'

type Props = { context: UiPluginContext; report?(state: unknown): void }
type EnableTelemetryResult = { statusline?: Inspection['statusline']; nextLaunchEffect: string }
type Section = { id: SectionId; title: string }

const CORE_SECTIONS: Section[] = [
  { id: 'identity', title: 'Identity' },
  { id: 'usage', title: 'Usage' },
  { id: 'liveActivity', title: 'Live activity' },
  { id: 'context', title: 'Context' },
  { id: 'filesTouched', title: 'Files touched' },
  { id: 'hooksAndMcp', title: 'Hooks & MCP' }
]
const PANEL_STYLE = { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0', color: 'var(--text, inherit)' } as const
const BODY_STYLE = { overflowY: 'auto', minHeight: '0', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' } as const
const ROW_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(6rem, 0.8fr) minmax(0, 1.4fr)', gap: '0.6rem', padding: '0.2rem 0' } as const
const BUTTON_STYLE = { font: 'inherit', color: 'inherit', cursor: 'pointer' } as const
const MUTED_STYLE = { color: 'var(--muted, #8a909e)' } as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function eventSession(event: QuirkyEvent): string | null | undefined {
  if (!('data' in event)) return undefined
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  if ('session' in data) {
    const session = data.session
    return session === null ? null : typeof session === 'string' ? session : undefined
  }
  if ('sessionId' in data) {
    const session = data.sessionId
    return session === null ? null : typeof session === 'string' ? session : undefined
  }
  return undefined
}

function isRefreshEvent(type: string): boolean {
  return type === 'quirky.session-info/changed' || type === 'quirky.terminal/focusContextChanged' ||
    type === 'quirky.session/changed' || type === 'quirky.session/removed' || type === 'quirky.agent-status/changed'
}

function displayValue(value: string | null | undefined): string | null {
  return value === undefined || value === '' ? null : value
}
function displayLabel(value: string): string {
  const words = value.replace(/[-_]+/g, ' ')
  const first = words.charAt(0)
  return first === '' ? value : `${first.toUpperCase()}${words.slice(1)}`
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div style={ROW_STYLE}><span style={MUTED_STYLE}>{label}</span><span style={{ overflowWrap: 'anywhere' }}>{children}</span></div>
}

function AccordionSection({ id, title, open, onToggle, children }: { id: SectionId; title: string; open: boolean; onToggle(): void; children: ReactNode }) {
  const headingId = `session-info-heading-${id}`
  const panelId = `session-info-section-${id}`
  return (
    <section style={{ borderBottom: '1px solid var(--border, #2b2f3a)' }}>
      <h2 style={{ margin: 0, fontSize: '0.9rem' }}>
        <button id={headingId} type="button" aria-label={title} aria-expanded={open} aria-controls={panelId} onClick={onToggle} style={{ ...BUTTON_STYLE, width: '100%', display: 'flex', justifyContent: 'space-between', padding: '0.7rem 0.25rem', border: 0, background: 'transparent', textAlign: 'left', fontWeight: 600 }}>
          <span>{title}</span><span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      <div id={panelId} role="region" aria-labelledby={headingId} hidden={!open} style={{ padding: '0 0.25rem 0.75rem' }}>{children}</div>
    </section>
  )
}

function IdentityContent({ state, copied, action }: { state: PanelState; copied: CopyFeedback | null; action(name: string, session: string | null): Promise<void> }) {
  const identity = state.info!.identity
  const rows: { label: string; value: string | null }[] = [
    { label: 'Agent', value: identity.agent },
    { label: 'Model', value: displayValue(identity.model) },
    { label: 'Quirky ID', value: identity.sessionId },
    { label: 'Provider ID', value: displayValue(identity.providerSessionId ?? undefined) },
    { label: 'Pane', value: displayValue(identity.paneTitle) ?? displayValue(identity.pane) },
    { label: 'Workspace', value: identity.worktreeId },
    { label: 'Working directory', value: identity.cwd },
    { label: 'Started', value: formatTimestamp(identity.startedAt) },
    { label: 'Updated', value: formatTimestamp(identity.updatedAt) },
    { label: 'Transcript', value: displayValue(identity.transcriptPath) },
    { label: 'Version', value: displayValue(identity.version) },
    { label: 'Output style', value: displayValue(identity.outputStyle) },
    { label: 'Branch', value: displayValue(identity.branch) }
  ]
  const buttons = [
    ...(identity.providerSessionId ? [<button key="copy" type="button" aria-label="Copy ID" style={BUTTON_STYLE} onClick={() => void action('copy-id', state.session)}>{copied?.session === state.session && copied.kind === 'id' ? 'Copied' : 'Copy ID'}</button>] : []),
    <button key="history" type="button" aria-label="Open history" style={BUTTON_STYLE} onClick={() => void action('open-history', state.session)}>Open history</button>,
    ...(state.pane === null ? [] : [<button key="focus" type="button" aria-label="Focus pane" style={BUTTON_STYLE} onClick={() => void action('focus-pane', state.session)}>Focus pane</button>]),
    ...(identity.transcriptPath ? [
      <button key="transcript" type="button" aria-label="Open transcript" style={BUTTON_STYLE} onClick={() => void action('open-transcript', state.session)}>Open transcript</button>,
      <button key="reveal" type="button" aria-label="Reveal transcript" style={BUTTON_STYLE} onClick={() => void action('reveal-transcript', state.session)}>Reveal transcript</button>
    ] : [])
  ]
  return (
    <div>
      {rows.filter((row) => row.value !== null).map((row) => <Row key={row.label} label={row.label}>{row.value}</Row>)}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', paddingTop: '0.55rem' }}>{buttons}</div>
    </div>
  )
}

function UsageContent({ usage, busy, onRetry }: { usage: Usage; busy: boolean; onRetry(): void }) {
  if (usage.status === 'waiting') return <p role="status" style={MUTED_STYLE}>Waiting for the first completed turn…</p>
  const values: [string, number | undefined][] = [
    ['Total tokens', usage.totalTokens], ['Turns', usage.turnCount], ['Input', usage.input], ['Output', usage.output], ['Cache read', usage.cacheRead], ['Cache write', usage.cacheWrite]
  ]
  const timestamp = formatTimestamp(usage.updatedAt)
  const refreshing = busy || usage.freshness === 'refreshing'
  const canRetry = usage.freshness === 'stale' || usage.error !== undefined
  return (
    <div aria-busy={refreshing}>
      {refreshing && <p role="status">Refreshing usage…</p>}
      {usage.freshness === 'stale' && <p role="status">Stale{timestamp ? ` · As of ${timestamp}` : ''}</p>}
      {values.filter(([, value]) => value !== undefined).map(([label, value]) => <Row key={label} label={label}>{formatCount(value) ?? value}</Row>)}
      {usage.error && <p role="alert">{usage.error}</p>}
      {usage.freshness === 'fresh' && timestamp && <p style={MUTED_STYLE}>As of {timestamp}</p>}
      {canRetry && <button type="button" aria-label="Retry usage" onClick={onRetry} disabled={refreshing} style={BUTTON_STYLE}>Retry</button>}
    </div>
  )
}

function LiveActivityContent({ activity }: { activity: LiveActivity }) {
  const updated = formatTimestamp(activity.updatedAt)
  const inputPreview = activity.toolInput && activity.toolInput.length > 500
    ? `${activity.toolInput.slice(0, 500)}…`
    : activity.toolInput
  return (
    <div>
      <Row label="State">{activity.label || activity.state}</Row>
      {activity.toolName && <Row label="Tool">{activity.toolName}</Row>}
      {inputPreview && <Row label="Input preview"><span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{inputPreview}</span></Row>}
      <Row label="Subagents">{formatCount(activity.subagentCount) ?? activity.subagentCount}</Row>
      {updated && <p style={MUTED_STYLE}>Updated {updated}</p>}
    </div>
  )
}

function PlanWindowRow({ label, usedPercentage, resetsAt }: { label: string; usedPercentage: number; resetsAt: number }) {
  const percentage = formatPercentage(usedPercentage)
  const reset = formatTimestamp(resetsAt)
  return <Row label={label}>{percentage === null ? '—' : `${percentage}%`}{reset ? ` · resets ${reset}` : ''}</Row>
}

function ContextContent({ detail }: { detail: ContextInfo }) {
  if (detail.status === 'waiting') return <p role="status" style={MUTED_STYLE}>Waiting for the first statusline update…</p>
  const used = formatPercentage(detail.usedPercentage)
  const remaining = formatPercentage(detail.remainingPercentage)
  const window = formatCount(detail.window)
  const updated = formatTimestamp(detail.updatedAt)
  return (
    <div>
      {used !== null && <Row label="Used">{used}%</Row>}
      {remaining !== null && <Row label="Remaining">{remaining}%</Row>}
      {window && <Row label="Window">{window} tokens</Row>}
      {detail.used !== undefined && <Row label="Tokens used">{formatCount(detail.used) ?? detail.used}</Row>}
      {detail.remaining !== undefined && <Row label="Tokens remaining">{formatCount(detail.remaining) ?? detail.remaining}</Row>}
      {detail.estimated && <p style={MUTED_STYLE}>Estimated from transcript</p>}
      {detail.planWindows?.fiveHour && <PlanWindowRow label="5 hour plan" {...detail.planWindows.fiveHour} />}
      {detail.planWindows?.sevenDay && <PlanWindowRow label="7 day plan" {...detail.planWindows.sevenDay} />}
      {updated && <p style={MUTED_STYLE}>As of {updated}</p>}
    </div>
  )
}

function FilesContent({ files }: { files: FilesTouched }) {
  const updated = formatTimestamp(files.updatedAt)
  return (
    <div>
      {files.added !== undefined && <Row label="Lines added">+{formatCount(files.added) ?? files.added}</Row>}
      {files.removed !== undefined && <Row label="Lines removed">−{formatCount(files.removed) ?? files.removed}</Row>}
      {updated && <p style={MUTED_STYLE}>As of {updated}</p>}
    </div>
  )
}

function InspectionContent({
  inspection,
  busy,
  error,
  nextLaunchEffect,
  enableBusy,
  onRetry,
  onEnable,
  onDisable
}: {
  inspection?: Inspection
  busy: boolean
  error: string | null
  nextLaunchEffect: string | null
  enableBusy: boolean
  onRetry(): void
  onEnable(): void
  onDisable(): void
}) {
  const statusline = inspection?.statusline
  const needsConsent = statusline?.state === 'available' || statusline?.state === 'drifted' || statusline?.state === 'disabled'
  const enabled = statusline?.state === 'chained' || statusline?.state === 'managed'
  const statuslineLabel = statusline?.state === 'available' ? 'Custom statusline detected' : statusline?.state === 'drifted' ? 'Custom statusline changed' : statusline?.state === 'chained' ? 'Chained' : statusline?.state === 'managed' ? 'Managed telemetry' : statusline?.state === 'disabled' ? 'Disabled' : statusline?.state === 'error' ? 'Error' : undefined
  return (
    <div>
      {busy && <p role="status">Inspecting Hooks & MCP…</p>}
      {error && <p role="alert">Could not inspect Hooks & MCP: {error}</p>}
      {inspection?.error && <p role="alert">{inspection.error}</p>}
      {inspection?.hooks && <><h3>Hooks</h3><Row label="Status">{displayLabel(inspection.hooks.state)}</Row>{inspection.hooks.detail && <p>{inspection.hooks.detail}</p>}</>}
      {statuslineLabel && <>
        <h3>Statusline · {statuslineLabel}</h3>
        {statusline?.detail && <p>{statusline.detail}</p>}
        <p>Telemetry preference changes apply on the next launch; the running session is unchanged.</p>
        {needsConsent && <>
          <p>Quirky preserves your existing statusline command when you consent to chaining.</p>
          <button type="button" aria-label="Enable session telemetry" onClick={onEnable} disabled={enableBusy} style={BUTTON_STYLE}>{enableBusy ? 'Updating…' : 'Enable session telemetry'}</button>
        </>}
        {enabled && <button type="button" aria-label="Disable session telemetry" onClick={onDisable} disabled={enableBusy} style={BUTTON_STYLE}>{enableBusy ? 'Updating…' : 'Disable session telemetry'}</button>}
      </>}
      {nextLaunchEffect && <p role="status">{nextLaunchEffect}</p>}
      {inspection && <>
        <h3>Configured MCP servers</h3>
        {inspection.mcp.length === 0 ? <p style={MUTED_STYLE}>No configured servers found.</p> : <ul>
          {inspection.mcp.map((server) => <li key={server.name}><strong>{server.name}</strong> · {server.transport} · {displayLabel(server.state)}</li>)}
        </ul>}
        {formatTimestamp(inspection.updatedAt) && <p style={MUTED_STYLE}>As of {formatTimestamp(inspection.updatedAt)}</p>}
      </>}
      <button type="button" aria-label="Retry" onClick={onRetry} disabled={busy} style={BUTTON_STYLE}>Retry</button>
    </div>
  )
}

export function SessionInfoPanel({ context, report }: Props) {
  const [projection, setProjection] = useState<PanelState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inspectionError, setInspectionError] = useState<string | null>(null)
  const [inspectionBusy, setInspectionBusy] = useState(false)
  const [retryBusy, setRetryBusy] = useState(false)
  const [enableBusy, setEnableBusy] = useState(false)
  const [nextLaunchEffect, setNextLaunchEffect] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopyFeedback | null>(null)
  const projectionRef = useRef<PanelState | null>(null)
  const aliveRef = useRef(true)
  const requestRef = useRef(0)
  const inspectionRequestRef = useRef(0)
  const telemetryRequestRef = useRef(0)
  const inspectedSessionRef = useRef<string | null>(null)
  const refreshQueuedRef = useRef(false)
  const refreshLoopRef = useRef<Promise<void> | null>(null)
  const sectionWritesRef = useRef<Promise<void>>(Promise.resolve())
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const updateProjection = useCallback((next: PanelState | null) => {
    projectionRef.current = next
    setProjection(next)
  }, [])

  const reload = useCallback(async (clearFirst = false) => {
    requestRef.current++
    if (clearFirst) {
      updateProjection(null)
      setLoading(true)
      setLoadError(null)
      setActionError(null)
      telemetryRequestRef.current++
      setEnableBusy(false)
    }
    refreshQueuedRef.current = true
    const activeLoop = refreshLoopRef.current
    if (activeLoop) {
      await activeLoop
      return
    }
    const loop = (async () => {
      try {
        while (refreshQueuedRef.current && aliveRef.current) {
          refreshQueuedRef.current = false
          const request = requestRef.current
          setLoading(projectionRef.current === null)
          setLoadError(null)
          try {
            const fetched = await context.call('quirky.session-info/get', {}) as PanelState
            if (!aliveRef.current || request !== requestRef.current) continue
            let next = fetched
            const current = projectionRef.current
            const previousSession = current?.session
            if (previousSession !== next.session) {
              inspectionRequestRef.current++
              telemetryRequestRef.current++
              inspectedSessionRef.current = null
              setInspectionBusy(false)
              setEnableBusy(false)
              setInspectionError(null)
              setNextLaunchEffect(null)
            } else if (current?.info?.hooksAndMcp && next.info && !next.info.hooksAndMcp) {
              next = { ...next, info: { ...next.info, hooksAndMcp: current.info.hooksAndMcp } }
            }
            updateProjection(next)
            setLoading(false)
          } catch (error) {
            if (!aliveRef.current || request !== requestRef.current) continue
            setLoading(false)
            setLoadError(messageOf(error))
          }
        }
      } finally {
        refreshLoopRef.current = null
      }
    })()
    refreshLoopRef.current = loop
    await loop
  }, [context, updateProjection])

  const inspect = useCallback(async (session: string, force = false) => {
    if (!force && inspectedSessionRef.current === session) return
    inspectedSessionRef.current = session
    const request = ++inspectionRequestRef.current
    setInspectionBusy(true)
    setInspectionError(null)
    try {
      const inspection = await context.call('quirky.session-info/inspect', { session }) as Inspection
      if (!aliveRef.current || request !== inspectionRequestRef.current || projectionRef.current?.session !== session) return
      const current = projectionRef.current
      if (current?.info) updateProjection({ ...current, info: { ...current.info, hooksAndMcp: inspection } })
    } catch (error) {
      if (aliveRef.current && request === inspectionRequestRef.current && projectionRef.current?.session === session) setInspectionError(messageOf(error))
    } finally {
      if (aliveRef.current && request === inspectionRequestRef.current) setInspectionBusy(false)
    }
  }, [context, updateProjection])

  useEffect(() => {
    aliveRef.current = true
    const unsubscribe = context.subscribe((event) => {
      if (!isRefreshEvent(event.type)) return
      const changedSession = eventSession(event)
      const focusedChanged = event.type === 'quirky.terminal/focusContextChanged'
      const current = projectionRef.current?.session
      if (focusedChanged || changedSession === null || changedSession === undefined || changedSession === current) void reload(focusedChanged)
    })
    const disconnect = context.onConnection((status) => {
      if (status === 'connected') void reload(true)
    })
    void reload()
    return () => {
      aliveRef.current = false
      refreshQueuedRef.current = false
      requestRef.current++
      inspectionRequestRef.current++
      telemetryRequestRef.current++
      unsubscribe()
      disconnect()
      clearTimeout(copiedTimerRef.current)
    }
  }, [context, reload])

  useEffect(() => subscribeCopyFeedback((feedback) => {
    if (feedback.session !== projectionRef.current?.session) return
    setCopied(feedback)
    clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = undefined
      setCopied(null)
    }, 1500)
  }), [])

  const info = projection?.info ?? null
  const openSections = projection?.openSections ?? ['liveActivity']
  const showHooks = projection !== null && projection.workspace !== null
  const hasHooksSection = showHooks && !!info
  const hooksOpen = openSections.includes('hooksAndMcp')

  useEffect(() => {
    if (!hooksOpen || !hasHooksSection || !projection?.session || info?.hooksAndMcp) return
    void inspect(projection.session)
  }, [hooksOpen, hasHooksSection, projection?.session, info?.hooksAndMcp, inspect])

  useEffect(() => {
    if (!report) return
    report({
      state: loading ? (projection ? 'refreshing' : 'loading') : loadError ? 'error' : projection?.info ? 'ready' : 'empty',
      session: projection?.session ?? null,
      pane: projection?.pane ?? null,
      workspace: projection?.workspace ?? null,
      openSections,
      error: loadError ?? inspectionError ?? actionError
    })
  }, [report, loading, loadError, projection, openSections, inspectionError, actionError])

  const toggle = useCallback((id: SectionId) => {
    const current = projectionRef.current
    if (!current) return
    const nextOpen = new Set(current.openSections)
    if (nextOpen.has(id)) nextOpen.delete(id)
    else nextOpen.add(id)
    const open = [...nextOpen]
    updateProjection({ ...current, openSections: open })
    sectionWritesRef.current = sectionWritesRef.current.catch(() => undefined).then(async () => {
      try {
        const result = await context.call('quirky.session-info/sections', { open }) as { open: SectionId[] }
        const latest = projectionRef.current
        if (aliveRef.current && latest && latest.openSections.join('\0') === open.join('\0')) updateProjection({ ...latest, openSections: result.open })
      } catch (error) {
        if (aliveRef.current) setActionError(messageOf(error))
      }
    })
  }, [context, updateProjection])

  const runAction = useCallback(async (name: string, session: string | null) => {
    if (session === null) return
    setActionError(null)
    try {
      await context.executeCommand(`command:quirky.session-info/${name}`, { session })
    } catch (error) {
      if (aliveRef.current) setActionError(messageOf(error))
    }
  }, [context])

  const retry = useCallback(async () => {
    setActionError(null)
    setLoadError(null)
    const current = projectionRef.current
    setRetryBusy(true)
    try {
      if (current?.session) await inspect(current.session, true)
      await reload()
    } finally {
      if (aliveRef.current) setRetryBusy(false)
    }
  }, [inspect, reload])

  const setTelemetry = useCallback(async (enabled: boolean) => {
    const session = projectionRef.current?.session
    if (!session) return
    const request = ++telemetryRequestRef.current
    setEnableBusy(true)
    setActionError(null)
    try {
      const result = await context.call('quirky.session-info/enableTelemetry', { session, enabled }) as EnableTelemetryResult
      if (!aliveRef.current || request !== telemetryRequestRef.current || projectionRef.current?.session !== session) return
      setNextLaunchEffect(result.nextLaunchEffect)
      const current = projectionRef.current
      const prior = current?.info?.hooksAndMcp
      if (current?.info && prior && result.statusline) {
        updateProjection({ ...current, info: { ...current.info, hooksAndMcp: { ...prior, statusline: result.statusline } } })
      }
    } catch (error) {
      if (aliveRef.current && request === telemetryRequestRef.current) setActionError(messageOf(error))
    } finally {
      if (aliveRef.current && request === telemetryRequestRef.current) setEnableBusy(false)
    }
  }, [context, updateProjection])

  const contextValue = info?.context?.status === 'ready' ? info.context.usedPercentage : undefined
  const contextPercentage = formatPercentage(contextValue)
  const contextBand = contextPercentage === null || contextValue === undefined ? null : contextThreshold(contextValue)
  const headerModel = displayValue(info?.identity.model) ?? displayValue(info?.identity.agent) ?? 'Agent session'

  return (
    <main aria-label="Session Info" style={PANEL_STYLE}>
      <header style={{ padding: '0.8rem 0.9rem', borderBottom: '1px solid var(--border, #2b2f3a)' }}>
        <h1 style={{ margin: 0, fontSize: '1rem' }}>Session Info</h1>
        {info && <p style={{ margin: '0.35rem 0 0', fontWeight: 600 }}>{headerModel}</p>}
        {info && contextPercentage !== null && contextBand !== null && <div data-context-threshold={contextBand} style={{ marginTop: '0.55rem' }}>
          <strong>{contextPercentage}% context used</strong>
          <div role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextPercentage} style={{ height: '0.3rem', marginTop: '0.25rem', background: 'var(--bg-active, #2d3240)', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ width: `${contextPercentage}%`, height: '100%', background: contextBand === 'danger' ? 'var(--danger, #e5534b)' : contextBand === 'strong' ? 'var(--accent, #4f8ff7)' : 'var(--muted, #8a909e)' }} />
          </div>
          {formatTimestamp(info.context?.updatedAt) && <small style={MUTED_STYLE}>As of {formatTimestamp(info.context?.updatedAt)}</small>}
        </div>}
      </header>
      {loading && !projection && <p role="status" style={{ padding: '0.9rem' }}>Loading session info…</p>}
      {loading && projection && <p role="status" style={{ padding: '0.35rem 0.9rem', margin: 0, ...MUTED_STYLE }}>Refreshing session info…</p>}
      {loadError && <div role="alert" style={{ padding: '0.75rem' }}><p>Could not load session info: {loadError}</p><button type="button" aria-label="Retry" style={BUTTON_STYLE} onClick={() => void retry()}>Retry</button></div>}
      {!loading && !loadError && projection?.info === null && <div style={{ padding: '0.9rem' }}><h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>No agent session</h2><p style={{ margin: 0 }}>Focus a terminal pane with an agent session to inspect it here.</p></div>}
      {projection && info && <div style={BODY_STYLE}>
        {actionError && <p role="alert">{actionError}</p>}
        {CORE_SECTIONS.filter(({ id }) => {
          if (id === 'identity' || id === 'liveActivity') return true
          if (id === 'usage') return info?.usage !== undefined
          if (id === 'context') return info?.context !== undefined
          if (id === 'filesTouched') return info?.filesTouched !== undefined
          return hasHooksSection
        }).map(({ id, title }) => <AccordionSection key={id} id={id} title={title} open={openSections.includes(id)} onToggle={() => toggle(id)}>
          {id === 'identity' && <IdentityContent state={projection} copied={copied} action={runAction} />}
          {id === 'usage' && info.usage && <UsageContent usage={info.usage} busy={retryBusy || inspectionBusy} onRetry={() => void retry()} />}
          {id === 'liveActivity' && <LiveActivityContent activity={info.liveActivity} />}
          {id === 'context' && info.context && <ContextContent detail={info.context} />}
          {id === 'filesTouched' && info.filesTouched && <FilesContent files={info.filesTouched} />}
          {id === 'hooksAndMcp' && <InspectionContent inspection={info.hooksAndMcp} busy={inspectionBusy} error={inspectionError} nextLaunchEffect={nextLaunchEffect} enableBusy={enableBusy} onRetry={() => void retry()} onEnable={() => void setTelemetry(true)} onDisable={() => void setTelemetry(false)} />}
        </AccordionSection>)}
      </div>}
    </main>
  )
}
