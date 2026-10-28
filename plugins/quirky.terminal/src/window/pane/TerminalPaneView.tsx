import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from 'react'
import { Terminal, type ILinkHandler, type ITerminalAddon } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { ClipboardAddon, type IBase64, type IClipboardProvider } from '@xterm/addon-clipboard'
import { RpcError, RpcErrorCode, base64ToBytes, type UiPluginContext } from '@quirky/protocol'
import { shellEscapePaths } from '../../shell-escape'
import { pathsFromDrop } from './drop'
import { trackKittyFlags } from './kitty'
import { PathChecker, createFileLinkProvider } from './link-provider'
import { LinkPopover, type PopoverItem } from './LinkPopover'
import { decideLinkClick, type LinkKind } from './links'
import { resolveKeyAction } from './keys'
import { createOsc52Base64, createOsc52Provider, createOsc52QueryGuard } from './osc52'
import { planPaste, runPaste } from './paste'
import { createInputGate, writeReplay } from './replayGate'
import { isSafeRegex } from './regexSafety'
import { SearchBox } from './SearchBox'
import { trimGutter } from './selection'
import { fontStack, zoomed, type PaneSettings } from './settings'
import { readTerminalColors, withAlpha } from './terminalTheme'
import { ContextLossGuard, loseWebglContext, webglBudget } from './webgl'

/** The most characters a search query may have. */
export const MAX_SEARCH_QUERY = 1000

const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
}

/** xterm highlights at most this many matches; a count at the limit means there may be more. */
const HIGHLIGHT_LIMIT = 1000

export type PaneSearchReport = { query: string; regex: boolean; caseSensitive: boolean; current: number; total: number; more: boolean }

/** What a pane tells its parent about itself, whenever any of it changes. */
export type PaneReport = { cols: number; rows: number; fontSize: number; webgl: boolean; search: PaneSearchReport | null }

export type SearchOptions = { regex?: boolean; caseSensitive?: boolean }

/** The operations the workspace drives on a mounted pane. */
export type TerminalPaneHandle = {
  focus(): void
  scrollToBottom(): void
  /** The selected text (gutter-trimmed when the setting says so), also put on the clipboard; empty when nothing is selected. */
  copy(): string
  selectAll(): void
  /** Pastes through the same bracketed, chunked path as a real paste. */
  paste(text: string): Promise<void>
  /** Opens the find box, or focuses it when open; with a query it also searches. Throws invalid-params for a query over 1,000 characters. */
  search(query?: string, options?: SearchOptions): void
  searchNext(): void
  searchPrevious(): void
  searchClose(): void
  zoomIn(): void
  zoomOut(): void
  zoomReset(): void
}

export type TerminalPaneProps = {
  context: UiPluginContext
  sessionId: string
  /** The directory relative file links are joined onto. */
  cwd: string
  settings: PaneSettings
  /** Whether this is the focused pane of its tab; the pane takes keyboard focus when it becomes active. */
  active: boolean
  /** The terminal must not reclaim focus while the embedded dock owns keyboard input. */
  suppressAutoFocus?: boolean
  /** False once the process has exited, so keystrokes are not sent to a dead session. */
  interactive: boolean
  /** True while a divider or panel drag is resizing the pane; the shell is told the final size once the drag ends. */
  dragging: boolean
  onFocus?(): void
  onState?(state: PaneReport): void
  /** The element whose `--terminal-*` custom properties give the colors; defaults to the document root. */
  themeSource?: Element
  /** Replaces the WebGL addon constructor, so tests can run without a GPU. */
  createWebgl?: () => ITerminalAddon & { onContextLoss(listener: () => void): unknown }
  ref?: Ref<TerminalPaneHandle>
}

type SearchState = { query: string; regex: boolean; caseSensitive: boolean }
type Results = { index: number; count: number }
type View = { cols: number; rows: number; fontSize: number; webgl: boolean }
type Popover = { x: number; y: number; items: PopoverItem[] }

type Runtime = {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  webgl: ITerminalAddon | null
  webglBlocked: boolean
  paste(text: string): Promise<void>
  copy(): string
  scheduleFit(): void
  setFont(): void
  refreshWebgl(): void
  syncOsc52(): void
}

const EMPTY_RESULTS: Results = { index: -1, count: 0 }

const style: Record<string, CSSProperties> = {
  host: { position: 'absolute', inset: 0, boxSizing: 'border-box', overflow: 'hidden' },
  screen: { position: 'absolute' },
  hint: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    zIndex: 15,
    maxWidth: 'calc(100% - 12px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '2px 8px',
    borderRadius: 4,
    background: 'var(--popover, rgba(30, 32, 38, 0.95))',
    color: 'var(--popover-foreground, #d7dae0)',
    border: '1px solid var(--border, #3a3d45)',
    fontSize: 11,
    pointerEvents: 'none'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs a search call so an addon exception (a negative decoration width, a bad regex) never reaches the pane. */
function guarded<T>(call: () => T, fallback: T): T {
  try {
    return call()
  } catch {
    return fallback
  }
}

function hasMore(results: Results): boolean {
  return results.count > 0 && (results.index < 0 || results.count >= HIGHLIGHT_LIMIT)
}

/** Whether the addon may run this search; a regex that can backtrack catastrophically would freeze the window. */
function searchable(search: SearchState): boolean {
  return !search.regex || isSafeRegex(search.query, search.caseSensitive)
}

function searchStatus(search: SearchState, results: Results): string {
  if (!search.query) return '0/0'
  if (!searchable(search)) return 'Regex too complex'
  if (results.count === 0) return 'No results'
  return hasMore(results) ? `${results.count}+` : `${results.index + 1}/${results.count}`
}

let focusOwner: object | null = null

/**
 * One xterm instance attached to one session's output: replay and live stream, input gate,
 * search, links, paste, drop, per-pane zoom, WebGL under a window-wide cap, and the clipboard
 * addon for OSC 52. The workspace keys it by pane ID so a layout change never remounts it.
 */
export function TerminalPaneView(props: TerminalPaneProps) {
  const { context, sessionId, settings, active, dragging, suppressAutoFocus, themeSource, ref } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const latest = useRef(props)
  latest.current = props

  const [search, setSearchState] = useState<SearchState | null>(null)
  const searchRef = useRef<SearchState | null>(null)
  const [results, setResults] = useState<Results>(EMPTY_RESULTS)
  const [view, setView] = useState<View>({ cols: 80, rows: 24, fontSize: settings['font-size'], webgl: false })
  const [hint, setHint] = useState<string | null>(null)
  const [popover, setPopover] = useState<Popover | null>(null)
  const zoom = useRef<number | null>(null)
  const sentSize = useRef<{ cols: number; rows: number } | null>(null)
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging

  const effectiveFontSize = () => zoom.current ?? latest.current.settings['font-size']

  const sendResize = useCallback(() => {
    const rt = runtime.current
    if (!rt) return
    const { cols, rows } = rt.term
    const sent = sentSize.current
    if (sent && sent.cols === cols && sent.rows === rows) return
    sentSize.current = { cols, rows }
    void context.call('quirky.terminal/resize', { session: sessionId, cols, rows }).catch(() => {})
  }, [context, sessionId])

  const clearHighlights = () => {
    const rt = runtime.current
    if (!rt) return
    guarded(() => {
      rt.search.clearDecorations()
      rt.search.findNext('')
    }, undefined)
  }

  const runFind = (direction: 'next' | 'previous', incremental: boolean) => {
    const rt = runtime.current
    const state = searchRef.current
    if (!rt || !state || !state.query) return false
    if (!searchable(state)) {
      setResults(EMPTY_RESULTS)
      clearHighlights()
      return false
    }
    const options = { regex: state.regex, caseSensitive: state.caseSensitive, incremental, decorations: SEARCH_DECORATIONS }
    const found = guarded(() => (direction === 'next' ? rt.search.findNext(state.query, options) : rt.search.findPrevious(state.query, options)), null)
    if (found === null) setResults(EMPTY_RESULTS)
    return found === true
  }

  const applySearch = (next: SearchState | null) => {
    searchRef.current = next
    setSearchState(next)
    if (!next || !next.query) {
      setResults(EMPTY_RESULTS)
      clearHighlights()
      return
    }
    runFind('next', true)
  }

  const closeSearch = () => {
    applySearch(null)
    if (!latest.current.suppressAutoFocus) runtime.current?.term.focus()
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (!latest.current.suppressAutoFocus) runtime.current?.term.focus()
    },
    scrollToBottom: () => runtime.current?.term.scrollToBottom(),
    copy: () => runtime.current?.copy() ?? '',
    selectAll: () => runtime.current?.term.selectAll(),
    paste: (text) => runtime.current?.paste(text) ?? Promise.resolve(),
    search(query, options) {
      if (query !== undefined && query.length > MAX_SEARCH_QUERY) {
        throw new RpcError(RpcErrorCode.InvalidParams, `search query is longer than ${MAX_SEARCH_QUERY.toLocaleString('en-US')} characters`)
      }
      const current = searchRef.current
      if (!current) {
        applySearch({ query: query ?? '', regex: options?.regex ?? false, caseSensitive: options?.caseSensitive ?? false })
        return
      }
      if (query === undefined && options === undefined) {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      applySearch({ query: query ?? current.query, regex: options?.regex ?? current.regex, caseSensitive: options?.caseSensitive ?? current.caseSensitive })
    },
    searchNext: () => void runFind('next', false),
    searchPrevious: () => void runFind('previous', false),
    searchClose: () => {
      if (searchRef.current) closeSearch()
    },
    zoomIn() {
      zoom.current = zoomed(effectiveFontSize(), 1)
      runtime.current?.setFont()
    },
    zoomOut() {
      zoom.current = zoomed(effectiveFontSize(), -1)
      runtime.current?.setFont()
    },
    zoomReset() {
      zoom.current = null
      runtime.current?.setFont()
    }
  }))

  useEffect(() => {
    const host = hostRef.current
    const screen = screenRef.current
    if (!host || !screen) return
    const initial = latest.current.settings
    const colorSource = themeSource ?? host.ownerDocument.documentElement
    const colors = readTerminalColors(colorSource)
    const alpha = (settingsNow: PaneSettings) => settingsNow['background-opacity']
    const theme = (settingsNow: PaneSettings, base = readTerminalColors(colorSource)) => ({
      background: withAlpha(base.background, alpha(settingsNow)),
      foreground: base.foreground,
      cursor: base.cursor
    })

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: alpha(initial) < 1,
      scrollback: initial.scrollback,
      fontFamily: fontStack(initial['font-family']),
      fontSize: effectiveFontSize(),
      fontWeight: initial['font-weight'],
      fontWeightBold: initial['font-weight-bold'],
      lineHeight: initial['line-height'],
      cursorStyle: initial['cursor-style'],
      cursorBlink: initial['cursor-blink'],
      wordSeparator: initial['word-separators'],
      macOptionIsMeta: initial['option-as-alt'] === 'both',
      macOptionClickForcesSelection: true,
      scrollSensitivity: initial['scroll-sensitivity'],
      fastScrollSensitivity: initial['fast-scroll-sensitivity'],
      minimumContrastRatio: initial['minimum-contrast'],
      overviewRulerWidth: 10,
      theme: theme(initial, colors),
      linkHandler: createOscLinkHandler()
    })

    const fit = new FitAddon()
    const searchAddon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT })
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.loadAddon(searchAddon)
    term.open(screen)

    const copyText = (text: string) => void Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => {})
    const openTarget = (target: string, reveal: boolean) => {
      void context
        .call('quirky.terminal/openExternal', reveal ? { target, reveal: true } : { target })
        .catch((error: unknown) => context.toast('Could not open link', messageOf(error)))
    }
    const showPopover = (kind: LinkKind, target: string, event: MouseEvent) => {
      const items: PopoverItem[] =
        kind === 'url'
          ? [
              { label: 'Open', run: () => openTarget(target, false) },
              { label: 'Copy Link', run: () => copyText(target) }
            ]
          : [
              { label: 'Open with Default App', run: () => openTarget(target, false) },
              { label: 'Reveal in Finder', run: () => openTarget(target, true) },
              { label: 'Copy Path', run: () => copyText(target) }
            ]
      setPopover({ x: event.clientX, y: event.clientY, items })
    }
    const activateLink = (kind: LinkKind, target: string, event: MouseEvent) => {
      if (term.hasSelection()) return
      const action = decideLinkClick(kind, event, latest.current.settings)
      if (action === 'none') return
      event.preventDefault()
      if (action === 'popover') showPopover(kind, target, event)
      else if (action === 'open') openTarget(target, false)
      else if (action === 'reveal') openTarget(target, true)
      else copyText(target)
    }
    const activateUri = (event: MouseEvent, uri: string) => {
      if (/^file:/i.test(uri)) {
        const path = guarded(() => decodeURIComponent(new URL(uri).pathname), '')
        if (path.startsWith('/')) activateLink('path', path, event)
      } else if (/^(https?|mailto):/i.test(uri)) {
        activateLink('url', uri, event)
      }
    }
    function createOscLinkHandler(): ILinkHandler {
      return {
        activate: (event, uri) => activateUri(event, uri),
        hover: (_event, uri) => setHint(uri),
        leave: () => setHint(null)
      }
    }

    term.loadAddon(new WebLinksAddon((event, uri) => activateLink('url', uri, event), { hover: (_event, uri) => setHint(uri), leave: () => setHint(null) }))
    const checker = new PathChecker(async (paths) => {
      const reply = (await context.call('quirky.terminal/pathsExist', { paths })) as { exists: boolean[] }
      return reply.exists
    })
    const linkProvider = term.registerLinkProvider(
      createFileLinkProvider(term, checker, {
        cwd: () => latest.current.cwd,
        hover: setHint,
        activate: (event, link) => activateLink('path', link.path, event)
      })
    )

    // xterm's clipboard addon takes the codec first at runtime although its typings list only the provider
    const ClipboardWithCodec = ClipboardAddon as unknown as new (base64: IBase64, provider: IClipboardProvider) => ITerminalAddon
    let osc52: ITerminalAddon[] | null = null
    const syncOsc52 = () => {
      const wanted = latest.current.settings['allow-osc52']
      if (wanted && !osc52) {
        osc52 = [
          new ClipboardWithCodec(createOsc52Base64(), createOsc52Provider((text) => navigator.clipboard?.writeText(text))),
          createOsc52QueryGuard()
        ]
        for (const addon of osc52) term.loadAddon(addon)
      } else if (!wanted && osc52) {
        for (const addon of osc52) addon.dispose()
        osc52 = null
      }
    }
    syncOsc52()

    const kitty = trackKittyFlags(term.parser)
    let optionSide: 'left' | 'right' | null = null
    const gate = createInputGate()
    let readOnly = false
    let disposed = false
    let streamId: number | null = null
    let unsubscribe: (() => void) | null = null
    const canSend = () => !readOnly && latest.current.interactive
    let inputClaim: Promise<void> | null = null
    let inputClaimAt = 0
    const claimUserInput = (): Promise<void> | null => {
      if (!canSend() || !gate.allows()) return null
      if (inputClaim) return inputClaim
      if (Date.now() - inputClaimAt < 30_000) return null
      const claim = (async () => {
        const identity = await context.call('quirky.session/identity', { session: sessionId }) as { processIncarnation: string; live: boolean }
        if (!identity.live || !identity.processIncarnation) throw new Error('Terminal process is no longer attached.')
        await context.call('quirky.terminal/userInput', { session: sessionId, expectedIncarnation: identity.processIncarnation })
        inputClaimAt = Date.now()
      })()
      inputClaim = claim
      void claim.then(
        () => { if (inputClaim === claim) inputClaim = null },
        (error: unknown) => {
          if (inputClaim === claim) inputClaim = null
          if (!disposed) context.toast('Input blocked', error instanceof Error ? error.message : String(error))
        }
      )
      return claim
    }
    const onInputIntent = () => { void claimUserInput()?.catch(() => {}) }
    const sendInput = (data: string) => {
      if (!canSend() || !gate.allows()) return
      const write = () => {
        if (!disposed && canSend() && gate.allows()) return context.call('quirky.terminal/write', { session: sessionId, data })
      }
      // onKey precedes xterm's corresponding onData synchronously. Query replies
      // emit only onData and never create human input evidence.
      if (inputClaim) void inputClaim.then(write).catch(() => {})
      else void write()?.catch(() => {})
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Alt') optionSide = event.type === 'keydown' ? (event.location === 1 ? 'left' : event.location === 2 ? 'right' : null) : null
      const action = resolveKeyAction(event, { kittyFlags: kitty.kitty.flags, optionAsAlt: latest.current.settings['option-as-alt'], optionSide })
      if (!action) return true
      event.preventDefault()
      if (action.type === 'send') {
        onInputIntent()
        sendInput(action.data)
      }
      else if (action.position === 'top') term.scrollToTop()
      else term.scrollToBottom()
      return false
    })
    term.onKey(onInputIntent)

    term.onData((data) => sendInput(latest.current.settings['jis-yen-backslash'] && data === '¥' ? '\\' : data))

    let pasteQueue: Promise<void> = Promise.resolve()
    const pasteNow = async (text: string) => {
      if (!canSend()) return
      const plan = planPaste(text, term.modes.bracketedPasteMode)
      if (plan.kind === 'refused') {
        context.toast('Paste is larger than 16 MiB', 'Nothing was pasted.')
        return
      }
      if (text.length === 0) return
      await claimUserInput()
      if (disposed || !canSend()) return
      const outcome = await runPaste(plan.chunks, (data) => context.call('quirky.terminal/write', { session: sessionId, data }), { closer: plan.closer })
      if (outcome === 'timeout') context.toast('Paste timed out', 'Only part of the text was pasted.')
      else if (outcome === 'failed') context.toast('Paste failed', 'The terminal stopped accepting input.')
    }
    const paste = (text: string) => {
      pasteQueue = pasteQueue.then(() => pasteNow(text), () => pasteNow(text))
      return pasteQueue
    }

    const selectionText = () => {
      const text = term.getSelection()
      return latest.current.settings['trim-gutter-on-copy'] ? trimGutter(text) : text
    }
    const copy = () => {
      if (!term.hasSelection()) return ''
      const text = selectionText()
      copyText(text)
      return text
    }

    const element = term.element!
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (term.textarea) term.textarea.value = ''
      void paste(event.clipboardData?.getData('text/plain') ?? '')
    }
    const onCopy = (event: ClipboardEvent) => {
      if (!term.hasSelection() || !event.clipboardData) return
      event.clipboardData.setData('text/plain', selectionText())
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    element.addEventListener('paste', onPaste, true)
    element.addEventListener('copy', onCopy, true)

    let selecting = false
    const onMouseDown = (event: MouseEvent) => {
      selecting = event.button === 0
      latest.current.onFocus?.()
    }
    const onMouseUp = () => {
      if (selecting && latest.current.settings['copy-on-select'] && term.hasSelection()) copy()
      selecting = false
    }
    const onContextMenu = (event: MouseEvent) => {
      if (!latest.current.settings['right-click-paste'] || event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve(navigator.clipboard?.readText())
        .then((text) => (text ? paste(text) : undefined))
        .catch(() => {})
    }
    const onMouseEnter = () => {
      if (latest.current.settings['focus-follows-mouse'] && !latest.current.suppressAutoFocus && !draggingRef.current) term.focus()
    }
    const onDragOver = (event: DragEvent) => {
      const types = Array.from(event.dataTransfer?.types ?? [])
      if (!types.includes('Files') && !types.includes('text/uri-list')) return
      event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return
      const paths = pathsFromDrop(event.dataTransfer)
      if (paths.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      onInputIntent()
      sendInput(shellEscapePaths(paths))
    }
    host.addEventListener('mousedown', onMouseDown, true)
    host.addEventListener('mouseup', onMouseUp)
    host.addEventListener('contextmenu', onContextMenu)
    host.addEventListener('mouseenter', onMouseEnter)
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    const textarea = term.textarea
    const owner = {}
    const onTextareaFocus = () => {
      focusOwner = owner
      context.setContext('terminalFocus', true)
      latest.current.onFocus?.()
    }
    const releaseFocusContext = () => {
      if (focusOwner !== owner) return
      focusOwner = null
      context.setContext('terminalFocus', false)
    }
    textarea?.addEventListener('focus', onTextareaFocus)
    // IME and virtual keyboards can commit text without onKey. Their real DOM
    // input intent is guarded before xterm's data callback; parser replies do
    // not dispatch these events.
    textarea?.addEventListener('compositionstart', onInputIntent, true)
    textarea?.addEventListener('input', onInputIntent, true)
    textarea?.addEventListener('blur', releaseFocusContext)

    let fitFrame = 0
    const doFit = () => {
      fitFrame = 0
      if (disposed || screen.clientWidth <= 0 || screen.clientHeight <= 0) return
      guarded(() => fit.fit(), undefined)
    }
    const scheduleFit = () => {
      if (fitFrame || disposed) return
      fitFrame = requestAnimationFrame(doFit)
    }
    let observedWidth = screen.clientWidth
    let observedHeight = screen.clientHeight
    const onScreenResize = () => {
      const width = screen.clientWidth
      const height = screen.clientHeight
      if (width === observedWidth && height === observedHeight) return
      observedWidth = width
      observedHeight = height
      scheduleFit()
    }
    const observer = new ResizeObserver(onScreenResize)
    observer.observe(screen)

    const reportSize = () => setView((now) => (now.cols === term.cols && now.rows === term.rows ? now : { ...now, cols: term.cols, rows: term.rows }))
    term.onResize(() => {
      reportSize()
      if (!draggingRef.current) sendResize()
    })

    const guard = new ContextLossGuard()
    const rt: Runtime = {
      term,
      fit,
      search: searchAddon,
      webgl: null,
      webglBlocked: false,
      paste,
      copy,
      scheduleFit,
      syncOsc52,
      setFont() {
        term.options.fontSize = effectiveFontSize()
        setView((now) => ({ ...now, fontSize: effectiveFontSize() }))
        scheduleFit()
      },
      refreshWebgl() {
        if (latest.current.settings['gpu-acceleration'] === 'off') disableWebgl()
        else enableWebgl()
      }
    }
    runtime.current = rt

    const disableWebgl = () => {
      if (!rt.webgl) return
      loseWebglContext(term.element)
      guarded(() => rt.webgl!.dispose(), undefined)
      rt.webgl = null
      webglBudget.release()
      setView((now) => ({ ...now, webgl: false }))
    }
    const enableWebgl = () => {
      if (rt.webgl || rt.webglBlocked || latest.current.settings['gpu-acceleration'] === 'off' || !webglBudget.tryAcquire()) return
      try {
        const addon = (latest.current.createWebgl ?? (() => new WebglAddon()))()
        term.loadAddon(addon)
        addon.onContextLoss(() => {
          if (rt.webgl !== addon) return
          disableWebgl()
          if (guard.record()) rt.webglBlocked = true
          else enableWebgl()
        })
        rt.webgl = addon
        setView((now) => ({ ...now, webgl: true }))
      } catch {
        webglBudget.release()
      }
    }
    enableWebgl()

    searchAddon.onDidChangeResults((event) => setResults({ index: event.resultIndex ?? -1, count: event.resultCount ?? 0 }))

    guarded(() => fit.fit(), undefined)
    reportSize()
    setView((now) => ({ ...now, fontSize: effectiveFontSize() }))
    sentSize.current = { cols: term.cols, rows: term.rows }

    const detach = (id: number) => void context.call('quirky.terminal/detach', { streamId: id }).catch(() => {})
    context
      .call('quirky.terminal/attach', { session: sessionId, cols: term.cols, rows: term.rows, historyLines: initial.scrollback })
      .then((value) => {
        const result = value as { streamId: number; replay: string; live?: boolean }
        if (disposed) {
          detach(result.streamId)
          return
        }
        streamId = result.streamId
        writeReplay(term, base64ToBytes(result.replay), gate)
        if (result.live === false) {
          readOnly = true
          return
        }
        unsubscribe = context.onStream(result.streamId, (bytes) => term.write(bytes))
      })
      .catch((error: Error) => {
        if (!disposed) term.write(`\r\n\x1b[31mCould not attach: ${error.message}\x1b[0m\r\n`)
      })

    let appliedColors = colors
    const applyTheme = () => {
      if (disposed) return
      const next = readTerminalColors(colorSource)
      if (next.background === appliedColors.background && next.foreground === appliedColors.foreground && next.cursor === appliedColors.cursor) return
      appliedColors = next
      term.options.theme = theme(latest.current.settings, next)
      host.style.background = withAlpha(next.background, alpha(latest.current.settings))
    }
    host.style.background = withAlpha(colors.background, alpha(initial))
    // the shell writes the new theme's variables after its own async refresh, later than theme.changed arrives
    const themeObserver = new MutationObserver(applyTheme)
    themeObserver.observe(host.ownerDocument.documentElement, { attributes: true })
    themeObserver.observe(colorSource, { attributes: true })
    const unsubscribeEvents = context.subscribe((event) => {
      if (event.type === 'theme.changed') applyTheme()
    })

    if (latest.current.active && !latest.current.suppressAutoFocus) term.focus()

    return () => {
      disposed = true
      runtime.current = null
      if (fitFrame) cancelAnimationFrame(fitFrame)
      themeObserver.disconnect()
      observer.disconnect()
      unsubscribeEvents()
      unsubscribe?.()
      if (streamId !== null) detach(streamId)
      releaseFocusContext()
      textarea?.removeEventListener('focus', onTextareaFocus)
      textarea?.removeEventListener('blur', releaseFocusContext)
      textarea?.removeEventListener('compositionstart', onInputIntent, true)
      textarea?.removeEventListener('input', onInputIntent, true)
      element.removeEventListener('paste', onPaste, true)
      element.removeEventListener('copy', onCopy, true)
      host.removeEventListener('mousedown', onMouseDown, true)
      host.removeEventListener('mouseup', onMouseUp)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('mouseenter', onMouseEnter)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      linkProvider.dispose()
      kitty.dispose()
      disableWebgl()
      guarded(() => term.dispose(), undefined)
    }
  }, [context, sessionId, themeSource, sendResize])

  useEffect(() => {
    const rt = runtime.current
    if (!rt) return
    const { term } = rt
    term.options.fontFamily = fontStack(settings['font-family'])
    term.options.fontWeight = settings['font-weight']
    term.options.fontWeightBold = settings['font-weight-bold']
    term.options.lineHeight = settings['line-height']
    rt.scheduleFit()
  }, [settings['font-family'], settings['font-weight'], settings['font-weight-bold'], settings['line-height']])

  useEffect(() => {
    const rt = runtime.current
    if (!rt) return
    rt.setFont()
  }, [settings['font-size']])

  useEffect(() => {
    const rt = runtime.current
    if (!rt) return
    const { term } = rt
    term.options.cursorStyle = settings['cursor-style']
    term.options.cursorBlink = settings['cursor-blink']
    term.options.scrollback = settings.scrollback
    term.options.wordSeparator = settings['word-separators']
    term.options.macOptionIsMeta = settings['option-as-alt'] === 'both'
    term.options.scrollSensitivity = settings['scroll-sensitivity']
    term.options.fastScrollSensitivity = settings['fast-scroll-sensitivity']
    term.options.minimumContrastRatio = settings['minimum-contrast']
  }, [
    settings['cursor-style'],
    settings['cursor-blink'],
    settings.scrollback,
    settings['word-separators'],
    settings['option-as-alt'],
    settings['scroll-sensitivity'],
    settings['fast-scroll-sensitivity'],
    settings['minimum-contrast']
  ])

  useEffect(() => {
    const rt = runtime.current
    const host = hostRef.current
    if (!rt || !host) return
    const colors = readTerminalColors(themeSource ?? host.ownerDocument.documentElement)
    const opacity = settings['background-opacity']
    if (opacity < 1) rt.term.options.allowTransparency = true
    rt.term.options.theme = { background: withAlpha(colors.background, opacity), foreground: colors.foreground, cursor: colors.cursor }
    host.style.background = withAlpha(colors.background, opacity)
  }, [settings['background-opacity'], themeSource])

  useEffect(() => {
    runtime.current?.scheduleFit()
  }, [settings['padding-x'], settings['padding-y']])

  useEffect(() => {
    runtime.current?.refreshWebgl()
  }, [settings['gpu-acceleration']])

  useEffect(() => {
    runtime.current?.syncOsc52()
  }, [settings['allow-osc52']])

  useEffect(() => {
    if (active && !suppressAutoFocus) runtime.current?.term.focus()
  }, [active, suppressAutoFocus])

  const wasDragging = useRef(dragging)
  useEffect(() => {
    if (wasDragging.current && !dragging) {
      const rt = runtime.current
      const screen = screenRef.current
      if (rt) {
        if (screen && screen.clientWidth > 0 && screen.clientHeight > 0) guarded(() => rt.fit.fit(), undefined)
        sendResize()
      }
    }
    wasDragging.current = dragging
  }, [dragging, sendResize])

  const searchReport: PaneSearchReport | null = search
    ? {
        query: search.query,
        regex: search.regex,
        caseSensitive: search.caseSensitive,
        current: search.query && results.index >= 0 ? results.index + 1 : 0,
        total: search.query ? results.count : 0,
        more: Boolean(search.query) && hasMore(results)
      }
    : null
  const report: PaneReport = { cols: view.cols, rows: view.rows, fontSize: view.fontSize, webgl: view.webgl, search: searchReport }
  const reportKey = JSON.stringify(report)
  useEffect(() => {
    latest.current.onState?.(JSON.parse(reportKey) as PaneReport)
  }, [reportKey])

  return (
    <div
      ref={hostRef}
      data-terminal-pane={sessionId}
      style={{ ...style.host, opacity: active ? 1 : settings['inactive-pane-opacity'] }}
    >
      <div
        ref={screenRef}
        style={{ ...style.screen, left: settings['padding-x'], right: settings['padding-x'], top: settings['padding-y'], bottom: settings['padding-y'] }}
      />
      {search ? (
        <SearchBox
          query={search.query}
          caseSensitive={search.caseSensitive}
          regex={search.regex}
          status={searchStatus(search, results)}
          inputRef={searchInputRef}
          onQueryChange={(query) => {
            if (query.length <= MAX_SEARCH_QUERY) applySearch({ ...search, query })
          }}
          onCaseSensitiveChange={(caseSensitive) => applySearch({ ...search, caseSensitive })}
          onRegexChange={(regex) => applySearch({ ...search, regex })}
          onNext={() => void runFind('next', false)}
          onPrevious={() => void runFind('previous', false)}
          onClose={closeSearch}
        />
      ) : null}
      {hint ? (
        <div data-pane-link-hint style={style.hint}>
          {hint}
        </div>
      ) : null}
      {popover ? <LinkPopover x={popover.x} y={popover.y} items={popover.items} onClose={() => setPopover(null)} /> : null}
    </div>
  )
}
