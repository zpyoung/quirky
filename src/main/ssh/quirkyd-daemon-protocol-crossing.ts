/**
 * D7: whether live terminals survive an quirkyd restart onto another build.
 *
 * The daemon outlives every quirkyd restart, so after the swap the incoming build must route
 * sessions owned by a daemon that may speak another protocol. It can only when it speaks that
 * protocol or lists it as previous — the same rule `config/scripts/daemon-protocol-facts.mjs`
 * (`canAttach`) applies to release pairs in CI.
 */
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import type { QuirkydTerminalCensus } from '../../shared/quirkyd-terminal-census'

export type QuirkydDaemonProtocolFacts = {
  protocolVersion: number
  previousProtocolVersions: readonly number[]
}

/** This client's build, which is also the quirkyd bundle it deploys. */
export const CURRENT_QUIRKYD_DAEMON_PROTOCOL: QuirkydDaemonProtocolFacts = {
  protocolVersion: PROTOCOL_VERSION,
  previousProtocolVersions: PREVIOUS_DAEMON_PROTOCOL_VERSIONS
}

export function quirkydBuildCanAttachDaemon(
  reader: QuirkydDaemonProtocolFacts,
  ownerProtocolVersion: number
): boolean {
  return (
    reader.protocolVersion === ownerProtocolVersion ||
    reader.previousProtocolVersions.includes(ownerProtocolVersion)
  )
}

export type QuirkydLiveDaemonCrossing =
  | 'no-live-terminals'
  | 'attachable'
  | 'strands-live-terminals'
  | 'unverifiable'

/** An unknown session count or daemon protocol is planned for as live and unattachable. */
export function assessQuirkydLiveDaemonCrossing(
  census: QuirkydTerminalCensus,
  incoming: QuirkydDaemonProtocolFacts
): QuirkydLiveDaemonCrossing {
  if (census.liveSessions === 0) {
    return 'no-live-terminals'
  }
  if (census.daemonProtocolVersion === null) {
    return 'unverifiable'
  }
  return quirkydBuildCanAttachDaemon(incoming, census.daemonProtocolVersion)
    ? 'attachable'
    : 'strands-live-terminals'
}
