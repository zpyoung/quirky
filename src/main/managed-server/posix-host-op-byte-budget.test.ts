import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPosixStdoutFence } from '../../shared/posix-stdout-fence'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { initialQuirkydActivationAdmissionCommand } from '../ssh/quirkyd-initial-activation-admission'
import {
  captureQuirkydLaunchSshSessionCommand,
  quirkydLaunchSshSessionProbeCommand,
  writeQuirkydLaunchSshSessionCommand
} from '../ssh/quirkyd-launch-ssh-session'
import { makeExecStdinWriteFileCommand } from '../ssh/ssh-exec-stdin-file-transfer'
import { wrapRemoteCommandForPosixShell } from '../ssh/ssh-posix-command-wrapper'
import {
  listRemoteInstallBaseDirsCommand,
  moveRemoteTreeCommand,
  probeFileExistsCommand,
  probeRemoteInstallCompleteCommand,
  readRemoteHomeCommand,
  removeRemoteFileCommand,
  removeRemoteTreeCommand,
  restoreRemoteTreeCommand,
  writeRemoteEmptyFileCommand
} from '../ssh/ssh-remote-commands'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { makePosixWriteFileCommand } from '../ssh/system-transport/system-ssh-file-binary-transfer'
import {
  posixQuirkydFenceGuard,
  runWithQuirkydFence,
  type QuirkydFence
} from './activation/quirkyd-activation-fence-scope'
import { posixReleaseFenceCommand } from './activation/quirkyd-activation-lock'
import {
  captureQuirkydStateSnapshotCommand,
  clearQuirkydStateSnapshotMembersCommand,
  compareQuirkydStateSnapshotCommand,
  probeQuirkydStateSnapshotCommand,
  restoreQuirkydStateSnapshotCommand,
  serializedStateMutationCommand
} from './host-state/quirkyd-state-snapshot'
import { newestStateMtimeCommand } from './host-state/quirkyd-state-newest-mtime'
import { quirkydSnapshotSpaceCommand } from './host-state/quirkyd-state-snapshot-space'
import { posixProcessGroupCommand } from './host-state/quirkyd-state-mutation-owner-record'
import { quirkydMachineClaimCommand } from './host-state/quirkyd-machine-claim-command'
import { quirkydMachineHomeProbeCommand } from './host-state/quirkyd-machine-home'
import { executablePermissionsCommand } from './install/quirkyd-remote-install'
import {
  quirkydNodeSlotRuntimeCommand,
  selectQuirkydSlotEntryCommand,
  selectQuirkydSlotRuntimeCommand
} from './install/quirkyd-remote-runtime'
import {
  quirkydLaunchCommand,
  quirkydLivenessProbeCommand,
  readQuirkydReadinessCommand
} from './install/quirkyd-remote-launch'
import {
  createExecProbedStageCommand,
  installNodeRuntimeFromHostArchiveCommand,
  probeRemoteNodeRuntimeCommand,
  promoteRemoteNodeRuntimeCommand,
  recheckAndPromoteRemoteNodeRuntimeCommand,
  remoteNodeRuntimePresentCommand
} from './install/quirkyd-remote-node-runtime'
import { remoteSha256Command } from './install/remote-sha256-command'
import { hostDownloadNodeRuntimeCommand } from './install/remote-node-runtime-host-download'
import { remoteQuirkydBuildHashCommand } from './install/quirkyd-remote-build-hash'
import { remoteFreeSpaceProbeCommand } from './install/remote-install-out-of-space'
import { sweepStaleRuntimeStagesCommand } from './install/remote-node-runtime-store-gc'
import { quirkydProfilePreflightCommand } from './install/quirkyd-remote-preflight'
import {
  recordedNodeRuntimeProbeCommand,
  recordedRemoteNodeRuntimeProbeCommand
} from './install/quirkyd-remote-node-runtime-recorded-probe'
import { runtimeStoreInventoryCommand } from './install/remote-node-runtime-store-inventory'
import { posixReleaseOwnedLockCommand } from './install/remote-node-runtime-store-lock'
import { QUIRKYD_INSTALL_MODEL } from './install/remote-install-model'
import { stopQuirkydCommand } from './install/quirkyd-remote-process-control'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  orphanInstallLockCommand,
  probeInstallLockExistsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './install/remote-install-lock-commands'
import { quirkydLogTailCommand } from './install/quirkyd-remote-log-tail'
import {
  quirkydReadinessWaitCommand,
  readQuirkydReadinessNowCommand
} from './install/quirkyd-remote-readiness-wait'
import { quirkydPosixStdioBridgeCommand } from './lifecycle/quirkyd-stdio-bridge-script'

// Why 6 KB: gateways cut exec requests near 10 KB (#30491). This bounds the wire string: the
// fence-guarded command, wrapped uncompressed as a host without gzip/base64 receives it.
const POSIX_HOST_OP_BYTE_BUDGET = 6 * 1024

// Ops already past the budget, at their measured size. Ceilings may only shrink.
const OVER_BUDGET_CEILINGS: Readonly<Record<string, number>> = {
  tryStealInstallLockCommand: 9_022,
  quirkydLaunchCommand: 7_130
}

type HostCase = { host: RemoteHostPlatform; target: NodeRuntimeTarget; nodePath: string }

// Realistic worst case: a long NFS home, a long account name and a held activation fence.
const home = `/net/nfs-home-cluster-03/users/engineering/${'a'.repeat(48)}.longname`
const baseDir = `${home}/.quirky-remote`
const slotDir = `${baseDir}/quirkyd-1.4.299-rc.12+${'f'.repeat(40)}`
const userDataDir = `${baseDir}/quirkyd-data`
const snapshotDir = `${baseDir}/quirkyd-snapshots/pre-1.4.299-rc.12-1760000000000`
const installLock = `${slotDir}.install-lock`
const token = 'f'.repeat(64)
const fence: QuirkydFence = { lockDir: `${baseDir}/quirkyd-activation.lock`, token }
const owner = { fileName: 'owner', token }

function hostCase(platform: 'linux-x64' | 'darwin-arm64', target: NodeRuntimeTarget): HostCase {
  const nodePath = `${baseDir}/node-runtimes/v22.20.0-${target}/bin/node`
  return { host: getRemoteHostPlatform(platform), target, nodePath }
}

const HOST_CASES: readonly HostCase[] = [
  hostCase('linux-x64', 'linux-x64-glibc'),
  hostCase('darwin-arm64', 'darwin-arm64')
]

function launchSpec(nodePath: string): Parameters<typeof quirkydLaunchCommand>[1] {
  return {
    remoteInstallDir: slotDir,
    nodePath,
    fullVersion: '1.4.299-rc.12',
    userDataDir,
    bindHost: '127.0.0.1',
    port: 65535,
    activationRoot: `${baseDir}/quirkyd-activation`
  }
}

function promoteArgs({
  nodePath,
  target
}: HostCase): Parameters<typeof promoteRemoteNodeRuntimeCommand>[1] {
  return {
    stageDir: `${nodePath}.stage-${token}`,
    archive: `${baseDir}/node-runtimes/archive.tar.xz`,
    runtimeDir: nodePath,
    target,
    token
  }
}

const BUILDERS: Readonly<Record<string, (c: HostCase) => string>> = {
  serializedStateMutationCommand: () => serializedStateMutationCommand(baseDir, ':', 20, fence),
  // As activation runs it: pruning every other capture but the recorded one.
  captureQuirkydStateSnapshotCommand: ({ host }) =>
    captureQuirkydStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir, {
      snapshotsRoot: `${baseDir}/quirkyd-snapshots`,
      keep: [snapshotDir.slice(snapshotDir.lastIndexOf('/') + 1), 'pre-1.4.298-rc.3-1750000000000']
    }),
  probeQuirkydStateSnapshotCommand: ({ host }) =>
    probeQuirkydStateSnapshotCommand(host, snapshotDir, baseDir),
  restoreQuirkydStateSnapshotCommand: ({ host }) =>
    restoreQuirkydStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  clearQuirkydStateSnapshotMembersCommand: ({ host }) =>
    clearQuirkydStateSnapshotMembersCommand(host, userDataDir, baseDir),
  compareQuirkydStateSnapshotCommand: ({ host }) =>
    compareQuirkydStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  newestStateMtimeCommand: ({ host }) => newestStateMtimeCommand(host, userDataDir, baseDir),
  quirkydSnapshotSpaceCommand: ({ host }) =>
    quirkydSnapshotSpaceCommand(host, userDataDir, snapshotDir, baseDir, ['keep-a', 'keep-b']) ??
    '',
  posixProcessGroupCommand: () => posixProcessGroupCommand('"$pid"'),
  quirkydMachineClaimCommand: ({ host }) => quirkydMachineClaimCommand(host, home, 'k'.repeat(64)),
  quirkydMachineHomeProbeCommand: ({ host }) => quirkydMachineHomeProbeCommand(host),
  selectQuirkydSlotEntryCommand: ({ host }) => selectQuirkydSlotEntryCommand(host, slotDir),
  quirkydNodeSlotRuntimeCommand: ({ host }) => quirkydNodeSlotRuntimeCommand(host, slotDir),
  selectQuirkydSlotRuntimeCommand: ({ host, nodePath }) =>
    selectQuirkydSlotRuntimeCommand(host, slotDir, nodePath),
  // As SSH launches it; on macOS it embeds the launch-session capture and record.
  quirkydLaunchCommand: ({ host, nodePath }) =>
    quirkydLaunchCommand(host, launchSpec(nodePath), 'nohup', []),
  'quirkydLaunchCommand (WSL setsid)': ({ host, nodePath }) =>
    quirkydLaunchCommand(host, launchSpec(nodePath), 'setsid', [
      ['QUIRKY_EXAMPLE_HOST_ENV', 'x'.repeat(200)]
    ]),
  readQuirkydReadinessCommand: ({ host }) => readQuirkydReadinessCommand(host, slotDir),
  quirkydLivenessProbeCommand: ({ host }) => quirkydLivenessProbeCommand(host, slotDir),
  remoteSha256Command: ({ nodePath }) => remoteSha256Command(`'${nodePath}'`),
  remoteFreeSpaceProbeCommand: ({ nodePath }) => remoteFreeSpaceProbeCommand(nodePath),
  hostDownloadNodeRuntimeCommand: ({ host, nodePath, target }) =>
    hostDownloadNodeRuntimeCommand(host, { stageDir: `${nodePath}.stage-${token}`, target }),
  createExecProbedStageCommand: ({ host, nodePath }) =>
    createExecProbedStageCommand(host, `${nodePath}.stage-${token}`),
  probeRemoteNodeRuntimeCommand: ({ host, nodePath, target }) =>
    probeRemoteNodeRuntimeCommand(host, nodePath, target),
  remoteNodeRuntimePresentCommand: ({ host, nodePath }) =>
    remoteNodeRuntimePresentCommand(host, nodePath, true),
  promoteRemoteNodeRuntimeCommand: (c) => promoteRemoteNodeRuntimeCommand(c.host, promoteArgs(c)),
  recheckAndPromoteRemoteNodeRuntimeCommand: (c) =>
    recheckAndPromoteRemoteNodeRuntimeCommand(c.host, promoteArgs(c)),
  installNodeRuntimeFromHostArchiveCommand: ({ host, nodePath, target }) =>
    installNodeRuntimeFromHostArchiveCommand(host, {
      runtimeDir: nodePath,
      archive: `${baseDir}/node-runtimes/archive.tar.xz`,
      target,
      token
    }),
  remoteQuirkydBuildHashCommand: ({ host }) => remoteQuirkydBuildHashCommand(host, slotDir),
  sweepStaleRuntimeStagesCommand: ({ host }) =>
    sweepStaleRuntimeStagesCommand(`${baseDir}/node-runtimes`, host),
  quirkydProfilePreflightCommand: ({ host }) =>
    quirkydProfilePreflightCommand(host, slotDir, token),
  recordedNodeRuntimeProbeCommand: ({ host, nodePath }) =>
    recordedNodeRuntimeProbeCommand(host, nodePath, token),
  recordedRemoteNodeRuntimeProbeCommand: ({ host, nodePath, target }) =>
    recordedRemoteNodeRuntimeProbeCommand(host, nodePath, target),
  runtimeStoreInventoryCommand: ({ host }) => runtimeStoreInventoryCommand(host, home),
  stopQuirkydCommand: ({ host, nodePath }) =>
    stopQuirkydCommand(host, slotDir, { waitSeconds: 30, nodePath }),
  acquireInstallLockParentCommand: ({ host }) => acquireInstallLockParentCommand(host, baseDir),
  tryCreateInstallLockCommand: ({ host }) => tryCreateInstallLockCommand(host, installLock, owner),
  probeInstallLockExistsCommand: ({ host }) => probeInstallLockExistsCommand(host, installLock),
  lockAgeSecondsCommand: ({ host }) => lockAgeSecondsCommand(host, installLock),
  orphanInstallLockCommand: ({ host }) => orphanInstallLockCommand(host, installLock),
  tryStealInstallLockCommand: ({ host }) =>
    tryStealInstallLockCommand(host, installLock, 120, owner, {
      ...owner,
      quietSeconds: 60,
      mutationLock: `${baseDir}/quirkyd-state-mutation.lock`
    }),
  quirkydLogTailCommand: ({ host }) => quirkydLogTailCommand(host, slotDir),
  quirkydReadinessWaitCommand: ({ host }) => quirkydReadinessWaitCommand(host, slotDir, 120),
  readQuirkydReadinessNowCommand: ({ host }) => readQuirkydReadinessNowCommand(host, slotDir),
  quirkydPosixStdioBridgeCommand: () => quirkydPosixStdioBridgeCommand(65535),
  posixReleaseFenceCommand: () =>
    posixReleaseFenceCommand(
      fence,
      `${baseDir}/quirkyd-activation/journal.json`,
      `${baseDir}/quirkyd-activation`
    ),
  posixReleaseOwnedLockCommand: ({ host }) =>
    `${posixReleaseOwnedLockCommand(host, `${baseDir}/node-runtimes/.store-lock`, owner)} || true`,
  executablePermissionsCommand: ({ host, target }) =>
    executablePermissionsCommand(host, slotDir, target),
  readRemoteHomeCommand: ({ host }) => readRemoteHomeCommand(host),
  removeRemoteFileCommand: ({ host }) => removeRemoteFileCommand(host, `${slotDir}/.quirkyd-pid`),
  removeRemoteTreeCommand: ({ host }) => removeRemoteTreeCommand(host, slotDir),
  moveRemoteTreeCommand: ({ host }) =>
    moveRemoteTreeCommand(host, slotDir, `${slotDir}.trash-${token}`),
  restoreRemoteTreeCommand: ({ host }) =>
    restoreRemoteTreeCommand(host, `${slotDir}.trash-${token}`, slotDir),
  writeRemoteEmptyFileCommand: ({ host }) =>
    writeRemoteEmptyFileCommand(host, `${slotDir}/.complete`),
  probeRemoteInstallCompleteCommand: ({ host }) =>
    probeRemoteInstallCompleteCommand(host, slotDir, [
      ...QUIRKYD_INSTALL_MODEL.requiredArtifacts(host),
      QUIRKYD_INSTALL_MODEL.installCompleteFilename
    ]),
  listRemoteInstallBaseDirsCommand: ({ host }) =>
    listRemoteInstallBaseDirsCommand(host, baseDir, QUIRKYD_INSTALL_MODEL),
  probeFileExistsCommand: ({ host }) => probeFileExistsCommand(host, `${slotDir}/.complete`),
  captureQuirkydLaunchSshSessionCommand: () => captureQuirkydLaunchSshSessionCommand(),
  writeQuirkydLaunchSshSessionCommand: ({ host }) =>
    writeQuirkydLaunchSshSessionCommand(host, userDataDir),
  quirkydLaunchSshSessionProbeCommand: ({ host }) =>
    quirkydLaunchSshSessionProbeCommand(host, slotDir, userDataDir),
  initialQuirkydActivationAdmissionCommand: ({ host, nodePath }) =>
    initialQuirkydActivationAdmissionCommand(host, userDataDir, slotDir, nodePath),
  makeExecStdinWriteFileCommand: () =>
    makeExecStdinWriteFileCommand(`${slotDir}/quirkyd.js`, Number.MAX_SAFE_INTEGER, {
      token,
      executable: true
    }),
  makePosixWriteFileCommand: () =>
    makePosixWriteFileCommand(`${slotDir}/quirkyd.js`, { exclusive: true })
}

// Exported builders that never produce a POSIX host op, and why.
const NOT_POSIX_HOST_OPS: Readonly<Record<string, string>> = {
  powerShellCommand: 'builds the Windows PowerShell exec line',
  spawnProxyCommand: 'spawns a local ProxyCommand process',
  buildSshLoginShellCommand: 'wraps a caller-built op in the login shell',
  isSnapshotCaptureCommand: 'a predicate over a command, not a builder',
  execCommand: 'the exec entry point every measured op goes through',
  execHostCommand: 'the exec entry point every measured op goes through',
  spawnSystemSshCommand: 'spawns the local ssh client'
}

// Not ssh/legacy-relay: the legacy relay retires 2027-01-15.
const SCANNED_DIRS = [
  ...['host-state', 'install', 'lifecycle', 'activation'].map((dir) => join(__dirname, dir)),
  join(__dirname, '..', 'ssh'),
  ...['system-transport', 'connection', 'remote-exec'].map((dir) =>
    join(__dirname, '..', 'ssh', dir)
  )
]

function exportedCommandBuilders(): string[] {
  const names: string[] = []
  for (const root of SCANNED_DIRS) {
    for (const file of readdirSync(root)) {
      if (
        !file.endsWith('.ts') ||
        /\.test(-fixture)?\.ts$/.test(file) ||
        file.endsWith('.spec.ts')
      ) {
        continue
      }
      if (/windows/i.test(file)) {
        continue
      }
      const source = readFileSync(join(root, file), 'utf8')
      for (const match of source.matchAll(/^export (?:async )?function (\w+Command)\(/gm)) {
        names.push(match[1])
      }
    }
  }
  return names.sort()
}

// The largest wire string across POSIX host OSes; guarded even where the op can run unfenced.
async function sentBytes(build: (c: HostCase) => string): Promise<number> {
  let max = 0
  for (const c of HOST_CASES) {
    const command = await runWithQuirkydFence(fence, async () => build(c))
    // execCommand frames stdout before the transport wraps; 16 chars is the longest real nonce.
    const framed = buildPosixStdoutFence(
      `${posixQuirkydFenceGuard(fence)} ${command}`,
      'SSH',
      'z'.repeat(16)
    ).command
    const sent = wrapRemoteCommandForPosixShell(framed, { compress: false })
    max = Math.max(max, Buffer.byteLength(sent, 'utf8'))
  }
  return max
}

describe('POSIX host-op byte budget', () => {
  it('measures every exported POSIX host-op builder', () => {
    const unmeasured = exportedCommandBuilders().filter(
      (name) => !(name in BUILDERS) && !(name in NOT_POSIX_HOST_OPS)
    )
    expect(unmeasured).toEqual([])
  })

  it.each(Object.keys(BUILDERS))('%s stays under the sent byte budget', async (name) => {
    const bytes = await sentBytes(BUILDERS[name])
    const ceiling = OVER_BUDGET_CEILINGS[name]
    if (ceiling === undefined) {
      expect(bytes).toBeLessThanOrEqual(POSIX_HOST_OP_BYTE_BUDGET)
      return
    }
    // A listed op must stay listed only while it is actually over budget.
    expect(bytes).toBeGreaterThan(POSIX_HOST_OP_BYTE_BUDGET)
    expect(bytes).toBeLessThanOrEqual(ceiling)
  })
})
