import {
  NATIVE_BROWSER_NAVIGATION_RULES,
  NATIVE_BROWSER_PARTITION_RE,
  type NativeBrowserCapability,
  type NativeBrowserHandle,
  type NativeBrowserOptions,
  type NativeBrowserRequest,
  type NativeBrowserState
} from '@quirky/protocol'

/** The native layer sits above host DOM; these masks keep standard overlays visible. */
/** Plugin-owned overlay elements may opt in with `data-quirky-native-mask`; standard ARIA overlays are masked too. */
export const NATIVE_BROWSER_DEFAULT_MASKS = ['[data-quirky-native-mask]', '[role="dialog"]', '[role="menu"]', '[role="listbox"]'] as const

export type NativeBrowserAdapterHandle = {
  request(request: NativeBrowserRequest): Promise<NativeBrowserState>
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
  clearPartition(partition: string): Promise<void>
}

export type NativeBrowserShellBridge = {
  claimNativeBrowserView(params: { viewId: number; owner: string; partition: string }): Promise<{ zoomFactor: number }>
  setNativeBrowserZoom(params: { viewId: number; owner: string; level: number }): Promise<{ zoomFactor: number }>
  releaseNativeBrowserView(params: { viewId: number; owner: string }): Promise<{ released: true }>
}

type Mount = {
  adapterHandle: NativeBrowserAdapterHandle
  disposePromise?: Promise<void>
  disposed: boolean
  generation: number
  state: NativeBrowserState
  publicHandle: NativeBrowserHandle
}

type WebviewTag = HTMLElement & {
  webviewId: number | null
  on(name: string, listener: (event: CustomEvent) => void): void
  off(name: string, listener: (event: CustomEvent) => void): void
  loadURL(url: string): void
  reload(): void
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

function installNativeBrowserPreload(): void {
  let findText = ''
  let findCurrent = 0
  let findTotal = 0
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

function createWebviewTag(): WebviewTag {
  return document.createElement('electrobun-webview') as WebviewTag
}

class ElectrobunNativeBrowserMount implements NativeBrowserAdapterHandle {
  private readonly owner = crypto.randomUUID()
  private child: WebviewTag | null = null
  private viewId: number | null = null
  private claimed = false
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
      findTotal: 0
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
    await this.bridge.claimNativeBrowserView({ viewId, owner: this.owner, partition: this.options.partition })
    this.claimed = true
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
    this.setState({ zoom: actualLevel, error: null })
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
    listen('load-started', () => this.setState({ loading: true, error: null }))
    listen('load-finished', () => {
      this.setState({ loading: false })
      void this.refreshHistory()
    })
    listen('will-navigate', (event) => this.onWillNavigate(event.detail))
    listen('did-navigate', (event) => this.onNavigation(event.detail))
    listen('did-navigate-in-page', (event) => this.onNavigation(event.detail))
    listen('dom-ready', (event) => this.onNavigation(event.detail))
    listen('host-message', (event) => this.onGuestState(event.detail))
    listen('new-window-open', (event) => this.onPopup(event.detail))
  }

  private onWillNavigate(detail: unknown): void {
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

  private onNavigation(detail: unknown): void {
    const url = eventUrl(detail)
    if (!url || (this.expectedNavigation !== null && url !== this.expectedNavigation && !this.navigationStarted)) return
    if (this.expectedNavigation !== null && url !== this.expectedNavigation && this.waiter?.kind === 'navigation') {
      this.waiter.expectedUrl = url
    }
    this.expectedNavigation = null
    this.navigationStarted = false
    this.documentUrl = url
    this.setState({ url, loading: false, error: null, findCurrent: 0, findTotal: 0 })
    void this.refreshHistory()
  }

  private onGuestState(detail: unknown): void {
    const guest = parseGuestState(detail)
    if (!guest) return
    const url = normalizeUrl(guest.url)
    if (this.expectedNavigation !== null && url !== this.expectedNavigation) return
    if (this.expectedNavigation === url) {
      this.expectedNavigation = null
      this.navigationStarted = false
    } else if (url !== this.documentUrl) {
      return
    }
    this.documentUrl = url
    const state = this.setState({
      url,
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
    const child = this.requireChild()
    this.expectedNavigation = target
    this.navigationStarted = false
    const completion = this.wait('navigation', target)
    child.loadURL(target)
    return completion
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

  async request(request: NativeBrowserRequest): Promise<NativeBrowserState> {
    await this.ready
    if (this.disposed) throw new Error('native browser view is disposed')
    const child = this.requireChild()
    const generation = ++this.commandRevision
    this.cancelWaiter()
    this.expectedNavigation = null
    this.navigationStarted = false
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
        case 'hardReload':
          throw new Error('Hard reload is unavailable in the native browser: the pinned Electrobun SDK has no cache-bypassing reload operation')
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
  const disposeMount = (mount: Mount): Promise<void> => {
    if (mount.disposePromise) return mount.disposePromise
    mount.disposed = true
    if (current === mount) current = null
    mount.disposePromise = mount.adapterHandle.dispose()
    lastDispose = mount.disposePromise
    return mount.disposePromise
  }

  return {
    available,
    clearPartitionAvailable: adapter?.clearPartitionAvailable === true,
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
          findTotal: 0
        },
        publicHandle: undefined as unknown as NativeBrowserHandle
      }
      const publish = (state: NativeBrowserState) => {
        if (mount.disposed || current !== mount) return
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
          mount.state = { ...state }
          options.onState({ ...mount.state })
          return { ...mount.state }
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
      if (!adapter.clearPartitionAvailable) {
        throw new Error('Native browser profile clearing is unavailable: the pinned SDK exposes no completion signal for native website-data removal')
      }
      await adapter.clearPartition(partition)
    }
  }
}

export function createElectrobunNativeBrowserAdapter(bridge: NativeBrowserShellBridge): NativeBrowserAdapter {
  return {
    clearPartitionAvailable: false,
    mount: (element, options, afterDispose, onState) => new ElectrobunNativeBrowserMount(element, options, bridge, afterDispose, onState),
    async clearPartition(partition) {
      if (!NATIVE_BROWSER_PARTITION_RE.test(partition)) throw new Error('unsupported browser partition')
      throw new Error('Native browser profile clearing is unavailable: the pinned SDK exposes no completion signal for native website-data removal')
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
