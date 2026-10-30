import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, forwardRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { MobileTerminalState, PtySnapshot, PtySubscription, Session } from '@quirky/protocol'
import type { MobilePageBridge } from '../contracts'
import { dispatchTerminalLink } from './terminal-links'
import { errorMessage } from './components'

export type PhoneTerminalLease = MobileTerminalState & { controlledByCaller: boolean }
export type TerminalViewHandle = {
  focus(): void
  fit(): { cols: number; rows: number }
  resize(cols: number, rows: number): void
  applySnapshot(snapshot: PtySnapshot): void
}

type AttachResult = PtySubscription & { streamId: number; restored: boolean }
type LeaseResult = { terminals: PhoneTerminalLease[] }

type Props = {
  bridge: MobilePageBridge
  session: Session
  connected: boolean
  canDrive: boolean
  displayMode: 'phone' | 'desktop'
  lease: PhoneTerminalLease | null
  textScale: number
  onLease(lease: PhoneTerminalLease | null): void
  onRestored(): void
  onDesktopLink(url: string): Promise<void>
}

function boundedDimensions(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Number.isFinite(cols) ? Math.max(1, Math.min(1000, Math.floor(cols))) : 80,
    rows: Number.isFinite(rows) ? Math.max(1, Math.min(500, Math.floor(rows))) : 24
  }
}

function decodeReplay(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const TerminalView = forwardRef<TerminalViewHandle, Props>(function TerminalView({
  bridge, session, connected, canDrive, displayMode, lease, textScale, onLease, onRestored, onDesktopLink
}, forwardedRef) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const inputQueue = useRef<Promise<void>>(Promise.resolve())
  const streamId = useRef<number | null>(null)
  const connectedRef = useRef(false)
  const canDriveRef = useRef(false)
  const modeRef = useRef(displayMode)
  const desktopLinkRef = useRef(onDesktopLink)
  desktopLinkRef.current = onDesktopLink
  const mountedRef = useRef(false)
  const textScaleRef = useRef(textScale)
  const pageActive = connected && bridge.state.phase === 'connected' &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  connectedRef.current = pageActive
  canDriveRef.current = pageActive && canDrive
  modeRef.current = displayMode
  textScaleRef.current = textScale
  const [snapshotLabel, setSnapshotLabel] = useState('Opening terminal…')
  const [streamError, setStreamError] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  const fit = useCallback(() => {
    const current = terminal.current
    const fit = fitAddon.current
    if (current && fit) {
      if (current.element) {
        current.element.style.transform = ''
        current.element.style.width = ''
        current.element.style.height = ''
      }
      try { fit.fit() } catch { /* the terminal is temporarily hidden or has no measured cells */ }
      return boundedDimensions(current.cols, current.rows)
    }
    return { cols: 80, rows: 24 }
  }, [])

  const scaleViewer = useCallback(() => {
    const current = terminal.current
    const element = current?.element
    if (!current || !element) return
    const proposed = fitAddon.current?.proposeDimensions()
    const scale = canDriveRef.current && modeRef.current === 'phone'
      ? 1
      : Math.min(1, (proposed && proposed.cols > 0 ? proposed.cols : current.cols) / current.cols)
    element.style.transformOrigin = 'top left'
    element.style.transform = scale < 1 ? `scale(${scale})` : ''
    element.style.width = scale < 1 ? `${100 / scale}%` : ''
    element.style.height = scale < 1 ? `${100 / scale}%` : ''
  }, [])

  useImperativeHandle(forwardedRef, () => ({
    focus() { terminal.current?.focus() },
    fit,
    resize(cols, rows) {
      const dimensions = boundedDimensions(cols, rows)
      terminal.current?.resize(dimensions.cols, dimensions.rows)
    },
    applySnapshot(snapshot) {
      const current = terminal.current
      if (!current) return
      const dimensions = boundedDimensions(snapshot.cols, snapshot.rows)
      current.reset()
      current.resize(dimensions.cols, dimensions.rows)
      current.write(snapshot.ansi)
    }
  }), [fit])

  useEffect(() => {
    const container = host.current
    if (!container) return
    const openLink = (uri: string) => {
      void dispatchTerminalLink(uri, bridge.init.preferences.terminalLinkMode, {
        openExternal: (url) => bridge.native.openExternal(url),
        openChromeWatch: (url) => desktopLinkRef.current(url)
      }).catch((cause) => {
        if (mountedRef.current) setStreamError(errorMessage(cause, 'Could not open the terminal link.'))
        else console.error('Could not open a terminal link after leaving the terminal.', cause)
      })
    }
    const current = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      disableStdin: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: Math.max(8, Math.min(28, 14 * textScaleRef.current)),
      lineHeight: 1.05,
      scrollback: 3000,
      linkHandler: { activate: (_event, uri) => openLink(uri) },
      theme: { background: '#101318', foreground: '#e7ebf0', cursor: '#d9e7f8', selectionBackground: '#496486' }
    })
    const fit = new FitAddon()
    current.loadAddon(fit)
    current.loadAddon(new Unicode11Addon())
    current.unicode.activeVersion = '11'
    current.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)))
    current.open(container)
    if (current.textarea) {
      const enabled = bridge.init.preferences.autocomplete
      current.textarea.autocomplete = enabled ? 'on' : 'off'
      current.textarea.setAttribute('autocorrect', enabled ? 'on' : 'off')
      current.textarea.setAttribute('autocapitalize', 'none')
      current.textarea.spellcheck = enabled
    }
    terminal.current = current
    fitAddon.current = fit
    mountedRef.current = true
    current.options.disableStdin = !connectedRef.current || !canDriveRef.current || modeRef.current !== 'phone'
    try { fit.fit() } catch { /* size will be recalculated when the terminal becomes visible */ }
    const input = current.onData((data) => {
      if (!mountedRef.current || !connectedRef.current || !canDriveRef.current || modeRef.current !== 'phone') return
      inputQueue.current = inputQueue.current
        .then(() => {
          if (!mountedRef.current || !connectedRef.current || !canDriveRef.current || modeRef.current !== 'phone') return
          return bridge.call('quirky.terminal/write', { session: session.id, data })
        })
        .then(() => {})
        .catch((cause) => {
          if (mountedRef.current && connectedRef.current && canDriveRef.current) setStreamError(errorMessage(cause, 'Terminal input was refused.'))
        })
    })
    return () => {
      mountedRef.current = false
      input.dispose()
      current.dispose()
      terminal.current = null
      fitAddon.current = null
    }
  }, [bridge, session.id])

  const refreshLease = useCallback(async () => {
    if (!mountedRef.current || !connectedRef.current) return
    try {
      const result = await bridge.call<LeaseResult>('quirky.terminal/mobileState', { session: session.id })
      if (!mountedRef.current || !connectedRef.current) return
      onLease(result.terminals.find((item) => item.session === session.id) ?? null)
    } catch (cause) {
      if (mountedRef.current && connectedRef.current) setStreamError(errorMessage(cause, 'Could not read terminal control state.'))
    }
  }, [bridge, onLease, session.id])

  useEffect(() => {
    const container = host.current
    if (!container) return
    const resize = () => {
      if (!mountedRef.current) return
      if (modeRef.current !== 'phone' || !canDriveRef.current) {
        scaleViewer()
        return
      }
      const current = terminal.current
      if (!current) return
      const previous = { cols: current.cols, rows: current.rows }
      const dimensions = fit()
      if (previous.cols === dimensions.cols && previous.rows === dimensions.rows) return
      if (!connectedRef.current || !canDriveRef.current) return
      inputQueue.current = inputQueue.current
        .then(() => {
          if (!mountedRef.current || !connectedRef.current || !canDriveRef.current || modeRef.current !== 'phone') return
          return bridge.call('quirky.terminal/resize', { session: session.id, ...dimensions })
        })
        .then(() => {})
        .catch((cause) => {
          if (mountedRef.current && connectedRef.current && canDriveRef.current) setStreamError(errorMessage(cause, 'Could not resize the terminal.'))
        })
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(container)
    window.addEventListener('resize', resize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [bridge, fit, scaleViewer, session.id, connected, canDrive, displayMode])

  useLayoutEffect(() => {
    const current = terminal.current
    if (!current) return
    current.options.fontSize = Math.max(8, Math.min(28, 14 * textScale))
    current.options.disableStdin = !pageActive || !canDrive || displayMode !== 'phone'
    if (displayMode === 'phone' && canDrive) {
      fit()
    } else if (lease) {
      const dimensions = boundedDimensions(lease.cols, lease.rows)
      current.resize(dimensions.cols, dimensions.rows)
    }
    scaleViewer()
  }, [pageActive, canDrive, displayMode, textScale, lease?.cols, lease?.rows, fit, scaleViewer])

  useEffect(() => {
    if (!mountedRef.current || !connectedRef.current) {
      setSnapshotLabel('Disconnected · last terminal output may be stale')
      setLive(false)
      return
    }
    let cancelled = false
    let removeStream = () => {}
    let attachedStreamId: number | null = null
    const open = async () => {
      setStreamError(null)
      setSnapshotLabel('Reading terminal snapshot…')
      try {
        if (!(session.status === 'exited' && session.restorable)) {
          const snapshot = await bridge.call<PtySnapshot>('quirky.terminal/snapshot', { session: session.id })
          if (cancelled || !mountedRef.current || !connectedRef.current) return
          setSnapshotLabel(snapshot.title || snapshot.cwd || 'Terminal')
          terminal.current?.write(snapshot.ansi)
        }
        if (!mountedRef.current || !connectedRef.current) return
        setSnapshotLabel('Attaching live terminal…')
        const dimensions = fit()
        const attached = await bridge.call<AttachResult>('quirky.terminal/attach', {
          session: session.id,
          cols: dimensions.cols,
          rows: dimensions.rows,
          historyLines: 50
        })
        if (cancelled || !mountedRef.current || !connectedRef.current) {
          void bridge.call('quirky.terminal/detach', { streamId: attached.streamId }).catch(() => {})
          return
        }
        attachedStreamId = attached.streamId
        streamId.current = attached.streamId
        removeStream = bridge.onStream(attached.streamId, (bytes) => {
          if (mountedRef.current && connectedRef.current) terminal.current?.write(bytes)
        })
        const actual = boundedDimensions(attached.cols, attached.rows)
        terminal.current?.resize(actual.cols, actual.rows)
        scaleViewer()
        terminal.current?.reset()
        if (attached.replay) terminal.current?.write(decodeReplay(attached.replay))
        setLive(attached.live)
        setSnapshotLabel(attached.restored ? 'Restored terminal' : `Terminal · ${attached.shellState}`)
        if (attached.restored) onRestored()
        await refreshLease()
      } catch (cause) {
        if (!cancelled && mountedRef.current && connectedRef.current) {
          setLive(false)
          setStreamError(errorMessage(cause, 'Could not open this terminal.'))
        }
      }
    }
    void open()
    return () => {
      cancelled = true
      removeStream()
      if (streamId.current === attachedStreamId) streamId.current = null
      if (attachedStreamId !== null) void bridge.call('quirky.terminal/detach', { streamId: attachedStreamId }).catch(() => {})
    }
  }, [bridge, session.id, session.status, session.restorable, connected, fit, scaleViewer, refreshLease, onRestored])

  return (
    <>
      {streamError && <div className="qp-terminal-stale" role="alert">{streamError}</div>}
      <div className="qp-terminal-wrap" aria-label={`Terminal ${session.title}`}>
        <div className="qp-terminal-status">
          <span className={`qp-status-dot${live && connected ? '' : ' qp-status-dot--stale'}`} aria-hidden="true" />
          <span>{snapshotLabel}</span>
          <span className="qp-terminal-status__fill" />
          <span>{live ? 'Live' : connected ? 'Read-only' : 'Stale'}</span>
        </div>
        <div className="qp-terminal-screen" ref={host} onClick={() => terminal.current?.focus()} />
      </div>
    </>
  )
})
