/** Trusted daemon source; no RPC/event-bus producer is exposed. */
export type HostPowerTransition = 'suspend' | 'resume'

/** Power facts a plugin may use to throttle work; `externalDisplay` is null when the source cannot tell. */
export type HostPowerState = {
  onBattery: boolean
  externalDisplay: boolean | null
}

export interface NativeHostPowerSource {
  /** Delivers on the JS thread. The native sleep acknowledgment follows listener return. */
  start(listener: (transition: HostPowerTransition) => void): () => void
  /**
   * Takes an assertion that prevents idle system sleep while the display may still sleep.
   * Returns null when the platform refuses it. A source omitting this member cannot keep the host awake.
   */
  createAssertion?(reason: string): number | null
  /** Releases an id returned by `createAssertion`. */
  releaseAssertion?(id: number): void
  /** Reads the live power source; a source omitting this member reports the unsupported default. */
  powerState?(): HostPowerState
}
