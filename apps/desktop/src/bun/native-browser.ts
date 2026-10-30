import {
  NATIVE_BROWSER_LABEL_DOMAIN,
  NATIVE_BROWSER_NAVIGATION_RULES,
  NATIVE_BROWSER_PARTITION_RE,
  NATIVE_BROWSER_PREVIEW_NAVIGATION_RULES,
  NATIVE_BROWSER_PREVIEW_SCHEME,
  isNativeBrowserPreviewGrant,
  type NativeBrowserPreviewGrant,
  type DesktopRevealRequest,
  type DesktopRevealResult,
  type DesktopWindowCloseResult,
  type DesktopWindowOpenRequest,
  type DesktopWindowResult,
  type FolderPickerRequest,
  type FolderPickerResult,
  type NativeBrowserDownloadUpdate,
  type NativeBrowserPageAnswer,
  type NativeBrowserPageRequest
} from '@quirky/protocol'
import { isAbsolute } from 'node:path'
import type { NativeBrowserStorage } from './native-browser-storage'
import { createWorkspacePreviewHandler, type WorkspacePreviewHandler } from './workspace-preview'

export type NativeBrowserPageEvent =
  | { type: 'request'; request: NativeBrowserPageRequest }
  | { type: 'expired'; id: string }
  | { type: 'download'; update: NativeBrowserDownloadUpdate }

export type NativeBrowserHostRPC = {
  bun: {
    requests: {
      claimNativeBrowserView: {
        params: { viewId: number; owner: string; partition: string; preview?: NativeBrowserPreviewGrant }
        response: { zoomFactor: number; pageRequests: boolean }
      }
      answerNativeBrowserRequest: {
        params: { viewId: number; owner: string; id: string; answer: NativeBrowserPageAnswer }
        response: { answered: boolean }
      }
      cancelNativeBrowserDownload: {
        params: { viewId: number; owner: string; id: string }
        response: { cancelled: boolean }
      }
      setNativeBrowserZoom: {
        params: { viewId: number; owner: string; level: number }
        response: { zoomFactor: number }
      }
      releaseNativeBrowserView: {
        params: { viewId: number; owner: string }
        response: { released: true }
      }
      routeNativeBrowserLabels: {
        params: { viewId: number; owner: string; port: number }
        response: { routed: boolean }
      }
      prepareNativeBrowserPartition: {
        params: { partition: string }
        response: { storageIdentifier: string | null }
      }
      clearNativeBrowserPartition: {
        params: { partition: string }
        response: { cleared: true }
      }
      readClipboardText: { params: {}; response: string }
      pickFolder: { params: FolderPickerRequest; response: FolderPickerResult }
      openWindow: { params: DesktopWindowOpenRequest; response: DesktopWindowResult }
      closeWindow: { params: { windowId: string }; response: DesktopWindowCloseResult }
      revealItem: { params: DesktopRevealRequest; response: DesktopRevealResult }
      activateOwner: { params: { windowId: string }; response: { activated: boolean } }
      dropSourcePathsSupported: { params: {}; response: boolean }
    }
    messages: {}
  }
  webview: { requests: {}; messages: { dropSourcePaths: { paths: string[] }; nativeBrowserPageEvent: { viewId: number; event: NativeBrowserPageEvent } } }
}

export type NativeRequestKind = 'dialogs' | 'auth' | 'certificates' | 'downloads' | 'popups' | 'externalApps'
export type NativeRequestResponse = { accept: boolean; text?: string; username?: string; password?: string; path?: string }

export type NativeBrowserViewPort = {
  id: number
  windowId: number
  hostWebviewId?: number
  sandbox: boolean
  renderer: 'native' | 'cef'
  partition: string | null
  url: string | null
  navigationRules: string | null
  allowedProtocols: { views: boolean; appData: boolean }
  /** The scheme of an SDK isolated preview; absent on SDKs without isolated previews. */
  isolatedPreview?: string | null
  setIsolatedPreviewHandler?(handler: WorkspacePreviewHandler | null): void
  setNavigationRules(rules: string[]): void
  setPageZoom(factor: number): void
  getPageZoom(): number
  getStorageIdentifier(): string | null
  remove(): void
  /** Present on Electrobun builds with native page requests; false means the renderer keeps its defaults. */
  setNativeRequestHandling?(kinds: NativeRequestKind[], options?: { timeoutMs?: number }): boolean
  respondToNativeRequest?(requestId: number, response: NativeRequestResponse): boolean
  cancelDownload?(downloadId: number): boolean
  on?(name: string, handler: (event: unknown) => void): void
}

export type NativeBrowserLabelProxy = { type: 'http'; host: '127.0.0.1'; port: number; matchDomains: string[] }
export type NativeBrowserPopup = { requestId: number; url: string; partition: string; width: number | null; height: number | null }

export type NativeBrowserHostDeps = {
  getWindow(): { id: number; webview: { id: number } } | null
  getView(id: number): NativeBrowserViewPort | undefined
  /** The SDK's per-partition proxy; `supported` is false where the native engine can't route through one. */
  sessionProxy: { supported(): boolean; set(partition: string, proxy: NativeBrowserLabelProxy): void }
  sendPageEvent?(message: { viewId: number; event: NativeBrowserPageEvent }): void
  /** Adopts the parked popup into a host-owned window; resolves false when it could not be hosted. */
  openPopup?(popup: NativeBrowserPopup): boolean
  storage: Pick<NativeBrowserStorage, 'identifierFor' | 'prepare' | 'clear'>
  createPreviewHandler?(grant: NativeBrowserPreviewGrant): WorkspacePreviewHandler
}

export type NativeBrowserHandlers = {
  claim(params: NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['response']>
  setZoom(params: NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['params']): Promise<{ zoomFactor: number }>
  release(params: NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['params']): Promise<{ released: true }>
  routeLabels(params: NativeBrowserHostRPC['bun']['requests']['routeNativeBrowserLabels']['params']): Promise<{ routed: boolean }>
  answer(params: NativeBrowserHostRPC['bun']['requests']['answerNativeBrowserRequest']['params']): Promise<{ answered: boolean }>
  cancelDownload(params: NativeBrowserHostRPC['bun']['requests']['cancelNativeBrowserDownload']['params']): Promise<{ cancelled: boolean }>
  prepare(params: NativeBrowserHostRPC['bun']['requests']['prepareNativeBrowserPartition']['params']): Promise<{ storageIdentifier: string | null }>
  clear(params: NativeBrowserHostRPC['bun']['requests']['clearNativeBrowserPartition']['params']): Promise<{ cleared: true }>
  dispose(): void
}

/** Outlives the page's prompt deadline so the daemon's fail-closed answer normally lands first. */
export const NATIVE_REQUEST_TIMEOUT_MS = 125_000
const NATIVE_REQUEST_KINDS: NativeRequestKind[] = ['dialogs', 'auth', 'certificates', 'downloads', 'popups', 'externalApps']
const NATIVE_REQUEST_EVENTS = [
  'dialog-request', 'auth-request', 'certificate-request', 'download-request', 'popup-request', 'external-app-request',
  'native-request-expired', 'download-started', 'download-progress', 'download-completed', 'download-failed'
] as const
const TEXT_LIMIT = 4096

type PendingRequest = { kind: NativeBrowserPageRequest['kind']; popup?: NativeBrowserPopup }
type PageRequestSession = { viewId: number; pending: Map<number, PendingRequest>; downloads: Map<number, string> }

function detailOf(event: unknown): Record<string, unknown> | null {
  const detail = (event as { data?: { detail?: unknown } } | null)?.data?.detail
  return detail && typeof detail === 'object' ? detail as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

function dimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/** Maps SDK request detail onto the public request shape; anything malformed is declined by the caller. */
export function pageRequestFromDetail(name: string, detail: Record<string, unknown>): NativeBrowserPageRequest | null {
  const requestId = detail.requestId
  if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId <= 0) return null
  const id = String(requestId)
  const origin = text(detail.origin)
  switch (name) {
    case 'dialog-request': {
      const kind = detail.type
      if (kind !== 'alert' && kind !== 'confirm' && kind !== 'prompt') return null
      return {
        id, kind, origin, frameUrl: text(detail.frameUrl), message: text(detail.message),
        ...(kind === 'prompt' ? { defaultText: text(detail.defaultText) } : {})
      }
    }
    case 'auth-request':
      return { id, kind: 'auth', origin, host: text(detail.host), realm: text(detail.realm), isProxy: detail.isProxy === true, previousFailureCount: count(detail.previousFailureCount) }
    case 'certificate-request':
      return { id, kind: 'certificate', origin, host: text(detail.host), error: text(detail.error) }
    case 'external-app-request':
      return { id, kind: 'external', origin, url: text(detail.url), scheme: text(detail.scheme), userGesture: detail.isUserGesture === true }
    case 'download-request':
      return {
        id, kind: 'download', origin, url: text(detail.url), suggestedFilename: text(detail.suggestedFilename),
        mimeType: text(detail.mimeType), expectedBytes: count(detail.expectedBytes)
      }
    case 'popup-request': {
      const features = detail.windowFeatures && typeof detail.windowFeatures === 'object' ? detail.windowFeatures as Record<string, unknown> : {}
      return { id, kind: 'popup', origin, url: text(detail.url), method: text(detail.method) || 'GET', width: dimension(features.width), height: dimension(features.height) }
    }
    default:
      return null
  }
}

type Claim = { viewId: number; owner: string; partition: string; preview: boolean }

function invalidChild(): Error {
  return new Error('native browser view is not an owned sandboxed child')
}

/** An isolated preview child: the SDK's fences, not a browsing partition, define what it may reach. */
function isPreviewChild(view: NativeBrowserViewPort): boolean {
  return view.isolatedPreview === NATIVE_BROWSER_PREVIEW_SCHEME && typeof view.setIsolatedPreviewHandler === 'function'
}

function isZoomLevel(level: number): boolean {
  return Number.isFinite(level) && level >= -3 && level <= 5 && Number.isInteger(level * 2)
}

/** Checks safe schemes; the actual native policy is synchronously installed with SDK navigation rules. */
export function isNativeBrowserNavigationAllowed(raw: string): boolean {
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

/** A popup window's title is its origin, so the page cannot disguise where it is. */
export function popupWindowTitle(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin === 'null' ? url.protocol : url.origin
  } catch {
    return 'Popup'
  }
}

/** Prefixes the trusted shell preload with whether this host can confirm native profile clears. */
export function nativeBrowserPreloadSource(bundle: string, clearAvailable: boolean): string {
  return `const QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE = ${clearAvailable ? 'true' : 'false'};\n${bundle}`
}

/** Only the trusted BrowserWindow RPC may claim and zoom a native browser view. */
export function createNativeBrowserHandlers(deps: NativeBrowserHostDeps): NativeBrowserHandlers {
  let claim: Claim | null = null
  let session: PageRequestSession | null = null
  const subscribedViews = new Set<number>()

  const decline = (view: NativeBrowserViewPort, requestId: number) => {
    view.respondToNativeRequest?.(requestId, { accept: false })
  }

  const onViewEvent = (view: NativeBrowserViewPort, name: string, event: unknown) => {
    const detail = detailOf(event)
    if (!detail) return
    const active = session && session.viewId === view.id && claim?.viewId === view.id ? session : null
    const send = (pageEvent: NativeBrowserPageEvent) => deps.sendPageEvent?.({ viewId: view.id, event: pageEvent })
    if (name === 'native-request-expired') {
      const requestId = count(detail.requestId)
      if (!active?.pending.delete(requestId)) return
      send({ type: 'expired', id: String(requestId) })
      return
    }
    if (name.startsWith('download-') && name !== 'download-request') {
      const id = active?.downloads.get(count(detail.id))
      if (!id) return
      const state = name === 'download-started' ? 'started' : name === 'download-progress' ? 'progress' : name === 'download-completed' ? 'completed' : 'failed'
      if (state === 'completed' || state === 'failed') active?.downloads.delete(count(detail.id))
      send({
        type: 'download',
        update: {
          id, state,
          ...(typeof detail.path === 'string' && detail.path ? { path: detail.path } : {}),
          ...(state === 'progress' ? { received: Math.max(0, count(detail.receivedBytes)), ...(count(detail.totalBytes) > 0 ? { total: count(detail.totalBytes) } : {}) } : {}),
          ...(state === 'failed' ? { error: text(detail.error), cancelled: detail.cancelled === true } : {})
        }
      })
      return
    }
    const request = pageRequestFromDetail(name, detail)
    const requestId = count(detail.requestId)
    if (!request || !active || !deps.sendPageEvent) {
      if (requestId > 0) decline(view, requestId)
      return
    }
    active.pending.set(requestId, {
      kind: request.kind,
      ...(request.kind === 'popup'
        ? { popup: { requestId, url: request.url, partition: claim?.partition ?? '', width: request.width, height: request.height } }
        : {})
    })
    if (request.kind === 'download') active.downloads.set(count(detail.downloadId), request.id)
    send({ type: 'request', request })
  }

  /** Turns on every request kind for the claimed view; false keeps the SDK defaults and the observational popup path. */
  const enablePageRequests = (view: NativeBrowserViewPort): boolean => {
    if (!view.setNativeRequestHandling || !view.respondToNativeRequest || !view.on || !deps.sendPageEvent) return false
    if (!view.setNativeRequestHandling(NATIVE_REQUEST_KINDS, { timeoutMs: NATIVE_REQUEST_TIMEOUT_MS })) return false
    if (!subscribedViews.has(view.id)) {
      subscribedViews.add(view.id)
      for (const name of NATIVE_REQUEST_EVENTS) view.on(name, (event) => onViewEvent(view, name, event))
    }
    session = { viewId: view.id, pending: new Map(), downloads: new Map() }
    return true
  }

  const requestNumber = (id: string): number => {
    const value = Number(id)
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(value)) throw new Error('invalid native browser request id')
    return value
  }

  const nativeAnswer = (pending: PendingRequest, answer: NativeBrowserPageAnswer): NativeRequestResponse => {
    if (!answer.accept) return { accept: false }
    switch (pending.kind) {
      case 'prompt': return { accept: true, text: typeof answer.text === 'string' ? answer.text : '' }
      case 'auth':
        if (typeof answer.username !== 'string' || typeof answer.password !== 'string') return { accept: false }
        return { accept: true, username: answer.username, password: answer.password }
      case 'download':
        if (typeof answer.path !== 'string' || !isAbsolute(answer.path) || answer.path.includes('\0')) return { accept: false }
        return { accept: true, path: answer.path }
      default: return { accept: true }
    }
  }

  const ownedView = (viewId: number, owner: string): NativeBrowserViewPort => {
    if (!claim || claim.viewId !== viewId || claim.owner !== owner) throw new Error('native browser view is not owned by this handle')
    const view = deps.getView(viewId)
    const window = deps.getWindow()
    const rules = claim.preview ? NATIVE_BROWSER_PREVIEW_NAVIGATION_RULES : NATIVE_BROWSER_NAVIGATION_RULES
    if (
      !view || !window || view.id !== viewId || view.windowId !== window.id || view.hostWebviewId !== window.webview.id ||
      !view.sandbox || view.renderer !== 'native' || isPreviewChild(view) !== claim.preview ||
      (!claim.preview && view.partition !== claim.partition) ||
      view.allowedProtocols.appData || view.navigationRules !== JSON.stringify(rules)
    ) {
      claim = null
      throw invalidChild()
    }
    return view
  }

  return {
    async claim(params) {
      const preview = params.preview !== undefined
      if (
        !Number.isSafeInteger(params.viewId) || params.viewId <= 0 || typeof params.owner !== 'string' || params.owner.length === 0 ||
        (preview ? !isNativeBrowserPreviewGrant(params.preview) : !NATIVE_BROWSER_PARTITION_RE.test(params.partition))
      ) {
        throw invalidChild()
      }
      const window = deps.getWindow()
      const view = deps.getView(params.viewId)
      if (
        !window || !view || view.windowId !== window.id || view.hostWebviewId !== window.webview.id ||
        !view.sandbox || view.renderer !== 'native' || isPreviewChild(view) !== preview ||
        (!preview && view.partition !== params.partition) ||
        view.allowedProtocols.appData || view.url !== 'about:blank'
      ) throw invalidChild()
      // a preview's throwaway store has no partition and no profile identifier to check against
      const storageIdentifier = preview ? null : deps.storage.identifierFor(params.partition)
      if (storageIdentifier !== null && view.getStorageIdentifier()?.toUpperCase() !== storageIdentifier) {
        throw new Error('native browser view is not using its profile storage')
      }
      if (claim && !deps.getView(claim.viewId)) claim = null
      if (claim && (claim.viewId !== params.viewId || claim.owner !== params.owner)) {
        throw new Error('window already has a native browser view')
      }

      // `webviewTagInit` creates the view before applying its policy; it always starts on inert about:blank.
      // This public SDK call completes before claim resolves and before the renderer can load a target URL.
      const rules = preview ? NATIVE_BROWSER_PREVIEW_NAVIGATION_RULES : NATIVE_BROWSER_NAVIGATION_RULES
      view.setNavigationRules([...rules])
      if (view.navigationRules !== JSON.stringify(rules)) throw new Error('native browser navigation policy was not installed')
      if (params.preview) {
        // Until this runs the SDK answers every preview request with 404, so nothing is readable early.
        view.setIsolatedPreviewHandler!((deps.createPreviewHandler ?? createWorkspacePreviewHandler)(params.preview))
      }
      const zoomFactor = view.getPageZoom()
      claim = { viewId: params.viewId, owner: params.owner, partition: params.partition, preview }
      // a preview's downloads, popups and prompts stay blocked: nothing may relay them to the host
      const pageRequests = preview ? false : enablePageRequests(view)
      return { zoomFactor, pageRequests }
    },
    async answer(params) {
      const view = ownedView(params.viewId, params.owner)
      const requestId = requestNumber(params.id)
      const pending = session?.viewId === view.id ? session.pending.get(requestId) : undefined
      if (!pending || !view.respondToNativeRequest) return { answered: false }
      session?.pending.delete(requestId)
      if (pending.popup && params.answer.accept === true) {
        if (deps.openPopup?.(pending.popup)) return { answered: true }
        decline(view, requestId)
        return { answered: false }
      }
      return { answered: view.respondToNativeRequest(requestId, nativeAnswer(pending, params.answer)) }
    },
    async cancelDownload(params) {
      const view = ownedView(params.viewId, params.owner)
      if (!session || session.viewId !== view.id || !view.cancelDownload) return { cancelled: false }
      for (const [downloadId, id] of session.downloads) {
        if (id === params.id) return { cancelled: view.cancelDownload(downloadId) }
      }
      return { cancelled: false }
    },
    async setZoom(params) {
      if (!isZoomLevel(params.level)) throw new Error('invalid native browser zoom level')
      const view = ownedView(params.viewId, params.owner)
      view.setPageZoom(Math.pow(1.2, params.level))
      return { zoomFactor: view.getPageZoom() }
    },
    async routeLabels(params) {
      if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65535) throw new Error('invalid localhost label proxy port')
      const view = ownedView(params.viewId, params.owner)
      if (!deps.sessionProxy.supported()) return { routed: false }
      // the session proxy only ever sees label hosts; every other request in the profile still connects directly
      deps.sessionProxy.set(view.partition!, { type: 'http', host: '127.0.0.1', port: params.port, matchDomains: [NATIVE_BROWSER_LABEL_DOMAIN] })
      return { routed: true }
    },
    async release(params) {
      if (!claim) return { released: true }
      if (claim.viewId !== params.viewId || claim.owner !== params.owner) {
        throw new Error('native browser view is not owned by this handle')
      }
      const active = claim
      claim = null
      session = null
      const view = deps.getView(active.viewId)
      const window = deps.getWindow()
      if (!view || !window) return { released: true }
      if (view.windowId !== window.id || view.hostWebviewId !== window.webview.id) throw invalidChild()
      view.remove()
      return { released: true }
    },
    async prepare(params) {
      return deps.storage.prepare(params.partition)
    },
    async clear(params) {
      return deps.storage.clear(params.partition)
    },
    dispose() {
      const active = claim
      claim = null
      session = null
      if (active) deps.getView(active.viewId)?.remove()
    }
  }
}
