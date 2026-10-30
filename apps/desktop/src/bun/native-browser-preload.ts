import type { DesktopShellBridge, NativeDesktopCapabilities } from '@quirky/protocol'
import { Electroview } from 'electrobun/view'
import { createDropSourcePathsInbox } from './drop-source-paths'
import type { NativeBrowserHostRPC, NativeBrowserPageEvent } from './native-browser'
import { preloadNotificationCapabilities } from './native-notifications'

type NativeBrowserPreloadBridge = {
  readonly clearPartitionAvailable: boolean
  claimNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['response']>
  nativeBrowserDefaultUserAgent(params: NativeBrowserHostRPC['bun']['requests']['nativeBrowserDefaultUserAgent']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['nativeBrowserDefaultUserAgent']['response']>
  setNativeBrowserZoom(params: NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['response']>
  releaseNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['response']>
  routeNativeBrowserLabels(params: NativeBrowserHostRPC['bun']['requests']['routeNativeBrowserLabels']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['routeNativeBrowserLabels']['response']>
  answerNativeBrowserRequest(params: NativeBrowserHostRPC['bun']['requests']['answerNativeBrowserRequest']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['answerNativeBrowserRequest']['response']>
  cancelNativeBrowserDownload(params: NativeBrowserHostRPC['bun']['requests']['cancelNativeBrowserDownload']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['cancelNativeBrowserDownload']['response']>
  onNativeBrowserPageEvent(listener: (viewId: number, event: NativeBrowserPageEvent) => void): () => void
  prepareNativeBrowserPartition(params: NativeBrowserHostRPC['bun']['requests']['prepareNativeBrowserPartition']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['prepareNativeBrowserPartition']['response']>
  clearNativeBrowserPartition(params: NativeBrowserHostRPC['bun']['requests']['clearNativeBrowserPartition']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['clearNativeBrowserPartition']['response']>
}

type DesktopRequestBridge = {
  pickFolder(params: NativeBrowserHostRPC['bun']['requests']['pickFolder']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['pickFolder']['response']>
  openWindow(params: NativeBrowserHostRPC['bun']['requests']['openWindow']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['openWindow']['response']>
  closeWindow(params: NativeBrowserHostRPC['bun']['requests']['closeWindow']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['closeWindow']['response']>
  revealItem(params: NativeBrowserHostRPC['bun']['requests']['revealItem']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['revealItem']['response']>
  activateOwner(params: NativeBrowserHostRPC['bun']['requests']['activateOwner']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['activateOwner']['response']>
  readClipboardText(params: NativeBrowserHostRPC['bun']['requests']['readClipboardText']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['readClipboardText']['response']>
  dropSourcePathsSupported(params: NativeBrowserHostRPC['bun']['requests']['dropSourcePathsSupported']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['dropSourcePathsSupported']['response']>
}

/** Set by the main process ahead of this bundle; see nativeBrowserPreloadSource. */
declare const QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE: boolean | undefined

declare global {
  interface Window {
    __quirkyNativeBrowserHost?: NativeBrowserPreloadBridge
    __quirkyDesktopHost?: DesktopShellBridge
    __quirkyNotificationCapabilities?: unknown
  }
}

const DESKTOP_CAPABILITIES: NativeDesktopCapabilities = {
  directoryPicker: true,
  auxiliaryWindows: true,
  revealItem: true,
  notifications: preloadNotificationCapabilities(window.__quirkyNotificationCapabilities)
}

// This runs only in Quirky's trusted shell BrowserWindow. Sandboxed guest webviews never receive this preload.
const dropSourcePaths = createDropSourcePathsInbox()
const pageEventListeners = new Set<(viewId: number, event: NativeBrowserPageEvent) => void>()
const rpc = Electroview.defineRPC<NativeBrowserHostRPC>({
  handlers: {
    requests: {},
    messages: {
      dropSourcePaths: ({ paths }: { paths: string[] }) => dropSourcePaths.receive(paths),
      nativeBrowserPageEvent: ({ viewId, event }: { viewId: number; event: NativeBrowserPageEvent }) => {
        for (const listener of pageEventListeners) listener(viewId, event)
      }
    }
  }
})
new Electroview({ rpc })
const requests = (rpc as unknown as { request: NativeBrowserPreloadBridge & DesktopRequestBridge }).request


const bridge: NativeBrowserPreloadBridge & { readonly previewAvailable: boolean } = {
  clearPartitionAvailable: typeof QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE === 'boolean' && QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE,
  // The pinned Electrobun fork enforces isolated previews on every macOS it supports; the main
  // claim still refuses a view the SDK did not create as one.
  previewAvailable: true,
  claimNativeBrowserView: (params) => requests.claimNativeBrowserView(params),
  nativeBrowserDefaultUserAgent: (params) => requests.nativeBrowserDefaultUserAgent(params),
  setNativeBrowserZoom: (params) => requests.setNativeBrowserZoom(params),
  releaseNativeBrowserView: (params) => requests.releaseNativeBrowserView(params),
  routeNativeBrowserLabels: (params) => requests.routeNativeBrowserLabels(params),
  answerNativeBrowserRequest: (params) => requests.answerNativeBrowserRequest(params),
  cancelNativeBrowserDownload: (params) => requests.cancelNativeBrowserDownload(params),
  onNativeBrowserPageEvent: (listener) => {
    pageEventListeners.add(listener)
    return () => pageEventListeners.delete(listener)
  },
  prepareNativeBrowserPartition: (params) => requests.prepareNativeBrowserPartition(params),
  clearNativeBrowserPartition: (params) => requests.clearNativeBrowserPartition(params)
}

let dropSourcePathsSupported: Promise<boolean> | null = null

const desktopBridge: DesktopShellBridge = {
  capabilities: DESKTOP_CAPABILITIES,
  readClipboardText: () => requests.readClipboardText({}),
  pickFolder: (params) => requests.pickFolder(params),
  openWindow: (request, ownerShell) => requests.openWindow({ request, ownerShell }),
  closeWindow: (windowId) => requests.closeWindow({ windowId }),
  revealItem: (params) => requests.revealItem(params),
  activateOwner: (windowId) => requests.activateOwner({ windowId }),
  async nativeDropPaths(fileNames) {
    dropSourcePathsSupported ??= requests.dropSourcePathsSupported({}).catch(() => false)
    if (!(await dropSourcePathsSupported)) return null
    return dropSourcePaths.take(fileNames)
  }
}

Object.defineProperty(window, '__quirkyDesktopHost', {
  value: desktopBridge,
  configurable: false,
  enumerable: false,
  writable: false
})

Object.defineProperty(window, '__quirkyNativeBrowserHost', {
  value: bridge,
  configurable: false,
  enumerable: false,
  writable: false
})
