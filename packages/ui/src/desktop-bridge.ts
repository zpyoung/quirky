import type { DesktopShellBridge, NativeDesktopCapabilities } from '@quirky/protocol'

export type DesktopWindowRoute = {
  windowId: string
  ownerShellConnId: number
  ownerShellName?: string
  view: string | null
  input?: unknown
  title?: string
  attached: boolean
}

const NO_NATIVE_CAPABILITIES: NativeDesktopCapabilities = {
  directoryPicker: false,
  auxiliaryWindows: false,
  revealItem: false,
  notifications: { permission: false, click: false, dismiss: false }
}

declare global {
  interface Window {
    __quirkyDesktopHost?: DesktopShellBridge
  }
}

/** The trusted preload bridge is absent in browser and unsupported hosts. */
export function desktopBridgeForWindow(): DesktopShellBridge | null {
  return typeof window === 'undefined' ? null : window.__quirkyDesktopHost ?? null
}

export function noNativeDesktopCapabilities(): NativeDesktopCapabilities {
  return { ...NO_NATIVE_CAPABILITIES, notifications: { ...NO_NATIVE_CAPABILITIES.notifications } }
}

/** A route is present only when the shell provided unique owner, window, and view identities. */
export function parseDesktopWindowRoute(rawUrl: string): DesktopWindowRoute | null {
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  const windowIds = url.searchParams.getAll('quirkyWindowId')
  const ownerIds = url.searchParams.getAll('quirkyOwnerShellConnId')
  const views = url.searchParams.getAll('quirkyView')
  if (windowIds.length === 0 && ownerIds.length === 0 && views.length === 0) return null
  if (windowIds.length !== 1 || ownerIds.length !== 1 || views.length !== 1 || !windowIds[0] || !views[0] || !/^[1-9]\d*$/.test(ownerIds[0]!)) return null
  const ownerShellConnId = Number(ownerIds[0])
  if (!Number.isSafeInteger(ownerShellConnId)) return null

  const inputValues = url.searchParams.getAll('quirkyInput')
  if (inputValues.length > 1) return null
  let input: unknown
  if (inputValues.length === 1) {
    try { input = JSON.parse(inputValues[0]!) as unknown } catch { return null }
  }
  const titles = url.searchParams.getAll('quirkyTitle')
  const ownerNames = url.searchParams.getAll('quirkyOwnerShellName')
  if (titles.length > 1 || ownerNames.length > 1) return null
  return {
    windowId: windowIds[0],
    ownerShellConnId,
    ...(ownerNames[0] ? { ownerShellName: ownerNames[0] } : {}),
    view: views[0],
    ...(inputValues.length === 0 ? {} : { input }),
    ...(titles[0] ? { title: titles[0] } : {}),
    attached: false
  }
}
