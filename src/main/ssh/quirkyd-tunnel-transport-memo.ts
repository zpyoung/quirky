/** Which transport each host's managed tunnel last started on, for connect telemetry. */
export type QuirkydTunnelTransport = 'tcp_forward' | 'stdio_bridge'

// Keyed by the local target id, which never leaves this process.
const transports = new Map<string, QuirkydTunnelTransport>()

export function rememberQuirkydTunnelTransport(
  targetId: string,
  transport: QuirkydTunnelTransport
): void {
  transports.set(targetId, transport)
}

export function knownQuirkydTunnelTransport(targetId: string): QuirkydTunnelTransport | null {
  return transports.get(targetId) ?? null
}
