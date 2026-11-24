/** Whether the pre-activation snapshot fits, asked before the running server is stopped (#30491). */
import { quirkydRemoteBaseDir } from '../managed-server/install/quirkyd-remote-windows-node'
import { execQuirkydRemoteOr } from '../managed-server/install/quirkyd-remote-runtime-control'
import {
  QUIRKYD_STATE_SNAPSHOT_DIR,
  type QuirkydActivationRecord
} from '../managed-server/activation/quirkyd-activation-record'
import {
  quirkydSnapshotShortfallKb,
  quirkydSnapshotShortfallMessage,
  quirkydSnapshotSpaceCommand,
  parseQuirkydSnapshotSpace
} from '../managed-server/host-state/quirkyd-state-snapshot-space'
import { joinRemotePath } from './ssh-remote-platform'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import type { QuirkydSlotOptions } from './quirkyd-recovery-slot'

export const QUIRKYD_SNAPSHOT_SPACE_INSUFFICIENT_CODE = 'quirkyd_snapshot_space_insufficient'

export function quirkydSnapshotsRoot(
  options: Pick<QuirkydSlotOptions, 'host' | 'remoteHome'>
): string {
  return joinRemotePath(
    options.host,
    quirkydRemoteBaseDir(options.host, options.remoteHome),
    QUIRKYD_STATE_SNAPSHOT_DIR
  )
}

/** The refusal to show when the snapshot cannot fit, or null to go ahead (an unread answer too). */
export async function quirkydSnapshotRoomRefusal(
  options: QuirkydSlotOptions,
  record: QuirkydActivationRecord,
  fullVersion: string
): Promise<string | null> {
  const baseDir = quirkydRemoteBaseDir(options.host, options.remoteHome)
  const command = quirkydSnapshotSpaceCommand(
    options.host,
    options.userDataDir,
    quirkydSnapshotsRoot(options),
    baseDir,
    record.snapshot ? [record.snapshot.dirName] : []
  )
  if (!command) {
    return null
  }
  const space = parseQuirkydSnapshotSpace(await measureRoom(options, command))
  const shortfall = quirkydSnapshotShortfallKb(space)
  return space && shortfall !== null
    ? quirkydSnapshotShortfallMessage(space, shortfall, {
        userDataDir: options.userDataDir,
        baseDir,
        fullVersion,
        active: record.active
      })
    : null
}

async function measureRoom(options: QuirkydSlotOptions, command: string): Promise<string> {
  try {
    return await execQuirkydRemoteOr(options, command)
  } catch (error) {
    // A read-only probe that lost its channel only leaves the room unknown; the capture decides.
    if (isUnconfirmedSshCommandTermination(error) && !options.signal?.aborted) {
      return ''
    }
    throw error
  }
}
