/** Safe desktop identity readable by paired phones without exposing pairing administration. */
export type MobileHostInfo = {
  machineName: string
  platform: string
  deviceScope: 'mobile'
}

/** Public, non-secret projection of a durably paired phone. Pending offers are not listed. */
export type MobileDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

export type MobileNetworkInterface = {
  name: string
  address: string
  family: 'IPv4' | 'IPv6'
  kind: 'tailscale' | 'lan' | 'virtual'
}

/** Quirky pairing is direct-only; the mobile app uses Quirky JSON-RPC, not Orca RPC. */
export type MobilePairingOffer = {
  v: 2
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  pairedDeviceId: string
  scope: 'mobile'
}

export type MobilePairingResult =
  | {
      available: true
      pairingUrl: string
      endpoint: string
      deviceId: string
      connectionMode: 'local-only'
      qrDataUrl: string | null
      qrSize: number | null
      qrError?: 'encoding_failed'
    }
  | {
      available: false
      reason: 'invalid_advertised_endpoint' | 'network_exposure_failed' | 'device_registry_unavailable' | 'e2ee_key_unavailable' | 'websocket_unavailable'
      guidance: string
    }

export type MobileState = {
  machineName: string
  showMobileButton: boolean
  onboardingSeen: boolean
  autoRestoreFitMs: number | null
  customAddresses: string[]
  interfaces: MobileNetworkInterface[]
  devices: MobileDevice[]
  listener: { available: boolean; host: string | null; port: number | null }
  relay: 'unavailable'
}

/** Daemon-owned terminal ownership. Viewport dimensions are PTY cells, not pixels. */
export type MobileTerminalState = {
  session: string
  driver: { deviceId: string; connectionId: number; name: string } | null
  phoneFit: boolean
  cols: number
  rows: number
  desktopCols: number | null
  desktopRows: number | null
}

/** Page-delivery DTOs shared by the mobile plugin and the Expo companion. */
export type MobilePageGrant = 'rpc' | 'terminal' | 'storage' | 'navigate' | 'clipboard.read' | 'clipboard.write' | 'externalLink' | 'haptics'
export type MobileBundleAsset = { path: string; bytes: number; sha256: string; contentType: string }
export type MobileBundleRoute = { kind: 'workspaces' | 'session'; path: string; grants: MobilePageGrant[] }
export type MobileBundleManifest = {
  v: 1
  shellVersion: 1
  buildId: string
  assets: MobileBundleAsset[]
  totalBytes: number
  routes: MobileBundleRoute[]
}
export type MobileBundleManifestResult = { manifest: MobileBundleManifest; chunkBytes: number; rangeBytes: number }
export type MobileBundleReadResult = { buildId: string; path: string; offset: number; data: string; encoding: 'identity' | 'gzip'; eof: boolean; sha256: string }
