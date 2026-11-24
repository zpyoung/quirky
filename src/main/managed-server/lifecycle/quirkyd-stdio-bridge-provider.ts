/**
 * The managed tunnel's second transport, for hosts whose sshd refuses port forwarding: the same
 * local listener the forward gives, but each accepted socket rides its own exec channel running
 * the stdio bridge. Nothing above the tunnel can tell the two apart.
 *
 * Disconnects match the forward: a lost channel drops its socket and the listener stays, so the
 * tunnel's own reconnect logic decides, and a lost transport never reads as a dead server.
 */
import { QuirkydStdioBridgeUnavailableError } from '../../quirkyd/quirkyd-host-unavailable'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import {
  checkQuirkydStdioBridge,
  openQuirkydStdioBridgeChannel,
  resolveQuirkydStdioBridge,
  type QuirkydStdioBridge
} from '../../ssh/quirkyd-stdio-bridge'
import { listenQuirkydStdioBridge } from './quirkyd-stdio-bridge-listener'
import { sshQuirkydHostTransport } from '../../ssh/quirkyd-ssh-host-transport'
import type { RemoteCommandChannel } from '../install/remote-install-transport'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'

export type QuirkydStdioBridgeDependencies = {
  resolveBridge: (conn: QuirkydHostTransport, port: number) => Promise<QuirkydStdioBridge>
  checkBridge: (conn: QuirkydHostTransport, bridge: QuirkydStdioBridge) => Promise<unknown>
  openChannel: (
    conn: QuirkydHostTransport,
    bridge: QuirkydStdioBridge
  ) => Promise<RemoteCommandChannel>
}

export const QUIRKYD_STDIO_BRIDGE_DEPENDENCIES: QuirkydStdioBridgeDependencies = {
  resolveBridge: resolveQuirkydStdioBridge,
  checkBridge: checkQuirkydStdioBridge,
  openChannel: openQuirkydStdioBridgeChannel
}

export class QuirkydStdioBridgePortForwardProvider implements SshPortForwardProvider {
  constructor(
    private readonly dependencies: QuirkydStdioBridgeDependencies = QUIRKYD_STDIO_BRIDGE_DEPENDENCIES
  ) {}

  // System SSH runs each bridge socket as an exec over its ControlMaster, or as its own login
  // when multiplexing is off; the transport only picks it once a forward did not start.
  canHandle(conn: SshConnection): boolean {
    return conn.getClient() !== null || conn.usesSystemSshTransport()
  }

  start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    return startQuirkydStdioBridge(sshQuirkydHostTransport(conn), options, this.dependencies)
  }
}

/** Transport-agnostic: any quirkyd host whose exec can run the bridge (SSH, a WSL distro). */
export async function startQuirkydStdioBridge(
  host: QuirkydHostTransport,
  options: PortForwardStartOptions,
  deps: QuirkydStdioBridgeDependencies
): Promise<StartedPortForward> {
  let bridge: Promise<QuirkydStdioBridge> | null = null
  // Memoized once it resolves; a failed resolve is retried by the next socket.
  const resolveBridge = (): Promise<QuirkydStdioBridge> => {
    bridge ??= deps.resolveBridge(host, options.remotePort).catch((error: unknown) => {
      bridge = null
      throw error
    })
    return bridge
  }
  try {
    await deps.checkBridge(host, await resolveBridge())
  } catch (error) {
    if (error instanceof QuirkydStdioBridgeUnavailableError) {
      throw error
    }
    // A slow or dropped check is loss of contact; sockets resolve the bridge again.
    console.warn('[ssh] Quirky stdio bridge check was unverifiable:', error)
  }
  return listenQuirkydStdioBridge(options, async () => {
    const resolved = await resolveBridge()
    return { channel: await deps.openChannel(host, resolved), mode: resolved.mode }
  })
}
