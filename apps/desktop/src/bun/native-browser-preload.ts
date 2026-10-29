import type { DesktopShellBridge, NativeDesktopCapabilities } from '@quirky/protocol'
import { Electroview } from 'electrobun/view'
import type { NativeBrowserHostRPC, NativeBrowserPageEvent } from './native-browser'

type NativeBrowserPreloadBridge = {
  claimNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['response']>
  setNativeBrowserZoom(params: NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['response']>
  releaseNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['response']>
  answerNativeBrowserRequest(params: NativeBrowserHostRPC['bun']['requests']['answerNativeBrowserRequest']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['answerNativeBrowserRequest']['response']>
  cancelNativeBrowserDownload(params: NativeBrowserHostRPC['bun']['requests']['cancelNativeBrowserDownload']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['cancelNativeBrowserDownload']['response']>
  onNativeBrowserPageEvent(listener: (viewId: number, event: NativeBrowserPageEvent) => void): () => void
}

type DesktopRequestBridge = {
  pickFolder(params: NativeBrowserHostRPC['bun']['requests']['pickFolder']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['pickFolder']['response']>
  openWindow(params: NativeBrowserHostRPC['bun']['requests']['openWindow']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['openWindow']['response']>
  closeWindow(params: NativeBrowserHostRPC['bun']['requests']['closeWindow']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['closeWindow']['response']>
  revealItem(params: NativeBrowserHostRPC['bun']['requests']['revealItem']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['revealItem']['response']>
  activateOwner(params: NativeBrowserHostRPC['bun']['requests']['activateOwner']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['activateOwner']['response']>
  readClipboardText(params: NativeBrowserHostRPC['bun']['requests']['readClipboardText']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['readClipboardText']['response']>
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
const pageEventListeners = new Set<(viewId: number, event: NativeBrowserPageEvent) => void>()
const rpc = Electroview.defineRPC<NativeBrowserHostRPC>({
  handlers: {
    requests: {},
    messages: {
      nativeBrowserPageEvent: ({ viewId, event }: { viewId: number; event: NativeBrowserPageEvent }) => {
        for (const listener of pageEventListeners) listener(viewId, event)
      }
    }
  }
})
new Electroview({ rpc })
const requests = (rpc as unknown as { request: NativeBrowserPreloadBridge & DesktopRequestBridge }).request


const bridge: NativeBrowserPreloadBridge = {
  claimNativeBrowserView: (params) => requests.claimNativeBrowserView(params),
  setNativeBrowserZoom: (params) => requests.setNativeBrowserZoom(params),
  releaseNativeBrowserView: (params) => requests.releaseNativeBrowserView(params),
  answerNativeBrowserRequest: (params) => requests.answerNativeBrowserRequest(params),
  cancelNativeBrowserDownload: (params) => requests.cancelNativeBrowserDownload(params),
  onNativeBrowserPageEvent: (listener) => {
    pageEventListeners.add(listener)
    return () => pageEventListeners.delete(listener)
  }
}

const desktopBridge: DesktopShellBridge = {
  capabilities: DESKTOP_CAPABILITIES,
  readClipboardText: () => requests.readClipboardText({}),
  pickFolder: (params) => requests.pickFolder(params),
  openWindow: (request, ownerShell) => requests.openWindow({ request, ownerShell }),
  closeWindow: (windowId) => requests.closeWindow({ windowId }),
  revealItem: (params) => requests.revealItem(params),
  activateOwner: (windowId) => requests.activateOwner({ windowId })
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
