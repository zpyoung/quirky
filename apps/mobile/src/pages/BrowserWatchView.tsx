import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent, type SyntheticEvent, type WheelEvent } from 'react'
import type { MobileWorkspaceTab } from '@quirky/protocol'
import type { MobilePageBridge } from '../contracts'
import { errorMessage, PageError } from './components'

type BrowserTab = MobileWorkspaceTab & { browserMode?: 'native' | 'watch' }
type BrowserWatch = { tab: BrowserTab; watchId: string }
type BrowserFrame = {
  tabId: string
  worktreeId: string
  watchId: string
  sequence: number
  width: number
  height: number
  mimeType: 'image/jpeg'
  data: string
}
type Viewport = 'default' | 'mobile-s' | 'mobile-m' | 'mobile-l' | 'tablet' | 'laptop' | 'laptop-l' | 'desktop'

type Props = {
  bridge: MobilePageBridge
  worktreeId: string
  tab: BrowserTab
  canMutate: boolean
  onTabsChanged(): void
  onClosed(): void
}

const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  default: { width: 1280, height: 720 },
  'mobile-s': { width: 320, height: 568 },
  'mobile-m': { width: 375, height: 667 },
  'mobile-l': { width: 425, height: 812 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1024, height: 768 },
  'laptop-l': { width: 1440, height: 900 },
  desktop: { width: 1920, height: 1080 }
}

export function BrowserWatchView({ bridge, worktreeId, tab, canMutate, onTabsChanged, onClosed }: Props) {
  const [watch, setWatch] = useState<BrowserWatch | null>(null)
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [address, setAddress] = useState('')
  const [textInput, setTextInput] = useState('')
  const [viewport, setViewport] = useState<Viewport>('mobile-m')
  const [visible, setVisible] = useState(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const watchRef = useRef<BrowserWatch | null>(null)
  const frameRef = useRef<BrowserFrame | null>(null)
  const visibleRef = useRef(visible)
  const polling = useRef(false)
  const operationTail = useRef<Promise<void>>(Promise.resolve())

  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const current = operationTail.current.then(operation)
    operationTail.current = current.then(() => undefined, () => undefined)
    return current
  }, [])

  const stop = useCallback(async (current: BrowserWatch, showError: boolean) => {
    try {
      const result = await bridge.call<{ closed: boolean }>('quirky.mobile/browserWatchStop', {
        worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId
      })
      if (!result.closed) throw new Error('The desktop did not confirm stopping the exact Watch lease.')
    } catch (cause) {
      if (showError) setError(errorMessage(cause, 'Could not stop this Browser Watch lease.'))
    } finally {
      if (watchRef.current?.watchId === current.watchId) {
        watchRef.current = null
        setWatch(null)
        frameRef.current = null
        setFrame(null)
      }
    }
  }, [bridge])

  useEffect(() => {
    const updateVisibility = () => {
      const next = document.visibilityState !== 'hidden'
      visibleRef.current = next
      setVisible(next)
    }
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  useEffect(() => {
    if (tab.browserMode !== 'watch' || !canMutate || !visible) return
    let active = true
    void enqueue(async () => {
      setError(null)
      try {
        const started = await bridge.call<BrowserWatch>('quirky.mobile/browserWatchStart', { worktree: worktreeId, tabId: tab.tabId })
        if (!active || !visibleRef.current) {
          await stop(started, false)
          return
        }
        watchRef.current = started
        setWatch(started)
      } catch (cause) {
        if (active) setError(errorMessage(cause, 'Could not start this explicit Chrome Watch.'))
      }
    })
    return () => {
      active = false
      const current = watchRef.current
      if (current?.tab.tabId === tab.tabId) void enqueue(() => stop(current, false))
    }
  }, [bridge, canMutate, enqueue, stop, tab.browserMode, tab.tabId, visible, worktreeId])

  useEffect(() => {
    if (!watch || !canMutate || !visible) return
    let active = true
    let timer: number | undefined
    const poll = async () => {
      if (!active || polling.current) return
      polling.current = true
      try {
        const next = await bridge.call<BrowserFrame | null>('quirky.mobile/browserWatchFrame', {
          worktree: watch.tab.worktreeId, tabId: watch.tab.tabId, watchId: watch.watchId
        })
        if (active && next && next.sequence !== frameRef.current?.sequence) {
          frameRef.current = next
          setFrame(next)
        }
      } catch (cause) {
        if (active) setError(errorMessage(cause, 'Could not read a safe Browser Watch frame.'))
      } finally {
        polling.current = false
        if (active) timer = window.setTimeout(() => void poll(), 180)
      }
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [bridge, canMutate, visible, watch])

  const sendControl = async (action: 'back' | 'forward' | 'reload' | 'stop') => {
    const current = watchRef.current
    if (!current || !canMutate || busy) return
    setBusy(true)
    setError(null)
    try {
      await enqueue(() => bridge.call('quirky.mobile/browserWatchControl', {
        worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId, action
      }))
      onTabsChanged()
    } catch (cause) {
      setError(errorMessage(cause, `Could not ${action} this Browser Watch page.`))
    } finally {
      setBusy(false)
    }
  }

  const navigate = async (event: FormEvent) => {
    event.preventDefault()
    const current = watchRef.current
    if (!current || !canMutate || busy || !address.trim()) return
    setBusy(true)
    setError(null)
    try {
      await enqueue(() => bridge.call('quirky.mobile/browserWatchNavigate', {
        worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId, input: address
      }))
      setAddress('')
      onTabsChanged()
    } catch (cause) {
      setError(errorMessage(cause, 'The Browser refused this address or search.'))
    } finally {
      setBusy(false)
    }
  }

  const sendText = async (event: FormEvent) => {
    event.preventDefault()
    const current = watchRef.current
    if (!current || !canMutate || busy || !textInput) return
    setBusy(true)
    setError(null)
    try {
      await enqueue(() => bridge.call('quirky.mobile/browserWatchInput', {
        worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId, kind: 'text', text: textInput
      }))
      setTextInput('')
    } catch (cause) {
      setError(errorMessage(cause, 'Could not send typed text to this Watch page.'))
    } finally {
      setBusy(false)
    }
  }

  const point = (event: { currentTarget: HTMLImageElement; clientX: number; clientY: number }, source: BrowserFrame): { x: number; y: number } | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / source.width, rect.height / source.height)
    if (!Number.isFinite(scale) || scale <= 0) return null
    const shownWidth = source.width * scale
    const shownHeight = source.height * scale
    const offsetX = (rect.width - shownWidth) / 2
    const offsetY = (rect.height - shownHeight) / 2
    const imageX = event.clientX - rect.left - offsetX
    const imageY = event.clientY - rect.top - offsetY
    if (imageX < 0 || imageY < 0 || imageX > shownWidth || imageY > shownHeight) return null
    const size = VIEWPORT_SIZES[viewport]
    return {
      x: Math.max(0, Math.min(size.width - 1, Math.round(imageX / scale * size.width / source.width))),
      y: Math.max(0, Math.min(size.height - 1, Math.round(imageY / scale * size.height / source.height)))
    }
  }

  const sendPointer = async (event: PointerEvent<HTMLImageElement>, type: 'mousePressed' | 'mouseReleased') => {
    const current = watchRef.current
    const displayed = frameRef.current
    if (!current || !displayed || !canMutate || busy) return
    const coordinates = point(event, displayed)
    if (!coordinates) return
    try {
      await enqueue(() => bridge.call('quirky.mobile/browserWatchInput', {
        worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId,
        kind: 'mouse', type, ...coordinates, button: 'left'
      }))
    } catch (cause) {
      setError(errorMessage(cause, 'Could not send pointer input to this Watch page.'))
    }
  }

  const sendWheel = async (event: WheelEvent<HTMLImageElement>) => {
    const current = watchRef.current
    const displayed = frameRef.current
    if (!current || !displayed || !canMutate || busy) return
    const coordinates = point(event, displayed)
    if (!coordinates) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / displayed.width, rect.height / displayed.height)
    const size = VIEWPORT_SIZES[viewport]
    try {
      await enqueue(() => bridge.call('quirky.mobile/browserWatchInput', {
        worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId,
        kind: 'wheel',
        ...coordinates,
        deltaX: event.deltaX * size.width / (displayed.width * scale),
        deltaY: event.deltaY * size.height / (displayed.height * scale)
      }))
    } catch (cause) {
      setError(errorMessage(cause, 'Could not send scroll input to this Watch page.'))
    }
  }

  const acknowledgeFrame = (event: SyntheticEvent<HTMLImageElement>, loaded: BrowserFrame) => {
    if (event.currentTarget.naturalWidth === 0) return
    const current = watchRef.current
    if (!current || current.watchId !== loaded.watchId) return
    void enqueue(async () => {
      try {
        await bridge.call('quirky.mobile/browserWatchFrameAck', {
          worktree: current.tab.worktreeId, tabId: current.tab.tabId, watchId: current.watchId, sequence: loaded.sequence
        })
      } catch (cause) {
        setError(errorMessage(cause, 'The Browser rejected this stale Watch frame acknowledgement.'))
      }
    })
  }

  const closeTab = async () => {
    if (!canMutate || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await enqueue(() => bridge.call<{ tabId: string; closed: boolean }>('quirky.mobile/sessionTabAction', {
        worktree: worktreeId, tabId: tab.tabId, action: 'close'
      }))
      if (!result.closed) throw new Error('The Browser did not close this tab.')
      watchRef.current = null
      setWatch(null)
      frameRef.current = null
      setFrame(null)
      onClosed()
    } catch (cause) {
      setError(errorMessage(cause, 'Could not close this Browser tab.'))
    } finally {
      setBusy(false)
    }
  }

  if (tab.browserMode !== 'watch') {
    return (
      <div className="qp-session-empty qp-empty" role="note">
        <strong>Native browser cannot stream to phone</strong>
        This is the actual Native human browser tab. Switch it to Watch explicitly on the desktop to view its managed Chrome Watch page here; the phone will never mirror or convert it silently.
      </div>
    )
  }

  return (
    <section className="qp-browser-watch" aria-label={`Browser Chrome Watch ${tab.title}`}>
      <div className="qp-dock-row" style={{ flexWrap: 'wrap' }}>
        <button className="qp-button" type="button" disabled={!watch || busy} onClick={() => void sendControl('back')}>Back</button>
        <button className="qp-button" type="button" disabled={!watch || busy} onClick={() => void sendControl('forward')}>Forward</button>
        <button className="qp-button" type="button" disabled={!watch || busy} onClick={() => void sendControl('reload')}>Reload</button>
        <button className="qp-button" type="button" disabled={!watch || busy} onClick={() => void sendControl('stop')}>Stop</button>
        <button className="qp-button qp-button--danger" type="button" disabled={!canMutate || busy} onClick={() => void closeTab()}>Close tab</button>
      </div>
      <form className="qp-dock-row" onSubmit={navigate}>
        <input aria-label="Browser address" className="qp-dock-input" autoComplete="url" placeholder="Address or search" value={address} disabled={!watch || !canMutate} onChange={(event) => setAddress(event.currentTarget.value)} />
        <button className="qp-button qp-button--primary" type="submit" disabled={!watch || !canMutate || busy || !address.trim()}>Go</button>
      </form>
      {error && <PageError>{error}</PageError>}
      {!frame ? <div className="qp-session-empty qp-empty" role="status">{watch ? 'Waiting for a bounded Chrome Watch frame…' : 'Starting the explicit Chrome Watch lease…'}</div> : (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 120, maxHeight: '48dvh', overflow: 'hidden', background: '#0a0d11' }}>
          <img ref={image} alt={`Chrome Watch frame for ${tab.title}`} src={`data:${frame.mimeType};base64,${frame.data}`}
            onLoad={(event) => acknowledgeFrame(event, frame)} onPointerDown={(event) => void sendPointer(event, 'mousePressed')}
            onPointerUp={(event) => void sendPointer(event, 'mouseReleased')} onWheel={(event) => void sendWheel(event)}
            style={{ display: 'block', maxWidth: '100%', maxHeight: '48dvh', objectFit: 'contain', touchAction: 'none' }} />
        </div>
      )}
      <form className="qp-dock-row" onSubmit={sendText}>
        <input aria-label="Browser text input" className="qp-dock-input" placeholder="Type into focused page" value={textInput} disabled={!watch || !canMutate} onChange={(event) => setTextInput(event.currentTarget.value)} />
        <button className="qp-button" type="submit" disabled={!watch || !canMutate || busy || !textInput}>Send text</button>
      </form>
      <p className="qp-dialog-copy">Explicit agent Chrome Watch, not a Native browser mirror. Frames are bounded JPEG images; no iframe or remote page resources are loaded by the phone.</p>
    </section>
  )
}
