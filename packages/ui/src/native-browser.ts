import {
  NATIVE_BROWSER_LABEL_DOMAIN,
  NATIVE_BROWSER_NAVIGATION_RULES,
  NATIVE_BROWSER_PARTITION_RE,
  type NativeBrowserCapability,
  type NativeBrowserDownloadUpdate,
  type NativeBrowserHandle,
  type NativeBrowserOptions,
  type NativeBrowserPageAnswer,
  type NativeBrowserPageRequest,
  type NativeBrowserRequest,
  type NativeBrowserState
} from '@quirky/protocol'

/** The native layer sits above host DOM; these masks keep standard overlays visible. */
/** Plugin-owned overlay elements may opt in with `data-quirky-native-mask`; standard ARIA overlays are masked too. */
export const NATIVE_BROWSER_DEFAULT_MASKS = ['[data-quirky-native-mask]', '[role="dialog"]', '[role="menu"]', '[role="listbox"]'] as const
const NATIVE_BROWSER_EVALUATION_SCRIPT_MAX_BYTES = 64 * 1024
const NATIVE_BROWSER_EVALUATION_RESULT_MAX_BYTES = 256 * 1024
const NATIVE_BROWSER_EVALUATION_MESSAGE_MAX_BYTES = NATIVE_BROWSER_EVALUATION_RESULT_MAX_BYTES * 6 + 4096
const NATIVE_BROWSER_EVALUATION_TIMEOUT_MS = 5000

export type NativeBrowserAdapterHandle = {
  request(request: NativeBrowserRequest): Promise<NativeBrowserState>
  evaluate(script: string): Promise<unknown>
  answer(id: string, answer: NativeBrowserPageAnswer): Promise<boolean>
  cancelDownload(id: string): Promise<boolean>
  dispose(): Promise<void>
}

export type NativeBrowserAdapter = {
  mount(
    element: HTMLElement,
    options: NativeBrowserOptions,
    afterDispose: Promise<void>,
    onState: (state: NativeBrowserState) => void
  ): NativeBrowserAdapterHandle
  readonly clearPartitionAvailable: boolean
  readonly pageRequestsAvailable: boolean
  clearPartition(partition: string): Promise<void>
}

export type NativeBrowserPageEvent =
  | { type: 'request'; request: NativeBrowserPageRequest }
  | { type: 'expired'; id: string }
  | { type: 'download'; update: NativeBrowserDownloadUpdate }

/** Storage members are optional so a shell served to an older desktop host keeps its safe refusal. */
export type NativeBrowserShellBridge = {
  claimNativeBrowserView(params: { viewId: number; owner: string; partition: string }): Promise<{ zoomFactor: number; pageRequests?: boolean }>
  setNativeBrowserZoom(params: { viewId: number; owner: string; level: number }): Promise<{ zoomFactor: number }>
  releaseNativeBrowserView(params: { viewId: number; owner: string }): Promise<{ released: true }>
  routeNativeBrowserLabels(params: { viewId: number; owner: string; port: number }): Promise<{ routed: boolean }>
  answerNativeBrowserRequest?(params: { viewId: number; owner: string; id: string; answer: NativeBrowserPageAnswer }): Promise<{ answered: boolean }>
  cancelNativeBrowserDownload?(params: { viewId: number; owner: string; id: string }): Promise<{ cancelled: boolean }>
  onNativeBrowserPageEvent?(listener: (viewId: number, event: NativeBrowserPageEvent) => void): () => void
  readonly clearPartitionAvailable?: boolean
  prepareNativeBrowserPartition?(params: { partition: string }): Promise<{ storageIdentifier: string | null }>
  clearNativeBrowserPartition?(params: { partition: string }): Promise<{ cleared: true }>
}

const NATIVE_CLEAR_UNAVAILABLE = 'Native browser profile clearing is unavailable: this desktop host cannot confirm native website-data removal (macOS 14 or later is required)'


type Mount = {
  adapterHandle: NativeBrowserAdapterHandle
  disposePromise?: Promise<void>
  disposed: boolean
  generation: number
  evaluations: Set<EvaluationCancellation>
  state: NativeBrowserState
  publicHandle: NativeBrowserHandle
}

type WebviewTag = HTMLElement & {
  webviewId: number | null
  on(name: string, listener: (event: CustomEvent) => void): void
  off(name: string, listener: (event: CustomEvent) => void): void
  loadURL(url: string): void
  reload(): void
  /** Absent on SDKs without cache-bypassing reload; resolves false where the renderer can't bypass its cache. */
  reloadIgnoringCache?(): Promise<boolean>
  supportsReloadIgnoringCache?(): Promise<boolean>
  goBack(): void
  goForward(): void
  canGoBack(): Promise<boolean>
  canGoForward(): Promise<boolean>
  executeJavascript(script: string): void
  syncDimensions(force?: boolean): void
}

type WebviewEventName =
  | 'will-navigate'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'dom-ready'
  | 'host-message'
  | 'load-started'
  | 'load-finished'
  | 'load-failed'
  | 'new-window-open'

type GuestStateMessage = {
  type: 'quirky-native-browser-state'
  url: string
  title: string
  loading: boolean
  findCurrent: number
  findTotal: number
}

type Waiter = {
  kind: 'navigation' | 'load' | 'stopped' | 'find'
  expectedUrl: string | null
  resolve(state: NativeBrowserState): void
  reject(error: Error): void
}
type NativeBrowserEvaluationMessage =
  | { type: 'quirky-native-browser-evaluation-result'; requestId: string; ok: true; resultJson: string }
  | { type: 'quirky-native-browser-evaluation-result'; requestId: string; ok: false; error: string }

type PendingNativeBrowserEvaluation = {
  child: WebviewTag | null
  documentRevision: number
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type EvaluationCancellation = { promise: Promise<never>; reject(error: Error): void }

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes++
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
    if (bytes > limit) return true
  }
  return false
}


function installNativeBrowserPreload(): void {
  let findText = ''
  let findCurrent = 0
  let findTotal = 0
  const NativePromise = Promise
  const nativePromiseResolve = NativePromise.resolve
  const nativePromiseThen = NativePromise.prototype.then
  const nativeEval = eval
  const nativeStringify = JSON.stringify
  const nativeApply = Reflect.apply
  const nativeGet = Reflect.get
  const nativeDefineProperty = Object.defineProperty
  const nativeString = String
  const nativeSlice = String.prototype.slice
  const nativeCharCodeAt = String.prototype.charCodeAt
  const nativeIsInteger = Number.isInteger
  const exceedsByteLimit = (value: string, limit: number): boolean => {
    let bytes = 0
    for (let index = 0; index < value.length; index++) {
      const code = nativeApply(nativeCharCodeAt, value, [index]) as number
      if (code <= 0x7f) bytes++
      else if (code <= 0x7ff) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = nativeApply(nativeCharCodeAt, value, [index + 1]) as number
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          index++
        } else bytes += 3
      } else bytes += 3
      if (bytes > limit) return true
    }
    return false
  }
  const truncateUtf8ByteLimit = (value: string, limit: number): string => {
    let bytes = 0
    let index = 0
    while (index < value.length) {
      const code = nativeApply(nativeCharCodeAt, value, [index]) as number
      let characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
      let codeUnits = 1
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = nativeApply(nativeCharCodeAt, value, [index + 1]) as number
        if (next >= 0xdc00 && next <= 0xdfff) {
          characterBytes = 4
          codeUnits = 2
        }
      }
      if (bytes + characterBytes > limit) break
      bytes += characterBytes
      index += codeUnits
    }
    return nativeApply(nativeSlice, value, [0, index]) as string
  }

  const send = () => {
    const sendToHost: unknown = Reflect.get(window, '__electrobunSendToHost')
    if (typeof sendToHost !== 'function') return
    sendToHost({
      type: 'quirky-native-browser-state',
      url: location.href,
      title: document.title || '',
      loading: document.readyState !== 'complete',
      findCurrent,
      findTotal
    })
  }
  const find = (rawText: unknown, forward: boolean) => {
    const query = String(rawText || '')
    const previous = query === findText ? findCurrent : 0
    const requested = forward ? previous + 1 : previous - 1
    findText = query
    findCurrent = 0
    findTotal = 0
    const selection = window.getSelection()
    selection?.removeAllRanges()
    let firstNode: Node | null = null
    let firstOffset = 0
    let firstLength = 0
    let lastNode: Node | null = null
    let lastOffset = 0
    let lastLength = 0
    let selectedNode: Node | null = null
    let selectedOffset = 0
    let selectedLength = 0
    if (query && document.body) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const parent = node.parentElement
        if (!parent || parent.closest('script,style,noscript,textarea,input,select,[contenteditable="true"],[hidden],[aria-hidden="true"]')) continue
        const source = node.nodeValue || ''
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(source))) {
          findTotal++
          if (!firstNode) {
            firstNode = node
            firstOffset = match.index
            firstLength = match[0].length
          }
          lastNode = node
          lastOffset = match.index
          lastLength = match[0].length
          if (findTotal === requested) {
            selectedNode = node
            selectedOffset = match.index
            selectedLength = match[0].length
          }
        }
      }
    }
    if (findTotal) {
      findCurrent = requested >= 1 && requested <= findTotal ? requested : forward ? 1 : findTotal
      if (findCurrent === 1) {
        selectedNode = firstNode
        selectedOffset = firstOffset
        selectedLength = firstLength
      } else if (findCurrent === findTotal) {
        selectedNode = lastNode
        selectedOffset = lastOffset
        selectedLength = lastLength
      }
      if (selectedNode) {
        // DOM ranges preserve framework-owned text nodes; inserting <mark> elements breaks later React updates.
        const range = document.createRange()
        range.setStart(selectedNode, selectedOffset)
        range.setEnd(selectedNode, selectedOffset + selectedLength)
        selection?.addRange(range)
        const rect = range.getBoundingClientRect()
        window.scrollBy(rect.left, rect.top - window.innerHeight / 2)
      }
    }
    send()
  }
  Object.defineProperty(window, '__quirkyNativeBrowserFind', { value: find, configurable: true })
  const sendEvaluation = (requestId: string, ok: boolean, payload: string) => {
    const sendToHost: unknown = nativeGet(window, '__electrobunSendToHost')
    if (typeof sendToHost !== 'function') return
    const message = ok
      ? { type: 'quirky-native-browser-evaluation-result', requestId, ok: true, resultJson: payload }
      : { type: 'quirky-native-browser-evaluation-result', requestId, ok: false, error: payload }
    const encoded = nativeStringify(message)
    if (typeof encoded !== 'string' || exceedsByteLimit(encoded, 256 * 1024 * 6 + 4096)) {
      const failure = { type: 'quirky-native-browser-evaluation-result', requestId, ok: false, error: 'native browser evaluation response exceeded byte limit' }
      nativeApply(sendToHost, window, [failure])
      return
    }
    nativeApply(sendToHost, window, [message])
  }
  const sendEvaluationError = (requestId: string, error: unknown) => {
    let text = 'native browser guest evaluation failed'
    try {
      const message = error && typeof error === 'object' ? nativeGet(error, 'message') : null
      const raw = typeof message === 'string' ? message : nativeString(error)
      text = truncateUtf8ByteLimit(raw, 1024)
    } catch {}
    try { sendEvaluation(requestId, false, text) } catch {}
  }
  const evaluateGuest = (requestId: string, source: string, resultLimit: number) => {
    if (typeof requestId !== 'string' || requestId.length > 128) return
    if (
      typeof source !== 'string' || exceedsByteLimit(source, 64 * 1024) ||
      !nativeIsInteger(resultLimit) || resultLimit < 1 || resultLimit > 256 * 1024
    ) {
      sendEvaluationError(requestId, 'native browser evaluation input exceeded its limit')
      return
    }
    let value: unknown
    try {
      value = nativeApply(nativeEval, undefined, [source])
    } catch (error) {
      sendEvaluationError(requestId, error)
      return
    }
    let promise: Promise<unknown>
    try {
      promise = nativeApply(nativePromiseResolve, NativePromise, [value]) as Promise<unknown>
      nativeApply(nativePromiseThen, promise, [
        (result: unknown) => {
          try {
            const encoded = nativeStringify(result)
            const resultJson = typeof encoded === 'string' ? encoded : 'null'
            if (exceedsByteLimit(resultJson, resultLimit)) {
              sendEvaluation(requestId, false, 'native browser evaluation result exceeded byte limit')
              return
            }
            sendEvaluation(requestId, true, resultJson)
          } catch (error) {
            sendEvaluationError(requestId, error)
          }
        },
        (error: unknown) => sendEvaluationError(requestId, error)
      ])
    } catch (error) {
      sendEvaluationError(requestId, error)
    }
  }
  try {
    nativeDefineProperty(window, '__quirkyNativeBrowserEvaluate', {
      value: evaluateGuest,
      configurable: false,
      enumerable: false,
      writable: false
    })
  } catch {}

  const observeTitle = () => {
    const title = document.querySelector('title')
    if (title) new MutationObserver(send).observe(title, { childList: true, characterData: true, subtree: true })
  }
  document.addEventListener('DOMContentLoaded', () => { observeTitle(); send() }, { once: true })
  document.addEventListener('readystatechange', send)
  window.addEventListener('load', send)
  window.addEventListener('pageshow', send)
  window.addEventListener('popstate', send)
  window.addEventListener('hashchange', send)
  send()
}

let pagePreload: string | undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function parseNativeBrowserEvaluationMessage(value: unknown): NativeBrowserEvaluationMessage | null {
  try {
    let message = value
    if (typeof message === 'string') {
      if (exceedsUtf8ByteLimit(message, NATIVE_BROWSER_EVALUATION_MESSAGE_MAX_BYTES)) return null
      message = JSON.parse(message)
    }
    if (!message || typeof message !== 'object') return null
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(message, key)
      return descriptor && 'value' in descriptor ? descriptor.value : undefined
    }
    const type = read('type')
    const requestId = read('requestId')
    const ok = read('ok')
    if (type !== 'quirky-native-browser-evaluation-result' || typeof requestId !== 'string' || requestId.length > 128) return null
    if (ok === true) {
      const resultJson = read('resultJson')
      if (typeof resultJson !== 'string' || exceedsUtf8ByteLimit(resultJson, NATIVE_BROWSER_EVALUATION_RESULT_MAX_BYTES)) return null
      return { type, requestId, ok, resultJson }
    }
    const error = read('error')
    if (ok !== false || typeof error !== 'string' || exceedsUtf8ByteLimit(error, 1024)) return null
    return { type, requestId, ok, error }
  } catch {
    return null
  }
}


function allowedUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'about:') return url.href === 'about:blank'
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.username === '' && url.password === ''
  return url.protocol === 'file:'
}

function levelIsValid(level: number): boolean {
  return Number.isFinite(level) && level >= -3 && level <= 5 && Number.isInteger(level * 2)
}

function normalizeUrl(raw: string): string {
  return new URL(raw).href
}

function parseGuestState(value: unknown): GuestStateMessage | null {
  let message = value
  if (typeof value === 'string') {
    try {
      message = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!message || typeof message !== 'object') return null
  const state = message as Partial<GuestStateMessage>
  if (
    state.type !== 'quirky-native-browser-state' || typeof state.url !== 'string' || !allowedUrl(state.url) ||
    typeof state.title !== 'string' || typeof state.loading !== 'boolean' ||
    !Number.isInteger(state.findCurrent) || !Number.isInteger(state.findTotal) ||
    (state.findCurrent as number) < 0 || (state.findTotal as number) < 0 || (state.findCurrent as number) > (state.findTotal as number)
  ) return null
  return state as GuestStateMessage
}

function eventUrl(detail: unknown): string | null {
  const raw = typeof detail === 'string'
    ? detail
    : detail && typeof detail === 'object' && typeof (detail as { url?: unknown }).url === 'string'
      ? (detail as { url: string }).url
      : null
  return raw && allowedUrl(raw) ? normalizeUrl(raw) : null
}

type LoadFailure = { url: string; domain: string; code: number; description: string }

/** Ends a navigation without being a network or TLS failure: a stop, a supersession, or a download/policy hand-off. */
const NON_FAILURE_LOAD_ERRORS = new Set(['NSURLErrorDomain:-999', 'WebKitErrorDomain:102', 'WebKitErrorDomain:204'])

function parseLoadFailure(detail: unknown): LoadFailure | null {
  let value = detail
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const { url, domain, code, description } = value as Partial<LoadFailure>
  if (typeof url !== 'string' || !allowedUrl(url) || typeof domain !== 'string' || !Number.isSafeInteger(code)) return null
  if (NON_FAILURE_LOAD_ERRORS.has(`${domain}:${code}`)) return null
  return {
    url: normalizeUrl(url),
    domain: domain.slice(0, 128),
    code: code as number,
    description: typeof description === 'string' ? description.slice(0, 300) : ''
  }
}

/** Native will-navigate details are JSON strings carrying the target and whether policy allowed it. */
function allowedNavigationTarget(detail: unknown): string | null {
  let value = detail
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value && typeof value === 'object' && (value as { allowed?: unknown }).allowed === false) return null
  return eventUrl(value)
}

function createWebviewTag(): WebviewTag {
  return document.createElement('electrobun-webview') as WebviewTag
}

class ElectrobunNativeBrowserMount implements NativeBrowserAdapterHandle {
  private readonly owner = crypto.randomUUID()
  private child: WebviewTag | null = null
  private viewId: number | null = null
  private claimed = false
  private pageRequests = false
  private disposed = false
  private disposal: Promise<void> | undefined
  private ready: Promise<void>
  private state: NativeBrowserState
  private waiter: Waiter | null = null
  private eventHandlers: Array<[WebviewEventName, (event: CustomEvent) => void]> = []
  private stateRevision = 0
  private commandRevision = 0
  private expectedNavigation: string | null = null
  private navigationStarted = false
  private documentUrl = 'about:blank'
  private documentRevision = 0
  private navigationPending = false
  private labelProxyPort: number | null = null
  private navigationTarget: string | null = null
  private loadFailed = false
  private readonly pendingEvaluations = new Map<string, PendingNativeBrowserEvaluation>()

  constructor(
    private readonly element: HTMLElement,
    private readonly options: NativeBrowserOptions,
    private readonly bridge: NativeBrowserShellBridge,
    afterDispose: Promise<void>,
    private readonly report: (state: NativeBrowserState) => void
  ) {
    this.state = {
      id: options.id,
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoom: options.zoom,
      error: null,
      findCurrent: 0,
      findTotal: 0,
      hardReloadAvailable: false
    }
    this.ready = this.start(afterDispose)
    void this.ready.catch((error) => {
      this.setState({ error: messageOf(error), loading: false })
      void this.dispose().catch(() => undefined)
    })
  }

  private setState(patch: Partial<NativeBrowserState>): NativeBrowserState {
    if (this.disposed) return this.state
    this.state = { ...this.state, ...patch }
    this.report({ ...this.state })
    return this.state
  }

  private async start(afterDispose: Promise<void>): Promise<void> {
    await afterDispose
    if (this.disposed) return
    // the profile's native store can only be chosen before its first view exists.
    await this.bridge.prepareNativeBrowserPartition?.({ partition: this.options.partition })
    if (this.disposed) return

    const child = createWebviewTag()
    this.child = child
    const masks = [...NATIVE_BROWSER_DEFAULT_MASKS, ...(this.options.masks ?? [])]
    child.setAttribute('sandbox', '')
    child.setAttribute('renderer', 'native')
    child.setAttribute('partition', this.options.partition)
    child.setAttribute('navigation-rules', JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
    child.setAttribute('masks', masks.join(','))
    child.setAttribute('preload', pagePreload ??= `(${installNativeBrowserPreload.toString()})()`)
    // SDK webviewTagInit does not apply constructor navigationRules to the native view.
    // Start only on inert about:blank; the trusted main claim installs and verifies policy before target navigation.
    child.setAttribute('src', 'about:blank')
    child.style.display = 'block'
    child.style.width = '100%'
    child.style.height = '100%'
    child.style.border = '0'
    this.listen(child)
    this.element.append(child)
    child.syncDimensions(true)

    const viewId = await this.waitForViewId(child)
    if (viewId === null || this.disposed) return
    this.viewId = viewId
    const claim = await this.bridge.claimNativeBrowserView({ viewId, owner: this.owner, partition: this.options.partition })
    this.claimed = true
    this.listenForPageEvents(viewId, claim.pageRequests === true)
    if (this.disposed) {
      await this.releaseClaim()
      return
    }
    const initialZoom = await this.bridge.setNativeBrowserZoom({ viewId, owner: this.owner, level: this.options.zoom })
    if (this.disposed) {
      await this.releaseClaim()
      return
    }
    const actualLevel = Math.round(Math.log(initialZoom.zoomFactor) / Math.log(1.2) * 2) / 2
    const hardReloadAvailable = await child.supportsReloadIgnoringCache?.().catch(() => false) === true
    if (this.disposed) {
      await this.releaseClaim()
      return
    }
    this.setState({ zoom: actualLevel, error: null, hardReloadAvailable })
    if (this.options.url !== 'about:blank') await this.navigateTo(this.options.url)
    else this.setState({ url: 'about:blank', loading: false })
  }

  private waitForViewId(child: WebviewTag): Promise<number | null> {
    if (child.webviewId !== null) return Promise.resolve(child.webviewId)
    const { promise, resolve } = Promise.withResolvers<number | null>()
    let frame = 0
    let settled = false
    const finish = (viewId: number | null) => {
      if (settled) return
      settled = true
      if (frame) cancelAnimationFrame(frame)
      resolve(viewId)
    }
    const poll = () => {
      if (this.disposed) {
        finish(null)
        return
      }
      if (child.webviewId !== null) {
        finish(child.webviewId)
        return
      }
      frame = requestAnimationFrame(poll)
    }
    frame = requestAnimationFrame(poll)
    this.onDispose(() => finish(null))
    return promise
  }

  private onDispose(cleanup: () => void): void {
    this.disposeCleanups.add(cleanup)
  }

  private readonly disposeCleanups = new Set<() => void>()

  private listen(child: WebviewTag): void {
    const listen = (name: WebviewEventName, handler: (event: CustomEvent) => void) => {
      child.on(name, handler)
      this.eventHandlers.push([name, handler])
    }
    listen('load-started', () => {
      if (!this.navigationPending) {
        this.navigationPending = true
        this.invalidateEvaluations('native browser evaluation was cancelled by navigation')
      }
      this.loadFailed = false
      this.setState({ loading: true, error: null })
    })
    listen('load-failed', (event) => this.onLoadFailed(event.detail))
    listen('load-finished', () => {
      this.navigationPending = false
      this.setState({ loading: false })
      void this.refreshHistory()
    })
    listen('will-navigate', (event) => this.onWillNavigate(event.detail))
    listen('did-navigate', (event) => this.onNavigation(event.detail, true))
    listen('did-navigate-in-page', (event) => this.onNavigation(event.detail, true))
    listen('dom-ready', (event) => this.onNavigation(event.detail))
    listen('host-message', (event) => this.onHostMessage(event.detail))
    listen('new-window-open', (event) => this.onPopup(event.detail))
  }

  private listenForPageEvents(viewId: number, enabled: boolean): void {
    const subscribe = this.bridge.onNativeBrowserPageEvent
    if (!enabled || !subscribe || !this.bridge.answerNativeBrowserRequest) return
    this.pageRequests = true
    const unsubscribe = subscribe((eventViewId, event) => {
      if (this.disposed || eventViewId !== viewId) return
      if (event.type === 'expired') this.options.onPageRequestExpired?.(event.id)
      else if (event.type === 'download') this.options.onDownload?.(event.update)
      else if (this.options.onPageRequest) this.options.onPageRequest(event.request)
      else void this.answer(event.request.id, { accept: false }).catch(() => undefined)
    })
    this.onDispose(unsubscribe)
  }

  async answer(id: string, answer: NativeBrowserPageAnswer): Promise<boolean> {
    const viewId = this.viewId
    if (this.disposed || !this.pageRequests || viewId === null || !this.bridge.answerNativeBrowserRequest) return false
    return (await this.bridge.answerNativeBrowserRequest({ viewId, owner: this.owner, id, answer })).answered
  }

  async cancelDownload(id: string): Promise<boolean> {
    const viewId = this.viewId
    if (this.disposed || !this.pageRequests || viewId === null || !this.bridge.cancelNativeBrowserDownload) return false
    return (await this.bridge.cancelNativeBrowserDownload({ viewId, owner: this.owner, id })).cancelled
  }

  private invalidateEvaluations(reason: string): void {
    this.documentRevision++
    for (const [requestId, pending] of this.pendingEvaluations) {
      this.pendingEvaluations.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
  }

  private settleEvaluation(
    requestId: string,
    result: { ok: true; value: unknown } | { ok: false; error: Error }
  ): void {
    const pending = this.pendingEvaluations.get(requestId)
    if (!pending) return
    this.pendingEvaluations.delete(requestId)
    clearTimeout(pending.timer)
    if (this.disposed || (pending.child !== null && pending.child !== this.child)) {
      pending.reject(new Error('native browser view is disposed'))
      return
    }
    if (pending.documentRevision !== this.documentRevision || this.navigationPending) {
      pending.reject(new Error('native browser evaluation was cancelled by navigation'))
      return
    }
    if (result.ok) pending.resolve(result.value)
    else pending.reject(result.error)
  }

  private onHostMessage(detail: unknown): void {
    if (typeof detail === 'string' && exceedsUtf8ByteLimit(detail, NATIVE_BROWSER_EVALUATION_MESSAGE_MAX_BYTES)) return
    const message = parseNativeBrowserEvaluationMessage(detail)
    if (message?.ok) {
      try {
        this.settleEvaluation(message.requestId, { ok: true, value: JSON.parse(message.resultJson) })
      } catch {
        this.settleEvaluation(message.requestId, { ok: false, error: new Error('native browser evaluation returned invalid JSON') })
      }
    } else if (message) {
      this.settleEvaluation(message.requestId, { ok: false, error: new Error(message.error) })
    }
    this.onGuestState(detail)
  }

  private onWillNavigate(detail: unknown): void {
    if (!this.navigationPending) {
      this.navigationPending = true
      this.invalidateEvaluations('native browser evaluation was cancelled by navigation')
    }
    const target = allowedNavigationTarget(detail)
    if (target) {
      this.navigationTarget = target
      this.loadFailed = false
    }
    const url = eventUrl(detail)
    if (!url) return
    if (this.expectedNavigation !== null) {
      if (url === this.expectedNavigation) {
        this.navigationStarted = true
        if (this.waiter?.kind === 'navigation') this.waiter.expectedUrl = url
      }
      else if (!this.navigationStarted) return
      else if (this.waiter?.kind === 'navigation') this.waiter.expectedUrl = url
    }
    this.setState({ url, loading: true, error: null, findCurrent: 0, findTotal: 0 })
  }

  private onNavigation(detail: unknown, navigationCommit = false): void {
    const url = eventUrl(detail)
    if (!url || (this.expectedNavigation !== null && url !== this.expectedNavigation && !this.navigationStarted)) return
    if (this.expectedNavigation !== null && url !== this.expectedNavigation && this.waiter?.kind === 'navigation') {
      this.waiter.expectedUrl = url
    }
    if (this.navigationPending || navigationCommit || url !== this.documentUrl) {
      this.invalidateEvaluations('native browser evaluation was cancelled by navigation')
      this.navigationPending = false
    }
    this.expectedNavigation = null
    this.navigationStarted = false
    this.navigationTarget = null
    this.loadFailed = false
    this.documentUrl = url
    this.setState({ url, loading: false, error: null, findCurrent: 0, findTotal: 0 })
    void this.refreshHistory()
  }

  /** Only a failure of the navigation this view is currently waiting on may replace its state. */
  private onLoadFailed(detail: unknown): void {
    const failure = parseLoadFailure(detail)
    if (!failure) return
    if (failure.url !== this.expectedNavigation && failure.url !== this.navigationTarget && failure.url !== this.state.url) return
    this.navigationPending = false
    this.expectedNavigation = null
    this.navigationStarted = false
    this.navigationTarget = null
    this.loadFailed = true
    const reason = failure.description || 'The page could not be loaded.'
    this.setState({ url: failure.url, loading: false, error: `${reason} (${failure.domain} ${failure.code})`, findCurrent: 0, findTotal: 0 })
    if (this.waiter?.kind !== 'find') this.cancelWaiter()
    void this.refreshHistory()
  }

  private onGuestState(detail: unknown): void {
    const guest = parseGuestState(detail)
    if (!guest || this.loadFailed) return
    const url = normalizeUrl(guest.url)
    if (url !== this.documentUrl || this.navigationPending) return
    const state = this.setState({
      url: this.documentUrl,
      title: guest.title,
      loading: guest.loading,
      findCurrent: guest.findCurrent,
      findTotal: guest.findTotal
    })
    if (!guest.loading) this.resolveWaiter('stopped')
    this.resolveWaiter('find')
    void this.refreshHistory(state)
  }

  private onPopup(detail: unknown): void {
    if (!this.options.onPopup) return
    let data = detail
    if (typeof detail === 'string') {
      try {
        data = JSON.parse(detail)
      } catch {
        data = detail
      }
    }
    const value = data && typeof data === 'object' ? data as { url?: unknown; userGesture?: unknown } : null
    const url = typeof data === 'string' ? data : typeof value?.url === 'string' ? value.url : null
    if (url) this.options.onPopup(url, value?.userGesture === true)
  }

  private async refreshHistory(base = this.state): Promise<NativeBrowserState> {
    const child = this.child
    if (!child || this.disposed) return this.state
    const revision = ++this.stateRevision
    try {
      const [canGoBack, canGoForward] = await Promise.all([child.canGoBack(), child.canGoForward()])
      if (this.disposed || revision !== this.stateRevision) return this.state
      const state = this.setState({ ...base, canGoBack, canGoForward })
      this.resolveWaiter('navigation')
      this.resolveWaiter('load')
      return state
    } catch (error) {
      if (this.disposed || revision !== this.stateRevision) return this.state
      const state = this.setState({ ...base, error: messageOf(error) })
      this.resolveWaiter('navigation')
      this.resolveWaiter('load')
      return state
    }
  }

  private wait(kind: Waiter['kind'], expectedUrl: string | null = null): Promise<NativeBrowserState> {
    const { promise, resolve, reject } = Promise.withResolvers<NativeBrowserState>()
    this.waiter = { kind, expectedUrl, resolve, reject }
    return promise
  }

  private resolveWaiter(kind: Waiter['kind']): void {
    const waiter = this.waiter
    if (!waiter || waiter.kind !== kind) return
    if (waiter.expectedUrl !== null && waiter.expectedUrl !== this.state.url) return
    this.waiter = null
    waiter.resolve({ ...this.state })
  }

  private cancelWaiter(): void {
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = null
    waiter.resolve({ ...this.state })
  }

  private async navigateTo(raw: string): Promise<NativeBrowserState> {
    const target = normalizeUrl(raw)
    this.requireChild()
    await this.routeLabel(new URL(target))
    const child = this.requireChild()
    this.expectedNavigation = target
    this.navigationStarted = false
    this.navigationTarget = null
    const completion = this.wait('navigation', target)
    child.loadURL(target)
    return completion
  }

  /** A label URL names the label proxy's port; the partition must send label hosts there before loading it. */
  private async routeLabel(url: URL): Promise<void> {
    if (!url.hostname.endsWith(`.${NATIVE_BROWSER_LABEL_DOMAIN}`) || this.viewId === null) return
    const port = Number(url.port || 80)
    if (this.labelProxyPort === port) return
    const { routed } = await this.bridge.routeNativeBrowserLabels({ viewId: this.viewId, owner: this.owner, port })
    if (!routed) throw new Error('Localhost worktree labels need macOS 14 or later in the Native pane; open the localhost address instead')
    this.labelProxyPort = port
  }

  private requireChild(): WebviewTag {
    if (this.disposed || !this.child || !this.claimed) throw new Error('native browser view is unavailable')
    return this.child
  }

  private async releaseClaim(): Promise<void> {
    if (!this.claimed || this.viewId === null) return
    this.claimed = false
    await this.bridge.releaseNativeBrowserView({ viewId: this.viewId, owner: this.owner })
  }

  evaluate(script: string): Promise<unknown> {
    if (typeof script !== 'string' || exceedsUtf8ByteLimit(script, NATIVE_BROWSER_EVALUATION_SCRIPT_MAX_BYTES)) {
      return Promise.reject(new Error('native browser evaluation script exceeded byte limit'))
    }
    if (this.disposed) return Promise.reject(new Error('native browser view is disposed'))
    if (this.navigationPending) return Promise.reject(new Error('native browser evaluation is unavailable during navigation'))
    const requestId = `${this.owner}:${crypto.randomUUID()}`
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.settleEvaluation(requestId, { ok: false, error: new Error('native browser evaluation timed out') })
    }, NATIVE_BROWSER_EVALUATION_TIMEOUT_MS)
    this.pendingEvaluations.set(requestId, {
      child: this.child,
      documentRevision: this.documentRevision,
      resolve,
      reject,
      timer
    })
    void this.ready.then(
      () => {
        try {
          const pending = this.pendingEvaluations.get(requestId)
          if (!pending) return
          if (this.disposed) {
            this.settleEvaluation(requestId, { ok: false, error: new Error('native browser view is disposed') })
            return
          }
          if (pending.documentRevision !== this.documentRevision || this.navigationPending) {
            this.settleEvaluation(requestId, { ok: false, error: new Error('native browser evaluation was cancelled by navigation') })
            return
          }
          const child = this.requireChild()
          if (pending.child !== null && pending.child !== child) {
            this.settleEvaluation(requestId, { ok: false, error: new Error('native browser view is disposed') })
            return
          }
          pending.child = child
          child.executeJavascript(
            `window.__quirkyNativeBrowserEvaluate?.(${JSON.stringify(requestId)},${JSON.stringify(script)},${NATIVE_BROWSER_EVALUATION_RESULT_MAX_BYTES})`
          )
        } catch (error) {
          this.settleEvaluation(requestId, { ok: false, error: new Error(messageOf(error)) })
        }
      },
      (error) => this.settleEvaluation(requestId, { ok: false, error: new Error(messageOf(error)) })
    )
    return promise
  }

  async request(request: NativeBrowserRequest): Promise<NativeBrowserState> {
    await this.ready
    if (this.disposed) throw new Error('native browser view is disposed')
    const child = this.requireChild()
    const generation = ++this.commandRevision
    this.cancelWaiter()
    this.expectedNavigation = null
    this.navigationStarted = false
    this.navigationTarget = null
    try {
      switch (request.action) {
        case 'navigate':
          await this.navigateTo(request.url)
          break
        case 'back': {
          if (!(await child.canGoBack())) return { ...this.state }
          const completion = this.wait('navigation')
          child.goBack()
          await completion
          break
        }
        case 'forward': {
          if (!(await child.canGoForward())) return { ...this.state }
          const completion = this.wait('navigation')
          child.goForward()
          await completion
          break
        }
        case 'reload': {
          const completion = this.wait('load')
          child.reload()
          await completion
          break
        }
        case 'hardReload': {
          const unavailable = 'Hard reload is unavailable in the native browser: this system webview has no cache-bypassing reload'
          if (!this.state.hardReloadAvailable || !child.reloadIgnoringCache) throw new Error(unavailable)
          const completion = this.wait('load')
          if (!(await child.reloadIgnoringCache())) {
            this.cancelWaiter()
            throw new Error(unavailable)
          }
          await completion
          break
        }
        case 'stop': {
          if (!this.state.loading) return { ...this.state }
          const completion = this.wait('stopped')
          child.executeJavascript('window.stop()')
          await completion
          break
        }
        case 'find': {
          const completion = this.wait('find')
          child.executeJavascript(`window.__quirkyNativeBrowserFind?.(${JSON.stringify(request.text)},${request.forward !== false})`)
          await completion
          break
        }
        case 'zoom': {
          const viewId = this.viewId
          if (viewId === null) throw new Error('native browser view is unavailable')
          const actual = await this.bridge.setNativeBrowserZoom({ viewId, owner: this.owner, level: request.level })
          const level = Math.round(Math.log(actual.zoomFactor) / Math.log(1.2) * 2) / 2
          this.setState({ zoom: level })
          break
        }
      }
      if (generation !== this.commandRevision) return { ...this.state }
      return { ...this.state }
    } catch (error) {
      if (generation === this.commandRevision && !this.disposed) this.setState({ error: messageOf(error), loading: false })
      throw error
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.invalidateEvaluations('native browser view is disposed')
    this.cancelWaiter()
    for (const cleanup of this.disposeCleanups) cleanup()
    this.disposeCleanups.clear()
    if (this.child) {
      for (const [name, handler] of this.eventHandlers) this.child.off(name, handler)
      this.eventHandlers = []
      this.child.remove()
    }
    this.disposal = this.ready
      .catch(() => undefined)
      .then(() => this.releaseClaim())
    return this.disposal
  }
}

/** State-aware wrapper enforcing URL/partition policy and one resident view per window. */
export function createNativeBrowserCapability(adapter?: NativeBrowserAdapter): NativeBrowserCapability {
  let current: Mount | null = null
  const available = adapter !== undefined

  let lastDispose: Promise<void> = Promise.resolve()
  const cancelEvaluations = (mount: Mount, reason: string) => {
    for (const evaluation of mount.evaluations) evaluation.reject(new Error(reason))
    mount.evaluations.clear()
  }
  const disposeMount = (mount: Mount): Promise<void> => {
    if (mount.disposePromise) return mount.disposePromise
    mount.disposed = true
    cancelEvaluations(mount, 'native browser handle is disposed')
    if (current === mount) current = null
    mount.disposePromise = mount.adapterHandle.dispose()
    lastDispose = mount.disposePromise
    return mount.disposePromise
  }

  return {
    available,
    clearPartitionAvailable: adapter?.clearPartitionAvailable === true,
    pageRequestsAvailable: adapter?.pageRequestsAvailable === true,
    mount(element, options) {
      if (!adapter) throw new Error('Native browser is unavailable outside the Quirky desktop app')
      if (!options.id || !allowedUrl(options.url)) throw new Error('unsupported native browser URL')
      if (!NATIVE_BROWSER_PARTITION_RE.test(options.partition)) throw new Error('unsupported browser partition')
      if (!levelIsValid(options.zoom)) throw new Error('invalid native browser zoom level')
      const previous = current
      const afterDispose = previous ? disposeMount(previous) : lastDispose
      const mount: Mount = {
        adapterHandle: undefined as unknown as NativeBrowserAdapterHandle,
        disposed: false,
        generation: 0,
        evaluations: new Set(),
        state: {
          id: options.id,
          url: 'about:blank',
          title: '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          zoom: options.zoom,
          error: null,
          findCurrent: 0,
          findTotal: 0,
          hardReloadAvailable: false
        },
        publicHandle: undefined as unknown as NativeBrowserHandle
      }
      const publish = (state: NativeBrowserState) => {
        if (mount.disposed || current !== mount) return
        if (state.url !== mount.state.url) {
          cancelEvaluations(mount, 'native browser evaluation was cancelled by navigation')
        }
        mount.state = { ...state }
        options.onState({ ...mount.state })
      }
      mount.adapterHandle = adapter.mount(element, options, afterDispose, publish)
      mount.publicHandle = {
        request: async (request) => {
          if (mount.disposed || current !== mount) throw new Error('native browser handle is disposed')
          if (request.action === 'navigate' && !allowedUrl(request.url)) throw new Error('unsupported native browser URL')
          if (request.action === 'zoom' && !levelIsValid(request.level)) throw new Error('invalid native browser zoom level')
          const generation = ++mount.generation
          const state = await mount.adapterHandle.request(request)
          if (mount.disposed || current !== mount) throw new Error('native browser handle is disposed')
          if (generation !== mount.generation) return { ...mount.state }
          if (state.url !== mount.state.url) {
            cancelEvaluations(mount, 'native browser evaluation was cancelled by navigation')
          }
          mount.state = { ...state }
          options.onState({ ...mount.state })
          return { ...mount.state }
        },
        evaluate: async (script) => {
          if (mount.disposed || current !== mount) throw new Error('native browser handle is disposed')
          if (typeof script !== 'string' || exceedsUtf8ByteLimit(script, NATIVE_BROWSER_EVALUATION_SCRIPT_MAX_BYTES)) {
            throw new Error('native browser evaluation script exceeded byte limit')
          }
          const cancellation = Promise.withResolvers<never>()
          const evaluation = { promise: cancellation.promise, reject: cancellation.reject }
          mount.evaluations.add(evaluation)
          try {
            const value = await Promise.race([mount.adapterHandle.evaluate(script), evaluation.promise])
            if (mount.disposed || current !== mount) throw new Error('native browser handle is disposed')
            return value
          } finally {
            mount.evaluations.delete(evaluation)
          }
        },
        answer: async (id, answer) => {
          if (mount.disposed || current !== mount) return false
          return await mount.adapterHandle.answer(id, answer)
        },
        cancelDownload: async (id) => {
          if (mount.disposed || current !== mount) return false
          return await mount.adapterHandle.cancelDownload(id)
        },
        dispose: () => {
          void disposeMount(mount).catch(() => undefined)
        }
      }
      current = mount
      return mount.publicHandle
    },
    async clearPartition(partition) {
      if (!NATIVE_BROWSER_PARTITION_RE.test(partition)) throw new Error('unsupported browser partition')
      if (!adapter) throw new Error('Native browser is unavailable outside the Quirky desktop app')
      if (!adapter.clearPartitionAvailable) throw new Error(NATIVE_CLEAR_UNAVAILABLE)
      await adapter.clearPartition(partition)
    }
  }
}

export function createElectrobunNativeBrowserAdapter(bridge: NativeBrowserShellBridge): NativeBrowserAdapter {
  const clear = bridge.clearPartitionAvailable === true ? bridge.clearNativeBrowserPartition : undefined
  return {
    clearPartitionAvailable: clear !== undefined,
    pageRequestsAvailable: typeof bridge.onNativeBrowserPageEvent === 'function' && typeof bridge.answerNativeBrowserRequest === 'function',
    mount: (element, options, afterDispose, onState) => new ElectrobunNativeBrowserMount(element, options, bridge, afterDispose, onState),
    async clearPartition(partition) {
      if (!NATIVE_BROWSER_PARTITION_RE.test(partition)) throw new Error('unsupported browser partition')
      if (!clear) throw new Error(NATIVE_CLEAR_UNAVAILABLE)
      const result = await clear.call(bridge, { partition })
      if (result?.cleared !== true) throw new Error('The desktop did not confirm native website-data removal.')
    }
  }
}

export function nativeBrowserCapabilityForWindow(): NativeBrowserCapability {
  if (typeof window === 'undefined' || !window.__quirkyNativeBrowserHost || !window.customElements?.get('electrobun-webview')) {
    return createNativeBrowserCapability()
  }
  return createNativeBrowserCapability(createElectrobunNativeBrowserAdapter(window.__quirkyNativeBrowserHost))
}

declare global {
  interface Window {
    __quirkyNativeBrowserHost?: NativeBrowserShellBridge
  }
}
