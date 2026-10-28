import { Electroview } from 'electrobun/view'
import type { NativeBrowserHostRPC } from './native-browser'

type NativeBrowserPreloadBridge = {
  claimNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['claimNativeBrowserView']['response']>
  setNativeBrowserZoom(params: NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['setNativeBrowserZoom']['response']>
  releaseNativeBrowserView(params: NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['params']): Promise<NativeBrowserHostRPC['bun']['requests']['releaseNativeBrowserView']['response']>
}

declare global {
  interface Window {
    __quirkyNativeBrowserHost?: NativeBrowserPreloadBridge
  }
}

// This runs only in Quirky's trusted shell BrowserWindow. Sandboxed guest webviews never receive this preload.
const rpc = Electroview.defineRPC<NativeBrowserHostRPC>({ handlers: { requests: {}, messages: {} } })
new Electroview({ rpc })
const requests = (rpc as unknown as { request: NativeBrowserPreloadBridge }).request


const bridge: NativeBrowserPreloadBridge = {
  claimNativeBrowserView: (params) => requests.claimNativeBrowserView(params),
  setNativeBrowserZoom: (params) => requests.setNativeBrowserZoom(params),
  releaseNativeBrowserView: (params) => requests.releaseNativeBrowserView(params)
}

Object.defineProperty(window, '__quirkyNativeBrowserHost', {
  value: bridge,
  configurable: false,
  enumerable: false,
  writable: false
})
