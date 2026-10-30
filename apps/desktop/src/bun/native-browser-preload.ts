import type { DesktopShellBridge, NativeDesktopCapabilities } from '@quirky/protocol'
import { Electroview } from 'electrobun/view'
import { createDropSourcePathsInbox } from './drop-source-paths'
import type { NativeBrowserHostRPC } from './native-browser'

type NativeBrowserPreloadBridge = {
  claimNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['response']>
  setNativeBrowserZoom(params: NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['response']>
  releaseNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['response']>
  routeNativeBrowserLabels(params: NativeBrowserHostRPC['bun']['requests']['routeNativeBrowserLabels']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['routeNativeBrowserLabels']['response']>
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

const DESKTOP_CAPABILITIES: NativeDesktopCapabilities = {
  directoryPicker: true,
  auxiliaryWindows: true,
  revealItem: true,
  notifications: { permission: false, click: false, dismiss: false }
}

declare global {
  interface Window {
    __quirkyNativeBrowserHost?: NativeBrowserPreloadBridge
    __quirkyDesktopHost?: DesktopShellBridge
  }
}

// This runs only in Quirky's trusted shell BrowserWindow. Sandboxed guest webviews never receive this preload.
const dropSourcePaths = createDropSourcePathsInbox()
const rpc = Electroview.defineRPC<NativeBrowserHostRPC>({
  handlers: { requests: {}, messages: { dropSourcePaths: ({ paths }: { paths: string[] }) => dropSourcePaths.receive(paths) } }
})
new Electroview({ rpc })
const requests = (rpc as unknown as { request: NativeBrowserPreloadBridge & DesktopRequestBridge }).request


const bridge: NativeBrowserPreloadBridge = {
  claimNativeBrowserView: (params) => requests.claimNativeBrowserView(params),
  setNativeBrowserZoom: (params) => requests.setNativeBrowserZoom(params),
  releaseNativeBrowserView: (params) => requests.releaseNativeBrowserView(params),
  routeNativeBrowserLabels: (params) => requests.routeNativeBrowserLabels(params)
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
