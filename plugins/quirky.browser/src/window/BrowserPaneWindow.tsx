import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { NativeBrowserHandle, NativeBrowserPageRequest, NativeBrowserRequest, NativeBrowserState, UiPluginContext } from '@quirky/protocol'
import type { PaneCommand, PaneDownload, PaneFrame, PaneNativeAction, PaneNativeDecision, PanePrompt, PaneState, PaneTab, PaneViewport } from '../pane-contract'
import { acceptLatestFrame, isTextInputKey, nativePreviewNavigationUrl, nativePreviewReportUrl, paneAddress, paneForView, paneHistoryControls, pointerToFramePoint } from './model'
import { DesignWindow, type DesignAction } from '../design-window/DesignWindow'
import { BrowserImportHint, BrowserProfileMenu } from '../preferences-window/BrowserProfileMenu'
import { nativePaneUserAgent } from '../preferences/native-identity'
import { Badge, Button, EmptyState, FormRow, IconButton, ListRow, SectionHeader, StatusDot, TextField } from '@quirky/ui'

const WORKTREE_VIEW = 'view:quirky.session/worktree'
const SEARCH_ENGINES = ['google', 'duckduckgo', 'bing', 'kagi'] as const
const VIEWPORTS: { id: PaneViewport; label: string; width?: number; height?: number; mobile: boolean }[] = [
  { id: 'default', label: 'Default', mobile: false },
  { id: 'mobile-s', label: 'Mobile S · 320 × 568', width: 320, height: 568, mobile: true },
  { id: 'mobile-m', label: 'Mobile M · 375 × 667', width: 375, height: 667, mobile: true },
  { id: 'mobile-l', label: 'Mobile L · 425 × 812', width: 425, height: 812, mobile: true },
  { id: 'tablet', label: 'Tablet · 768 × 1024', width: 768, height: 1024, mobile: true },
  { id: 'laptop', label: 'Laptop · 1024 × 768', width: 1024, height: 768, mobile: false },
  { id: 'laptop-l', label: 'Laptop L · 1440 × 900', width: 1440, height: 900, mobile: false },
  { id: 'desktop', label: 'Desktop · 1920 × 1080', width: 1920, height: 1080, mobile: false }
]

type BrowserSettings = { homePage: string; searchEngine: (typeof SEARCH_ENGINES)[number]; zoom: number }
type AgentPage = { browserPageId: string; url: string; title: string; active: boolean }
type NativeHandle = NativeBrowserHandle
type InputArgs = Record<string, unknown>

const paneStyles = {
  root: {
    boxSizing: 'border-box',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
    color: 'var(--ui-text)',
    background: 'var(--ui-surface)',
    fontSize: 'var(--ui-font-body)'
  },
  toolbar: {
    display: 'flex',
    flex: '0 0 auto',
    position: 'relative',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 'var(--ui-space-4)',
    padding: 'var(--ui-space-8) var(--ui-space-12)',
    borderBottom: 'var(--ui-border-width) solid var(--ui-border)',
    background: 'var(--ui-rail)',
    minWidth: 0
  },
  toolbarControl: { flex: '0 0 auto' },
  addressWrap: {
    position: 'relative',
    display: 'flex',
    flex: '1 1 40%',
    minWidth: 0
  },
  addressFieldWrap: { flex: '1 1 auto', minWidth: 0 },
  addressField: { width: '100%', minWidth: 0 },
  suggestions: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 20,
    display: 'grid',
    gap: 'var(--ui-space-4)',
    width: '100%',
    maxHeight: '60vh',
    overflow: 'auto',
    margin: 0
  },
  suggestionTitle: { display: 'block', fontWeight: 600, overflowWrap: 'anywhere' },
  suggestionDetail: {
    display: 'block',
    color: 'var(--ui-muted)',
    fontSize: 'var(--ui-font-label)',
    overflowWrap: 'anywhere'
  },
  details: { position: 'relative', display: 'flex', flexDirection: 'column', flex: '0 0 auto', minWidth: 0 },
  profileDetails: { position: 'static', display: 'flex', flexDirection: 'column', flex: '0 0 auto', minWidth: 0 },
  menuSummary: {
    display: 'inline-flex',
    width: 'auto',
    minWidth: 'var(--ui-row-single)',
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    listStyle: 'none',
    textAlign: 'left',
    whiteSpace: 'normal',
    cursor: 'pointer'
  },
  menuPopover: {
    position: 'static',
    width: '100%',
    maxWidth: '100%',
    maxHeight: '60vh',
    overflow: 'auto',
    margin: 'var(--ui-space-4) 0 0'
  },
  profilePopover: {
    position: 'absolute',
    top: '100%',
    left: 'var(--ui-space-12)',
    right: 'auto',
    zIndex: 20,
    width: 'min(calc(var(--ui-row-double) * 12), calc(100% - var(--ui-space-24)))',
    maxHeight: '60vh',
    overflow: 'auto',
    margin: 'var(--ui-space-4) 0 0'
  },
  historyPopover: {
    position: 'absolute',
    top: '100%',
    left: 'auto',
    right: 0,
    zIndex: 20,
    width: 'min(calc(var(--ui-row-double) * 12), calc(100vw - var(--ui-space-24)))',
    maxHeight: '60vh',
    overflow: 'auto',
    margin: 'var(--ui-space-4) 0 0'
  },
  menuItems: { display: 'grid', gap: 'var(--ui-space-4)' },
  find: {
    display: 'flex',
    flex: '0 0 auto',
    alignItems: 'end',
    flexWrap: 'wrap',
    gap: 'var(--ui-space-8)',
    width: '100%',
    minWidth: 0,
    padding: 'var(--ui-space-8) var(--ui-space-12)',
    borderBottom: 'var(--ui-border-width) solid var(--ui-border)',
    background: 'var(--ui-rail)'
  },
  findField: { flex: '1 1 auto', minWidth: 0 },
  findInput: { width: '100%', minWidth: 0 },
  findCount: { color: 'var(--ui-muted)', textAlign: 'center' },
  message: {
    display: 'flex',
    flex: '0 0 auto',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 'var(--ui-space-8)',
    minWidth: 0,
    padding: 'var(--ui-space-8) var(--ui-space-12)',
    borderBottom: 'var(--ui-border-width) solid var(--ui-border)'
  },
  messageText: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' },
  errorText: { color: 'var(--ui-failing)', margin: 0, overflowWrap: 'anywhere' },
  mutedText: { color: 'var(--ui-muted)', margin: 0, overflowWrap: 'anywhere' },
  helpText: { color: 'var(--ui-muted)', margin: 0, overflowWrap: 'anywhere' },
  page: {
    position: 'relative',
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--ui-rail)'
  },
  nativeHost: { flex: '0 1 auto', width: '100%', height: '100%', minWidth: 0, minHeight: 0 },
  watchImage: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    userSelect: 'none'
  },
  overlay: {
    position: 'absolute',
    zIndex: 5,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--ui-space-16)',
    overflow: 'auto',
    background: 'var(--ui-scrim)'
  },
  card: {
    width: '100%',
    maxWidth: 'min(100%, calc(var(--ui-row-double) * 18))',
    maxHeight: '100%',
    overflow: 'auto',
    padding: 'var(--ui-space-16)'
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-8)' },
  prompt: { display: 'grid', gap: 'var(--ui-space-8)' },
  shelf: {
    display: 'flex',
    flex: '0 0 auto',
    flexDirection: 'column',
    gap: 'var(--ui-space-8)',
    maxHeight: '24vh',
    padding: 'var(--ui-space-8) var(--ui-space-12)',
    overflow: 'auto',
    borderTop: 'var(--ui-border-width) solid var(--ui-border)',
    background: 'var(--ui-rail)'
  },
  download: { minWidth: 0 },
  downloadDescription: { display: 'grid', gap: 'var(--ui-space-4)', width: '100%', minWidth: 0 },
  downloadActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-4)', minWidth: 0, maxWidth: '100%' },
  downloadProgress: { width: 'min(100%, 25vw)', minWidth: 0, accentColor: 'var(--ui-accent)' },
  mode: { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)', flex: '0 0 auto' }
} satisfies Record<string, CSSProperties>

let focusedPaneId: string | null = null
let focusAddress: (() => void) | null = null
let focusFind: (() => void) | null = null

export function focusedBrowserPane(): string | null {
  return focusedPaneId
}

export function focusBrowserAddress(): void {
  focusAddress?.()
}

export function focusBrowserFind(): void {
  focusFind?.()
}
const focusedDesignActions = new Map<string, { mode: () => PaneTab['mode'] | undefined; run: (action: DesignAction) => Promise<boolean> }>()

async function focusBrowserPane(id: string): Promise<boolean> {
  if (focusedPaneId === id) return true
  const root = [...document.querySelectorAll<HTMLElement>('[data-browser-pane]')].find((entry) => entry.dataset.browserPane === id)
  if (!root) return false
  root.focus()
  for (let attempt = 0; focusedPaneId !== id && attempt < 20; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  return focusedPaneId === id
}

/**
 * Starts a design action in the focused Native pane, or in `targetPane` after focusing it through the
 * pane's own focus handler. Returns a reason instead of acting when the target is not a mounted Native pane.
 */
export async function runFocusedBrowserDesign(action: DesignAction, targetPane?: string): Promise<{ started: boolean; reason?: string }> {
  if (targetPane !== undefined) {
    const target = focusedDesignActions.get(targetPane)
    if (!target) return { started: false, reason: `Browser pane ${targetPane} is not open.` }
    if (target.mode() !== 'native') return { started: false, reason: `Browser pane ${targetPane} is a Watch pane; design operations need a Native pane.` }
    if (!await focusBrowserPane(targetPane)) return { started: false, reason: `Browser pane ${targetPane} did not take focus.` }
    if (focusedPaneId !== targetPane) return { started: false, reason: `Focus moved away from browser pane ${targetPane} before the design operation started.` }
  }
  const pane = focusedPaneId
  if (!pane) return { started: false, reason: 'No browser pane is focused.' }
  const run = focusedDesignActions.get(pane)?.run
  if (!run) return { started: false, reason: 'The focused browser pane has no active design controls.' }
  const started = await run(action)
  return started ? { started: true } : { started: false, reason: 'The requested design operation could not start on the focused Native page.' }
}

function settingFrom(context: UiPluginContext, name: string): unknown {
  try {
    return context.getSetting(name)
  } catch {
    return undefined
  }
}

function readSettings(context: UiPluginContext): BrowserSettings {
  const homePage = settingFrom(context, 'defaultHomePage')
  const searchEngine = settingFrom(context, 'defaultSearchEngine')
  const zoom = settingFrom(context, 'defaultZoom')
  return {
    homePage: typeof homePage === 'string' ? homePage : '',
    searchEngine: SEARCH_ENGINES.includes(searchEngine as BrowserSettings['searchEngine']) ? searchEngine as BrowserSettings['searchEngine'] : 'google',
    zoom: typeof zoom === 'number' && Number.isFinite(zoom) ? Math.round(Math.min(5, Math.max(-3, zoom)) * 2) / 2 : 0
  }
}

function paneIdFrom(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const pane = Reflect.get(input, 'pane')
  return typeof pane === 'string' && pane !== '' ? pane : null
}

function worktreeSelector(worktreeId: string): string {
  return worktreeId.startsWith('id:') ? worktreeId : `id:${worktreeId}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPaneState(value: unknown): value is PaneState {
  return typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'tabs'))
}

function nativeRequest(command: PaneCommand, pane: PaneTab, hardReloadAvailable: boolean): NativeBrowserRequest | null {
  switch (command.action) {
    case 'navigate': {
      const url = nativePreviewNavigationUrl(command.url, pane.preview?.url, window.location.href)
      return url ? { action: 'navigate', url } : null
    }
    case 'back':
    case 'forward':
    case 'reload':
    case 'stop': return { action: command.action }
    case 'hardReload': return hardReloadAvailable ? { action: 'hardReload' } : null
    case 'find': return { action: 'find', text: command.text ?? '', ...(command.forward === undefined ? {} : { forward: command.forward }) }
    case 'zoom': return { action: 'zoom', level: command.level ?? 0 }
  }
}

function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

function imageSource(frame: PaneFrame): string {
  return frame.data.startsWith('data:') ? frame.data : `data:image/jpeg;base64,${frame.data}`
}


export function BrowserPaneWindow({ context, input }: { context: UiPluginContext; input?: unknown }) {
  const requestedPaneId = paneIdFrom(input)
  const promptFieldsId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<PaneTab | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const editingFindRef = useRef(false)
  const findTextRef = useRef('')
  const findPaneIdRef = useRef<string | null>(null)
  const nativeHostRef = useRef<HTMLDivElement>(null)
  const frameHostRef = useRef<HTMLDivElement>(null)
  const watchImageRef = useRef<HTMLImageElement | null>(null)
  const watchIdRef = useRef<string | null>(null)
  const lastPointerMoveRef = useRef(0)
  const lastPointerPointRef = useRef<{ x: number; y: number } | null>(null)
  const pendingFrameRef = useRef<PaneFrame | null>(null)
  const deferredFrameRef = useRef<PaneFrame | null>(null)
  const loadedFrameRef = useRef<{ watchId: string; sequence: number } | null>(null)
  const lastAckRef = useRef<{ watchId: string; sequence: number } | null>(null)
  const pendingWatchLeaseRef = useRef<string | null>(null)
  const explicitWatchPendingRef = useRef(false)
  const mountedRef = useRef(true)
  const frameRef = useRef<PaneFrame | null>(null)
  const nativeHandleRef = useRef<NativeHandle | null>(null)
  const lastNativeCommandRef = useRef<string | null>(null)
  const designActionRef = useRef<((action: DesignAction) => Promise<boolean>) | null>(null)

  const [state, setState] = useState<PaneState | null>(null)
  const [pane, setPane] = useState<PaneTab | null>(null)
  const [address, setAddress] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  const [suggestions, setSuggestions] = useState<{ url: string; title: string; kind: 'history' | 'search' | 'document' }[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [frame, setFrame] = useState<PaneFrame | null>(null)
  const [watchRevision, setWatchRevision] = useState(0)
  const [watchStarting, setWatchStarting] = useState(false)
  const [watchError, setWatchError] = useState<string | null>(null)
  const [nativeError, setNativeError] = useState<string | null>(null)
  const [nativeRetry, setNativeRetry] = useState(0)
  const [nativeMountRevision, setNativeMountRevision] = useState(0)
  const [nativeReady, setNativeReady] = useState(0)
  const [nativeState, setNativeState] = useState<NativeBrowserState | null>(null)
  const [nativeUserAgent, setNativeUserAgent] = useState<{ value: string | undefined } | null>(null)
  const [pageList, setPageList] = useState<AgentPage[] | null>(null)
  const [pageListError, setPageListError] = useState<string | null>(null)
  const [pageListLoading, setPageListLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'error' } | null>(null)
  const [settings, setSettings] = useState(() => readSettings(context))
  const [promptValues, setPromptValues] = useState<Record<string, { text: string; username: string; password: string }>>({})
  // Native sign-in credentials stay in this window: the daemon only learns that the user accepted.
  const nativeCredentialsRef = useRef(new Map<string, { username: string; password: string }>())
  const [designPageHost, setDesignPageHost] = useState<HTMLDivElement | null>(null)
  const [browserFocused, setBrowserFocused] = useState(false)

  paneRef.current = pane
  frameRef.current = frame
  const attachFrameHost = useCallback((host: HTMLDivElement | null) => {
    frameHostRef.current = host
    if (host) setDesignPageHost(host)
  }, [])
  const reportDesignMessage = useCallback((text: string, kind: 'info' | 'error') => {
    const copied = text === 'Copied' || text === 'Screenshotted' || text === 'Annotations copied.' || text === 'Notes sent.' || text === 'Markup copied — paste it into your agent.'
    context.toast(copied ? text : 'Browser design mode', copied ? '' : text, { kind: copied ? 'success' : kind })
    setMessage({ text, kind })
  }, [context])

  const updateState = useCallback((next: PaneState) => {
    setState(next)
    const selected = paneForView(next.tabs, next.active, requestedPaneId)
    setPane(selected)
    if (selected) {
      if (!editingAddress) setAddress(selected.url)
      if (selected.id !== findPaneIdRef.current || !editingFindRef.current) {
        findPaneIdRef.current = selected.id
        findTextRef.current = selected.find.text
        setFindText(selected.find.text)
      }
    }
  }, [editingAddress, requestedPaneId])

  const refresh = useCallback(async () => {
    try {
      const next = await context.call('quirky.browser/paneState', {})
      if (!mountedRef.current) return
      if (isPaneState(next)) updateState(next)
    } catch (error) {
      if (mountedRef.current) setMessage({ text: errorText(error), kind: 'error' })
    }
  }, [context, updateState])

  const invoke = useCallback(async (method: string, params: InputArgs): Promise<unknown> => {
    try {
      return await context.call(`quirky.browser/${method}`, params)
    } catch (error) {
      if (mountedRef.current) setMessage({ text: errorText(error), kind: 'error' })
      return undefined
    }
  }, [context])

  useEffect(() => {
    void refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.browser/paneChanged' && isPaneState(event.data)) updateState(event.data)
      if (event.type === 'quirky.browser/paneFrame' && typeof event.data === 'object' && event.data !== null) {
        const current = paneRef.current
        const candidate = event.data as PaneFrame
        if (!current || candidate.pane !== current.id) return
        const lease = watchIdRef.current
        if (!lease) {
          if (current.mode === 'watch' || explicitWatchPendingRef.current) {
            const pending = pendingFrameRef.current
            if (!pending || pending.watchId !== candidate.watchId || candidate.sequence > pending.sequence) pendingFrameRef.current = candidate
          }
          return
        }
        if (current.mode !== 'watch') return
        const previous = frameRef.current
        const accepted = acceptLatestFrame(previous, candidate, current.id, lease)
        if (accepted === previous) return
        if (previous) {
          const loaded = loadedFrameRef.current
          if (loaded?.watchId === previous.watchId && loaded.sequence === previous.sequence) {
            loadedFrameRef.current = null
            frameRef.current = accepted
            setFrame(accepted)
            return
          }
          const deferred = deferredFrameRef.current
          if (!deferred || deferred.watchId !== candidate.watchId || candidate.sequence > deferred.sequence) deferredFrameRef.current = accepted
          return
        }
        frameRef.current = accepted
        setFrame(accepted)
      }
      if (event.type === 'quirky.browser/paneNative' && typeof event.data === 'object' && event.data !== null) {
        const action = event.data as PaneNativeAction
        const handle = nativeHandleRef.current
        if (!handle || paneRef.current?.id !== action.pane || paneRef.current.mode !== 'native') return
        if (action.action === 'cancelDownload') {
          void handle.cancelDownload?.(action.id).catch(() => false)
          return
        }
        const credentials = action.kind === 'auth' ? nativeCredentialsRef.current.get(action.prompt) : undefined
        nativeCredentialsRef.current.delete(action.prompt)
        void handle.answer?.(action.id, {
          accept: action.accept,
          ...(action.text === undefined ? {} : { text: action.text }),
          ...(credentials && action.accept ? credentials : {})
        }).catch(() => false)
      }
      if (event.type === 'setting.changed' && event.id.startsWith('setting:quirky.browser/')) setSettings(readSettings(context))
    })
    return unsubscribe
  }, [context, refresh, updateState])

  useEffect(() => {
    if (pane) {
      if (!editingAddress) setAddress(paneAddress(pane))
      if (pane.id !== findPaneIdRef.current || !editingFindRef.current) {
        findPaneIdRef.current = pane.id
        findTextRef.current = pane.find.text
        setFindText(pane.find.text)
      }
    }
  }, [pane?.id, pane?.url, pane?.document?.path, pane?.find.text, editingAddress])
  useEffect(() => {
    const activePrompts = new Set(pane?.prompts.map((prompt) => prompt.id) ?? [])
    setPromptValues((current) => {
      const next: typeof current = {}
      let changed = false
      for (const [id, values] of Object.entries(current)) {
        if (activePrompts.has(id)) next[id] = values
        else changed = true
      }
      return changed ? next : current
    })
  }, [pane?.id, pane?.prompts])

  useEffect(() => {
    mountedRef.current = true
    const root = rootRef.current
    const mountFocus = window.setTimeout(() => {
      if (root && !root.contains(document.activeElement)) addressRef.current?.focus()
      focusedPaneId = paneRef.current?.id ?? requestedPaneId
      focusAddress = () => addressRef.current?.focus()
      focusFind = () => {
        setFindOpen(true)
        requestAnimationFrame(() => findRef.current?.focus())
      }
      context.setContext('browserFocus', true)
      setBrowserFocused(true)
    }, 0)
    return () => {
      mountedRef.current = false
      window.clearTimeout(mountFocus)
      const lease = pendingWatchLeaseRef.current
      pendingWatchLeaseRef.current = null
      if (lease) void context.call('quirky.browser/paneWatchStop', { pane: paneRef.current?.id ?? requestedPaneId, watchId: lease }).catch(() => undefined)
      if (focusedPaneId === (paneRef.current?.id ?? requestedPaneId)) {
        focusedPaneId = null
        focusAddress = null
        focusFind = null
        setBrowserFocused(false)
        context.setContext('browserFocus', false)
      }
    }
  }, [context, requestedPaneId])
  useEffect(() => {
    const id = pane?.id ?? requestedPaneId
    if (!id) return
    const run = async (action: DesignAction): Promise<boolean> => {
      if (focusedPaneId !== id || paneRef.current?.mode !== 'native') return false
      const handler = designActionRef.current
      return handler ? await handler(action) : false
    }
    const entry = { mode: () => paneRef.current?.mode, run }
    focusedDesignActions.set(id, entry)
    return () => {
      if (focusedDesignActions.get(id) === entry) focusedDesignActions.delete(id)
    }
  }, [pane?.id, requestedPaneId])

  useEffect(() => {
    if (pane && rootRef.current?.contains(document.activeElement)) {
      focusedPaneId = pane.id
      setBrowserFocused(true)
    }
  }, [pane?.id])


  useEffect(() => {
    lastPointerPointRef.current = null
    if (!pane || pane.mode !== 'watch' || !pane.page) {
      watchIdRef.current = null
      if (!explicitWatchPendingRef.current && !pendingWatchLeaseRef.current) pendingFrameRef.current = null
      deferredFrameRef.current = null
      loadedFrameRef.current = null
      lastAckRef.current = null
      setFrame(null)
      frameRef.current = null
      setWatchError(null)
      return
    }

    let mounted = true
    let ownedLease: string | null = null
    const activateLease = (id: string) => {
      ownedLease = id
      watchIdRef.current = id
      const pending = pendingFrameRef.current
      pendingFrameRef.current = null
      if (pending) {
        const accepted = acceptLatestFrame(null, pending, pane.id, id)
        if (accepted) {
          frameRef.current = accepted
          setFrame(accepted)
        }
      }
    }
    setFrame(null)
    frameRef.current = null
    deferredFrameRef.current = null
    loadedFrameRef.current = null
    lastAckRef.current = null
    setWatchError(null)
    if (explicitWatchPendingRef.current) return () => { mounted = false }

    const queuedLease = pendingWatchLeaseRef.current
    if (queuedLease) {
      pendingWatchLeaseRef.current = null
      explicitWatchPendingRef.current = false
      activateLease(queuedLease)
    } else {
      pendingFrameRef.current = null
      void context.call('quirky.browser/paneWatch', { pane: pane.id }).then((result) => {
        const id = typeof result === 'object' && result !== null ? Reflect.get(result, 'watchId') : null
        if (typeof id !== 'string' || id === '') throw new Error('Watch did not return a lease ID')
        if (!mounted) {
          void context.call('quirky.browser/paneWatchStop', { pane: pane.id, watchId: id }).catch(() => undefined)
          return
        }
        activateLease(id)
      }).catch((error: unknown) => {
        if (mounted) setWatchError(errorText(error))
      })
    }
    return () => {
      mounted = false
      const id = ownedLease
      if (id && watchIdRef.current === id) watchIdRef.current = null
      if (frameRef.current?.watchId === id) {
        frameRef.current = null
        setFrame(null)
      }
      deferredFrameRef.current = null
      loadedFrameRef.current = null
      lastAckRef.current = null
      if (id) void context.call('quirky.browser/paneWatchStop', { pane: pane.id, watchId: id }).catch(() => undefined)
    }
  }, [context, pane?.id, pane?.mode, pane?.page, pane?.profileId, pane?.partition, watchRevision])

  const reportNativeState = useCallback((
    native: NativeBrowserState,
    command?: PaneCommand,
    target?: Pick<PaneTab, 'id' | 'profileId' | 'partition' | 'document'>
  ) => {
    const current = paneRef.current
    if (
      !mountedRef.current || !current || current.mode !== 'native' ||
      (target && (
        current.id !== target.id || current.profileId !== target.profileId || current.partition !== target.partition ||
        current.document?.grant.id !== target.document?.grant.id
      ))
    ) return
    // the daemon rejects an unacknowledged report while a command is pending; that command's own report carries this state
    if (!command && current.command) return
    void context.call('quirky.browser/paneReport', {
      pane: current.id,
      ...(command ? { command: command.id } : {}),
      url: nativePreviewReportUrl(native.url, current.preview?.url, window.location.href),
      title: native.title,
      loading: native.loading,
      error: native.error,
      canGoBack: native.canGoBack,
      canGoForward: native.canGoForward,
      findCurrent: native.findCurrent,
      findTotal: native.findTotal,
      ...(current.tabId ? { tabId: current.tabId } : {})
    }).catch((error: unknown) => {
      if (mountedRef.current) setMessage({ text: errorText(error), kind: 'error' })
    })
  }, [context])

  const relayNativeRequest = useCallback(async (handle: NativeHandle, paneId: string, request: NativeBrowserPageRequest) => {
    try {
      const decision = await context.call('quirky.browser/paneNativeRequest', { pane: paneId, request }) as PaneNativeDecision
      if (decision.answer) {
        await handle.answer?.(request.id, decision.answer)
        if (request.kind === 'popup' && !decision.answer.accept && mountedRef.current) {
          setMessage({ text: `A popup to ${request.url} was blocked: only HTTP(S) popups may open, at most four every two seconds.`, kind: 'info' })
        }
      }
    } catch (error) {
      await handle.answer?.(request.id, { accept: false }).catch(() => false)
      if (mountedRef.current) setMessage({ text: errorText(error), kind: 'error' })
    }
  }, [context])

  const nativeIdentityNeeded = pane?.mode === 'native' && context.nativeBrowser.available
  useEffect(() => {
    if (!nativeIdentityNeeded) return
    let current = true
    nativePaneUserAgent(context).then(
      (value) => { if (current) setNativeUserAgent((previous) => previous && previous.value === value ? previous : { value }) },
      (error: unknown) => { if (current) setNativeError(`Browser identity could not be read: ${errorText(error)}`) }
    )
    return () => { current = false }
  }, [context, nativeIdentityNeeded, nativeRetry])

  useEffect(() => {
    const host = nativeHostRef.current
    if (!pane || pane.mode !== 'native' || !context.nativeBrowser.available || !host || (pane.document && !context.nativeBrowser.previewAvailable)) {
      nativeHandleRef.current = null
      setNativeError(null)
      return
    }
    if (
      pane.url === 'about:blank' && !pane.loading && !pane.command &&
      !pane.canGoBack && !pane.canGoForward && !nativeHandleRef.current
    ) {
      setNativeError(null)
      setNativeState(null)
      setNativeReady(0)
      return
    }
    let mounted = true
    let handle: NativeHandle
    setNativeState(null)
    setNativeReady(0)
    if (!nativeUserAgent) return
    try {
      handle = context.nativeBrowser.mount(host, {
        id: pane.id,
        partition: pane.partition,
        url: pane.command?.action === 'navigate' ? 'about:blank' : pane.url,
        zoom: pane.zoom,
        ...(pane.document ? { preview: pane.document.grant } : {}),
        ...(nativeUserAgent.value === undefined ? {} : { userAgent: nativeUserAgent.value }),
        onState: (next) => {
          if (!mounted) return
          setNativeState(next)
          reportNativeState(next, undefined, pane)
        },
        onPopup: (url, userGesture) => {
          if (!mounted) return
          const gesture = userGesture ? 'after a user action' : 'without a user action'
          setMessage({ text: `A native popup was observed ${gesture}. Quirky cannot safely transfer named or opener-dependent windows; no URL-only popup was opened (${url}).`, kind: 'info' })
        },
        onPageRequest: (request) => {
          if (!mounted) return
          void relayNativeRequest(handle, pane.id, request)
        },
        onPageRequestExpired: (id) => {
          if (!mounted) return
          void context.call('quirky.browser/paneNativeUpdate', { pane: pane.id, expired: id }).catch(() => undefined)
        },
        onDownload: (update) => {
          if (!mounted) return
          void context.call('quirky.browser/paneNativeUpdate', { pane: pane.id, download: update }).catch(() => undefined)
        }
      })
      nativeHandleRef.current = handle
      setNativeError(null)
      setNativeReady((revision) => revision + 1)
    } catch (error) {
      setNativeError(errorText(error))
      nativeHandleRef.current = null
      return
    }
    return () => {
      mounted = false
      if (nativeHandleRef.current === handle) nativeHandleRef.current = null
      handle.dispose()
    }
  }, [context, pane?.id, pane?.mode, pane?.profileId, pane?.partition, pane?.document?.grant.id, context.nativeBrowser.available, reportNativeState, relayNativeRequest, nativeRetry, nativeMountRevision, nativeUserAgent])
  useEffect(() => {
    if (!pane || pane.mode !== 'native' || !context.nativeBrowser.available) return
    const needsGuest = pane.url !== 'about:blank' || pane.loading || pane.command !== null || pane.canGoBack || pane.canGoForward
    if (needsGuest && !nativeHandleRef.current) setNativeMountRevision((revision) => revision + 1)
  }, [pane?.id, pane?.mode, pane?.url, pane?.loading, pane?.command?.id, pane?.canGoBack, pane?.canGoForward, pane?.profileId, pane?.partition, pane?.document?.grant.id, context.nativeBrowser.available])

  useEffect(() => {
    const command = pane?.command
    const handle = nativeHandleRef.current
    if (!pane || pane.mode !== 'native' || !command || !handle || command.id === lastNativeCommandRef.current) return
    const request = nativeRequest(command, pane, nativeState?.hardReloadAvailable === true)
    if (!request) {
      lastNativeCommandRef.current = command.id
      const reason = command.action === 'hardReload'
        ? 'Hard Reload is unavailable in Native mode: this system webview cannot reload without its cache. Ordinary Reload is available.'
        : `Native browser cannot execute ${command.action} without a valid request.`
      setMessage({ text: reason, kind: 'info' })
      void context.call('quirky.browser/paneReport', {
        pane: pane.id,
        command: command.id,
        error: reason,
        ...(pane.tabId ? { tabId: pane.tabId } : {})
      }).catch((error: unknown) => {
        if (mountedRef.current) setMessage({ text: errorText(error), kind: 'error' })
      })
      return
    }
    lastNativeCommandRef.current = command.id
    void handle.request(request).then((result) => reportNativeState(result, command, pane), (error: unknown) => {
      const current = paneRef.current
      if (
        !mountedRef.current || !current || current.id !== pane.id ||
        current.profileId !== pane.profileId || current.partition !== pane.partition ||
        current.document?.grant.id !== pane.document?.grant.id
      ) return
      void context.call('quirky.browser/paneReport', {
        pane: current.id,
        command: command.id,
        error: errorText(error),
        ...(current.tabId ? { tabId: current.tabId } : {})
      }).catch((reportError: unknown) => {
        if (mountedRef.current) setMessage({ text: errorText(reportError), kind: 'error' })
      })
    })
  }, [context, pane?.id, pane?.mode, pane?.profileId, pane?.partition, pane?.document?.grant.id, pane?.command?.id, nativeReady, reportNativeState])

  useEffect(() => {
    if (!pane || !suggestionsOpen) return
    let mounted = true
    const timeout = window.setTimeout(() => {
      void context.call('quirky.browser/paneSuggestions', {
        worktree: worktreeSelector(pane.worktreeId),
        query: address
      }).then((result) => {
        if (!mounted) return
        const rows = typeof result === 'object' && result !== null ? Reflect.get(result, 'suggestions') : null
        setSuggestions(Array.isArray(rows) ? rows as typeof suggestions : [])
        setActiveSuggestion(0)
      }).catch((error: unknown) => {
        if (mounted) setMessage({ text: errorText(error), kind: 'error' })
      })
    }, 120)
    return () => {
      mounted = false
      window.clearTimeout(timeout)
    }
  }, [context, pane?.id, pane?.worktreeId, address, suggestionsOpen])

  const navigate = useCallback(async (inputValue: string) => {
    if (!pane) return
    setEditingAddress(false)
    setSuggestionsOpen(false)
    setMessage(null)
    await invoke('paneNavigate', { pane: pane.id, input: inputValue })
  }, [invoke, pane])

  const control = useCallback(async (action: PaneCommand['action'] | 'viewport', values: InputArgs = {}) => {
    if (!pane) return
    await invoke('paneControl', { pane: pane.id, action, ...values })
  }, [invoke, pane])

  const openWatchPage = useCallback(async (pageId: string) => {
    if (!pane) return
    const selector = worktreeSelector(pane.worktreeId)
    const created = await invoke('paneOpen', { worktree: selector, page: pageId, mode: 'watch' }) as PaneTab | undefined
    if (!created) return
    context.openView(WORKTREE_VIEW, { worktree: selector })
  }, [context, invoke, pane])
  const startWatchHere = useCallback(async () => {
    if (!pane || pane.mode !== 'native') return
    explicitWatchPendingRef.current = true
    setWatchStarting(true)
    pendingWatchLeaseRef.current = null
    pendingFrameRef.current = null
    deferredFrameRef.current = null
    loadedFrameRef.current = null
    watchIdRef.current = null
    frameRef.current = null
    setFrame(null)
    setWatchError(null)
    setEditingAddress(false)
    setSuggestionsOpen(false)
    try {
      if (address !== pane.url) await context.call('quirky.browser/paneNavigate', { pane: pane.id, input: address })
      const result = await context.call('quirky.browser/paneWatch', { pane: pane.id })
      const id = typeof result === 'object' && result !== null ? Reflect.get(result, 'watchId') : null
      if (typeof id !== 'string' || id === '') throw new Error('Watch did not return a lease ID')
      if (!mountedRef.current) {
        void context.call('quirky.browser/paneWatchStop', { pane: pane.id, watchId: id }).catch(() => undefined)
        explicitWatchPendingRef.current = false
        setWatchStarting(false)
        return
      }
      pendingWatchLeaseRef.current = id
      explicitWatchPendingRef.current = false
      setWatchStarting(false)
      setWatchRevision((revision) => revision + 1)
      await refresh()
    } catch (error) {
      explicitWatchPendingRef.current = false
      if (!mountedRef.current) return
      setWatchStarting(false)
      setWatchError(errorText(error))
      setWatchRevision((revision) => revision + 1)
    }
  }, [address, context, pane, refresh])

  const loadAgentPages = useCallback(async () => {
    if (!pane) return
    setPageListLoading(true)
    setPageListError(null)
    try {
      const result = await context.call('quirky.browser/tabList', { worktree: worktreeSelector(pane.worktreeId) })
      if (!mountedRef.current) return
      const tabs = typeof result === 'object' && result !== null ? Reflect.get(result, 'tabs') : null
      setPageList(Array.isArray(tabs) ? tabs as AgentPage[] : [])
    } catch (error) {
      if (!mountedRef.current) return
      setPageListError(errorText(error))
      setPageList([])
    } finally {
      if (mountedRef.current) setPageListLoading(false)
    }
  }, [context, pane])

  const applySuggestion = (value: string) => {
    void navigate(value)
  }

  const sendInput = useCallback((args: InputArgs) => {
    if (!pane || pane.mode !== 'watch' || pane.error || watchError) return
    void context.call('quirky.browser/paneInput', { pane: pane.id, ...args }).catch((error: unknown) => {
      if (mountedRef.current) setWatchError(errorText(error))
    })
  }, [context, pane, watchError])
  const sendInputRef = useRef(sendInput)
  sendInputRef.current = sendInput

  const pointForEvent = useCallback((clientX: number, clientY: number) => {
    const host = frameHostRef.current
    const currentFrame = frameRef.current
    if (!host || !currentFrame) return null
    const rect = host.getBoundingClientRect()
    return pointerToFramePoint(clientX, clientY, rect, currentFrame.width, currentFrame.height)
  }, [])

  useEffect(() => {
    const host = frameHostRef.current
    if (!host) return
    const handleWheel = (event: WheelEvent) => {
      if (paneRef.current?.mode !== 'watch') return
      const point = pointForEvent(event.clientX, event.clientY)
      if (!point) return
      event.preventDefault()
      const currentFrame = frameRef.current
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? currentFrame?.height ?? 1 : 1
      sendInputRef.current({ kind: 'wheel', ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiers(event) })
    }
    host.addEventListener('wheel', handleWheel, { passive: false })
    return () => host.removeEventListener('wheel', handleWheel)
  }, [pointForEvent])

  const mouseEvent = (
    event: ReactPointerEvent<HTMLDivElement>,
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    knownPoint?: { x: number; y: number }
  ) => {
    const point = knownPoint ?? pointForEvent(event.clientX, event.clientY)
    if (!point) return
    const buttons: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' }
    sendInput({
      kind: 'mouse', type, ...point,
      ...(type === 'mouseMoved' ? {} : { button: buttons[event.button] ?? 'left' }),
      modifiers: modifiers(event)
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!frame || pane?.mode !== 'watch') return
    const point = pointForEvent(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.currentTarget.focus()
    lastPointerPointRef.current = point
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* detached element */ }
    mouseEvent(event, 'mousePressed', point)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pane?.mode !== 'watch') return
    event.preventDefault()
    const point = pointForEvent(event.clientX, event.clientY) ?? lastPointerPointRef.current
    if (point) mouseEvent(event, 'mouseReleased', point)
    lastPointerPointRef.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* capture already released */ }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pane?.mode !== 'watch' || !frame) return
    const point = pointForEvent(event.clientX, event.clientY)
    if (!point) return
    lastPointerPointRef.current = point
    const now = performance.now()
    if (now - lastPointerMoveRef.current < 16) return
    lastPointerMoveRef.current = now
    mouseEvent(event, 'mouseMoved', point)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (pane?.mode !== 'watch' || !frame || event.target !== event.currentTarget || event.nativeEvent.isComposing || event.key === 'Process' || event.key === 'Dead') return
    if (isTextInputKey(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      sendInput({ kind: 'text', text: event.key })
      return
    }
    event.preventDefault()
    sendInput({ kind: 'key', type: 'keyDown', key: event.key, code: event.code, modifiers: modifiers(event) })
  }

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      pane?.mode !== 'watch' || !frame || event.target !== event.currentTarget || event.nativeEvent.isComposing ||
      event.key === 'Process' || event.key === 'Dead' ||
      (isTextInputKey(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey)
    ) return
    event.preventDefault()
    sendInput({ kind: 'key', type: 'keyUp', key: event.key, code: event.code, modifiers: modifiers(event) })
  }

  const onCompositionEnd = (event: ReactCompositionEvent<HTMLDivElement>) => {
    if (pane?.mode === 'watch' && event.target === event.currentTarget && event.data !== '') {
      event.preventDefault()
      sendInput({ kind: 'text', text: event.data })
    }
  }

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (pane?.mode !== 'watch' || event.target !== event.currentTarget) return
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    sendInput({ kind: 'text', text })
  }

  const acknowledgeFrame = useCallback((candidate: PaneFrame) => {
    if (
      watchIdRef.current !== candidate.watchId ||
      frameRef.current?.sequence !== candidate.sequence ||
      frameRef.current?.pane !== candidate.pane
    ) return
    loadedFrameRef.current = { watchId: candidate.watchId, sequence: candidate.sequence }
    const previousAck = lastAckRef.current
    if (previousAck?.watchId === candidate.watchId && previousAck.sequence === candidate.sequence) return
    lastAckRef.current = loadedFrameRef.current
    void context.call('quirky.browser/paneFrameAck', { pane: candidate.pane, watchId: candidate.watchId, sequence: candidate.sequence }).catch((error: unknown) => {
      if (mountedRef.current) setWatchError(errorText(error))
    })
    const next = deferredFrameRef.current
    if (!next || next.watchId !== candidate.watchId || next.sequence <= candidate.sequence) return
    deferredFrameRef.current = null
    loadedFrameRef.current = null
    frameRef.current = next
    setFrame(next)
  }, [context])

  useEffect(() => {
    const image = watchImageRef.current
    if (frame && image?.complete && image.naturalWidth > 0) acknowledgeFrame(frame)
  }, [frame, acknowledgeFrame])

  const respond = async (prompt: PanePrompt, accept: boolean) => {
    const values = promptValues[prompt.id] ?? { text: prompt.defaultValue ?? '', username: '', password: '' }
    const nativeAuth = pane?.mode === 'native' && prompt.kind === 'auth'
    if (nativeAuth && accept) nativeCredentialsRef.current.set(prompt.id, { username: values.username, password: values.password })
    await invoke('paneRespond', {
      pane: pane?.id,
      prompt: prompt.id,
      accept,
      ...(prompt.kind === 'prompt' && accept ? { text: values.text } : {}),
      ...(prompt.kind === 'auth' && accept && !nativeAuth ? { username: values.username, password: values.password } : {})
    })
    if (!mountedRef.current) return
    setPromptValues((current) => {
      const next = { ...current }
      delete next[prompt.id]
      return next
    })
  }

  const openEditor = async (path: string, mode: 'source' | 'preview') => {
    if (!pane) return
    try {
      await context.call('quirky.editor/open', {
        worktree: worktreeSelector(pane.worktreeId),
        path,
        mode,
        focus: true
      })
    } catch (error) {
      if (mountedRef.current) setMessage({ text: `Could not open this workspace document in the editor: ${errorText(error)}`, kind: 'error' })
    }
  }

  const zoom = pane?.zoom ?? settings.zoom
  const zoomPercent = Math.round(100 * 1.2 ** zoom)
  const nativeViewport = VIEWPORTS.find((entry) => entry.id === pane?.viewport)
  const nativeSize = pane?.mode === 'native' && nativeViewport?.width && nativeViewport.height
    ? { width: nativeViewport.width, height: nativeViewport.height, maxWidth: '100%', maxHeight: '100%' }
    : undefined
  const canUseWatch = pane?.mode === 'watch'

  const activePrompt = pane?.mode === 'watch' || (pane?.mode === 'native' && context.nativeBrowser.pageRequestsAvailable) ? pane.prompts[0] ?? null : null
  return (
    <div
      ref={rootRef}
      className="qbp"
      data-browser-pane={pane?.id ?? requestedPaneId ?? ''}
      style={paneStyles.root}
      tabIndex={-1}
      onFocusCapture={() => {
        focusedPaneId = paneRef.current?.id ?? requestedPaneId
        focusAddress = () => addressRef.current?.focus()
        focusFind = () => {
          setFindOpen(true)
          requestAnimationFrame(() => findRef.current?.focus())
        }
        context.setContext('browserFocus', true)
        setBrowserFocused(true)
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && rootRef.current?.contains(next)) return
        if (focusedPaneId === (paneRef.current?.id ?? requestedPaneId)) {
          focusedPaneId = null
          focusAddress = null
          focusFind = null
          context.setContext('browserFocus', false)
          setBrowserFocused(false)
        }
      }}
    >
      <div className="qbp-toolbar" aria-label="Browser controls" style={paneStyles.toolbar}>
        <IconButton label="Back" title="Back" disabled={!pane || !paneHistoryControls(pane).back} onClick={() => void control('back')} style={paneStyles.toolbarControl}>‹</IconButton>
        <IconButton label="Forward" title="Forward" disabled={!pane || !paneHistoryControls(pane).forward} onClick={() => void control('forward')} style={paneStyles.toolbarControl}>›</IconButton>
        <IconButton
          label={pane?.loading ? 'Stop loading' : 'Reload'}
          title={pane?.loading ? 'Stop loading' : 'Reload'}
          disabled={!pane}
          onClick={() => void control(pane?.loading ? 'stop' : 'reload')}
          style={paneStyles.toolbarControl}
        >{pane?.loading ? '■' : '↻'}</IconButton>
        <div className="qbp-address-wrap" style={paneStyles.addressWrap}>
          <div style={paneStyles.addressFieldWrap}>
            <TextField
              ref={addressRef}
              className="qbp-address"
              label="Address and search"
              aria-label="Address and search"
              aria-autocomplete="list"
              aria-expanded={suggestionsOpen && suggestions.length > 0}
              value={address}
              placeholder="Search or enter address"
              style={paneStyles.addressField}
              onFocus={() => { setEditingAddress(true); setSuggestionsOpen(true) }}
              onBlur={() => { window.setTimeout(() => setSuggestionsOpen(false), 120); setEditingAddress(false) }}
              onChange={(event) => { setAddress(event.target.value); setSuggestionsOpen(true) }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && suggestions.length > 0) {
                  event.preventDefault()
                  setActiveSuggestion((value) => (value + 1) % suggestions.length)
                } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                  event.preventDefault()
                  setActiveSuggestion((value) => (value + suggestions.length - 1) % suggestions.length)
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  const suggestion = suggestionsOpen ? suggestions[activeSuggestion] : undefined
                  void navigate(suggestion?.url ?? address)
                } else if (event.key === 'Escape') {
                  setSuggestionsOpen(false)
                  addressRef.current?.blur()
                }
              }}
            />
          </div>
          {suggestionsOpen && suggestions.length > 0 ? (
            <div className="ui-menu__list qbp-address-popover" role="listbox" aria-label="Browser suggestions" style={paneStyles.suggestions}>
              {suggestions.map((suggestion, index) => (
                <Button
                  className="ui-menu__item"
                  role="option"
                  aria-selected={index === activeSuggestion}
                  key={`${suggestion.kind}:${suggestion.url}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySuggestion(suggestion.url)}
                >
                  <span className="qbp-suggestion-title" style={paneStyles.suggestionTitle}>{suggestion.title || suggestion.url}</span>
                  <span className="qbp-suggestion-detail" style={paneStyles.suggestionDetail}>{suggestion.kind} · {suggestion.url}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <Button aria-label="Find in page" title="Find in page (Mod+F)" onClick={() => { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()) }} style={paneStyles.toolbarControl}>Find</Button>
        <span className="qbp-mode" data-mode={pane?.mode ?? 'native'} style={paneStyles.mode}>
          <Badge tone={pane?.mode === 'watch' ? 'accent' : 'neutral'}>
            {pane?.mode === 'watch' ? 'Watch' : 'Native'}
          </Badge>
        </span>
        <DesignWindow
          context={context}
          pane={pane ? { id: pane.id, mode: pane.mode, page: pane.page, url: pane.url, title: pane.title, loading: pane.loading, error: pane.error, worktreeId: pane.worktreeId } : null}
          nativeHandle={nativeHandleRef.current}
          pageHost={designPageHost}
          nativePageHost={nativeHostRef.current}
          frameSize={pane?.mode === 'watch' && frame ? { width: frame.width, height: frame.height } : null}
          watchId={pane?.mode === 'watch' ? frame?.watchId ?? null : null}
          watchReady={Boolean(pane?.mode === 'watch' && frame?.pane === pane.id && frame.watchId === watchIdRef.current && !watchError && !pane.error)}
          focused={browserFocused && focusedPaneId === pane?.id}
          onMessage={reportDesignMessage}
          actionRef={designActionRef}
        />
        <details className="qbp-details qbp-profile-details" style={paneStyles.profileDetails}>
          <summary className="ui-menu__trigger" aria-label="Browser menu" style={paneStyles.menuSummary}>Browser menu</summary>
          <div className="ui-menu__list qbp-menu-popover" role="menu" style={paneStyles.profilePopover}>
            <div style={paneStyles.menuItems}>
            <BrowserProfileMenu context={context} pane={pane ?? undefined} inline onError={(text) => setMessage({ text, kind: 'error' })} />
            {pane?.mode === 'watch' || (pane?.mode === 'native' && nativeState?.hardReloadAvailable)
              ? <Button className="ui-menu__item" role="menuitem" onClick={() => void control('hardReload')}>Hard Reload</Button>
              : pane?.mode === 'native'
                ? <span className="qbp-muted" style={paneStyles.mutedText}>Hard Reload is unavailable in Native mode on this system webview; ordinary Reload is available.</span>
                : null}
            {settings.homePage
              ? <Button className="ui-menu__item" role="menuitem" onClick={() => void navigate(settings.homePage)}>Home Page · {settings.homePage}</Button>
              : <span className="qbp-muted" style={paneStyles.mutedText}>Home page: not set</span>}
            <Button className="ui-menu__item" role="menuitem" onClick={() => void control('zoom', { level: Math.max(-3, zoom - 0.5) })}>Zoom Out</Button>
            <Button className="ui-menu__item" role="menuitem" onClick={() => void control('zoom', { level: Math.min(5, zoom + 0.5) })}>Zoom In</Button>
            <Button className="ui-menu__item" role="menuitem" onClick={() => void control('zoom', { level: 0 })}>Reset Zoom · {zoomPercent}%</Button>
            <details className="qbp-details" style={paneStyles.details}>
              <summary className="ui-menu__trigger" style={paneStyles.menuSummary}>Viewport · {VIEWPORTS.find((entry) => entry.id === pane?.viewport)?.label ?? 'Default'}</summary>
              <div className="ui-menu__list qbp-menu-popover" role="menu" aria-label="Viewport preset" style={paneStyles.menuPopover}>
                <div style={paneStyles.menuItems}>
                {VIEWPORTS.map((preset) => (
                  <Button className="ui-menu__item" key={preset.id} role="menuitemradio" aria-checked={pane?.viewport === preset.id} onClick={() => void control('viewport', { preset: preset.id })}>
                    {preset.label}{preset.mobile && pane?.mode === 'native' ? ' · visible size only' : ''}
                  </Button>
                ))}
                </div>
              </div>
            </details>
            {pane?.mode === 'native' ? <Button className="ui-menu__item" role="menuitem" onClick={() => void startWatchHere()} disabled={watchStarting}>{watchStarting ? 'Starting Watch…' : 'Start Watch in an owned page…'}</Button> : null}
            {pane ? <Button className="ui-menu__item" role="menuitem" onClick={() => void loadAgentPages()} disabled={pageListLoading}>{pageListLoading ? 'Loading agent pages…' : 'Watch an agent page…'}</Button> : null}
            {pane && pageList ? <div role="menu" aria-label="Managed pages for Watch" style={{ display: 'grid', gap: 'var(--ui-space-4)' }}>
              {pageList.length ? pageList.map((entry) => <Button className="ui-menu__item" key={entry.browserPageId} role="menuitem" onClick={() => void openWatchPage(entry.browserPageId)}>
                <span className="qbp-suggestion-title" style={paneStyles.suggestionTitle}>{entry.title || entry.url || 'Untitled page'}</span>
                <span className="qbp-suggestion-detail" style={paneStyles.suggestionDetail}>{entry.active ? 'Active · ' : ''}{entry.url}</span>
              </Button>) : <EmptyState message="No managed pages are available in this worktree." />}
            </div> : null}
            {pane?.mode === 'watch' ? <Button className="ui-menu__item" role="menuitem" onClick={() => {
              const selector = worktreeSelector(pane.worktreeId)
              context.openView(WORKTREE_VIEW, { worktree: selector })
            }}>Open worktree view</Button> : null}
            <span className="qbp-muted" style={paneStyles.mutedText}>Search engine: {settings.searchEngine}</span>
            </div>
          </div>
        </details>
        <BrowserImportHint context={context} pane={pane ?? undefined} onError={(text) => setMessage({ text, kind: 'error' })} />
        <details className="qbp-details" style={paneStyles.details}>
          <summary className="ui-menu__trigger" aria-label="Browser history" style={paneStyles.menuSummary}>History</summary>
          <div className="ui-menu__list qbp-menu-popover qbp-history" role="menu" aria-label="Recent browser history" style={paneStyles.historyPopover}>
            <div style={paneStyles.menuItems}>
            {state?.history.length ? state.history.slice(0, 200).map((entry) => (
              <Button className="ui-menu__item" key={`${entry.url}:${entry.visitedAt}`} role="menuitem" onClick={() => void navigate(entry.url)}>
                <span className="qbp-suggestion-title" style={paneStyles.suggestionTitle}>{entry.title || entry.url}</span>
                <span className="qbp-suggestion-detail" style={paneStyles.suggestionDetail}>{entry.url}</span>
              </Button>
            )) : <EmptyState message="No browser history yet." />}
            </div>
          </div>
        </details>
      </div>

      {findOpen ? (
        <div className="qbp-find" role="search" aria-label="Find in page" style={paneStyles.find}>
          <div style={paneStyles.findField}>
            <TextField
              ref={findRef}
              label="Find text in page"
              aria-label="Find text in page"
              placeholder="Find in page"
              value={findText}
              style={paneStyles.findInput}
              onFocus={() => { editingFindRef.current = true }}
              onBlur={() => { editingFindRef.current = false }}
              onChange={(event) => {
                const value = event.target.value
                findTextRef.current = value
                setFindText(value)
                void control('find', { text: value, forward: true })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void control('find', { text: findTextRef.current, forward: !event.shiftKey }) }
                if (event.key === 'Escape') { event.preventDefault(); editingFindRef.current = false; setFindOpen(false); void control('find', { text: '' }) }
              }}
            />
          </div>
          <span className="qbp-find-count" aria-live="polite" style={paneStyles.findCount}>
            <Badge>{pane?.find.total ? `${pane.find.current} of ${pane.find.total}` : 'No matches'}</Badge>
          </span>
          <IconButton label="Previous match" title="Previous match" onClick={() => void control('find', { text: findTextRef.current, forward: false })}>↑</IconButton>
          <IconButton label="Next match" title="Next match" onClick={() => void control('find', { text: findTextRef.current, forward: true })}>↓</IconButton>
          <Button aria-label="Close find" onClick={() => { editingFindRef.current = false; findTextRef.current = ''; setFindOpen(false); setFindText(''); void control('find', { text: '' }) }}>Close</Button>
        </div>
      ) : null}

      {message ? <div className="qbp-message" data-kind={message.kind} role={message.kind === 'error' ? 'alert' : 'status'} style={paneStyles.message}>
        <StatusDot status={message.kind === 'error' ? 'failing' : 'idle'} label={message.kind === 'error' ? 'Browser error' : 'Browser notice'} />
        <span style={message.kind === 'error' ? { ...paneStyles.messageText, ...paneStyles.errorText } : paneStyles.messageText}>{message.text}</span>
        <Button onClick={() => setMessage(null)} aria-label="Dismiss message">Dismiss</Button>
      </div> : null}
      {pane?.mode === 'watch' && frame && (watchError || pane.error) ? <div className="qbp-message" data-kind="error" role="alert" style={paneStyles.message}>
        <StatusDot status="failing" label="Watch error" />
        <span style={{ ...paneStyles.messageText, ...paneStyles.errorText }}>{watchError ?? pane.error}</span>
        <Button onClick={() => setWatchRevision((revision) => revision + 1)}>Retry this Watch</Button>
      </div> : null}

      <div
        ref={attachFrameHost}
        className="qbp-page"
        style={paneStyles.page}
        aria-label={pane ? `${pane.mode === 'watch' ? 'Watched' : 'Native'} page: ${pane.title || pane.url}` : 'Browser page'}
        tabIndex={canUseWatch ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        onContextMenu={(event) => { if (canUseWatch) event.preventDefault() }}
      >
        {pane?.mode === 'native' && pane.document && context.nativeBrowser.available && !context.nativeBrowser.previewAvailable ? (
          <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card}>
            <SectionHeader title="Workspace document preview is unavailable here" />
            <p className="ui-help-text" style={paneStyles.helpText}>This desktop host cannot isolate a workspace preview from the network, device permissions and downloads, so the document is not rendered. Open the source file instead, or go Back.</p>
          </div></div>
        ) : null}
        {pane?.mode === 'native' && context.nativeBrowser.available ? <div className="qbp-native-host" ref={nativeHostRef} style={{ ...paneStyles.nativeHost, ...nativeSize }} aria-label="Native browser page" /> : null}
        {pane?.mode === 'watch' && frame ? <img
          className="qbp-watch-image"
          ref={watchImageRef}
          key={`${frame.watchId}:${frame.sequence}`}
          src={imageSource(frame)}
          alt={`Watched page frame ${frame.width} by ${frame.height}`}
          draggable={false}
          style={paneStyles.watchImage}
          onLoad={() => acknowledgeFrame(frame)}
          onError={() => setWatchError('The latest Watch frame could not be decoded.')}
        /> : null}
        {!pane ? <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card}>
          <SectionHeader title="Browser pane unavailable" />
          <EmptyState message="The browser pane state could not be loaded for this tab." action={{ label: 'Retry', onAction: () => void refresh() }} />
        </div></div> : null}
        {pane?.mode === 'native' && !context.nativeBrowser.available ? (
          <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card}>
            <SectionHeader title="Native browsing is unavailable here" />
            <p className="ui-help-text" style={paneStyles.helpText}>This web client cannot embed the sandboxed system webview. Watch is explicit: it creates or binds a managed agent page through the browser pane service; it never silently substitutes Chrome.</p>
            {nativeError ? <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{nativeError}</p> : null}
            <div className="qbp-actions" style={paneStyles.actions}>
              <Button onClick={() => void startWatchHere()} disabled={watchStarting}>{watchStarting ? 'Starting Watch…' : 'Watch this address in an owned page'}</Button>
              <Button onClick={() => void loadAgentPages()} disabled={pageListLoading}>{pageListLoading ? 'Loading pages…' : 'Choose an existing agent page'}</Button>
            </div>
            {pageListError ? <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{pageListError}</p> : null}
            {pageList ? <div className="ui-menu__list qbp-menu-popover" role="list" aria-label="Managed pages" style={{ ...paneStyles.menuPopover, ...paneStyles.menuItems }}>
              {pageList.length ? pageList.map((entry) => <Button className="ui-menu__item" key={entry.browserPageId} onClick={() => void openWatchPage(entry.browserPageId)}>
                <span className="qbp-suggestion-title" style={paneStyles.suggestionTitle}>{entry.title || entry.url || 'Untitled page'}</span>
                <span className="qbp-suggestion-detail" style={paneStyles.suggestionDetail}>{entry.active ? 'Active · ' : ''}{entry.url}</span>
              </Button>) : <EmptyState message="No managed pages are available in this worktree." />}
            </div> : null}
            <p className="qbp-muted" style={paneStyles.mutedText}>Native browsing requires the desktop shell. Watch is an explicit opt-in to a managed agent page.</p>
          </div></div>
        ) : null}
        {pane?.mode === 'native' && context.nativeBrowser.available && nativeError ? (
          <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card} role="dialog" aria-modal="false" aria-label="Native browser could not start">
            <SectionHeader title="Native browser could not start" />
            <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{nativeError}</p>
            <Button onClick={() => { setNativeError(null); setNativeRetry((revision) => revision + 1) }}>Retry Native Browser</Button>
          </div></div>
        ) : null}
        {pane?.mode === 'watch' && !frame ? (
          <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card}>
            <SectionHeader title={pane.error ? 'Watch ended' : 'Connecting to Watch'} />
            <EmptyState message={pane.error ?? watchError ?? (pane.page ? 'Connecting to the selected managed page…' : 'This Watch pane has no managed page selected.')} />
            {watchError ? <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{watchError}</p> : null}
            {!pane.page ? <Button onClick={() => void loadAgentPages()}>Choose an agent page to Watch</Button> : null}
            {pageListError ? <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{pageListError}</p> : null}
            {pageList ? <div className="ui-menu__list qbp-menu-popover" role="list" aria-label="Managed pages" style={{ ...paneStyles.menuPopover, ...paneStyles.menuItems }}>
              {pageList.length ? pageList.map((entry) => <Button className="ui-menu__item" key={entry.browserPageId} onClick={() => void openWatchPage(entry.browserPageId)}>
                <span className="qbp-suggestion-title" style={paneStyles.suggestionTitle}>{entry.title || entry.url || 'Untitled page'}</span>
                <span className="qbp-suggestion-detail" style={paneStyles.suggestionDetail}>{entry.url}</span>
              </Button>) : <EmptyState message="No managed pages are available in this worktree." />}
            </div> : null}
            {pane.error || watchError ? <Button onClick={() => setWatchRevision((revision) => revision + 1)}>Retry this Watch</Button> : null}
          </div></div>
        ) : null}
        {pane?.mode === 'native' && context.nativeBrowser.available && (pane.url !== 'about:blank' || pane.loading || pane.command !== null || pane.canGoBack || pane.canGoForward) && nativeReady === 0 && !nativeError ? <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card} role="dialog" aria-modal="false" aria-label="Starting native browser">
          <SectionHeader title="Starting native browser…" />
          <EmptyState message="Creating the sandboxed system webview." />
        </div></div> : null}
        {nativeState?.error && pane?.mode === 'native' ? <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card} role="dialog" aria-modal="false" aria-label="Page could not load">
          <SectionHeader title="Page could not load" />
          <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{nativeState.error}</p>
          <div className="qbp-actions" style={paneStyles.actions}>
            <Button onClick={() => void navigate(nativeState.url)}>Retry</Button>
            <Button onClick={() => setNativeState(null)}>Dismiss</Button>
          </div>
        </div></div> : null}
        {pane?.mode === 'native' && context.nativeBrowser.available && !nativeError && !pane.loading && pane.url === 'about:blank' && !nativeState?.error ? <div className="qbp-overlay" data-quirky-native-mask style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card}>
          <SectionHeader title="New Tab" />
          <EmptyState message="Type a URL or search above to start browsing." />
          <p className="qbp-muted" style={paneStyles.mutedText}>Home page: {settings.homePage || 'not set'} · Search: {settings.searchEngine}</p>
        </div></div> : null}
        {pane?.mode === 'watch' && pane.error && frame ? <div className="qbp-overlay" style={paneStyles.overlay}><div className="qbp-card ui-tool-panel-frame" style={paneStyles.card}>
          <SectionHeader title="Watch ended" />
          <p className="qbp-error ui-error-text" style={paneStyles.errorText} role="alert">{pane.error}</p>
          <p className="ui-help-text" style={paneStyles.helpText}>The browser pane will not attach to another page automatically.</p>
        </div></div> : null}
      </div>

      {pane?.sourcePath || pane?.preview ? <div className="qbp-message" aria-label="Workspace document actions" style={paneStyles.message}>
        {pane.sourcePath ? <Button onClick={() => void openEditor(pane.sourcePath!, 'source')}>Open source file</Button> : null}
        {pane.preview ? <Button onClick={() => void openEditor(pane.preview!.path, 'preview')}>Open in Editor Preview</Button> : null}
        {pane.mode === 'native' && pane.sourcePath && /\.html?$/i.test(pane.sourcePath) && !pane.preview && !pane.document
          ? context.nativeBrowser.previewAvailable
            ? <Button onClick={() => void invoke('panePreview', { pane: pane.id, path: pane.sourcePath! })}>Preview as workspace document</Button>
            : <span className="qbp-muted" style={paneStyles.mutedText}>Workspace HTML is open directly in Native; isolated workspace preview is unavailable in this host.</span>
          : null}
        {pane.document
          ? <span className="qbp-muted" style={paneStyles.mutedText}>Isolated workspace preview: {pane.document.grant.entryOnly ? 'only this file loads' : "only files in this document's folder load"}; network, permissions, popups and downloads are blocked.</span>
          : null}
      </div> : null}

      {activePrompt ? <div className="qbp-overlay" role="presentation" style={paneStyles.overlay}>
        <div className="qbp-card qbp-prompt ui-tool-panel-frame" role="dialog" aria-modal="true" aria-label={`${activePrompt.kind} from ${activePrompt.origin}`} style={{ ...paneStyles.card, ...paneStyles.prompt }}>
          <SectionHeader title={promptTitle(activePrompt.kind)} />
          <p className="ui-help-text" style={paneStyles.helpText}><strong>{activePrompt.origin}</strong></p>
          <p style={{ margin: 0, overflowWrap: 'anywhere' }}>{activePrompt.message}</p>
          {activePrompt.kind === 'prompt' ? <FormRow label="Response" htmlFor={`${promptFieldsId}-response`}>
            <input id={`${promptFieldsId}-response`} className="ui-text-field__input" value={(promptValues[activePrompt.id] ?? { text: activePrompt.defaultValue ?? '', username: '', password: '' }).text} onChange={(event) => updatePrompt(promptValues, setPromptValues, activePrompt, { text: event.target.value })} />
          </FormRow> : null}
          {activePrompt.kind === 'auth' ? <>
            <FormRow label="Username" htmlFor={`${promptFieldsId}-username`}>
              <input id={`${promptFieldsId}-username`} className="ui-text-field__input" autoComplete="username" value={(promptValues[activePrompt.id] ?? { text: '', username: '', password: '' }).username} onChange={(event) => updatePrompt(promptValues, setPromptValues, activePrompt, { username: event.target.value })} />
            </FormRow>
            <FormRow label="Password" htmlFor={`${promptFieldsId}-password`}>
              <input id={`${promptFieldsId}-password`} className="ui-text-field__input" type="password" autoComplete="current-password" value={(promptValues[activePrompt.id] ?? { text: '', username: '', password: '' }).password} onChange={(event) => updatePrompt(promptValues, setPromptValues, activePrompt, { password: event.target.value })} />
            </FormRow>
          </> : null}
          {activePrompt.kind === 'certificate' && !activePrompt.canProceed ? <p className="qbp-error ui-error-text" style={paneStyles.errorText}>Proceed is unavailable for this certificate error. Only eligible loopback addresses can be allowed.</p> : null}
          <div className="qbp-actions" style={{ ...paneStyles.actions, marginTop: 'var(--ui-space-12)' }}>
            {activePrompt.kind === 'alert' ? <Button onClick={() => void respond(activePrompt, true)}>OK</Button> : null}
            {activePrompt.kind !== 'alert' ? <Button onClick={() => void respond(activePrompt, false)}>{promptDecline(activePrompt.kind)}</Button> : null}
            {activePrompt.kind !== 'alert' && (activePrompt.kind !== 'certificate' || activePrompt.canProceed) ? <Button onClick={() => void respond(activePrompt, true)}>{promptAccept(activePrompt.kind)}</Button> : null}
          </div>
        </div>
      </div> : null}

      {pane?.downloads.length ? <div className="qbp-shelf" aria-label="Downloads" style={paneStyles.shelf}>
        <SectionHeader title="Downloads" />
        {pane.downloads.map((download) => <DownloadRow key={download.id} download={download} onAction={(action) => void invoke('paneDownload', { pane: pane.id, download: download.id, action })} />)}
      </div> : null}
    </div>
  )
}


function promptTitle(kind: PanePrompt['kind']): string {
  switch (kind) {
    case 'alert': return 'Page message'
    case 'confirm': return 'Page confirmation'
    case 'prompt': return 'Page input requested'
    case 'beforeunload': return 'Leave this page?'
    case 'auth': return 'Sign in to this site'
    case 'certificate': return 'Certificate warning'
    case 'external': return 'Open external application?'
  }
}

function promptDecline(kind: PanePrompt['kind']): string {
  return kind === 'beforeunload' ? 'Stay' : kind === 'external' ? 'Block' : 'Cancel'
}

function promptAccept(kind: PanePrompt['kind']): string {
  switch (kind) {
    case 'beforeunload': return 'Leave'
    case 'certificate': return 'Proceed to loopback site'
    case 'external': return 'Allow external application'
    case 'confirm': return 'Confirm'
    case 'prompt': return 'Submit'
    case 'auth': return 'Sign in'
    case 'alert': return 'OK'
  }
}

function updatePrompt(
  values: Record<string, { text: string; username: string; password: string }>,
  setValues: (update: (current: Record<string, { text: string; username: string; password: string }>) => Record<string, { text: string; username: string; password: string }>) => void,
  prompt: PanePrompt,
  update: Partial<{ text: string; username: string; password: string }>
): void {
  const current = values[prompt.id] ?? { text: prompt.defaultValue ?? '', username: '', password: '' }
  setValues((all) => ({ ...all, [prompt.id]: { ...current, ...update } }))
}

function DownloadRow({ download, onAction }: { download: PaneDownload; onAction: (action: 'cancel' | 'open' | 'reveal' | 'dismiss') => void }) {
  const hasProgress = download.state === 'downloading' || download.state === 'paused'
  const percent = download.total && download.total > 0 ? Math.min(100, download.received / download.total * 100) : undefined
  const description = (
    <span style={paneStyles.downloadDescription}>
      {download.error ? <span className="qbp-error" style={paneStyles.errorText}>{download.error}</span> : null}
      {hasProgress ? <span className="qbp-muted" style={paneStyles.mutedText}>{formatBytes(download.received)}{download.total ? ` / ${formatBytes(download.total)}` : ''}</span> : null}
      <span className="qbp-download-actions" style={paneStyles.downloadActions}>
        {percent !== undefined ? <progress aria-label={`${download.name} download progress`} max={100} value={percent} style={paneStyles.downloadProgress} /> : null}
        {hasProgress ? <Button onClick={() => onAction('cancel')}>Cancel download</Button> : null}
        {download.state === 'completed' ? <>
          <Button onClick={() => onAction('open')}>Open</Button>
          <Button onClick={() => onAction('reveal')}>Show in folder</Button>
        </> : null}
        <Button onClick={() => onAction('dismiss')}>Dismiss</Button>
      </span>
    </span>
  )
  const badgeTone = download.error ? 'failing' : download.state === 'completed' ? 'accent' : hasProgress ? 'working' : 'neutral'
  return (
    <div className="qbp-download" data-download={download.id} style={paneStyles.download}>
      <ListRow
        title={<span className="qbp-download-name"><strong>{download.name}</strong></span>}
        description={description}
        trailing={<Badge tone={badgeTone}>{download.state}</Badge>}
      />
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = bytes
  let unit = -1
  do { size /= 1024; unit++ } while (size >= 1024 && unit < units.length - 1)
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}
