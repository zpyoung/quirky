import { randomUUID } from 'node:crypto'
import {
  quirkydNodePtyNativeArtifacts,
  quirkydRipgrepArtifact
} from '../../../shared/quirkyd-artifacts'
import { quirkydAgentBrowserNativeName } from '../../../shared/quirkyd-agent-browser-name'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteQuirkydNodeRuntime } from './quirkyd-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './quirkyd-remote-node-runtime-recorded-probe'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { QUIRKYD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './remote-install-lock'
import { QUIRKYD_FENCE_OWNER_FILENAME } from '../activation/quirkyd-activation-fence-scope'
import {
  forgetHeldQuirkydFence,
  rememberHeldQuirkydFence
} from '../../ssh/quirkyd-held-fence-tokens'
import { exitedOwnLockProof } from '../../ssh/quirkyd-exited-own-lock'
import { quirkydWindowsBaseDir } from './quirkyd-remote-windows-node'
import { uploadRelayDirectory, writeRelayFile } from './remote-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './remote-versioned-install'

/** Install the bytes under `quirkyd-<version>/`, using the relay's install transaction. */
export async function installQuirkydBundle(
  options: {
    conn: QuirkydHostTransport
    host: RemoteHostPlatform
    localQuirkydDir: string
    target: NodeRuntimeTarget
    /** The locally verified pinned Node archive, fetched only when the host lacks the runtime. */
    nodeRuntimeArchive: () => Promise<string>
    /** Where a hand-copied Node archive is used offline; named when no download works. */
    nodeRuntimeOfflineArchivePath?: string
    /** WSL only: skip re-hashing a runtime whose stat signature is unchanged since it hashed to the pin. */
    recordedNodeRuntimeProbe?: boolean
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  // Why before the slot probe: an installed slot is unlaunchable without the runtime it names.
  await ensureRemoteQuirkydNodeRuntime({
    conn: options.conn,
    host: options.host,
    slotDir: remoteDir,
    target: options.target,
    archivePath: options.nodeRuntimeArchive,
    offlineArchivePath: options.nodeRuntimeOfflineArchivePath,
    signal: options.signal,
    ...(options.recordedNodeRuntimeProbe
      ? { posixProbeCommand: recordedRemoteNodeRuntimeProbeCommand }
      : {})
  })
  if (
    await isRemoteInstallComplete(options.conn, QUIRKYD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return
  }
  // Its token lets a relaunch prove a lock its own quit left mid-upload (BUG-23).
  const token = randomUUID()
  rememberHeldQuirkydFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: QUIRKYD_FENCE_OWNER_FILENAME, token },
      // Nothing keeps writing once its client exited: uploads are SFTP and chmod is immediate.
      exitedOwner: exitedOwnLockProof(options, {
        baseDir: quirkydWindowsBaseDir(options.host, remoteDir),
        guardsStateMutation: false
      })
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      forgetHeldQuirkydFence(token)
    }
    throw error
  }
  let preserveInstallLock = false
  try {
    // Re-probe under the lock: a sibling deploy may have finished while we waited.
    if (
      await isRemoteInstallComplete(options.conn, QUIRKYD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      return
    }
    await uploadRelayDirectory(options.conn, options.localQuirkydDir, remoteDir, options.host, {
      signal: options.signal
    })
    if (options.host.os !== 'win32') {
      await execCommand(
        options.conn,
        executablePermissionsCommand(options.host, remoteDir, options.target),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal: options.signal
        }
      )
    }
    await writeRelayFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, QUIRKYD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal: options.signal }
    )
    await finalizeInstall(options.conn, remoteDir, options.host, {
      signal: options.signal,
      releaseLock: false
    })
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      // A removal a quit cut short keeps the token, so the relaunch can prove the lock its own.
      if (await abandonInstall(options.conn, remoteDir, options.host)) {
        forgetHeldQuirkydFence(token)
      }
    }
  }
}

export function executablePermissionsCommand(
  host: RemoteHostPlatform,
  directory: string,
  target: NodeRuntimeTarget
): string {
  const required = [quirkydRipgrepArtifact(target), ...quirkydNodePtyNativeArtifacts(target)]
    .filter((artifact) => /\/(?:rg|spawn-helper)$/.test(artifact))
    .map((artifact) => joinRemotePath(host, directory, ...artifact.split('/')))
  const browsers = new Set(
    (['glibc', 'musl'] as const).map((libc) =>
      quotePosixShell(
        joinRemotePath(host, directory, quirkydAgentBrowserNativeName(host.os, host.arch, libc))
      )
    )
  )
  // SFTP drops executable modes; missing optional browser binaries remain a supported install.
  return (
    `chmod 755 ${required.map(quotePosixShell).join(' ')} && ` +
    `for executable in ${[...browsers].join(' ')}; do ` +
    'if [ -f "$executable" ]; then chmod 755 "$executable" || exit $?; fi; done'
  )
}
