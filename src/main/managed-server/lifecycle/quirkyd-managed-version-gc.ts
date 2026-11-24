/**
 * After a managed deploy or update, removes this host's older quirkyd version dirs that are
 * proven stopped (design D10). Pins come from gcOldQuirkydVersions: the active version, the
 * rollback target, journaled versions, and the version the live terminal daemon was forked
 * from. Anything the host cannot answer about is kept.
 */
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { ServeReadiness } from '../../server/serve-readiness'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import { quirkydSlotDir, type QuirkydSlotOptions } from '../../ssh/quirkyd-recovery-slot'
import { gcOldQuirkydVersions } from '../install/quirkyd-remote-gc'
import { nodeRuntimeStorePins } from '../../ssh/pinned-runtime-host-target'

/** The daemon's build when the readiness proves it; undefined when it cannot say. */
export function provenLiveDaemonVersion(readiness: ServeReadiness): string | null | undefined {
  const daemon = readiness.health?.terminalDaemon
  if (daemon?.state === 'live' && daemon.buildVersion) {
    return daemon.buildVersion
  }
  // A daemon that answered as absent forked from nothing; degraded or unreported proves nothing.
  return daemon?.state === 'absent' ? null : undefined
}

export async function pruneManagedQuirkydVersions(args: {
  slot: QuirkydSlotOptions
  serverTarget: NodeRuntimeTarget
  activeVersion: string
  readiness: ServeReadiness
}): Promise<void> {
  const liveDaemonVersion = provenLiveDaemonVersion(args.readiness)
  // Why skip: without the daemon's version, GC could remove the tree a live daemon runs from.
  if (liveDaemonVersion === undefined) {
    return
  }
  try {
    await gcOldQuirkydVersions({
      conn: args.slot.conn,
      host: args.slot.host,
      remoteHome: args.slot.remoteHome,
      currentDirAbsPath: quirkydSlotDir(args.slot, args.activeVersion),
      record: await readQuirkydActivationRecord(args.slot),
      liveDaemonVersion,
      // Why both pins: a default and a compat quirkyd on one host share one runtime store.
      nodeRuntimePins: nodeRuntimeStorePins(args.serverTarget),
      signal: args.slot.signal
    })
  } catch (error) {
    // Best effort: the deploy already succeeded, and the next connect tries again.
    console.warn('[quirkyd-gc] Pruning old quirkyd versions failed:', error)
  }
}
