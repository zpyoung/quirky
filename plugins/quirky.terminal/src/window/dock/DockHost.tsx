import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { TerminalPaneView, type TerminalPaneHandle, type TerminalPaneProps } from '../pane/TerminalPaneView'
import type { WorkspaceController } from '../workspace/controller'
import { DEFAULT_GUTTER_ROWS, dockHeight, gutterRowsAfterDrag, RESIZE_HANDLE_HEIGHT_PX, shouldMountDock } from './geometry'
import { isDockState, type DockHostReport, type DockState, type DockTransport } from './types'

const COMPOSER_VIEW_ID = 'view:quirky.terminal-dock/composer'

type ResizeDrag = { startY: number; startRows: number; previewRows: number }

type Props = Omit<TerminalPaneProps, 'ref' | 'active' | 'dragging' | 'suppressAutoFocus'> & {
  controller: WorkspaceController
  paneId: string
  active: boolean
  dragging: boolean
  terminalEpoch: number
  availableHeight: number
  onHandle(handle: TerminalPaneHandle | null): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns the terminal's available height and embeds the dock only through the public view API. */
export function DockHost(props: Props) {
  const { context, controller, paneId, sessionId, active, dragging: workspaceDragging, availableHeight, terminalEpoch, onHandle, ...terminalProps } = props
  const [dock, setDock] = useState<DockState | null>(null)
  const dockRef = useRef<DockState | null>(null)
  const [rows, setRows] = useState(DEFAULT_GUTTER_ROWS)
  const resizeRef = useRef<ResizeDrag | null>(null)
  const [resize, setResize] = useState<ResizeDrag | null>(null)
  const [geometryMounted, setGeometryMounted] = useState(false)
  const [viewMounted, setViewMounted] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [hostFocused, setHostFocused] = useState(false)
  const [transport, setTransport] = useState<DockTransport>('connecting')
  const [hostError, setHostError] = useState<string | null>(null)
  const [mountError, setMountError] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const composerHost = useRef<HTMLDivElement>(null)
  const terminalHandle = useRef<TerminalPaneHandle | null>(null)
  const onHandleRef = useRef(onHandle)
  onHandleRef.current = onHandle
  const onPaneFocusRef = useRef(terminalProps.onFocus)
  onPaneFocusRef.current = terminalProps.onFocus
  const requestSequence = useRef(0)
  const reportSequence = useRef(0)
  const reportSignature = useRef<string | null>(null)
  const focusWanted = useRef(false)
  const focusRequestPending = useRef(false)
  const wasRequested = useRef(false)
  const wasActive = useRef(active)
  const wasPassthrough = useRef(false)

  const terminalRef = useCallback((handle: TerminalPaneHandle | null) => {
    terminalHandle.current = handle
    onHandleRef.current(handle)
  }, [])
  const onComposerFocus = useCallback(() => {
    onPaneFocusRef.current?.()
    setComposerFocused(true)
    setHostFocused(true)
  }, [])

  const acceptDock = useCallback(
    (next: DockState) => {
      if (next.pane !== paneId || next.session !== sessionId) return
      const previous = dockRef.current
      if (previous && next.revision < previous.revision) return
      dockRef.current = next
      setDock(next)
      if (!resizeRef.current) setRows(next.gutterRows)
      setHostError(null)
    },
    [paneId, sessionId]
  )

  const loadDock = useCallback(async () => {
    const sequence = ++requestSequence.current
    try {
      const result = await context.call('quirky.terminal-dock/get', { pane: paneId, session: sessionId })
      if (sequence !== requestSequence.current) return
      if (!isDockState(result) || result.pane !== paneId || result.session !== sessionId) throw new Error('The dock state response was invalid.')
      acceptDock(result)
      setTransport('connected')
    } catch (error) {
      if (sequence !== requestSequence.current) return
      const previous = dockRef.current
      const showError = Boolean(previous?.enabled && previous.supported && previous.docked)
      dockRef.current = null
      setDock(null)
      setHostError(showError ? messageOf(error) : null)
      setTransport('offline')
    }
  }, [acceptDock, context, paneId, sessionId])

  useEffect(() => {
    const onEvent = (event: QuirkyEvent) => {
      if (event.type !== 'quirky.terminal-dock/changed' || !('data' in event)) return
      const data = event.data
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return
      if (!('pane' in data) || data.pane !== paneId || !('state' in data) || !isDockState(data.state)) return
      requestSequence.current += 1
      acceptDock(data.state)
      setTransport('connected')
    }
    const unsubscribe = context.subscribe(onEvent)
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'reconnecting') {
        setTransport('reconnecting')
        return
      }
      setTransport('connected')
      void loadDock()
    })
    void loadDock()
    return () => {
      requestSequence.current += 1
      unsubscribe()
      unsubscribeConnection()
    }
  }, [acceptDock, context, loadDock, paneId])

  const requested = Boolean(dock?.enabled && dock.supported && dock.docked)
  const shownRows = resize?.previewRows ?? rows
  const shownHeight = dockHeight(shownRows)
  const overlayMaxHeight = Math.max(0, availableHeight - shownHeight - 6)
  useEffect(() => {
    const next = requested ? shouldMountDock(geometryMounted, availableHeight, dockHeight(shownRows), resize !== null) : false
    if (next !== geometryMounted) setGeometryMounted(next)
  }, [availableHeight, geometryMounted, requested, resize, shownRows])

  const renderComposer = requested && geometryMounted
  useLayoutEffect(() => {
    const hostElement = host.current
    if (!hostElement) return
    const composerElement = composerHost.current
    const onHostFocus = () => setHostFocused(true)
    const onHostBlur = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && hostElement.contains(next)) return
      setHostFocused(false)
    }
    const onComposerBlur = (event: FocusEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && composerElement?.contains(next)) return
      setComposerFocused(false)
    }
    hostElement.addEventListener('focusin', onHostFocus, true)
    hostElement.addEventListener('focusout', onHostBlur, true)
    composerElement?.addEventListener('focusin', onComposerFocus, true)
    composerElement?.addEventListener('focusout', onComposerBlur, true)
    return () => {
      hostElement.removeEventListener('focusin', onHostFocus, true)
      hostElement.removeEventListener('focusout', onHostBlur, true)
      composerElement?.removeEventListener('focusin', onComposerFocus, true)
      composerElement?.removeEventListener('focusout', onComposerBlur, true)
    }
  }, [onComposerFocus, renderComposer])
  useEffect(() => {
    const element = composerHost.current
    if (!renderComposer || !element) {
      if (!renderComposer) {
        setViewMounted(false)
        setMountError(null)
      }
      return
    }
    try {
      const unmount = context.mountView(COMPOSER_VIEW_ID, element, { pane: paneId, session: sessionId })
      setViewMounted(true)
      setMountError(null)
      // The contributed view has its own React root; release it after this root finishes committing.
      return () => queueMicrotask(unmount)
    } catch (error) {
      setViewMounted(false)
      setMountError(messageOf(error))
    }
  }, [context, paneId, renderComposer, sessionId])

  const mounted = renderComposer && viewMounted
  const focused = hostFocused
  const composerHasFocus = mounted && composerFocused
  useEffect(() => {
    if (!dock) {
      controller.clearDockState(paneId)
      return
    }
    controller.setDockState(paneId, {
      ...dock,
      mounted,
      passthrough: mounted && dock.passthrough
    })
  }, [controller, dock, mounted, paneId])

  useEffect(() => {
    controller.setDockHostState(paneId, mounted, focused, composerHasFocus)
  }, [composerHasFocus, controller, focused, mounted, paneId])

  useEffect(() => {
    if (!dock?.enabled) {
      reportSignature.current = null
      return
    }
    const report: DockHostReport = { mounted, focused, transport }
    const signature = JSON.stringify(report)
    if (reportSignature.current === signature) return
    reportSignature.current = signature
    const sequence = ++reportSequence.current
    let cancelled = false
    void context
      .call('quirky.terminal-dock/report', { pane: paneId, ...report })
      .then((result) => {
        if (cancelled || sequence !== reportSequence.current || !isDockState(result)) return
        acceptDock(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [acceptDock, context, dock?.enabled, focused, mounted, paneId, transport])

  const requestComposerFocus = useCallback(() => {
    if (!controller.canFocusDock(paneId) || focusRequestPending.current) return
    focusRequestPending.current = true
    void context.executeCommand('command:quirky.terminal-dock/focus', { pane: paneId }).then(
      () => {
        focusRequestPending.current = false
      },
      (error) => {
        focusRequestPending.current = false
        setMountError(messageOf(error))
      }
    )
  }, [context, controller, paneId])

  useEffect(() => {
    const enteringPassthrough = Boolean(dock?.passthrough && !wasPassthrough.current)
    const returningFromPassthrough = Boolean(wasPassthrough.current && dock && !dock.passthrough)
    const becameActive = active && !wasActive.current
    const closedDock = wasRequested.current && !requested
    if (requested && (!wasRequested.current || becameActive || returningFromPassthrough)) focusWanted.current = true

    if (!requested || dock?.passthrough) {
      if (active && (closedDock || composerFocused || focusWanted.current || enteringPassthrough || (becameActive && dock?.passthrough))) terminalHandle.current?.focus()
      focusWanted.current = false
    } else if (!mounted) {
      if (composerFocused && active) terminalHandle.current?.focus()
    } else {
      if (active && focusWanted.current && controller.canFocusDock(paneId)) {
        focusWanted.current = false
        requestComposerFocus()
      }
    }

    wasRequested.current = requested
    wasActive.current = active
    wasPassthrough.current = Boolean(dock?.passthrough)
  }, [active, composerFocused, controller, dock, hostFocused, mounted, paneId, requestComposerFocus, requested])

  const persistRows = useCallback(
    async (nextRows: number) => {
      const current = dockRef.current
      if (!current?.enabled || !current.supported || !current.docked || current.gutterRows === nextRows) return
      try {
        const result = await context.call('quirky.terminal-dock/set', { pane: paneId, gutterRows: nextRows })
        if (!isDockState(result)) throw new Error('The dock state response was invalid.')
        acceptDock(result)
      } catch (error) {
        setRows(dockRef.current?.gutterRows ?? DEFAULT_GUTTER_ROWS)
        context.toast('Could not resize the agent composer', messageOf(error))
      }
    },
    [acceptDock, context, paneId]
  )

  const beginResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !mounted || !dock?.enabled) return
    event.preventDefault()
    event.stopPropagation()
    const startRows = shownRows
    const initial = { startY: event.clientY, startRows, previewRows: startRows }
    resizeRef.current = initial
    setResize(initial)
  }

  useEffect(() => {
    if (!resize) return
    const target = host.current?.ownerDocument.defaultView
    if (!target) return
    const onMove = (event: MouseEvent) => {
      const current = resizeRef.current
      if (!current) return
      const next = { ...current, previewRows: gutterRowsAfterDrag(current.startRows, event.clientY - current.startY) }
      resizeRef.current = next
      setResize(next)
    }
    const onUp = () => {
      const current = resizeRef.current
      resizeRef.current = null
      setResize(null)
      if (!current || current.previewRows === current.startRows) return
      setRows(current.previewRows)
      void persistRows(current.previewRows)
    }
    target.addEventListener('mousemove', onMove)
    target.addEventListener('mouseup', onUp)
    return () => {
      target.removeEventListener('mousemove', onMove)
      target.removeEventListener('mouseup', onUp)
    }
  }, [persistRows, resize !== null])

  useEffect(() => () => {
    const current = dockRef.current
    controller.clearDockHostState(paneId)
    controller.clearDockState(paneId)
    if (current?.enabled) {
      void context
        .call('quirky.terminal-dock/report', { pane: paneId, mounted: false, focused: false, transport: 'disconnected' })
        .catch(() => {})
    }
  }, [context, controller, paneId])

  const onTerminalMouseUp = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest(`[data-terminal-pane="${sessionId}"]`)) return
    const current = dockRef.current
    if (active && mounted && current?.enabled && current.supported && current.docked && !current.passthrough) requestComposerFocus()
  }


  const suppressTerminalFocus = mounted && !dock?.passthrough && (composerFocused || focusWanted.current || !hostFocused)

  return (
    <div
      ref={host}
      className="qtd-host"
      data-dock-pane={paneId}
      data-dock-gutter={shownRows}
      onMouseUp={onTerminalMouseUp}

      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}
    >
      <div className="qtd-terminal" style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <TerminalPaneView
          key={terminalEpoch}
          {...terminalProps}
          ref={terminalRef}
          context={context}
          sessionId={sessionId}
          active={active}
          dragging={workspaceDragging || resize !== null}
          suppressAutoFocus={suppressTerminalFocus}
          onState={terminalProps.onState}
        />
      </div>
      {renderComposer ? (
        <div
          className="qtd-gutter"
          data-dock-height={shownHeight}
          style={{ flex: `0 0 ${shownHeight}px`, height: shownHeight, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'visible' }}
        >
          <div
            className="qtd-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize agent composer"
            data-resize-handle
            onMouseDown={beginResize}
            style={{ flex: `0 0 ${RESIZE_HANDLE_HEIGHT_PX}px`, height: RESIZE_HANDLE_HEIGHT_PX }}
          />
          <div
            ref={composerHost}
            className="qtd-composer-host"

            style={{ '--qtd-overlay-max-height': `${overlayMaxHeight}px`, flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'visible', position: 'relative' } as CSSProperties}
          />
        </div>
      ) : null}
      {hostError ? <div className="qtd-error" role="alert">Agent composer unavailable: {hostError}</div> : null}
      {mountError && requested && geometryMounted ? <div className="qtd-error" role="alert">Agent composer unavailable: {mountError}</div> : null}
    </div>
  )
}
