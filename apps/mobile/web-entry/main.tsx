import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MobilePageBridge, MobilePageInit } from '../src/contracts'
import { MOBILE_BRIDGE_MAX_BYTES } from '../src/contracts'
import { createPageBridge, type PageBridgePort } from '../src/shell/page-bridge'
import { utf8ByteLength } from '../src/shell/bridge-policy'
import { PageApp } from '../src/pages/PageApp'

declare global {
  interface Window {
    quirkyBridge?: {
      postMessage(data: string): void
      onmessage: ((event: { data: string }) => void) | null
    }
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('mobile page root element is missing')


const listeners = new Set<(json: string) => void>()
let bridge: MobilePageBridge | undefined
let reactRoot: Root | undefined

const pagePort: PageBridgePort = {
  postMessage(json) {
    const bridge = window.quirkyBridge
    if (!bridge) throw new Error('isolated native page bridge is unavailable')
    bridge.postMessage(json)
  },
  subscribe(handler) {
    listeners.add(handler)
    return () => listeners.delete(handler)
  }
}

function receive(json: string): void {
  if (utf8ByteLength(json) > MOBILE_BRIDGE_MAX_BYTES) return
  let value: unknown
  try { value = JSON.parse(json) as unknown } catch { return }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const packet = value as Record<string, unknown>
  if (packet.v !== 1 || typeof packet.kind !== 'string') return
  if (packet.kind === 'init') {
    const keys = Object.keys(packet)
    if (bridge || keys.length !== 4 || !['v', 'kind', 'sessionId', 'init'].every((key) => Object.hasOwn(packet, key))) return
    const rawInit = packet.init
    if (rawInit === null || typeof rawInit !== 'object' || Array.isArray(rawInit)) return
    const init = rawInit as MobilePageInit
    if (packet.sessionId !== init.sessionId) return
    bridge = createPageBridge(pagePort, init)
    reactRoot = createRoot(rootElement)
    reactRoot.render(createElement(PageApp, { bridge }))
    return
  }
  if (!bridge || packet.sessionId !== bridge.init.sessionId) return
  for (const listener of [...listeners]) listener(json)
}

const nativeBridge = window.quirkyBridge
if (nativeBridge) {
  nativeBridge.onmessage = (event) => receive(event.data)
  nativeBridge.postMessage(JSON.stringify({ v: 1, kind: 'ready' }))
} else {
  rootElement.textContent = 'This page requires Quirky’s isolated native origin.'
}
window.addEventListener('pagehide', () => {
  bridge?.close()
  reactRoot?.unmount()
  bridge = undefined
  if (nativeBridge) nativeBridge.onmessage = null
  reactRoot = undefined
  listeners.clear()
}, { once: true })
