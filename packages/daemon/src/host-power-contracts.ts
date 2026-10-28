/** Trusted daemon source; no RPC/event-bus producer is exposed. */
export type HostPowerTransition = 'suspend' | 'resume'

export interface NativeHostPowerSource {
  /** Delivers on the JS thread. The native sleep acknowledgment follows listener return. */
  start(listener: (transition: HostPowerTransition) => void): () => void
}
