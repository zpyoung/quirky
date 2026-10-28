/* Shared phone/shell/page contracts. Runtime secrets never cross the page bridge. */
import type { MobilePageGrant } from '@quirky/protocol'
import type { PanelRoute } from './panels/contracts'
export type { MobileBundleAsset, MobileBundleRoute, MobileBundleManifest, MobileBundleManifestResult, MobileBundleReadResult } from '@quirky/protocol'
export type MobileHost = {
  id: string
  name: string
  personalName?: string
  machineName?: string
  platform?: string
  endpoint: string
  publicKeyB64: string
  lastConnected: number | null
  lastWorktree?: string
}
export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'unreachable' | 'auth-failed' | 'credential-missing' | 'credential-unavailable'
export type MobileConnectionState = {
  phase: ConnectionPhase
  attempts: number
  connectedAt?: number
  message?: string
}
export type MobileLogEntry = { at: number; stage: string; message: string }
export type MobileCallOptions = { requestId?: string; timeoutMs?: number }
export interface MobileRpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: MobileCallOptions): Promise<T>
  onEvent(handler: (event: { event: string; data: unknown }) => void): () => void
  onStream(streamId: number, handler: (bytes: Uint8Array) => void): () => void
  onState(handler: (state: MobileConnectionState) => void): () => void
  readonly state: MobileConnectionState
  close(): void
}
export type MobilePreferences = {
  sessionView: 'terminal'
  onboardingCompleted: boolean
  notificationChoice: 'unset' | 'disabled' | 'enabled'
  terminalTextScale: 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2
  autocomplete: boolean
  terminalLinkMode: 'desktop' | 'phone'
  shortcuts: { id: string; label: string; text: string }[]
}
export type MobileRoute = { kind: 'workspaces' } | { kind: 'session'; worktreeId: string; sessionId?: string } | PanelRoute
export type MobilePermission = 'granted' | 'denied' | 'undetermined' | 'unavailable'
export interface MobileStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
export type MobileCredentialRead = { kind: 'available'; token: string } | { kind: 'missing' } | { kind: 'unavailable' }
export interface MobileSecretStorage {
  read(hostId: string): Promise<MobileCredentialRead>
  write(hostId: string, token: string): Promise<void>
  remove(hostId: string): Promise<void>
}
export interface MobileNativeActions {
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  haptic(): Promise<void>
  notificationPermission(request: boolean): Promise<MobilePermission>
  openSystemSettings(): Promise<void>
}
export interface MobileRuntime {
  readonly storage: MobileStorage
  readonly native: MobileNativeActions
  hosts(): Promise<MobileHost[]>
  preferences(): Promise<MobilePreferences>
  updatePreferences(patch: Partial<MobilePreferences>): Promise<MobilePreferences>
  pair(input: string, onLog?: (entry: MobileLogEntry) => void): Promise<MobileHost>
  editHost(hostId: string, patch: { personalName?: string; endpoint?: string }): Promise<MobileHost>
  removeHost(hostId: string): Promise<{ cleanupPending: boolean }>
  retryCredentialCleanup(): Promise<string[]>
  getRpc(hostId: string): Promise<MobileRpc>
  disconnect(hostId: string): void
  reconnect(hostId: string): Promise<MobileRpc>
  logs(hostId: string): Promise<MobileLogEntry[]>
  rememberWorkspace(hostId: string, worktreeId: string): Promise<void>
  subscribe(handler: () => void): () => void
  setForeground(active: boolean): void
  dispose(): void
}
export type MobileGrant = MobilePageGrant
export type MobilePageInit = {
  v: 1
  sessionId: string
  host: MobileHost
  route: MobileRoute
  grants: MobileGrant[]
  preferences: MobilePreferences
  connectionState: MobileConnectionState
  safeArea: { top: number; right: number; bottom: number; left: number }
}
export interface MobilePageBridge {
  readonly init: MobilePageInit
  readonly state: MobileConnectionState
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: MobileCallOptions): Promise<T>
  onEvent(handler: (event: { event: string; data: unknown }) => void): () => void
  onStream(streamId: number, handler: (bytes: Uint8Array) => void): () => void
  onState(handler: (state: MobileConnectionState) => void): () => void
  storage: MobileStorage
  native: Pick<MobileNativeActions, 'clipboardRead' | 'clipboardWrite' | 'openExternal' | 'haptic'>
  navigate(route: MobileRoute | { kind: 'home' }): Promise<void>
  report(state: Record<string, unknown>): void
  close(): void
}
export type HostPageShellProps = {
  runtime: MobileRuntime
  hostId: string
  route: MobileRoute
  onNavigate(route: MobileRoute | { kind: 'home' }): void
}
export type PageAppProps = { bridge: MobilePageBridge }
export const MOBILE_SHELL_VERSION = 1
export const MOBILE_BRIDGE_MAX_BYTES = 640 * 1024
export const MOBILE_BUNDLE_LIMITS = { assets: 256, totalBytes: 32 * 1024 * 1024, assetBytes: 10 * 1024 * 1024, routes: 64, hosts: 6 } as const
