import type { QuirkydHostTransport } from './quirkyd-host-transport'
import type { SshConnection } from './connection/ssh-connection'

/**
 * An SSH host's quirkyd transport is its connection itself, not a wrapper: tunnel ownership, serving
 * dedupe and per-connection caches compare and key by that object.
 */
export function sshQuirkydHostTransport(connection: SshConnection): QuirkydHostTransport {
  return connection
}
