import { ipcRenderer } from 'electron'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { PreloadApi } from '../api-types'

export const mobileApi = {
  listNetworkInterfaces: (): Promise<{
    interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
  }> => ipcRenderer.invoke('mobile:listNetworkInterfaces'),

  getPairingQR: (args?: {
    address?: string
    rotate?: boolean
  }): Promise<
    | {
        available: false
        reason?: string
        guidance?: string
      }
    | {
        available: true
        qrDataUrl: string | null
        /** Natural bitmap width and height in pixels. */
        qrSize: number | null
        qrError?: 'encoding_failed'
        pairingUrl: string
        endpoint: string
        deviceId: string
      }
  > => ipcRenderer.invoke('mobile:getPairingQR', args),

  getWindowsFirewallStatus: (args?: { address?: string }) =>
    ipcRenderer.invoke('mobile:getWindowsFirewallStatus', args),

  repairWindowsFirewall: () => ipcRenderer.invoke('mobile:repairWindowsFirewall'),

  openWindowsNetworkSettings: () => ipcRenderer.invoke('mobile:openWindowsNetworkSettings'),

  getRuntimePairingUrl: (args?: {
    address?: string
    rotate?: boolean
    // Why: the widen is one-way and host-wide, so main must gate it on the reach the user picked, not
    // on how the typed address happens to look (a Custom loopback may front an SSH tunnel).
    reach?: RuntimePairingReach
  }): Promise<
    | { available: false; reason?: 'network_exposure_failed'; guidance?: string }
    | {
        available: true
        pairingUrl: string
        webClientUrl: string | null
        endpoint: string
        deviceId: string
      }
  > => ipcRenderer.invoke('mobile:getRuntimePairingUrl', args),

  listDevices: (): Promise<{
    devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
  }> => ipcRenderer.invoke('mobile:listDevices'),

  revokeDevice: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
    ipcRenderer.invoke('mobile:revokeDevice', args),

  listRuntimeAccessGrants: () => ipcRenderer.invoke('mobile:listRuntimeAccessGrants'),

  revokeRuntimeAccess: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
    ipcRenderer.invoke('mobile:revokeRuntimeAccess', args),

  isWebSocketReady: (): Promise<{ ready: boolean; endpoint: string | null }> =>
    ipcRenderer.invoke('mobile:isWebSocketReady'),

  consumePendingUnpairedDeviceAuthFailure: (): Promise<boolean> =>
    ipcRenderer.invoke('mobile:consumePendingUnpairedDeviceAuthFailure'),

  /** Fires (throttled, once per session) when an unpaired phone repeatedly fails direct-transport auth. */
  onUnpairedDeviceAuthFailure: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('mobile:unpairedDeviceAuthFailure', listener)
    return () => ipcRenderer.removeListener('mobile:unpairedDeviceAuthFailure', listener)
  }
} satisfies PreloadApi['mobile']
