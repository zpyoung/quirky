/**
 * What every managed-quirkyd operation on a Windows host needs before its first host op: this
 * client's pinned node.exe in the runtime store, and the host script it runs.
 *
 * Both are idempotent: a present runtime costs one probe and nothing is uploaded, and the host
 * script is content-addressed, so rewriting it changes nothing a running quirkyd depends on.
 */
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteQuirkydNodeRuntime } from '../install/quirkyd-remote-node-runtime'
import {
  installQuirkydWindowsHostScript,
  quirkydRemoteBaseDir
} from '../install/quirkyd-remote-windows-node'
import { materializeNodeRuntimeArchive } from '../../node-runtime/pinned-runtime-materializer'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export async function prepareWindowsQuirkydHost(options: {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  serverTarget: NodeRuntimeTarget
  signal?: AbortSignal
}): Promise<void> {
  const baseDir = quirkydRemoteBaseDir(options.host, options.remoteHome)
  await ensureRemoteQuirkydNodeRuntime({
    conn: options.conn,
    host: options.host,
    // Only its parent is read: the runtime store sits beside the slots.
    slotDir: joinRemotePath(options.host, baseDir, 'quirkyd-host'),
    target: options.serverTarget,
    archivePath: () =>
      materializeNodeRuntimeArchive(
        options.serverTarget,
        join(getAppEnvironment().getPath('userData'), 'quirkyd-artifacts'),
        { signal: options.signal }
      ),
    signal: options.signal
  })
  await installQuirkydWindowsHostScript(options, baseDir)
}
