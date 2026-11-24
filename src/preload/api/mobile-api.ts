import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'

export type MobileApi = {
  listNetworkInterfaces: () => Promise<{
    interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
  }>
  getPairingQR: (args?: { address?: string; rotate?: boolean }) => Promise<
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
  >
  getWindowsFirewallStatus: (args?: { address?: string }) => Promise<
    | { supported: false }
    | {
        supported: true
        port: number
        ruleAllowed: boolean
        blockingRuleDetected: boolean
        privateFirewallEnabled: boolean
        networkCategory: 'private' | 'public' | 'domain' | 'unknown'
        inspectionAvailable: boolean
      }
  >
  repairWindowsFirewall: () => Promise<
    { ok: true } | { ok: false; reason: 'cancelled' | 'failed' | 'unsupported' }
  >
  openWindowsNetworkSettings: () => Promise<boolean>
  getRuntimePairingUrl: (args?: {
    address?: string
    rotate?: boolean
    reach?: RuntimePairingReach
  }) => Promise<
    | {
        available: false
        reason?: 'network_exposure_failed'
        guidance?: string
      }
    | {
        available: true
        pairingUrl: string
        webClientUrl: string | null
        endpoint: string
        deviceId: string
      }
  >
  listDevices: () => Promise<{
    devices: {
      deviceId: string
      name: string
      pairedAt: number
      lastSeenAt: number
    }[]
  }>
  revokeDevice: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
  listRuntimeAccessGrants: () => Promise<{ grants: RuntimeAccessGrant[] }>
  revokeRuntimeAccess: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
  isWebSocketReady: () => Promise<{ ready: boolean; endpoint: string | null }>
  /** Consumes an auth-failure notification that arrived before the renderer listener mounted. */
  consumePendingUnpairedDeviceAuthFailure?: () => Promise<boolean>
  /** Fires (throttled, once per session) when an unpaired phone repeatedly fails direct-transport auth. */
  onUnpairedDeviceAuthFailure?: (callback: () => void) => () => void
}
