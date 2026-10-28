export type MobileConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'unreachable' | 'auth-failed' | 'credential-missing' | 'credential-unavailable'

export type MobileConnectionState = {
  phase: MobileConnectionPhase
  attempts: number
  connectedAt?: number
  message?: string
}

export type MobileCallOptions = { requestId?: string; timeoutMs?: number }

export interface MobileRpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: MobileCallOptions): Promise<T>
  onEvent(handler: (event: { event: string; data: unknown }) => void): () => void
  onStream(streamId: number, handler: (bytes: Uint8Array) => void): () => void
  onState(handler: (state: MobileConnectionState) => void): () => void
  readonly state: MobileConnectionState
  close(): void
}
