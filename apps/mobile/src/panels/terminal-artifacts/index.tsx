import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { TERMINAL_ARTIFACT_TEXT_BYTES, type TerminalArtifact, type TerminalArtifactPreview, type TerminalArtifactResult } from '@quirky/protocol'
import type { MobileConnectionState } from '../../contracts'
import { utf8ByteLength } from '../../shell/bridge-policy'
import type { PanelProps, PanelRoute } from '../contracts'
import { MarkdownView } from '../files-tasks'

type ArtifactListRoute = Extract<PanelRoute, { kind: 'terminal-artifacts' }>
type ArtifactRoute = Extract<PanelRoute, { kind: 'terminal-artifact' }>
type ArtifactPanelRoute = ArtifactListRoute | ArtifactRoute
type ArtifactAction = 'list' | 'preview' | 'refresh' | 'save'
type ArtifactCall = {
  action: ArtifactAction
  worktree: string
  session: string
  artifactId?: string
  grant?: string
  expectedRevision?: string
  content?: string
}
type ViewMode = 'rendered' | 'source' | 'edit'
type ConfirmationAction = 'navigate' | 'reload'

const ARTIFACT_METHOD = 'quirky.terminal/artifacts'
const MAX_LISTED_ARTIFACTS = 50
const MAX_IMAGE_BASE64_BYTES = 256 * 1024
const ROOT_STYLE: CSSProperties = {
  boxSizing: 'border-box', minHeight: 0, minWidth: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 12,
  color: 'var(--text, #e8e8ea)', overflowWrap: 'anywhere'
}
const BUTTON_STYLE: CSSProperties = {
  boxSizing: 'border-box', minHeight: 36, border: '1px solid var(--border, #555860)', borderRadius: 8,
  padding: '7px 10px', color: 'inherit', background: 'var(--surface-raised, #25272c)', font: 'inherit', cursor: 'pointer'
}
const MUTED_STYLE: CSSProperties = { margin: 0, color: 'var(--muted, #a4a6ad)', fontSize: 13, overflowWrap: 'anywhere' }
const ERROR_STYLE: CSSProperties = { margin: 0, color: 'var(--danger, #ff8c83)', overflowWrap: 'anywhere' }
const TEXTAREA_STYLE: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minHeight: 220, maxHeight: '55dvh', resize: 'vertical',
  border: '1px solid var(--border, #555860)', borderRadius: 8, padding: 10, color: 'inherit',
  background: 'var(--surface-raised, #25272c)', font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validOpaqueString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validArtifact(value: unknown, route: ArtifactPanelRoute): value is TerminalArtifact {
  return isRecord(value) && value.source === 'terminalArtifact' && value.worktree === route.worktreeId && value.session === route.sessionId &&
    (route.kind === 'terminal-artifacts' || value.artifactId === route.artifactId) &&
    validOpaqueString(value.artifactId, 128) && validOpaqueString(value.grant, 1024) &&
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 256 && !value.name.includes('\0') &&
    typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096 && !value.path.includes('\0')
}

function validPreview(value: unknown, route: ArtifactRoute): value is TerminalArtifactPreview {
  if (!isRecord(value) || value.kind !== 'preview' || !validArtifact(value.artifact, route) ||
    value.artifact.artifactId !== route.artifactId || value.artifact.grant !== route.grant ||
    (value.format !== 'text' && value.format !== 'markdown' && value.format !== 'image' && value.format !== 'binary') ||
    typeof value.content !== 'string' || utf8ByteLength(value.content) > TERMINAL_ARTIFACT_TEXT_BYTES ||
    !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 ||
    typeof value.truncated !== 'boolean' || typeof value.writable !== 'boolean' ||
    !validOpaqueString(value.revision, 256)) return false
  if (value.image !== undefined) {
    if (value.format !== 'image' || !isRecord(value.image) ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(value.image.mime)) ||
      typeof value.image.data !== 'string' || value.image.data.length > MAX_IMAGE_BASE64_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.image.data)) return false
  }
  return true
}

function refusalText(value: unknown): string | null {
  if (!isRecord(value) || value.kind !== 'refused' || typeof value.reason !== 'string' || typeof value.guidance !== 'string') return null
  const reasons = ['grant-expired', 'grant-invalid', 'source-unavailable', 'file-changed', 'unsupported', 'too-large', 'read-only']
  if (!reasons.includes(value.reason)) return null
  return `${value.reason}: ${value.guidance.slice(0, 512)}`
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 512) : fallback
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function refusalOrFallback(value: unknown, fallback: string): string {
  return refusalText(value) ?? fallback
}


function connectionMessage(state: MobileConnectionState): string {
  if (state.phase === 'connected') return ''
  if (state.message) return state.message
  if (state.phase === 'connecting' || state.phase === 'reconnecting') return 'Connecting to desktop…'
  if (state.phase === 'auth-failed' || state.phase === 'credential-missing' || state.phase === 'credential-unavailable') return 'Desktop access is unavailable. Re-pair or restore the saved device credential.'
  return 'Waiting for desktop connection.'
}

export function TerminalArtifactsPanel({ bridge, route, connected: routeConnected, onRegisterNavigationGuard }: PanelProps) {
  const artifactRoute = route.kind === 'terminal-artifact' ? route : null
  const artifactListRoute = route.kind === 'terminal-artifacts' ? route : null
  const scopedRoute = artifactRoute ?? artifactListRoute
  const [connection, setConnection] = useState<MobileConnectionState>(bridge.state)
  const [artifacts, setArtifacts] = useState<TerminalArtifact[]>([])
  const [preview, setPreview] = useState<TerminalArtifactPreview | null>(null)
  const [draft, setDraft] = useState('')
  const [savedDraft, setSavedDraft] = useState('')
  const [revision, setRevision] = useState<string | null>(null)
  const [grant, setGrant] = useState(artifactRoute?.grant ?? '')
  const [viewMode, setViewMode] = useState<ViewMode>('source')
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState<ArtifactAction | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [limited, setLimited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draftLimitExceeded, setDraftLimitExceeded] = useState(false)
  const [authorizationRefreshed, setAuthorizationRefreshed] = useState(false)
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction | null>(null)
  const confirmationResolver = useRef<((approved: boolean) => void) | null>(null)
  const confirmationPending = useRef(false)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const requestSequence = useRef(0)
  const initialPreviewRequest = useRef<string | null>(null)
  const connected = routeConnected === undefined ? connection.phase === 'connected' : routeConnected && connection.phase === 'connected'
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const busyNow = busy || !connected
  const writableText = Boolean(preview && (preview.format === 'text' || preview.format === 'markdown') && preview.writable && !preview.truncated &&
    preview.bytes <= TERMINAL_ARTIFACT_TEXT_BYTES && utf8ByteLength(preview.content) <= TERMINAL_ARTIFACT_TEXT_BYTES)
  const dirty = writableText && draft !== savedDraft
  dirtyRef.current = dirty
  busyRef.current = busy

  useEffect(() => bridge.onState(setConnection), [bridge])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestSequence.current++
      const resolve = confirmationResolver.current
      confirmationResolver.current = null
      confirmationPending.current = false
      resolve?.(false)
    }
  }, [])

  const requestConfirmation = useCallback((action: ConfirmationAction): Promise<boolean> => {
    if (confirmationPending.current) return Promise.resolve(false)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    confirmationResolver.current = resolve
    confirmationPending.current = true
    setConfirmationAction(action)
    return promise
  }, [])

  const navigationGuard = useCallback(async () => {
    if (busyRef.current) {
      setError('Wait for the current artifact request to finish before leaving this page.')
      return false
    }
    return !dirtyRef.current || await requestConfirmation('navigate')
  }, [requestConfirmation])

  useEffect(() => onRegisterNavigationGuard?.(navigationGuard), [navigationGuard, onRegisterNavigationGuard])

  const resolveConfirmation = (approved: boolean) => {
    const resolve = confirmationResolver.current
    confirmationResolver.current = null
    confirmationPending.current = false
    setConfirmationAction(null)
    resolve?.(approved)
  }

  const sourceRoute = useMemo(() => scopedRoute
    ? { kind: 'session' as const, worktreeId: scopedRoute.worktreeId, sessionId: scopedRoute.sessionId }
    : null, [scopedRoute?.worktreeId, scopedRoute?.sessionId])

  const currentRouteKey = scopedRoute
    ? `${scopedRoute.worktreeId}\0${scopedRoute.sessionId}${artifactRoute ? `\0${artifactRoute.artifactId}\0${artifactRoute.grant}` : ''}`
    : ''
  const loadList = useCallback(async () => {
    if (!artifactListRoute || !connected || busyRef.current) return
    const sequence = ++requestSequence.current
    setBusy(true)
    busyRef.current = true
    setBusyAction('list')
    setError(null)
    setNotice(null)
    try {
      const result = await bridge.call<TerminalArtifactResult>(ARTIFACT_METHOD, {
        action: 'list', worktree: artifactListRoute.worktreeId, session: artifactListRoute.sessionId
      } satisfies ArtifactCall)
      if (!mounted.current || sequence !== requestSequence.current || !connectedRef.current) return
      if (!isRecord(result) || result.kind !== 'listed' || !Array.isArray(result.artifacts) || typeof result.limited !== 'boolean') {
        setError(refusalOrFallback(result, 'The desktop returned an invalid artifact list.'))
        return
      }
      const next = result.artifacts.filter((item): item is TerminalArtifact => validArtifact(item, artifactListRoute)).slice(0, MAX_LISTED_ARTIFACTS)
      setArtifacts(next)
      setLimited(result.limited || result.artifacts.length > MAX_LISTED_ARTIFACTS)
      setLoaded(true)
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current && connectedRef.current) setError(errorText(cause, 'Could not load terminal artifacts.'))
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        busyRef.current = false
        setBusy(false)
        setBusyAction(null)
      }
    }
  }, [artifactListRoute, bridge, connected])

  const loadPreview = useCallback(async () => {
    if (!artifactRoute || !connected || busyRef.current) return false
    const sequence = ++requestSequence.current
    setBusy(true)
    busyRef.current = true
    setBusyAction('preview')
    setError(null)
    setNotice(null)
    try {
      const result = await bridge.call<TerminalArtifactResult>(ARTIFACT_METHOD, {
        action: 'preview', worktree: artifactRoute.worktreeId, session: artifactRoute.sessionId,
        artifactId: artifactRoute.artifactId, grant
      } satisfies ArtifactCall)
      if (!mounted.current || sequence !== requestSequence.current || !connectedRef.current) return false
      if (!validPreview(result, { ...artifactRoute, grant })) {
        setError(refusalOrFallback(result, 'The desktop returned an invalid artifact preview.'))
        return false
      }
      setPreview(result)
      setDraft(result.content)
      setSavedDraft(result.content)
      setDraftLimitExceeded(false)
      setRevision(result.revision)
      setAuthorizationRefreshed(false)
      setViewMode(result.format === 'markdown' ? 'rendered' : 'source')
      setLoaded(true)
      return true
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current && connectedRef.current) setError(errorText(cause, 'Could not load the artifact preview.'))
      return false
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        busyRef.current = false
        setBusy(false)
        setBusyAction(null)
      }
    }
  }, [artifactRoute, bridge, connected, grant])

  useEffect(() => {
    setArtifacts([])
    setPreview(null)
    setDraft('')
    setSavedDraft('')
    setDraftLimitExceeded(false)
    setRevision(null)
    setGrant(artifactRoute?.grant ?? '')
    setLoaded(false)
    setLimited(false)
    setError(null)
    setNotice(null)
    setAuthorizationRefreshed(false)
    setViewMode('source')
  }, [currentRouteKey])

  useEffect(() => {
    if (artifactListRoute) {
      if (connected) void loadList()
    } else if (artifactRoute && connected && initialPreviewRequest.current !== currentRouteKey) {
      initialPreviewRequest.current = currentRouteKey
      void loadPreview()
    }
  }, [artifactListRoute, artifactRoute, connected, currentRouteKey, loadList, loadPreview])

  const openArtifact = (item: TerminalArtifact) => {
    if (!connected || busyNow || busyRef.current || !artifactListRoute || !validArtifact(item, artifactListRoute)) return
    void bridge.navigate({
      kind: 'terminal-artifact', worktreeId: artifactListRoute.worktreeId, sessionId: artifactListRoute.sessionId,
      artifactId: item.artifactId, grant: item.grant
    }).catch((cause) => setError(errorText(cause, 'Could not open this terminal artifact.')))
  }

  const reloadContent = async () => {
    if (busyNow || busyRef.current || !connected) return
    if (dirty && !(await requestConfirmation('reload'))) return
    await loadPreview()
  }

  const refreshAuthorization = async () => {
    if (!artifactRoute || busyNow || busyRef.current || !connected) return
    const sequence = ++requestSequence.current
    setBusy(true)
    busyRef.current = true
    setBusyAction('refresh')
    setError(null)
    setNotice(null)
    try {
      const result = await bridge.call<TerminalArtifactResult>(ARTIFACT_METHOD, {
        action: 'refresh', worktree: artifactRoute.worktreeId, session: artifactRoute.sessionId,
        artifactId: artifactRoute.artifactId, grant
      } satisfies ArtifactCall)
      if (!mounted.current || sequence !== requestSequence.current || !connectedRef.current) return
      if (!isRecord(result) || result.kind !== 'refreshed' || !validArtifact(result.artifact, { ...artifactRoute, grant })) {
        setError(refusalOrFallback(result, 'The desktop could not refresh artifact authorization.'))
        return
      }
      if (result.artifact.grant === grant) {
        setError('The desktop did not rotate the artifact authorization grant.')
        return
      }
      setGrant(result.artifact.grant)
      setAuthorizationRefreshed(true)
      setNotice(preview
        ? 'Authorization refreshed. The preview revision is unchanged; reload content explicitly to adopt a newer revision.'
        : 'Authorization refreshed. Reload content explicitly to load an artifact preview.')
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current && connectedRef.current) setError(errorText(cause, 'Could not refresh artifact authorization.'))
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        busyRef.current = false
        setBusy(false)
        setBusyAction(null)
      }
    }
  }

  const saveDraft = async () => {
    if (!artifactRoute || !preview || !writableText || !revision || !dirty || draftLimitExceeded || busyNow || busyRef.current || !connected || utf8ByteLength(draft) > TERMINAL_ARTIFACT_TEXT_BYTES) return
    const content = draft
    const expectedRevision = revision
    const usedGrant = grant
    const sequence = ++requestSequence.current
    setBusy(true)
    busyRef.current = true
    setBusyAction('save')
    setError(null)
    setNotice(null)
    try {
      const result = await bridge.call<TerminalArtifactResult>(ARTIFACT_METHOD, {
        action: 'save', worktree: artifactRoute.worktreeId, session: artifactRoute.sessionId,
        artifactId: artifactRoute.artifactId, grant: usedGrant, expectedRevision, content
      } satisfies ArtifactCall)
      if (!mounted.current || sequence !== requestSequence.current || !connectedRef.current) return
      if (!isRecord(result) || result.kind !== 'saved' || !validArtifact(result.artifact, { ...artifactRoute, grant: usedGrant }) ||
        !validOpaqueString(result.revision, 256)) {
        setError(refusalOrFallback(result, 'The artifact was not saved. Your draft is still available.'))
        return
      }
      setRevision(result.revision)
      setSavedDraft(content)
      setDraftLimitExceeded(false)
      setPreview((current) => current ? { ...current, artifact: result.artifact, revision: result.revision, content, bytes: utf8ByteLength(content) } : current)
      setAuthorizationRefreshed(false)
      setNotice('Terminal artifact saved.')
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current && connectedRef.current) setError(errorText(cause, 'Could not save the artifact. Your draft is still available.'))
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        busyRef.current = false
        setBusy(false)
        setBusyAction(null)
      }
    }
  }

  const sourceLabel = scopedRoute ? `Terminal session ${scopedRoute.sessionId}` : 'Terminal session unavailable'
  const disconnected = !connected

  return <section aria-label={artifactRoute ? 'Terminal artifact preview' : 'Terminal artifacts'} style={ROOT_STYLE}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" aria-label="Back to terminal session" disabled={busy || !sourceRoute} onClick={() => {
        if (sourceRoute) void bridge.navigate(sourceRoute).catch((cause) => setError(errorText(cause, 'Could not return to the terminal session.')))
      }} style={BUTTON_STYLE}>Back to terminal</button>
      <h2 style={{ margin: 0, flex: '1 1 auto', minWidth: 120, fontSize: 16 }}>{artifactRoute ? preview?.artifact.name ?? artifactRoute.artifactId : 'Terminal artifacts'}</h2>
      <span style={MUTED_STYLE}>{sourceLabel}</span>
      {artifactListRoute ? <button type="button" disabled={!connected || busy} onClick={() => void loadList()} style={BUTTON_STYLE}>{busyAction === 'list' ? 'Loading…' : 'Refresh list'}</button> : null}
    </header>

    {disconnected ? <p role="status" style={ERROR_STYLE}>Desktop disconnected · cached artifact data may be stale. {connectionMessage(connection)} Reads, refreshes, and saves are disabled.</p> : null}
    {error ? <p role="alert" style={ERROR_STYLE}>{error}</p> : null}
    {notice ? <p role="status" style={MUTED_STYLE}>{notice}</p> : null}

    {artifactListRoute ? <main style={{ minHeight: 0, display: 'grid', gap: 10 }}>
      <p style={MUTED_STYLE}>Artifacts discovered in the selected terminal session. Paths are source metadata; opening uses only the desktop-issued artifact capability.</p>
      {busy && !loaded ? <p role="status" style={MUTED_STYLE}>Loading terminal artifacts…</p> : null}
      {limited ? <p role="status" style={MUTED_STYLE}>The list reached its 50-artifact limit. Some terminal output matches may be omitted.</p> : null}
      {loaded && artifacts.length === 0 ? <p style={MUTED_STYLE}>No terminal artifacts were found in this session.</p> : null}
      {loaded && artifacts.length > 0 ? <div style={{ display: 'grid', gap: 8, maxHeight: '65dvh', overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {artifacts.map((item) => <button key={item.artifactId} type="button" disabled={!connected || busy} onClick={() => openArtifact(item)}
          aria-label={item.name} style={{ ...BUTTON_STYLE, width: '100%', textAlign: 'left', display: 'grid', gap: 4 }}>
          <strong>{item.name}</strong>
          <span style={MUTED_STYLE}>{item.path}</span>
          <span style={MUTED_STYLE}>Source terminalArtifact · {item.session}</span>
        </button>)}
      </div> : null}
    </main> : null}

    {artifactRoute ? <main style={{ minHeight: 0, display: 'grid', gap: 10 }}>
      {preview ? <>
        <section aria-label="Artifact source metadata" style={{ display: 'grid', gap: 4, padding: 10, border: '1px solid var(--border, #3b3d43)', borderRadius: 8 }}>
          <strong>{preview.artifact.name}</strong>
          <span style={MUTED_STYLE}>{preview.artifact.path}</span>
          <span style={MUTED_STYLE}>Source terminalArtifact · {sourceLabel} · {formatBytes(preview.bytes)}</span>
          {authorizationRefreshed ? <span role="status" style={MUTED_STYLE}>Authorization refreshed; preview revision {revision} is still the save base.</span> : null}
        </section>
        {preview.truncated ? <p role="status" style={ERROR_STYLE}>Preview truncated at the 48 KiB text limit · read-only.</p> : null}
        {!preview.truncated && (preview.format === 'text' || preview.format === 'markdown') && preview.bytes > TERMINAL_ARTIFACT_TEXT_BYTES
          ? <p role="status" style={MUTED_STYLE}>Preview exceeds the 48 KiB complete-text limit · read-only.</p>
          : !preview.truncated && (preview.format === 'text' || preview.format === 'markdown') && !preview.writable
            ? <p role="status" style={MUTED_STYLE}>This text artifact is read-only.</p>
            : null}
        {preview.format === 'binary' ? <p role="status" style={MUTED_STYLE}>Binary or invalid UTF-8 artifact · metadata only; read-only.</p> : null}
        {preview.format === 'image' ? <p role="status" style={MUTED_STYLE}>Raster image preview · read-only.</p> : null}
        {writableText ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {preview.format === 'markdown' ? <>
            <button type="button" aria-pressed={viewMode === 'rendered'} disabled={busy} onClick={() => setViewMode('rendered')} style={BUTTON_STYLE}>Rendered</button>
            <button type="button" aria-pressed={viewMode === 'source'} disabled={busy} onClick={() => setViewMode('source')} style={BUTTON_STYLE}>Source</button>
          </> : null}
          <button type="button" aria-pressed={viewMode === 'edit'} disabled={busy || !connected} onClick={() => setViewMode('edit')} style={BUTTON_STYLE}>Edit draft</button>
          <button type="button" disabled={!connected || busy || !revision || !dirty || draftLimitExceeded || utf8ByteLength(draft) > TERMINAL_ARTIFACT_TEXT_BYTES} onClick={() => void saveDraft()} style={BUTTON_STYLE}>{busyAction === 'save' ? 'Saving…' : 'Save terminal artifact'}</button>
          <button type="button" disabled={!connected || busy} onClick={() => void reloadContent()} style={BUTTON_STYLE}>Reload content</button>
          <button type="button" disabled={!connected || busy} onClick={() => void refreshAuthorization()} style={BUTTON_STYLE}>Refresh authorization</button>
        </div> : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {preview.format === 'markdown' && !preview.truncated ? <>
            <button type="button" aria-pressed={viewMode === 'rendered'} disabled={busy} onClick={() => setViewMode('rendered')} style={BUTTON_STYLE}>Rendered</button>
            <button type="button" aria-pressed={viewMode === 'source'} disabled={busy} onClick={() => setViewMode('source')} style={BUTTON_STYLE}>Source</button>
          </> : null}
          <button type="button" disabled={!connected || busy || !writableText || !revision || !dirty || draftLimitExceeded || utf8ByteLength(draft) > TERMINAL_ARTIFACT_TEXT_BYTES} onClick={() => void saveDraft()} style={BUTTON_STYLE}>Save terminal artifact</button>
          <button type="button" disabled={!connected || busy} onClick={() => void reloadContent()} style={BUTTON_STYLE}>Reload content</button>
          <button type="button" disabled={!connected || busy} onClick={() => void refreshAuthorization()} style={BUTTON_STYLE}>Refresh authorization</button>
        </div>}
        {writableText && viewMode === 'edit' ? <textarea
          aria-label="Terminal artifact draft"
          value={draft}
          maxLength={TERMINAL_ARTIFACT_TEXT_BYTES}
          readOnly={!connected || busy}
          spellCheck={false}
          onChange={(event) => {
            const content = event.currentTarget.value
            if (utf8ByteLength(content) <= TERMINAL_ARTIFACT_TEXT_BYTES) {
              setDraft(content)
              setDraftLimitExceeded(false)
            } else {
              setDraftLimitExceeded(true)
            }
          }}
          style={TEXTAREA_STYLE}
        /> : preview.format === 'image' && preview.image ? <img
          src={`data:${preview.image.mime};base64,${preview.image.data}`}
          alt={`${preview.artifact.name} preview`}
          style={{ display: 'block', maxWidth: '100%', maxHeight: '55dvh', objectFit: 'contain', margin: '0 auto' }}
        /> : preview.format === 'image' ? <p role="status" style={MUTED_STYLE}>The bounded image data was unavailable; only file metadata is shown.</p>
          : preview.format === 'binary' ? null
            : preview.format === 'markdown' && !preview.truncated && viewMode !== 'source' ? <div style={{ minHeight: 160, maxHeight: '55dvh', overflow: 'auto', padding: 10, border: '1px solid var(--border, #3b3d43)', borderRadius: 8 }}><MarkdownView value={draft} /></div>
              : <pre style={{ margin: 0, maxHeight: '55dvh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 10, border: '1px solid var(--border, #3b3d43)', borderRadius: 8 }}>{draft}</pre>}
        {writableText && (draftLimitExceeded || utf8ByteLength(draft) > TERMINAL_ARTIFACT_TEXT_BYTES) ? <p role="alert" style={ERROR_STYLE}>The draft exceeds the 48 KiB complete-text limit and cannot be saved.</p> : null}
        {dirty ? <p role="status" style={MUTED_STYLE}>Unsaved draft changes · base revision {revision}.</p> : null}
      </> : busy ? <p role="status" style={MUTED_STYLE}>Loading artifact preview…</p> : loaded ? <p style={MUTED_STYLE}>No preview is available.</p> : null}
      {!preview ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        <button type="button" disabled={!connected || busy || !writableText || !revision || !dirty || draftLimitExceeded || utf8ByteLength(draft) > TERMINAL_ARTIFACT_TEXT_BYTES} onClick={() => void saveDraft()} style={BUTTON_STYLE}>Save terminal artifact</button>
        <button type="button" disabled={!connected || busy} onClick={() => void reloadContent()} style={BUTTON_STYLE}>Reload content</button>
        <button type="button" disabled={!connected || busy} onClick={() => void refreshAuthorization()} style={BUTTON_STYLE}>Refresh authorization</button>
      </div> : null}
    </main> : null}

    {confirmationAction ? <div role="dialog" aria-modal="true" aria-labelledby="terminal-artifact-confirm-title" style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: 16, background: 'rgba(0,0,0,.55)' }}>
      <section style={{ width: 'min(100%, 380px)', display: 'grid', gap: 12, padding: 16, border: '1px solid var(--border, #555)', borderRadius: 12, background: 'var(--surface, #17181b)' }}>
        <h2 id="terminal-artifact-confirm-title" style={{ margin: 0, fontSize: 18 }}>{confirmationAction === 'reload' ? 'Discard draft and reload?' : 'Leave without saving?'}</h2>
        <p style={MUTED_STYLE}>{confirmationAction === 'reload' ? 'The preview will replace this unsaved phone draft only after the desktop returns fresh content.' : 'The phone draft will be discarded when you leave this artifact.'}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" aria-label={confirmationAction === 'reload' ? 'Cancel reload' : 'Stay on artifact'} onClick={() => resolveConfirmation(false)} style={BUTTON_STYLE}>{confirmationAction === 'reload' ? 'Cancel reload' : 'Stay'}</button>
          <button type="button" onClick={() => resolveConfirmation(true)} style={BUTTON_STYLE}>{confirmationAction === 'reload' ? 'Discard edits and reload' : 'Discard and continue'}</button>
        </div>
      </section>
    </div> : null}
  </section>
}
