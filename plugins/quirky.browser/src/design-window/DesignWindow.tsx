import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, EmptyState, FormRow, SectionHeader, StatusDot } from '@quirky/ui'
import { createPortal } from 'react-dom'
import { NATIVE_BROWSER_PREVIEW_SCHEME } from '@quirky/protocol'
import type { NativeBrowserHandle, UiPluginContext } from '@quirky/protocol'
import { MarkupOverlay } from '../markup/MarkupOverlay'
import type { DesignAnnotation, DesignPayload, DesignRead, DesignScreenshot, DesignSelection, DesignTarget, DesignTargets } from '../design-contract'
import { DESIGN_FULL_SCREENSHOT_MAX_BYTES } from '../design-contract'
import { guestProgram } from '../design/guest'
import { clampPayload } from '../design/payload'
type AnnotationPageSnapshot = { annotations: DesignAnnotation[]; heldIds: ReadonlySet<string> }
type AnnotationPageMemory = { snapshot: AnnotationPageSnapshot; listeners: Set<() => void> }
const EMPTY_ANNOTATION_PAGE: AnnotationPageSnapshot = { annotations: [], heldIds: new Set<string>() }
const annotationPageMemory = new Map<string, AnnotationPageMemory>()
let liveDesignPageKeys: Set<string> | null = null

function memoryForPage(pageId: string): AnnotationPageMemory {
  let page = annotationPageMemory.get(pageId)
  if (!page) {
    page = { snapshot: EMPTY_ANNOTATION_PAGE, listeners: new Set() }
    annotationPageMemory.set(pageId, page)
  }
  return page
}

function notifyPage(page: AnnotationPageMemory): void {
  for (const listener of page.listeners) listener()
}

function getAnnotationPage(pageId: string | null): AnnotationPageSnapshot {
  if (!pageId || (liveDesignPageKeys && !liveDesignPageKeys.has(pageId))) return EMPTY_ANNOTATION_PAGE
  return annotationPageMemory.get(pageId)?.snapshot ?? EMPTY_ANNOTATION_PAGE
}

function subscribeAnnotationPage(pageId: string | null, listener: () => void): () => void {
  if (!pageId) return () => {}
  const page = memoryForPage(pageId)
  page.listeners.add(listener)
  return () => {
    page.listeners.delete(listener)
    if (!page.listeners.size && !page.snapshot.annotations.length && !page.snapshot.heldIds.size) annotationPageMemory.delete(pageId)
  }
}

function updateAnnotations(pageId: string, update: (current: DesignAnnotation[]) => DesignAnnotation[]): void {
  if (liveDesignPageKeys && !liveDesignPageKeys.has(pageId)) return
  const page = memoryForPage(pageId)
  page.snapshot = { annotations: update(page.snapshot.annotations), heldIds: page.snapshot.heldIds }
  notifyPage(page)
}

function updateHeld(pageId: string, ids: string[], held: boolean): void {
  if (liveDesignPageKeys && !liveDesignPageKeys.has(pageId)) return
  const page = memoryForPage(pageId)
  const heldIds = new Set(page.snapshot.heldIds)
  for (const id of ids) held ? heldIds.add(id) : heldIds.delete(id)
  page.snapshot = { annotations: page.snapshot.annotations, heldIds }
  notifyPage(page)
}

export function setLiveDesignPageKeys(pageIds: Iterable<string>): void {
  const previous = liveDesignPageKeys
  liveDesignPageKeys = new Set(pageIds)
  for (const [pageId, page] of annotationPageMemory) {
    if (liveDesignPageKeys.has(pageId)) {
      if (!previous?.has(pageId)) notifyPage(page)
      continue
    }
    const changed = page.snapshot.annotations.length > 0 || page.snapshot.heldIds.size > 0
    page.snapshot = EMPTY_ANNOTATION_PAGE
    if (changed) notifyPage(page)
    if (!page.listeners.size) annotationPageMemory.delete(pageId)
  }
}

const MAX_ANNOTATIONS = 20
const MAX_COMMENT = 2000
const PICKER_TIMEOUT_MS = 120_000
const POLL_DELAY_MS = 100
const NATIVE_EVALUATION_BUSY = /native browser evaluation (timed out|was cancelled|is unavailable during)/
const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024
const WATCH_COPY_PROBE = `(() => { const active = document.activeElement; const selection = window.getSelection ? window.getSelection() : null; return { editable: !!active && (active.isContentEditable || active.tagName === 'IFRAME' || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)), selected: !!selection && String(selection).length > 0 }; })()`
const designOverlayStyle: CSSProperties = { position: 'absolute', zIndex: 12, inset: 0, pointerEvents: 'none' }
const floatingPanelStyle: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'auto',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)',
  background: 'var(--ui-surface)',
  boxShadow: '0 var(--ui-space-8) var(--ui-space-24) var(--ui-shadow)',
  color: 'var(--ui-text)',
  fontSize: 'var(--ui-font-body)',
  lineHeight: 1.4,
  boxSizing: 'border-box'
}
const menuPanelStyle: CSSProperties = {
  ...floatingPanelStyle,
  right: 'var(--ui-space-12)',
  top: 'var(--ui-space-12)',
  display: 'grid',
  gap: 'var(--ui-space-8)',
  width: 'min(calc(var(--ui-row-double) * 11), calc(100% - var(--ui-space-24)))',
  maxHeight: 'calc(100% - var(--ui-space-24))',
  padding: 'var(--ui-space-12)',
  overflow: 'auto'
}
const annotationTrayStyle: CSSProperties = {
  ...floatingPanelStyle,
  right: 'var(--ui-space-12)',
  bottom: 'var(--ui-space-12)',
  width: 'min(calc(var(--ui-row-double) * 12), calc(100% - var(--ui-space-24)))',
  maxHeight: '55%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}
const annotationTrayHeadStyle: CSSProperties = {
  padding: 'var(--ui-space-8)',
  borderBottom: 'var(--ui-border-width) solid var(--ui-border)'
}
const annotationListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-6)',
  padding: 'var(--ui-space-8)',
  overflow: 'auto'
}
const annotationNoteStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 'var(--ui-space-4) var(--ui-space-8)',
  padding: 'var(--ui-space-8)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-selected)'
}
const noteTextStyle: CSSProperties = { gridColumn: '1 / -1', margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }
const noteDetailsStyle: CSSProperties = { gridColumn: '1 / -1', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' }
const actionGroupStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--ui-space-4)' }
const targetGroupsStyle: CSSProperties = { display: 'grid', gap: 'var(--ui-space-8)' }
const menuButtonStyle: CSSProperties = { width: '100%', justifyContent: 'flex-start' }
const targetButtonStyle: CSSProperties = { ...menuButtonStyle, display: 'grid', gap: 'var(--ui-space-2)', justifyContent: 'stretch', textAlign: 'left' }
const targetStatusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-4)' }
const targetReasonStyle: CSSProperties = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' }
const toolbarStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--ui-space-6)' }
const hintStyle: CSSProperties = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' }
const highlightLabelStyle: CSSProperties = {
  position: 'absolute',
  left: 'calc(-1 * var(--ui-space-2))',
  bottom: '100%',
  maxWidth: '80vw',
  padding: 'var(--ui-space-2) var(--ui-space-6)',
  borderRadius: 'var(--ui-radius-mark) var(--ui-radius-mark) 0 0',
  color: 'var(--ui-text)',
  background: 'var(--ui-selected)',
  fontSize: 'var(--ui-font-label)',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}
const annotationFeedbackStyle: CSSProperties = { minHeight: 'calc(var(--ui-row-double) * 3)', resize: 'vertical' }
const errorMessageStyle: CSSProperties = { color: 'var(--ui-failing)' }

export type DesignAction = 'grab' | 'annotate' | 'draw' | 'cancel'
export type DesignPane = { id: string; mode: 'native' | 'watch'; page: string | null; url: string; title: string; loading: boolean; error: string | null; worktreeId: string }
type Operation = { opId: string; mode: 'grab' | 'annotate'; pane: DesignPane; identity: string; startedAt: number; nativeHandle: NativeBrowserHandle | null; generation: number }
type AnnotationDraft = { paneId: string; pageId: string; payload: DesignPayload; editingId: string | null; intent: 'change' | 'question'; comment: string }
type SelectionMenu = { payload: DesignPayload; op: Operation }
type SendTarget = { kind: 'session'; value: DesignTarget } | { kind: 'agent'; id: string; label: string }
type ClipboardProbe = { editable: boolean; selected: boolean }
type WriteText = (payload: DesignPayload, successMessage: string, rearm: boolean, expectedIdentity?: string) => Promise<boolean>
type WriteImage = (screenshot: DesignScreenshot, successMessage: string, rearm: boolean, expectedIdentity?: string) => Promise<boolean>
type Props = {
  context: UiPluginContext
  pane: DesignPane | null
  nativeHandle: NativeBrowserHandle | null

  pageHost: HTMLElement | null
  nativePageHost?: HTMLElement | null
  frameSize?: { width: number; height: number } | null
  watchId?: string | null
  watchReady: boolean
  focused?: boolean
  onMessage(text: string, kind: 'info' | 'error'): void
  actionRef?: { current: ((action: DesignAction) => Promise<boolean>) | null }
}
function identityOf(pane: DesignPane | null, watchId?: string | null, frameSize?: { width: number; height: number } | null): string {
  return pane ? JSON.stringify([pane.id, pane.mode, pane.page, pane.url, pane.loading, pane.error, watchId ?? null, frameSize?.width ?? null, frameSize?.height ?? null]) : ''
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function idOf(value: string): string {
  return `${value}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
}

function sanitizePayload(value: unknown): DesignPayload | null {
  try { return clampPayload(value) } catch { return null }
}

function selectionOf(value: unknown, opId: string): DesignSelection | null {
  const read = recordOf(value)
  if (!read || read.opId !== opId || read.status !== 'armed') return null
  const selection = recordOf(read.selection)
  if (!selection || !['selected', 'context-selected', 'copy', 'screenshot'].includes(String(selection.kind))) return null
  const payload = sanitizePayload(selection.payload)
  return payload ? { kind: selection.kind as DesignSelection['kind'], payload } : null
}

function readOf(value: unknown, opId: string): DesignRead | null {
  const read = recordOf(value)
  if (!read || read.opId !== opId || !['armed', 'cancelled', 'expired'].includes(String(read.status))) return null
  const selection = selectionOf(value, opId)
  return { opId, status: read.status as DesignRead['status'], ...(selection ? { selection } : {}) }
}

function hoverOf(value: unknown): DesignPayload | null {
  return sanitizePayload(recordOf(value)?.payload)
}

function screenshotOf(value: unknown, maxBytes = SCREENSHOT_MAX_BYTES): DesignScreenshot | null {
  const source = recordOf(value)
  if (!source || source.mimeType !== 'image/png' || typeof source.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(source.dataUrl)) return null
  const width = source.width
  const height = source.height
  const encoded = source.dataUrl.slice('data:image/png;base64,'.length)
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) <= 0 || (height as number) <= 0) return null
  if ((width as number) > 32_768 || (height as number) > 32_768 || Math.floor(encoded.length * 3 / 4) - padding > maxBytes) return null
  return { mimeType: 'image/png', dataUrl: source.dataUrl, width: width as number, height: height as number }
}

function screenshotFromCapture(value: unknown, maxBytes = SCREENSHOT_MAX_BYTES): DesignScreenshot | null {
  return screenshotOf(recordOf(value)?.screenshot, maxBytes)
}

function targetsOf(value: unknown): DesignTargets {
  const source = recordOf(value)
  const sessions = Array.isArray(source?.sessions) ? source.sessions : []
  const agents = Array.isArray(source?.agents) ? source.agents : []
  return {
    sessions: sessions.flatMap((item): DesignTarget[] => {
      const row = recordOf(item)
      if (!row || typeof row.session !== 'string' || typeof row.agent !== 'string' || typeof row.label !== 'string') return []
      return [{
        session: row.session, agent: row.agent, label: row.label,
        title: typeof row.title === 'string' ? row.title : '', status: typeof row.status === 'string' ? row.status : 'unknown',
        state: typeof row.state === 'string' ? row.state : null, lastActivityAt: typeof row.lastActivityAt === 'number' ? row.lastActivityAt : 0,
        sendable: row.sendable === true, ...(typeof row.reason === 'string' ? { reason: row.reason } : {})
      }]
    }),
    agents: agents.flatMap((item) => {
      const row = recordOf(item)
      return row && typeof row.id === 'string' && typeof row.label === 'string' ? [{ id: row.id, label: row.label }] : []
    })
  }
}

function copyProbeOf(raw: unknown): ClipboardProbe | null {
  let value = raw
  for (let depth = 0; depth < 3; depth++) {
    const row = recordOf(value)
    if (!row) return null
    if (typeof row.editable === 'boolean' && typeof row.selected === 'boolean') return { editable: row.editable, selected: row.selected }
    if ('value' in row) value = row.value
    else if ('result' in row) value = row.result
    else return null
  }
  return null
}

function editableHostTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return (target as HTMLElement).isContentEditable || target.closest('input,textarea,select,[contenteditable="true"]') !== null
}

function modifiers(event: KeyboardEvent): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

function shortcutMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

function formatAge(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'activity unknown'
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'active now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function elementLabel(payload: DesignPayload): string {
  const name = payload.target.accessibility.accessibleName || payload.target.textSnippet.slice(0, 60)
  return `${payload.target.reactComponents ? `${payload.target.reactComponents} ` : ''}${payload.target.tagName}${name ? ` “${name}”` : ''}`
}

function imageToBlob(screenshot: DesignScreenshot): Blob {
  const encoded = screenshot.dataUrl.slice(screenshot.dataUrl.indexOf(',') + 1)
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  return new Blob([bytes], { type: screenshot.mimeType })
}

function displayBox(host: HTMLElement, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const bounds = host.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return { left: 0, top: 0, width: 0, height: 0 }
  const scale = Math.min(bounds.width / width, bounds.height / height)
  const displayWidth = width * scale
  const displayHeight = height * scale
  return { left: (bounds.width - displayWidth) / 2, top: (bounds.height - displayHeight) / 2, width: displayWidth, height: displayHeight }
}

export function DesignWindow({ context, pane, nativeHandle, pageHost, nativePageHost, frameSize, watchId, watchReady, focused = false, onMessage, actionRef }: Props) {
  const feedbackId = useId()
  const [operation, setOperation] = useState<Operation | null>(null)
  const [hoverPayload, setHoverPayload] = useState<DesignPayload | null>(null)
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null)
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [targets, setTargets] = useState<DesignTargets | null>(null)
  const [targetsOpen, setTargetsOpen] = useState(false)
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [markupScreenshot, setMarkupScreenshot] = useState<DesignScreenshot | null>(null)
  const [operationPending, setOperationPending] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [hostRevision, setHostRevision] = useState(0)
  const cancellationRef = useRef<Promise<void>>(Promise.resolve())
  const guestQueueRef = useRef(Promise.resolve())
  const armPendingRef = useRef(false)
  const armAttemptRef = useRef(0)
  const [nativeShortcutOwner] = useState(() => idOf('native-shortcut'))
  const operationRef = useRef<Operation | null>(null)
  const hoverRef = useRef<DesignPayload | null>(null)
  const copiedSelectionRef = useRef<{ identity: string; payload: DesignPayload } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeTextRef = useRef<WriteText | null>(null)
  const writeImageRef = useRef<WriteImage | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const shortcutPendingRef = useRef(false)
  const handledChordRef = useRef(new Set<string>())
  const currentPaneRef = useRef(pane)
  const currentHandleRef = useRef(nativeHandle)
  const currentWatchRef = useRef(watchId)
  const currentFrameSizeRef = useRef(frameSize)
  const currentIdentity = identityOf(pane, watchId, frameSize)
  const identityRef = useRef(currentIdentity)
  const annotationPageId = pane ? pane.page ?? pane.id : null
  const subscribePage = useCallback((listener: () => void) => subscribeAnnotationPage(annotationPageId, listener), [annotationPageId])
  const readPage = useCallback(() => getAnnotationPage(annotationPageId), [annotationPageId])
  const annotationSnapshot = useSyncExternalStore(subscribePage, readPage, readPage)
  const annotations = annotationSnapshot.annotations
  const heldIds = annotationSnapshot.heldIds
  const usablePage = Boolean(pane && pane.url !== '' && pane.url !== 'about:blank' && !pane.loading && !pane.error)
  const modeReady = pane?.mode === 'native' ? nativeHandle !== null : pane?.mode === 'watch' ? Boolean(pane.page && watchReady) : false
  const active = Boolean(usablePage && modeReady && !markupScreenshot)
  const interactionLocked = Boolean(draft || selectionMenu || targetsOpen)
  const drawingDisabled = pane?.mode === 'native' || !active || operationPending || interactionLocked
  const currentOperation = operation?.identity === currentIdentity ? operation : null
  const grabDisabled = !active || interactionLocked || Boolean(currentOperation && currentOperation.mode !== 'grab')
  const annotateDisabled = !active || interactionLocked || Boolean(currentOperation && currentOperation.mode !== 'annotate')
  const notesAvailable = annotations.filter((annotation) => !heldIds.has(annotation.id))
  const geometryPayload = hoverPayload ?? annotations.find((annotation) => frameCurrent(annotation, pane?.url ?? ''))?.payload ?? null
  const pageGeometry = useMemo(() => {
    if (!pageHost || !pane) return null
    if (pane.mode === 'native' && nativePageHost) {
      const hostBounds = pageHost.getBoundingClientRect()
      const pageBounds = nativePageHost.getBoundingClientRect()
      return { left: pageBounds.left - hostBounds.left, top: pageBounds.top - hostBounds.top, width: pageBounds.width, height: pageBounds.height }
    }
    const width = frameSize?.width ?? geometryPayload?.page.viewportWidth ?? 0
    const height = frameSize?.height ?? geometryPayload?.page.viewportHeight ?? 0
    return displayBox(pageHost, width, height)
  }, [frameSize?.height, frameSize?.width, geometryPayload?.page.viewportHeight, geometryPayload?.page.viewportWidth, hostRevision, nativePageHost, pageHost, pane?.mode])
  useEffect(() => {
    if (!pageHost || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setHostRevision((revision) => revision + 1))
    observer.observe(pageHost)
    if (nativePageHost) observer.observe(nativePageHost)
    return () => observer.disconnect()
  }, [nativePageHost, pageHost])
  currentPaneRef.current = pane
  currentHandleRef.current = nativeHandle
  hoverRef.current = hoverPayload
  currentWatchRef.current = watchId
  currentFrameSizeRef.current = frameSize
  const serializeGuest = useCallback(<T,>(request: () => Promise<T>): Promise<T> => {
    const pending = guestQueueRef.current.then(request, request)
    guestQueueRef.current = pending.then(() => undefined, () => undefined)
    return pending
  }, [])


  const cancelOperation = useCallback(async (expected?: Operation, keepPending = false): Promise<void> => {
    if (!expected && !keepPending) armAttemptRef.current++
    const current = operationRef.current
    if (!current || (expected && current !== expected)) {
      if (!expected) {
        generationRef.current++
        if (mountedRef.current && !keepPending && !armPendingRef.current) {
          setOperation(null)
          setOperationPending(false)
          setHoverPayload(null)
        }
        hoverRef.current = null
      }
      await cancellationRef.current
      return
    }
    operationRef.current = null
    generationRef.current++
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    if (mountedRef.current) {
      setOperation(null)
      if (!keepPending) setOperationPending(false)
      setHoverPayload(null)
    }
    hoverRef.current = null
    const pending = cancellationRef.current.then(async () => {
      try {
        await serializeGuest(async () => {
          if (current.pane.mode === 'watch') await context.call('quirky.browser/designCancel', { pane: current.pane.id, opId: current.opId })
          else if (current.nativeHandle) await current.nativeHandle.evaluate(guestProgram('cancel', current.opId, current.mode))
        })
      } catch {
        return
      }
    })
    cancellationRef.current = pending
    await pending
  }, [context, serializeGuest])

  const cancelRef = useRef(cancelOperation)
  cancelRef.current = cancelOperation

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current++
      armAttemptRef.current++
      void cancelRef.current()
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (identityRef.current !== currentIdentity) {
      identityRef.current = currentIdentity
      copiedSelectionRef.current = null
      generationRef.current++
      armAttemptRef.current++
      if (mountedRef.current && !armPendingRef.current) setOperationPending(false)
    }
    const current = operationRef.current
    if (current && current.identity !== currentIdentity) void cancelOperation(current)
    if (current?.pane.mode === 'native' && current.nativeHandle !== nativeHandle) void cancelOperation(current)
    if (selectionMenu && selectionMenu.op.identity !== currentIdentity) setSelectionMenu(null)
  }, [currentIdentity, nativeHandle, cancelOperation, selectionMenu])

  const callFor = useCallback(async (operation: Operation, method: string, params: Record<string, unknown> = {}): Promise<unknown> => await serializeGuest(async () => {
    if (operation.pane.mode === 'watch') return await context.call(`quirky.browser/${method}`, { pane: operation.pane.id, ...params })
    const handle = operation.nativeHandle
    if (!handle) throw new Error('Native browser handle is no longer available.')
    const action = method === 'designCancel' ? 'cancel' : method === 'designRead' ? 'read' : method === 'designHover' ? 'hover' : method === 'designCapture' ? 'hide' : null
    if (!action) throw new Error(`Native browser does not support ${method}.`)
    return await handle.evaluate(guestProgram(action, operation.opId, operation.mode))
  }), [context, serializeGuest])

  const currentOperationIsLive = (candidate: Operation): boolean =>
    mountedRef.current && operationRef.current === candidate && generationRef.current === candidate.generation &&
    identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === candidate.identity

  const poll = useCallback(async (candidate: Operation): Promise<void> => {
    if (!currentOperationIsLive(candidate)) return
    if (Date.now() - candidate.startedAt >= PICKER_TIMEOUT_MS) {
      await cancelOperation(candidate)
      onMessage('Element selection timed out. Arm the picker again to continue.', 'error')
      return
    }
    try {
      const rawRead = await callFor(candidate, 'designRead', { opId: candidate.opId })
      if (!currentOperationIsLive(candidate)) return
      const read = readOf(rawRead, candidate.opId)
      if (!read) throw new Error('The browser returned an invalid selection response.')
      if (read.status === 'expired') {
        await cancelOperation(candidate)
        onMessage('Element selection timed out. Arm the picker again to continue.', 'error')
        return
      }
      if (read.status === 'cancelled') {
        await cancelOperation(candidate)
        return
      }
      if (read.selection) {
        await cancelOperation(candidate)
        if (read.selection.kind === 'context-selected') {
          setSelectionMenu({ payload: read.selection.payload, op: candidate })
          return
        }
        if (candidate.mode === 'annotate') {
          setDraft({ paneId: candidate.pane.page ?? candidate.pane.id, pageId: candidate.pane.page ?? candidate.pane.id, payload: { ...read.selection.payload, screenshot: null }, editingId: null, intent: 'change', comment: '' })
          return
        }
        setSelectionMenu({ payload: read.selection.payload, op: candidate })
        if (read.selection.kind === 'screenshot') {
          if (candidate.pane.mode === 'native') {
            onMessage('Native cropped screenshots are unavailable: the pinned public SDK has no supported page snapshot capability.', 'error')
            return
          }
          let image = screenshotOf(read.selection.payload.screenshot)
          if (!image && identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === candidate.identity) {
            const rect = read.selection.payload.target.rectViewport
            try {
              image = screenshotFromCapture(await serializeGuest(() => context.call('quirky.browser/designCapture', {
                pane: candidate.pane.id, rect
              })))
            } catch (error) {
              if (identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === candidate.identity) onMessage(errorText(error), 'error')
              return
            }
          }
          if (identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) !== candidate.identity) return
          if (!image) {
            onMessage('No screenshot available for this element.', 'error')
            return
          }
          await writeImageRef.current?.(image, 'Screenshotted', true, candidate.identity)
          return
        }
        await writeTextRef.current?.(read.selection.payload, 'Copied', true, candidate.identity)
        return
      }
      const rawHover = await callFor(candidate, 'designHover', { opId: candidate.opId })
      if (!currentOperationIsLive(candidate)) return
      const payload = hoverOf(rawHover)
      hoverRef.current = payload
      setHoverPayload(payload)
      timerRef.current = setTimeout(() => void poll(candidate), POLL_DELAY_MS)
    } catch (error) {
      if (!currentOperationIsLive(candidate)) return
      await cancelOperation(candidate)
      onMessage(errorText(error), 'error')
    }
  }, [callFor, cancelOperation, context, onMessage])

  const startOperation = useCallback(async (mode: 'grab' | 'annotate', keepCopiedSelection = false): Promise<boolean> => {
    const target = currentPaneRef.current
    const handle = currentHandleRef.current
    const eligible = target && target.url !== '' && target.url !== 'about:blank' && !target.loading && !target.error &&
      (target.mode === 'native' ? handle !== null : Boolean(target.page && watchReady)) && !markupScreenshot
    if (!eligible || !target) {
      onMessage(target?.mode === 'native' && !handle ? 'Native browser design tools are unavailable until its sandboxed page is ready.' : 'Design tools require a ready, nonblank browser page.', 'error')
      return false
    }
    if (armPendingRef.current) return false
    if (!keepCopiedSelection) copiedSelectionRef.current = null
    const identity = identityOf(target, watchId, frameSize)
    const attempt = ++armAttemptRef.current
    const opId = target.mode === 'native' ? idOf('design') : ''
    armPendingRef.current = true
    setOperationPending(true)
    setSelectionMenu(null)
    setDraft(null)
    try {
      await cancelOperation(undefined, true)
      if (!mountedRef.current || armAttemptRef.current !== attempt || identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) !== identity || (target.mode === 'native' && currentHandleRef.current !== handle)) return false
      const generation = ++generationRef.current
      let resolvedOpId = opId
      if (target.mode === 'watch') {
        const result = recordOf(await serializeGuest(() => context.call('quirky.browser/designArm', { pane: target.id, mode })))
        if (!result || typeof result.opId !== 'string' || result.opId === '') throw new Error('Watch did not return a design operation ID.')
        resolvedOpId = result.opId
      } else {
        await serializeGuest(() => handle!.evaluate(guestProgram('arm', resolvedOpId, mode)))
      }
      const candidate: Operation = { mode, pane: target, identity, startedAt: Date.now(), nativeHandle: handle, generation, opId: resolvedOpId }
      if (!mountedRef.current || armAttemptRef.current !== attempt || generationRef.current !== generation || identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) !== identity || (target.mode === 'native' && currentHandleRef.current !== handle)) {
        if (target.mode === 'watch') await serializeGuest(() => context.call('quirky.browser/designCancel', { pane: target.id, opId: resolvedOpId })).catch(() => undefined)
        else await serializeGuest(() => handle!.evaluate(guestProgram('cancel', resolvedOpId, mode))).catch(() => undefined)
        return false
      }
      operationRef.current = candidate
      setOperation(candidate)
      void poll(candidate)
      return true
    } catch (error) {
      if (mountedRef.current && armAttemptRef.current === attempt && identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === identity) onMessage(errorText(error), 'error')
      return false
    } finally {
      armPendingRef.current = false
      if (mountedRef.current) setOperationPending(false)
    }
  }, [cancelOperation, context, frameSize?.height, frameSize?.width, markupScreenshot, onMessage, poll, serializeGuest, watchId, watchReady])

  const writeText = useCallback(async (payload: DesignPayload, successMessage: string, rearm: boolean, expectedIdentity?: string): Promise<boolean> => {
    const stillCurrent = () => !expectedIdentity || identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === expectedIdentity
    if (!stillCurrent()) return false
    try {
      const formatted = recordOf(await context.call('quirky.browser/designFormat', { payload }))
      if (!formatted || typeof formatted.text !== 'string') throw new Error('The browser could not format this element context.')
      if (!stillCurrent()) return false
      if (!navigator.clipboard?.writeText) throw new Error('Text clipboard access is unavailable.')
      await navigator.clipboard.writeText(formatted.text)
      if (stillCurrent()) {
        copiedSelectionRef.current = { identity: expectedIdentity ?? identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current), payload: { ...payload, screenshot: null } }
        setCopyError(null)
        setSelectionMenu(null)
        if (rearm) void startOperation('grab', true)
      }
      onMessage(successMessage, 'info')
      return true
    } catch (error) {
      if (!stillCurrent()) return false
      const message = `Clipboard write failed: ${errorText(error)}. The selected data is still available; retry Copy.`
      setCopyError(message)
      onMessage(message, 'error')
      return false
    }
  }, [context, onMessage, startOperation])
  writeTextRef.current = writeText

  const capture = useCallback(async (operation: Operation | null, rect?: DesignPayload['target']['rectViewport']): Promise<DesignScreenshot | null> => {
    if (!pane || pane.mode !== 'watch') return null
    const result = await serializeGuest(() => context.call('quirky.browser/designCapture', {
      pane: pane.id,
      ...(operation ? { opId: operation.opId } : {}),
      ...(rect ? { rect } : {})
    }))
    return screenshotFromCapture(result, rect ? SCREENSHOT_MAX_BYTES : DESIGN_FULL_SCREENSHOT_MAX_BYTES)
  }, [context, pane, serializeGuest])

  const writeImage = useCallback(async (screenshot: DesignScreenshot, successMessage: string, rearm: boolean, expectedIdentity?: string): Promise<boolean> => {
    const stillCurrent = () => !expectedIdentity || identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === expectedIdentity
    if (!stillCurrent()) return false
    try {
      const clipboard = navigator.clipboard
      if (!clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('PNG clipboard access is unavailable.')
      if (!stillCurrent()) return false
      await clipboard.write([new ClipboardItem({ [screenshot.mimeType]: imageToBlob(screenshot) })])
      if (stillCurrent()) {
        setCopyError(null)
        setSelectionMenu(null)
        if (rearm) void startOperation('grab')
      }
      onMessage(successMessage, 'info')
      return true
    } catch (error) {
      if (!stillCurrent()) return false
      const message = `PNG clipboard write failed: ${errorText(error)}. The selected data is still available; retry Copy Screenshot.`
      setCopyError(message)
      onMessage(message, 'error')
      return false
    }
  }, [onMessage, startOperation])
  writeImageRef.current = writeImage

  const copyHover = useCallback(async (asImage: boolean): Promise<void> => {
    const operation = operationRef.current
    if (!operation || operation.mode !== 'grab') return
    const isCurrent = () => operationRef.current === operation && identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === operation.identity
    let payload = hoverRef.current
    if (!payload) {
      try { payload = hoverOf(await callFor(operation, 'designHover', { opId: operation.opId })) } catch (error) {
        if (isCurrent()) onMessage(errorText(error), 'error')
        return
      }
    }
    if (!isCurrent()) return
    const copied = copiedSelectionRef.current
    if (!payload && asImage && copied?.identity === operation.identity) payload = copied.payload
    if (!payload) {
      onMessage('No element hovered.', 'error')
      return
    }
    if (!asImage) {
      await writeText(payload, 'Copied', true, operation.identity)
      return
    }
    if (operation.pane.mode === 'native') {
      onMessage('Native cropped screenshots are unavailable: the pinned public SDK has no supported page snapshot capability.', 'error')
      return
    }
    try {
      const screenshot = await capture(operation, payload.target.rectViewport)
      if (!isCurrent()) return
      if (!screenshot) {
        onMessage('No screenshot available for this element.', 'error')
        return
      }
      await writeImage(screenshot, 'Screenshotted', true, operation.identity)
    } catch (error) {
      if (isCurrent()) onMessage(errorText(error), 'error')
    }
  }, [callFor, capture, onMessage, writeImage, writeText])

  const beginDraw = useCallback(async (): Promise<boolean> => {
    const target = currentPaneRef.current
    if (!target || target.mode !== 'watch' || !target.page || !watchReady || !usablePage || markupScreenshot) {
      onMessage(target?.mode === 'native' ? 'Draw is unavailable in Native: the pinned public SDK has no supported page snapshot capability.' : 'Draw requires a ready Watch page.', 'error')
      return false
    }
    const identity = identityOf(target, currentWatchRef.current, currentFrameSizeRef.current)
    await cancelOperation()
    setSelectionMenu(null)
    setDraft(null)
    try {
      const screenshot = await capture(null)
      if (identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) !== identity) return false
      if (!screenshot) {
        onMessage('No screenshot available for this Watch page.', 'error')
        return false
      }
      setMarkupScreenshot(screenshot)
      return true
    } catch (error) {
      if (identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === identity) onMessage(errorText(error), 'error')
      return false
    }
  }, [cancelOperation, capture, frameSize?.height, frameSize?.width, markupScreenshot, onMessage, usablePage, watchId, watchReady])

  const runAction = useCallback(async (action: DesignAction): Promise<boolean> => {
    if (action === 'cancel') {
      if (markupScreenshot) return false
      copiedSelectionRef.current = null
      await cancelOperation()
      setSelectionMenu(null)
      setDraft(null)
      return true
    }
    if (action === 'grab') return await startOperation('grab')
    if (action === 'annotate') return await startOperation('annotate')
    if (action === 'draw') return await beginDraw()
    return false
  }, [beginDraw, cancelOperation, markupScreenshot, startOperation])

  const runActionRef = useRef(runAction)
  runActionRef.current = runAction
  if (actionRef) actionRef.current = async (action) => await runActionRef.current(action)

  const probe = useCallback(async (target: DesignPane): Promise<ClipboardProbe | null> => {
    if (target.mode !== 'watch' || !target.page) return null
    try {
      const raw = await serializeGuest(() => context.call('quirky.browser/eval', { page: target.page, expression: WATCH_COPY_PROBE }))
      return copyProbeOf(raw)
    } catch {
      return null
    }
  }, [context, serializeGuest])

  const replayWatchKey = useCallback(async (target: DesignPane, key: string, code: string, modifierBits: number, text = false): Promise<void> => {
    if (!target.page) return
    try {
      if (text) {
        await context.call('quirky.browser/paneInput', { pane: target.id, kind: 'text', text: key })
        return
      }
      await context.call('quirky.browser/paneInput', { pane: target.id, kind: 'key', type: 'keyDown', key, code, modifiers: modifierBits })
      await context.call('quirky.browser/paneInput', { pane: target.id, kind: 'key', type: 'keyUp', key, code, modifiers: modifierBits })
    } catch (error) {
      onMessage(errorText(error), 'error')
    }
  }, [context, onMessage])

  const handleKeyboard = useCallback((event: KeyboardEvent) => {
    const target = currentPaneRef.current
    if (!focused || !target || !usablePage || event.isComposing || event.key === 'Process' || event.key === 'Dead') return
    const op = operationRef.current
    if (markupScreenshot) return
    if (event.key === 'Escape' && (op || armPendingRef.current || draft || selectionMenu)) {
      event.preventDefault()
      event.stopPropagation()
      void runActionRef.current('cancel')
      return
    }
    if (editableHostTarget(event.target)) return
    if (op?.mode === 'grab' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 's')) {
      event.preventDefault()
      event.stopPropagation()
      const chord = event.code || event.key
      handledChordRef.current.add(chord)
      if (shortcutPendingRef.current || event.repeat) return
      shortcutPendingRef.current = true
      const key = event.key
      const code = event.code
      const modifierBits = modifiers(event)
      void probe(target).then(async (state) => {
        if (!operationRef.current || operationRef.current.opId !== op.opId) return
        if (!state || state.editable) {
          await replayWatchKey(target, key, code, modifierBits, true)
          return
        }
        await copyHover(key.toLowerCase() === 's')
      }).finally(() => { shortcutPendingRef.current = false })
      return
    }
    if (event.target instanceof Element && event.target.closest('.qbp-toolbar, .qbp-find, .qbp-design-toolbar, .qbp-design-overlay')) return
    if (target.mode === 'native') return
    if (shortcutMod(event) && event.shiftKey && event.key.toLowerCase() === 'c' && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      void runActionRef.current('annotate')
      return
    }
    if (shortcutMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c' && !op && !event.repeat) {
      event.preventDefault()
      event.stopPropagation()
      const chord = event.code || event.key
      handledChordRef.current.add(chord)
      const key = event.key
      const code = event.code
      const modifierBits = modifiers(event)
      if (shortcutPendingRef.current) {
        void replayWatchKey(target, key, code, modifierBits)
        return
      }
      shortcutPendingRef.current = true
      void probe(target).then(async (state) => {
        if (!state || state.editable || state.selected) {
          await replayWatchKey(target, key, code, modifierBits)
          return
        }
        await runActionRef.current('grab')
      }).finally(() => { shortcutPendingRef.current = false })
    }
  }, [copyHover, draft, focused, markupScreenshot, probe, replayWatchKey, selectionMenu, usablePage])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => handleKeyboard(event)
    const keyup = (event: KeyboardEvent) => {
      const chord = event.code || event.key
      if (!handledChordRef.current.has(chord)) return
      event.preventDefault()
      event.stopPropagation()
      handledChordRef.current.delete(chord)
    }
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('keyup', keyup, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('keyup', keyup, true)
    }
  }, [handleKeyboard])
  useEffect(() => {
    // an isolated preview's CSP refuses injected script, so shortcuts could never install there
    if (pane?.mode !== 'native' || pane.url.startsWith(`${NATIVE_BROWSER_PREVIEW_SCHEME}://`) || !nativeHandle || !focused || !usablePage || currentOperation || operationPending || markupScreenshot || draft || selectionMenu || targetsOpen) return
    const handle = nativeHandle
    const owner = nativeShortcutOwner
    const ownerLiteral = JSON.stringify(owner)
    const key = JSON.stringify(`__quirkyDesignShortcut_${owner.replace(/[^a-zA-Z0-9]/g, '_')}`)
    const installScript = `(() => {
      const key = ${key};
      const owner = ${ownerLiteral};
      let bridge = window[key];
      if (bridge && bridge.owner !== owner) return false;
      if (!bridge) {
        bridge = { pending: null, dispose: null };
        Object.defineProperty(bridge, 'owner', { value: owner });
        Object.defineProperty(window, key, { value: bridge, configurable: false, writable: false });
      } else if (typeof bridge.dispose === 'function') {
        bridge.dispose();
      }
      bridge.pending = null;
      const keydown = (event) => {
        if (event.isTrusted !== true || event.defaultPrevented || event.isComposing || event.repeat || event.altKey ||
            (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'c') return;
        const active = document.activeElement;
        if (active && (active.isContentEditable || active.tagName === 'IFRAME' || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
        if (event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          bridge.pending = 'annotate';
          return;
        }
        const selection = window.getSelection ? window.getSelection() : null;
        if (selection && String(selection).length > 0) return;
        event.preventDefault();
        event.stopPropagation();
        bridge.pending = 'grab';
      };
      document.addEventListener('keydown', keydown, true);
      bridge.dispose = () => {
        document.removeEventListener('keydown', keydown, true);
        bridge.pending = null;
        bridge.dispose = null;
      };
      return true;
    })()`
    const readScript = `(() => {
      const bridge = window[${key}];
      if (!bridge || bridge.owner !== ${ownerLiteral}) return { installed: false };
      const action = bridge.pending;
      bridge.pending = null;
      return { installed: true, action };
    })()`
    const removeScript = `(() => {
      const bridge = window[${key}];
      if (!bridge || bridge.owner !== ${ownerLiteral}) return false;
      if (typeof bridge.dispose === 'function') bridge.dispose();
      return true;
    })()`
    const identity = currentIdentity
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const stillCurrent = () => active && mountedRef.current && focused &&
      currentHandleRef.current === handle &&
      identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === identity
    const poll = async (): Promise<void> => {
      if (!stillCurrent()) return
      try {
        const result = recordOf(await serializeGuest(() => handle.evaluate(readScript)))
        if (!stillCurrent()) return
        if (!result || result.installed !== true) {
          onMessage('Native design shortcuts are unavailable on this document; use the toolbar or design command.', 'error')
          return
        }
        if (result.action === 'grab' || result.action === 'annotate') {
          if (await runActionRef.current(result.action)) return
        }
      } catch (error) {
        if (!stillCurrent()) return
        // a page waiting on a native dialog can't evaluate until the user answers, which isn't a failure
        if (!NATIVE_EVALUATION_BUSY.test(errorText(error))) {
          onMessage(`Native design shortcut polling stopped: ${errorText(error)}`, 'error')
          return
        }
      }
      if (stillCurrent()) timer = setTimeout(() => void poll(), POLL_DELAY_MS)
    }
    void serializeGuest(() => handle.evaluate(installScript)).then((installed) => {
      if (!stillCurrent()) return
      if (installed !== true) {
        onMessage('Native design shortcuts could not be installed; use the toolbar or design command.', 'error')
        return
      }
      void poll()
    }).catch((error: unknown) => {
      if (stillCurrent() && !NATIVE_EVALUATION_BUSY.test(errorText(error))) onMessage(`Native design shortcuts could not be installed: ${errorText(error)}`, 'error')
    })
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
      void serializeGuest(() => handle.evaluate(removeScript)).catch(() => undefined)
    }
  }, [currentIdentity, currentOperation, draft, focused, markupScreenshot, nativeHandle, nativeShortcutOwner, onMessage, operationPending, pane?.mode, selectionMenu, serializeGuest, targetsOpen, usablePage])

  const saveDraft = useCallback(() => {
    if (!draft) return
    const comment = draft.comment.slice(0, MAX_COMMENT).trim()
    if (!comment) {
      onMessage('Add feedback before saving the annotation.', 'error')
      return
    }
    updateAnnotations(draft.paneId, (current) => {
      if (draft.editingId) return current.map((annotation) => annotation.id === draft.editingId
        ? { ...annotation, revision: annotation.revision + 1, intent: draft.intent, comment }
        : annotation)
      const annotation: DesignAnnotation = {
        id: idOf('annotation'), revision: 1, browserPageId: draft.pageId, payload: draft.payload, intent: draft.intent, comment
      }
      return [...current, annotation].slice(-MAX_ANNOTATIONS)
    })
    const shouldRearm = draft.paneId === (currentPaneRef.current?.page ?? currentPaneRef.current?.id)
    setDraft(null)
    setSelectionMenu(null)
    onMessage('Annotation added.', 'info')
    if (shouldRearm) void startOperation('annotate')
  }, [draft, onMessage, startOperation])

  const openTargets = useCallback(async () => {
    if (!pane) return
    setTargetsOpen(true)
    setTargetsLoading(true)
    try {
      setTargets(targetsOf(await context.call('quirky.browser/designTargets', { pane: pane.id })))
    } catch (error) {
      setTargets(null)
      onMessage(errorText(error), 'error')
    } finally {
      setTargetsLoading(false)
    }
  }, [context, onMessage, pane])

  const sendTo = useCallback(async (target: SendTarget) => {
    if (!pane) return
    const pageId = pane.page ?? pane.id
    const alreadyHeld = getAnnotationPage(pageId).heldIds
    const snapshot = annotations.filter((annotation) => !alreadyHeld.has(annotation.id)).map((annotation) => ({ ...annotation, payload: annotation.payload }))
    if (!snapshot.length) {
      onMessage('There are no available annotations to send.', 'info')
      return
    }
    const ids = snapshot.map((annotation) => annotation.id)
    updateHeld(pageId, ids, true)
    setTargetsOpen(false)
    try {
      const result = recordOf(await context.call('quirky.browser/designSend', {
        pane: pane.id, annotations: snapshot,
        ...(target.kind === 'session' ? { session: target.value.session } : { agent: target.id })
      }))
      if (result && (result.delivery === 'pasted' || result.delivery === 'command-line')) {
        const sentRevisions = new Map(snapshot.map((annotation) => [annotation.id, annotation.revision]))
        updateAnnotations(pageId, (current) => current.filter((annotation) => sentRevisions.get(annotation.id) !== annotation.revision))
        onMessage('Notes sent.', 'info')
      } else {
        onMessage(`Delivery outcome is uncertain (${typeof result?.delivery === 'string' ? result.delivery : 'unknown'}); annotations were retained.`, 'error')
      }
    } catch (error) {
      onMessage(`Notes were not confirmed as sent: ${errorText(error)}. Annotations were retained.`, 'error')
    } finally {
      updateHeld(pageId, ids, false)
    }
  }, [annotations, context, onMessage, pane])

  const editAnnotation = useCallback((annotation: DesignAnnotation) => {
    setDraft({ paneId: annotation.browserPageId, pageId: annotation.browserPageId, payload: annotation.payload, editingId: annotation.id, intent: annotation.intent, comment: annotation.comment })
  }, [])

  const removeAnnotation = useCallback((id: string) => {
    if (!pane) return
    updateAnnotations(pane.page ?? pane.id, (current) => current.filter((annotation) => annotation.id !== id))
  }, [pane])

  const copyAnnotations = useCallback(async (items: DesignAnnotation[]) => {
    try {
      const formatted = recordOf(await context.call('quirky.browser/designFormat', { annotations: items }))
      if (!formatted || typeof formatted.text !== 'string') throw new Error('The browser could not format these annotations.')
      if (!navigator.clipboard?.writeText) throw new Error('Text clipboard access is unavailable.')
      await navigator.clipboard.writeText(formatted.text)
      onMessage('Annotations copied.', 'info')
    } catch (error) {
      onMessage(`Clipboard write failed: ${errorText(error)}. Annotations were retained.`, 'error')
    }
  }, [context, onMessage])

  const copiedCurrentElement = copiedSelectionRef.current?.identity === currentIdentity
  const grabHint = copiedCurrentElement
    ? pane?.mode === 'watch' ? 'Copied — press S to screenshot, or select another element. Esc cancels.' : 'Copied — select another element. Esc cancels.'
    : pane?.mode === 'watch' ? 'Click an element, or hover and press C to copy / S to screenshot. Esc cancels.' : 'Click an element, or hover and press C to copy. Esc cancels.'

  const panel = pageHost ? createPortal(<div className="qbp-design-overlay" aria-label="Browser design mode" style={designOverlayStyle}>
    {hoverPayload && currentOperation?.mode === 'grab' && pageGeometry && pageGeometry.width > 0 ? <div aria-label={`${hoverPayload.target.tagName}${hoverPayload.target.accessibility.role ? ` role=${hoverPayload.target.accessibility.role}` : ''}${hoverPayload.target.accessibility.accessibleName ? ` “${hoverPayload.target.accessibility.accessibleName}”` : ''} ${Math.round(hoverPayload.target.rectViewport.width)}×${Math.round(hoverPayload.target.rectViewport.height)}`} style={{
      position: 'absolute', left: pageGeometry.left + hoverPayload.target.rectViewport.x * pageGeometry.width / hoverPayload.page.viewportWidth,
      top: pageGeometry.top + hoverPayload.target.rectViewport.y * pageGeometry.height / hoverPayload.page.viewportHeight,
      width: hoverPayload.target.rectViewport.width * pageGeometry.width / hoverPayload.page.viewportWidth,
      height: hoverPayload.target.rectViewport.height * pageGeometry.height / hoverPayload.page.viewportHeight,
      boxSizing: 'border-box', border: 'var(--ui-focus-width) solid var(--ui-accent)',
      boxShadow: '0 0 0 100vmax var(--ui-shadow)', pointerEvents: 'none'
    }}><span style={highlightLabelStyle}>{hoverPayload.target.tagName}{hoverPayload.target.accessibility.role ? ` role=${hoverPayload.target.accessibility.role}` : ''}{hoverPayload.target.accessibility.accessibleName ? ` “${hoverPayload.target.accessibility.accessibleName}”` : ''} {Math.round(hoverPayload.target.rectViewport.width)}×{Math.round(hoverPayload.target.rectViewport.height)}</span></div> : null}
    {annotations.map((annotation, index) => {
      if (!pageHost || !pane || !frameCurrent(annotation, pane.url) || !pageGeometry || pageGeometry.width <= 0) return null
      const rect = annotation.payload.target.rectViewport
      return <Button
        key={annotation.id}
        className="qbp-design-pin"
        data-quirky-native-mask
        style={{
          position: 'absolute', zIndex: 1, width: 'var(--ui-row-single)', height: 'var(--ui-row-single)', minHeight: 'var(--ui-row-single)',
          padding: 0, borderRadius: '50%', border: 'var(--ui-border-width) solid var(--ui-surface)',
          color: 'var(--ui-surface)', background: 'var(--ui-failing)', fontWeight: 700,
          transform: 'translate(-50%, -50%)', pointerEvents: 'auto',
          left: pageGeometry.left + (rect.x + rect.width / 2) * pageGeometry.width / annotation.payload.page.viewportWidth,
          top: pageGeometry.top + (rect.y + rect.height / 2) * pageGeometry.height / annotation.payload.page.viewportHeight
        }}
        aria-label={`Edit annotation ${index + 1}: ${annotation.comment}`}
        title={annotation.comment}
        onClick={(event) => { event.stopPropagation(); editAnnotation(annotation) }}
      >{index + 1}</Button>
    })}
    {selectionMenu ? <div role="menu" aria-label="Selected element actions" style={menuPanelStyle}>
      <SectionHeader title={elementLabel(selectionMenu.payload)} />
      {copyError ? <p style={errorMessageStyle} role="alert">{copyError}</p> : null}
      <Button style={menuButtonStyle} role="menuitem" onClick={() => void writeText(selectionMenu.payload, 'Copied', true, selectionMenu.op.identity)}>Copy</Button>
      <Button style={menuButtonStyle} role="menuitem" disabled={selectionMenu.op.pane.mode === 'native'} title={selectionMenu.op.pane.mode === 'native' ? 'Native cropped screenshots are unavailable: the pinned public SDK has no supported page snapshot capability.' : 'Copy a PNG crop of this element'} onClick={() => {
        if (selectionMenu.op.pane.mode === 'native') return
        const identity = selectionMenu.op.identity
        void capture(null, selectionMenu.payload.target.rectViewport).then((image) => {
          if (identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) !== identity) return
          if (image) void writeImage(image, 'Screenshotted', true, identity)
          else onMessage('No screenshot available for this element.', 'error')
        }).catch((error: unknown) => {
          if (identityOf(currentPaneRef.current, currentWatchRef.current, currentFrameSizeRef.current) === identity) onMessage(errorText(error), 'error')
        })
      }}>Copy Screenshot</Button>
      <Button style={menuButtonStyle} role="menuitem" onClick={() => { setSelectionMenu(null); void startOperation(selectionMenu.op.mode) }}>Select another element</Button>
      <Button style={menuButtonStyle} role="menuitem" onClick={() => { setSelectionMenu(null); void cancelOperation() }}>Cancel</Button>
    </div> : null}
    {draft ? <div role="dialog" aria-modal="false" aria-label={draft.editingId ? 'Edit browser annotation' : 'Add browser annotation'} style={menuPanelStyle}>
      <SectionHeader title={draft.editingId ? 'Edit browser annotation' : 'Add browser annotation'} />
      <span style={{ overflowWrap: 'anywhere' }}>{elementLabel(draft.payload)}</span>
      <div style={actionGroupStyle} role="group" aria-label="Annotation intent">
        <Button variant={draft.intent === 'change' ? 'primary' : 'secondary'} aria-pressed={draft.intent === 'change'} onClick={() => setDraft({ ...draft, intent: 'change' })}>Change</Button>
        <Button variant={draft.intent === 'question' ? 'primary' : 'secondary'} aria-pressed={draft.intent === 'question'} onClick={() => setDraft({ ...draft, intent: 'question' })}>Question</Button>
      </div>
      <FormRow htmlFor={feedbackId} label="Feedback">
        <textarea id={feedbackId} className="ui-text-field__input" aria-label="Feedback" maxLength={MAX_COMMENT} value={draft.comment} placeholder="Describe what the agent should change here..." style={annotationFeedbackStyle} onChange={(event) => setDraft({ ...draft, comment: event.target.value.slice(0, MAX_COMMENT) })} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveDraft() }
          if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
        }} />
      </FormRow>
      <small style={noteDetailsStyle}>{draft.comment.length}/{MAX_COMMENT} characters · {draft.payload.page.sanitizedUrl}</small>
      <div style={{ ...actionGroupStyle, justifyContent: 'flex-end' }}>
        <Button onClick={() => setDraft(null)}>Cancel</Button>
        <Button variant="primary" disabled={!draft.comment.trim()} onClick={saveDraft}>{draft.editingId ? 'Save' : 'Add'}</Button>
      </div>
    </div> : null}
    {targetsOpen ? <div role="menu" aria-label="Send notes to" style={menuPanelStyle}>
      <SectionHeader title="Send notes to" />
      {targetsLoading ? <span role="status">Loading targets…</span> : null}
      {!targetsLoading && targets ? <>
        <section aria-label="Running agents" style={targetGroupsStyle}>
          <SectionHeader title="Running agents" />
          {targets.sessions.map((target) => <Button key={target.session} style={targetButtonStyle} role="menuitem" disabled={!target.sendable || !notesAvailable.length} title={target.sendable ? undefined : target.reason ?? 'This agent cannot currently accept input.'} onClick={() => void sendTo({ kind: 'session', value: target })}>
            <span style={targetStatusStyle}><StatusDot status={target.sendable ? 'working' : 'idle'} />{target.label} · {target.state ?? target.status} · {formatAge(target.lastActivityAt)}</span>
            <span>{target.title || 'Untitled agent session'}</span>
            {!target.sendable ? <span style={targetReasonStyle}>{target.reason ?? 'This agent cannot currently accept input.'}</span> : null}
          </Button>)}
          {!targets.sessions.length ? <EmptyState message="No running agents in this worktree." /> : null}
        </section>
        <section aria-label="New agent" style={targetGroupsStyle}>
          <SectionHeader title="New agent" />
          {targets.agents.map((agent) => <Button key={agent.id} style={menuButtonStyle} role="menuitem" disabled={!notesAvailable.length} onClick={() => void sendTo({ kind: 'agent', id: agent.id, label: agent.label })}>{agent.label}</Button>)}
          {!targets.agents.length ? <EmptyState message="No new-agent targets are available." /> : null}
        </section>
      </> : null}
      <Button style={menuButtonStyle} onClick={() => setTargetsOpen(false)}>Close</Button>
    </div> : null}
    {annotations.length ? <section data-quirky-native-mask aria-label="Browser annotations" style={annotationTrayStyle}>
      <div style={annotationTrayHeadStyle}>
        <SectionHeader title="Browser annotations" actions={<>
          <Button aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{annotations.length} annotation{annotations.length === 1 ? '' : 's'}</Button>
          <Button disabled={!notesAvailable.length} onClick={() => void openTargets()}>Send</Button>
          <Button disabled={!annotations.length} onClick={() => void copyAnnotations(annotations)}>Copy All</Button>
          <Button variant="destructive" aria-label="Clear all annotations" onClick={() => annotationPageId && updateAnnotations(annotationPageId, () => [])}>Clear</Button>
        </>} />
      </div>
      {!collapsed ? <div style={annotationListStyle}>{annotations.map((annotation, index) => <article style={annotationNoteStyle} key={annotation.id}>
        <strong style={{ overflowWrap: 'anywhere' }}>{index + 1}. {elementLabel(annotation.payload)}</strong>
        <p style={noteTextStyle}><span>{annotation.intent === 'change' ? 'Change' : 'Question'}: </span>{annotation.comment}</p>
        <small style={noteDetailsStyle}>{annotation.payload.page.sanitizedUrl}</small>
        <div style={actionGroupStyle}>
          <Button onClick={() => editAnnotation(annotation)}>Edit</Button>
          <Button variant="destructive" onClick={() => removeAnnotation(annotation.id)}>Delete</Button>
          <Button onClick={() => void copyAnnotations([annotation])}>Copy</Button>
        </div>
      </article>)}</div> : null}
    </section> : null}
    {markupScreenshot ? <MarkupOverlay screenshot={markupScreenshot} onClose={() => setMarkupScreenshot(null)} onCopied={() => onMessage('Markup copied — paste it into your agent.', 'info')} onError={(message) => onMessage(message, 'error')} /> : null}
  </div>, pageHost) : null

  return <>
    <div className="qbp-design-toolbar" aria-label="Browser design tools" style={toolbarStyle}>
      <Button
        type="button"
        variant={currentOperation?.mode === 'grab' ? 'primary' : 'secondary'}
        aria-pressed={currentOperation?.mode === 'grab'}
        aria-disabled={grabDisabled || operationPending}
        aria-busy={operationPending}
        disabled={grabDisabled}
        title="Grab page element (Mod+C)"
        onClick={() => {
          if (armPendingRef.current) return
          if (currentOperation?.mode === 'grab') void cancelOperation()
          else void startOperation('grab')
        }}
      >{operationPending ? 'Arming…' : 'Grab'}</Button>
      <Button
        type="button"
        variant={currentOperation?.mode === 'annotate' ? 'primary' : 'secondary'}
        aria-pressed={currentOperation?.mode === 'annotate'}
        aria-disabled={annotateDisabled || operationPending}
        aria-busy={operationPending}
        disabled={annotateDisabled}
        title="Annotate page element (Mod+Shift+C)"
        onClick={() => {
          if (armPendingRef.current) return
          if (currentOperation?.mode === 'annotate') void cancelOperation()
          else void startOperation('annotate')
        }}
      >{operationPending ? 'Arming…' : 'Annotate'}{annotations.length ? ` (${annotations.length})` : ''}</Button>
      <Button type="button" variant={Boolean(markupScreenshot) ? 'primary' : 'secondary'} aria-pressed={Boolean(markupScreenshot)} disabled={drawingDisabled} title={pane?.mode === 'native' ? 'Native Draw is unavailable: the pinned public SDK has no supported page snapshot capability.' : 'Draw on screenshot'} onClick={() => void beginDraw()}>Draw</Button>
      {pane?.mode === 'native' ? <span style={hintStyle}>Native cropped screenshots and Draw are unavailable: the pinned public SDK has no supported page snapshot capability.</span> : null}
      {currentOperation ? <span style={hintStyle} role="status">{currentOperation.mode === 'grab' ? grabHint : 'Click an element to annotate. Esc cancels.'}</span> : null}
      {pane?.mode === 'native' && !nativeHandle ? <span style={hintStyle}>Native design tools are available when its sandboxed page is ready.</span> : null}
    </div>
    {panel}
  </>
}

function frameCurrent(annotation: DesignAnnotation, url: string): boolean {
  try {
    const original = new URL(annotation.payload.page.sanitizedUrl)
    const current = new URL(url)
    return original.origin === current.origin && original.pathname === current.pathname
  } catch {
    return annotation.payload.page.sanitizedUrl === url
  }
}
