import {
  NATIVE_BROWSER_NAVIGATION_RULES,
  NATIVE_BROWSER_PARTITION_RE,
  type DesktopRevealRequest,
  type DesktopRevealResult,
  type DesktopWindowCloseResult,
  type DesktopWindowOpenRequest,
  type DesktopWindowResult,
  type FolderPickerRequest,
  type FolderPickerResult
} from '@quirky/protocol'

export type NativeBrowserHostRPC = {
  bun: {
    requests: {
      claimNativeBrowserView: {
        params: { viewId: number; owner: string; partition: string }
        response: { zoomFactor: number }
      }
      setNativeBrowserZoom: {
        params: { viewId: number; owner: string; level: number }
        response: { zoomFactor: number }
      }
      releaseNativeBrowserView: {
        params: { viewId: number; owner: string }
        response: { released: true }
      }
      pickFolder: { params: FolderPickerRequest; response: FolderPickerResult }
      openWindow: { params: DesktopWindowOpenRequest; response: DesktopWindowResult }
      closeWindow: { params: { windowId: string }; response: DesktopWindowCloseResult }
      revealItem: { params: DesktopRevealRequest; response: DesktopRevealResult }
      activateOwner: { params: { windowId: string }; response: { activated: boolean } }
    }
    messages: {}
  }
  webview: { requests: {}; messages: {} }
}

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
  setNavigationRules(rules: string[]): void
  setPageZoom(factor: number): void
  getPageZoom(): number
  remove(): void
}

export type NativeBrowserHostDeps = {
  getWindow(): { id: number; webview: { id: number } } | null
  getView(id: number): NativeBrowserViewPort | undefined
}

export type NativeBrowserHandlers = {
  claim(params: NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['params']): Promise<{ zoomFactor: number }>
  setZoom(params: NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['params']): Promise<{ zoomFactor: number }>
  release(params: NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['params']): Promise<{ released: true }>
  dispose(): void
}

type Claim = { viewId: number; owner: string; partition: string }

function invalidChild(): Error {
  return new Error('native browser view is not an owned sandboxed child')
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

/** Only the trusted BrowserWindow RPC may claim and zoom a native browser view. */
export function createNativeBrowserHandlers(deps: NativeBrowserHostDeps): NativeBrowserHandlers {
  let claim: Claim | null = null

  const ownedView = (viewId: number, owner: string): NativeBrowserViewPort => {
    if (!claim || claim.viewId !== viewId || claim.owner !== owner) throw new Error('native browser view is not owned by this handle')
    const view = deps.getView(viewId)
    const window = deps.getWindow()
    if (
      !view || !window || view.id !== viewId || view.windowId !== window.id || view.hostWebviewId !== window.webview.id ||
      !view.sandbox || view.renderer !== 'native' || view.partition !== claim.partition ||
      view.allowedProtocols.appData || view.navigationRules !== JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES)
    ) {
      claim = null
      throw invalidChild()
    }
    return view
  }

  return {
    async claim(params) {
      if (!Number.isSafeInteger(params.viewId) || params.viewId <= 0 || typeof params.owner !== 'string' || params.owner.length === 0 || !NATIVE_BROWSER_PARTITION_RE.test(params.partition)) {
        throw invalidChild()
      }
      const window = deps.getWindow()
      const view = deps.getView(params.viewId)
      if (
        !window || !view || view.windowId !== window.id || view.hostWebviewId !== window.webview.id ||
        !view.sandbox || view.renderer !== 'native' || view.partition !== params.partition ||
        view.allowedProtocols.appData || view.url !== 'about:blank'
      ) throw invalidChild()
      if (claim && !deps.getView(claim.viewId)) claim = null
      if (claim && (claim.viewId !== params.viewId || claim.owner !== params.owner)) {
        throw new Error('window already has a native browser view')
      }

      // `webviewTagInit` creates the view before applying its policy; it always starts on inert about:blank.
      // This public SDK call completes before claim resolves and before the renderer can load a target URL.
      view.setNavigationRules([...NATIVE_BROWSER_NAVIGATION_RULES])
      if (view.navigationRules !== JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES)) throw new Error('native browser navigation policy was not installed')
      const zoomFactor = view.getPageZoom()
      claim = { viewId: params.viewId, owner: params.owner, partition: params.partition }
      return { zoomFactor }
    },
    async setZoom(params) {
      if (!isZoomLevel(params.level)) throw new Error('invalid native browser zoom level')
      const view = ownedView(params.viewId, params.owner)
      view.setPageZoom(Math.pow(1.2, params.level))
      return { zoomFactor: view.getPageZoom() }
    },
    async release(params) {
      if (!claim) return { released: true }
      if (claim.viewId !== params.viewId || claim.owner !== params.owner) {
        throw new Error('native browser view is not owned by this handle')
      }
      const active = claim
      claim = null
      const view = deps.getView(active.viewId)
      const window = deps.getWindow()
      if (!view || !window) return { released: true }
      if (view.windowId !== window.id || view.hostWebviewId !== window.webview.id) throw invalidChild()
      view.remove()
      return { released: true }
    },
    dispose() {
      const active = claim
      claim = null
      if (active) deps.getView(active.viewId)?.remove()
    }
  }
}
