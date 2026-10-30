import { describe, expect, test } from 'bun:test'
import { NATIVE_BROWSER_NAVIGATION_RULES } from '@quirky/protocol'
import {
  NATIVE_REQUEST_TIMEOUT_MS,
  createNativeBrowserHandlers,
  isNativeBrowserNavigationAllowed,
  nativeBrowserPreloadSource,
  popupWindowTitle,
  type NativeBrowserHostDeps,
  type NativeBrowserLabelProxy,
  type NativeBrowserPageEvent,
  type NativeBrowserPopup,
  type NativeBrowserViewPort,
  type NativeRequestKind,
  type NativeRequestResponse
} from '../src/bun/native-browser'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const PARTITION = `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`

class BrowserViewModel implements NativeBrowserViewPort {
  readonly id: number
  readonly windowId: number
  readonly hostWebviewId: number
  readonly sandbox: boolean
  readonly partition: string
  readonly renderer: 'native' | 'cef'
  readonly allowedProtocols: { views: boolean; appData: boolean }
  url: string
  storageIdentifier: string | null
  navigationRules: string | null = null
  userAgent: string | null = null
  userAgentSupported = true
  zoom = 1
  removed = false
  calls: string[] = []

  constructor(options: {
    id: number
    windowId?: number
    hostWebviewId?: number
    sandbox?: boolean
    partition?: string
    renderer?: 'native' | 'cef'
    appData?: boolean
    url?: string
    storageIdentifier?: string | null
  }) {
    this.id = options.id
    this.windowId = options.windowId ?? 12
    this.hostWebviewId = options.hostWebviewId ?? 34
    this.sandbox = options.sandbox ?? true
    this.partition = options.partition ?? PARTITION
    this.renderer = options.renderer ?? 'native'
    this.allowedProtocols = { views: true, appData: options.appData ?? false }
    this.url = options.url ?? 'about:blank'
    this.storageIdentifier = options.storageIdentifier ?? null
  }

  setNavigationRules(rules: string[]): void {
    this.calls.push('policy')
    this.navigationRules = JSON.stringify(rules)
  }

  setUserAgent(userAgent: string | null): boolean {
    if (!this.userAgentSupported) return false
    this.calls.push(`userAgent:${userAgent}`)
    this.userAgent = userAgent
    return true
  }

  loadURL(url: string): void {
    if (this.navigationRules !== JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES)) throw new Error('navigation policy is not ready')
    if (!isNativeBrowserNavigationAllowed(url)) throw new Error('navigation denied')
    this.calls.push(`load:${url}`)
    this.url = url
  }

  setPageZoom(factor: number): void {
    this.calls.push('zoom')
    this.zoom = factor
  }

  getPageZoom(): number {
    return this.zoom
  }

  getStorageIdentifier(): string | null {
    return this.storageIdentifier
  }

  remove(): void {
    this.calls.push('remove')
    this.removed = true
  }
}

const UNSUPPORTED_STORAGE: NativeBrowserHostDeps['storage'] = {
  identifierFor: () => null,
  prepare: () => ({ storageIdentifier: null }),
  clear: () => { throw new Error('Native browser profile clearing is unavailable') }
}

function rig(views: BrowserViewModel[], storage = UNSUPPORTED_STORAGE, proxySupported = true) {
  const proxies: Array<[string, NativeBrowserLabelProxy]> = []
  const handlers = createNativeBrowserHandlers({
    getWindow: () => ({ id: 12, webview: { id: 34 } }),
    getView: (id) => views.find((view) => view.id === id && !view.removed),
    sessionProxy: { supported: () => proxySupported, set: (partition, proxy) => { proxies.push([partition, proxy]) } },
    storage,
    defaultUserAgent: () => DEFAULT_USER_AGENT
  })
  return { handlers, proxies }
}

describe('native browser host bridge model', () => {
  test('routes only the label domain of an owned view partition through the label proxy', async () => {
    const child = new BrowserViewModel({ id: 7 })
    const { handlers, proxies } = rig([child])
    await expect(handlers.routeLabels({ viewId: 7, owner: 'owner-a', port: 4100 })).rejects.toThrow('not owned')
    await handlers.claim({ viewId: 7, owner: 'owner-a', partition: PARTITION, userAgent: null })
    await expect(handlers.routeLabels({ viewId: 7, owner: 'owner-b', port: 4100 })).rejects.toThrow('not owned')
    await expect(handlers.routeLabels({ viewId: 7, owner: 'owner-a', port: 0 })).rejects.toThrow('port')
    expect(await handlers.routeLabels({ viewId: 7, owner: 'owner-a', port: 4100 })).toEqual({ routed: true })
    expect(proxies).toEqual([[PARTITION, { type: 'http', host: '127.0.0.1', port: 4100, matchDomains: ['quirky.localhost'] }]])
  })

  test('reports label routing unsupported instead of loading label hosts without the proxy', async () => {
    const child = new BrowserViewModel({ id: 7 })
    const { handlers, proxies } = rig([child], UNSUPPORTED_STORAGE, false)
    await handlers.claim({ viewId: 7, owner: 'owner-a', partition: PARTITION, userAgent: null })
    expect(await handlers.routeLabels({ viewId: 7, owner: 'owner-a', port: 4100 })).toEqual({ routed: false })
    expect(proxies).toEqual([])
  })

  test('uses fail-closed SDK rules for supported URL protocols', () => {
    for (const url of ['https://example.test/', 'http://127.0.0.1:3000/', 'file:///tmp/index.html', 'about:blank']) {
      expect(isNativeBrowserNavigationAllowed(url)).toBe(true)
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'views://app/index.html', 'appdata://private/file', 'mailto:test@example.test']) {
      expect(isNativeBrowserNavigationAllowed(url)).toBe(false)
    }
  })

  test('installs policy on an owned about:blank guest before any target load or zoom', async () => {
    const child = new BrowserViewModel({ id: 7 })
    const foreign = new BrowserViewModel({ id: 8, hostWebviewId: 99 })
    const { handlers } = rig([child, foreign])

    await expect(handlers.claim({ viewId: 8, owner: 'owner-a', partition: PARTITION, userAgent: null })).rejects.toBeInstanceOf(Error)
    expect(foreign.calls).toEqual([])

    const claim = await handlers.claim({ viewId: 7, owner: 'owner-a', partition: PARTITION, userAgent: null })
    expect(claim).toEqual({ zoomFactor: 1, pageRequests: false })
    expect(child.calls).toEqual(['policy'])
    expect(child.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
    expect(child.url).toBe('about:blank')
    child.loadURL('https://example.test/')
    expect(child.calls).toEqual(['policy', 'load:https://example.test/'])

    const zoom = await handlers.setZoom({ viewId: 7, owner: 'owner-a', level: 1.5 })
    expect(zoom.zoomFactor).toBeCloseTo(1.2 ** 1.5)
    expect(child.calls.at(-1)).toBe('zoom')
    await expect(handlers.setZoom({ viewId: 8, owner: 'owner-a', level: 2 })).rejects.toBeInstanceOf(Error)
    expect(foreign.calls).toEqual([])
  })

  test('rejects unsafe creation properties before policy or zoom is applied', async () => {
    for (const child of [
      new BrowserViewModel({ id: 1, sandbox: false }),
      new BrowserViewModel({ id: 2, partition: 'persist:default' }),
      new BrowserViewModel({ id: 3, appData: true }),
      new BrowserViewModel({ id: 4, renderer: 'cef' }),
      new BrowserViewModel({ id: 5, url: 'https://attacker.test/' })
    ]) {
      const { handlers } = rig([child])
      await expect(handlers.claim({ viewId: child.id, owner: `owner-${child.id}`, partition: PARTITION, userAgent: null })).rejects.toBeInstanceOf(Error)
      expect(child.calls).toEqual([])
    }
  })

  test('a second owner cannot claim a window until the current child is released', async () => {
    const first = new BrowserViewModel({ id: 10 })
    const second = new BrowserViewModel({ id: 11 })
    const { handlers } = rig([first, second])

    await handlers.claim({ viewId: 10, owner: 'first', partition: PARTITION, userAgent: null })
    await expect(handlers.claim({ viewId: 11, owner: 'second', partition: PARTITION, userAgent: null })).rejects.toBeInstanceOf(Error)
    expect(second.calls).toEqual([])
    await handlers.release({ viewId: 10, owner: 'first' })
    expect(first.removed).toBe(true)
    await handlers.claim({ viewId: 11, owner: 'second', partition: PARTITION, userAgent: null })
    expect(second.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
  })

  test('a child removed by the SDK cannot leave a stale window claim', async () => {
    const first = new BrowserViewModel({ id: 12 })
    const second = new BrowserViewModel({ id: 13 })
    const { handlers } = rig([first, second])

    await handlers.claim({ viewId: 12, owner: 'old-owner', partition: PARTITION, userAgent: null })
    first.remove()
    await handlers.claim({ viewId: 13, owner: 'new-owner', partition: PARTITION, userAgent: null })

    expect(second.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
    expect(first.removed).toBe(true)
  })


  test('a foreign owner cannot release another view', async () => {
    const child = new BrowserViewModel({ id: 17 })
    const { handlers } = rig([child])

    await handlers.claim({ viewId: 17, owner: 'actual-owner', partition: PARTITION, userAgent: null })
    await expect(handlers.release({ viewId: 17, owner: 'foreign-owner' })).rejects.toBeInstanceOf(Error)
    expect(child.removed).toBe(false)
    await handlers.release({ viewId: 17, owner: 'actual-owner' })
    expect(child.removed).toBe(true)
  })

  test('a view whose native store is not its profile store is never claimed', async () => {
    const identifier = '9B0C5E52-8F3A-4C1D-9E7B-2A6F4D8C1E35'
    const storage: NativeBrowserHostDeps['storage'] = { ...UNSUPPORTED_STORAGE, identifierFor: () => identifier }
    for (const child of [
      new BrowserViewModel({ id: 20 }),
      new BrowserViewModel({ id: 21, storageIdentifier: crypto.randomUUID() })
    ]) {
      const { handlers } = rig([child], storage)
      await expect(handlers.claim({ viewId: child.id, owner: 'owner', partition: PARTITION, userAgent: null })).rejects.toThrow(/not using its profile storage/)
      expect(child.calls).toEqual([])
    }

    const owned = new BrowserViewModel({ id: 22, storageIdentifier: identifier.toLowerCase() })
    const { handlers } = rig([owned], storage)
    await handlers.claim({ viewId: 22, owner: 'owner', partition: PARTITION, userAgent: null })
    expect(owned.calls).toEqual(['policy'])
  })

  test('prepare and clear go to the shared profile storage', async () => {
    const calls: string[] = []
    const { handlers } = rig([], {
      identifierFor: () => null,
      prepare: (partition) => { calls.push(`prepare:${partition}`); return { storageIdentifier: 'id' } },
      clear: (partition) => { calls.push(`clear:${partition}`); return { cleared: true } }
    })

    await expect(handlers.prepare({ partition: PARTITION })).resolves.toEqual({ storageIdentifier: 'id' })
    await expect(handlers.clear({ partition: PARTITION })).resolves.toEqual({ cleared: true })
    expect(calls).toEqual([`prepare:${PARTITION}`, `clear:${PARTITION}`])
  })

  test('the trusted preload learns whether native clears are confirmed', () => {
    const bundle = '(()=>{globalThis.seen=QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE})();'
    for (const available of [true, false]) {
      const scope: { seen?: boolean } = {}
      new Function('globalThis', nativeBrowserPreloadSource(bundle, available))(scope)
      expect(scope.seen).toBe(available)
    }
  })
})

/** Stands in for the patched SDK: records request opt-in and answers, and replays native events. */
class RequestingViewModel extends BrowserViewModel {
  handling: { kinds: NativeRequestKind[]; timeoutMs?: number } | null = null
  supported = true
  responses: Array<[number, NativeRequestResponse]> = []
  cancelled: number[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  setNativeRequestHandling(kinds: NativeRequestKind[], options?: { timeoutMs?: number }): boolean {
    if (!this.supported) return false
    this.handling = { kinds, ...options }
    return true
  }

  respondToNativeRequest(requestId: number, response: NativeRequestResponse): boolean {
    this.responses.push([requestId, response])
    return true
  }

  cancelDownload(downloadId: number): boolean {
    this.cancelled.push(downloadId)
    return true
  }

  on(name: string, handler: (event: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler])
  }

  emit(name: string, detail: Record<string, unknown>): void {
    for (const handler of this.listeners.get(name) ?? []) handler({ data: { detail } })
  }
}

function requestRig(view: RequestingViewModel, openPopup: (popup: NativeBrowserPopup) => boolean = () => true) {
  const sent: NativeBrowserPageEvent[] = []
  const popups: NativeBrowserPopup[] = []
  const handlers = createNativeBrowserHandlers({
    getWindow: () => ({ id: 12, webview: { id: 34 } }),
    getView: (id) => (view.id === id && !view.removed ? view : undefined),
    sessionProxy: { supported: () => false, set: () => undefined },
    storage: UNSUPPORTED_STORAGE,
    defaultUserAgent: () => DEFAULT_USER_AGENT,
    sendPageEvent: ({ viewId, event }) => {
      expect(viewId).toBe(view.id)
      sent.push(event)
    },
    openPopup: (popup) => {
      popups.push(popup)
      return openPopup(popup)
    }
  })
  return { handlers, sent, popups }
}

describe('native browser page requests', () => {
  test('a claim turns on every request kind with a deadline past the page prompt timeout', async () => {
    const view = new RequestingViewModel({ id: 40 })
    const { handlers } = requestRig(view)
    const claim = await handlers.claim({ viewId: 40, owner: 'owner', partition: PARTITION, userAgent: null })
    expect(claim.pageRequests).toBe(true)
    expect(view.handling).toEqual({
      kinds: ['dialogs', 'auth', 'certificates', 'downloads', 'popups', 'externalApps'],
      timeoutMs: NATIVE_REQUEST_TIMEOUT_MS
    })
    expect(NATIVE_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000)
  })

  test('an SDK without native request support keeps its defaults and reports unsupported', async () => {
    const view = new RequestingViewModel({ id: 41 })
    view.supported = false
    const { handlers, sent } = requestRig(view)
    expect((await handlers.claim({ viewId: 41, owner: 'owner', partition: PARTITION, userAgent: null })).pageRequests).toBe(false)
    view.emit('dialog-request', { requestId: 1, type: 'confirm', message: 'Sure?', origin: 'https://site.test' })
    expect(sent).toEqual([])
  })

  test('relays a dialog and answers it once through the owning claim', async () => {
    const view = new RequestingViewModel({ id: 42 })
    const { handlers, sent } = requestRig(view)
    await handlers.claim({ viewId: 42, owner: 'owner', partition: PARTITION, userAgent: null })
    view.emit('dialog-request', { requestId: 5, type: 'prompt', message: 'Name?', defaultText: 'x', origin: 'https://site.test', frameUrl: 'https://site.test/a', isMainFrame: true })
    expect(sent).toEqual([{ type: 'request', request: { id: '5', kind: 'prompt', origin: 'https://site.test', frameUrl: 'https://site.test/a', message: 'Name?', defaultText: 'x' } }])

    await expect(handlers.answer({ viewId: 42, owner: 'intruder', id: '5', answer: { accept: true } })).rejects.toBeInstanceOf(Error)
    expect(await handlers.answer({ viewId: 42, owner: 'owner', id: '5', answer: { accept: true, text: 'h\u00e9llo \u4e16\u754c', password: 'leak' } })).toEqual({ answered: true })
    expect(view.responses).toEqual([[5, { accept: true, text: 'h\u00e9llo \u4e16\u754c' }]])
    expect(await handlers.answer({ viewId: 42, owner: 'owner', id: '5', answer: { accept: true } })).toEqual({ answered: false })
    expect(view.responses).toHaveLength(1)
  })

  test('auth credentials reach only auth requests, and a malformed request fails closed', async () => {
    const view = new RequestingViewModel({ id: 43 })
    const { handlers, sent } = requestRig(view)
    await handlers.claim({ viewId: 43, owner: 'owner', partition: PARTITION, userAgent: null })
    view.emit('auth-request', { requestId: 6, origin: 'https://site.test', host: 'site.test', realm: 'R', isProxy: false, previousFailureCount: 0 })
    view.emit('dialog-request', { requestId: 7, type: 'beforeunload', origin: 'https://site.test' })
    expect(sent.map((event) => event.type === 'request' ? event.request.kind : event.type)).toEqual(['auth'])
    expect(view.responses).toEqual([[7, { accept: false }]])

    await handlers.answer({ viewId: 43, owner: 'owner', id: '6', answer: { accept: true, username: 'ada' } })
    expect(view.responses.at(-1)).toEqual([6, { accept: false }])
  })

  test('downloads take only an absolute destination and report progress under the request id', async () => {
    const view = new RequestingViewModel({ id: 44 })
    const { handlers, sent } = requestRig(view)
    await handlers.claim({ viewId: 44, owner: 'owner', partition: PARTITION, userAgent: null })
    view.emit('download-request', { requestId: 8, downloadId: 3, url: 'https://site.test/a.pdf', suggestedFilename: 'a.pdf', mimeType: 'application/pdf', expectedBytes: 10, origin: 'https://site.test' })
    view.emit('download-request', { requestId: 9, downloadId: 4, url: 'https://site.test/b.pdf', suggestedFilename: 'b.pdf', origin: 'https://site.test' })

    await handlers.answer({ viewId: 44, owner: 'owner', id: '8', answer: { accept: true, path: '/Users/ada/Downloads/a.pdf' } })
    await handlers.answer({ viewId: 44, owner: 'owner', id: '9', answer: { accept: true, path: 'relative/b.pdf' } })
    expect(view.responses).toEqual([[8, { accept: true, path: '/Users/ada/Downloads/a.pdf' }], [9, { accept: false }]])

    view.emit('download-progress', { id: 3, progress: 50, receivedBytes: 5, totalBytes: 10 })
    view.emit('download-progress', { id: 99, progress: 50, receivedBytes: 5, totalBytes: 10 })
    view.emit('download-completed', { id: 3, path: '/Users/ada/Downloads/a.pdf' })
    expect(sent.filter((event) => event.type === 'download')).toEqual([
      { type: 'download', update: { id: '8', state: 'progress', received: 5, total: 10 } },
      { type: 'download', update: { id: '8', state: 'completed', path: '/Users/ada/Downloads/a.pdf' } }
    ])
    expect(await handlers.cancelDownload({ viewId: 44, owner: 'owner', id: '8' })).toEqual({ cancelled: false })
    expect(await handlers.cancelDownload({ viewId: 44, owner: 'owner', id: '9' })).toEqual({ cancelled: true })
    expect(view.cancelled).toEqual([4])
  })

  test('an accepted popup is hosted by the opener partition and a refused one is declined', async () => {
    const view = new RequestingViewModel({ id: 45 })
    let host = true
    const { handlers, popups } = requestRig(view, () => host)
    await handlers.claim({ viewId: 45, owner: 'owner', partition: PARTITION, userAgent: null })
    view.emit('popup-request', { requestId: 10, url: 'https://accounts.test/oauth', method: 'POST', windowFeatures: { width: 480, height: null }, origin: 'https://site.test' })
    expect(await handlers.answer({ viewId: 45, owner: 'owner', id: '10', answer: { accept: true } })).toEqual({ answered: true })
    expect(popups).toEqual([{ requestId: 10, url: 'https://accounts.test/oauth', partition: PARTITION, width: 480, height: null }])
    expect(view.responses).toEqual([])

    host = false
    view.emit('popup-request', { requestId: 11, url: 'https://accounts.test/oauth', method: 'GET', windowFeatures: {}, origin: 'https://site.test' })
    expect(await handlers.answer({ viewId: 45, owner: 'owner', id: '11', answer: { accept: true } })).toEqual({ answered: false })
    expect(view.responses).toEqual([[11, { accept: false }]])
    expect(popupWindowTitle('https://accounts.test/oauth?state=1')).toBe('https://accounts.test')
  })

  test('expiry is relayed once, and requests for a released view are declined', async () => {
    const view = new RequestingViewModel({ id: 46 })
    const { handlers, sent } = requestRig(view)
    await handlers.claim({ viewId: 46, owner: 'owner', partition: PARTITION, userAgent: null })
    view.emit('dialog-request', { requestId: 12, type: 'confirm', message: 'Sure?', origin: 'https://site.test' })
    view.emit('native-request-expired', { requestId: 12, reason: 'timeout' })
    view.emit('native-request-expired', { requestId: 12, reason: 'timeout' })
    expect(sent.at(-1)).toEqual({ type: 'expired', id: '12' })
    expect(sent.filter((event) => event.type === 'expired')).toHaveLength(1)
    expect(await handlers.answer({ viewId: 46, owner: 'owner', id: '12', answer: { accept: true } })).toEqual({ answered: false })

    await handlers.release({ viewId: 46, owner: 'owner' })
    view.removed = false
    view.emit('dialog-request', { requestId: 13, type: 'alert', message: 'late', origin: 'https://site.test' })
    expect(view.responses).toEqual([[13, { accept: false }]])
  })

  test('a claim applies the identity user agent after policy and before any target navigation', async () => {
    const view = new BrowserViewModel({ id: 21 })
    const { handlers } = rig([view])
    const cleaned = `${DEFAULT_USER_AGENT} Test/1`

    await handlers.claim({ viewId: 21, owner: 'owner-ua', partition: PARTITION, userAgent: cleaned })

    expect(view.userAgent).toBe(cleaned)
    expect(view.calls).toEqual(['policy', `userAgent:${cleaned}`])
    expect(await handlers.defaultUserAgent()).toEqual({ userAgent: DEFAULT_USER_AGENT })
  })

  test('a null user agent leaves the engine default untouched', async () => {
    const view = new BrowserViewModel({ id: 22 })
    const { handlers } = rig([view])

    await handlers.claim({ viewId: 22, owner: 'owner-native', partition: PARTITION, userAgent: null })

    expect(view.userAgent).toBeNull()
    expect(view.calls).toEqual(['policy'])
  })

  test('a host that cannot override the user agent fails the claim instead of pretending', async () => {
    const view = new BrowserViewModel({ id: 23 })
    view.userAgentSupported = false
    const { handlers } = rig([view])

    await expect(handlers.claim({ viewId: 23, owner: 'owner-ua', partition: PARTITION, userAgent: DEFAULT_USER_AGENT }))
      .rejects.toThrow('native browser user agent override is unavailable on this platform')
    await expect(handlers.setZoom({ viewId: 23, owner: 'owner-ua', level: 0 })).rejects.toBeInstanceOf(Error)
  })

  test('a user agent with header-breaking characters is rejected before touching the view', async () => {
    const view = new BrowserViewModel({ id: 24 })
    const { handlers } = rig([view])

    await expect(handlers.claim({ viewId: 24, owner: 'owner-ua', partition: PARTITION, userAgent: 'UA\r\nX-Injected: 1' }))
      .rejects.toThrow('invalid native browser user agent')
    expect(view.calls).toEqual([])
  })
})
