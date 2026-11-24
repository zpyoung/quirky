/** Everything a managed-quirkyd operation needs to know about one host (SSH or WSL) before it acts. */
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { SshTarget } from '../../../shared/ssh-types'
import type { QuirkydActivationRecord } from '../activation/quirkyd-activation-record'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import { resolveQuirkydRuntimeTarget } from '../lifecycle/quirkyd-runtime-target'
import { prepareWindowsQuirkydHost } from '../host-state/quirkyd-windows-host-preparation'
import type { QuirkydHostTarget, QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import {
  decideQuirkydMachineHome,
  quirkydMachineDataRoot,
  quirkydMachineHomeDir,
  quirkydMachineHomeProbeCommand,
  quirkydMachineOwnershipUnresolvedMessage,
  parseQuirkydMachineHomeProbe
} from '../host-state/quirkyd-machine-home'
import {
  quirkydMachineClaimCommand,
  readQuirkydMachineClaimAnswer
} from '../host-state/quirkyd-machine-claim-command'
import { execQuirkydRemote, type QuirkydRemoteExecTarget } from './quirkyd-remote-runtime-control'
import { readRemoteHomeCommand } from '../../ssh/ssh-remote-commands'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { detectRemoteHostPlatform } from '../../ssh/ssh-remote-platform-detection'
import { QuirkydHostUnsupportedError } from '../../quirkyd/quirkyd-host-unavailable'
import { rememberSshHostPlatform } from '../../ssh/ssh-host-platform-memo'

/** Defaults to SSH: most lifecycle code still reads SSH-only target fields. */
export type QuirkydRemoteContext<Target extends QuirkydHostTarget = SshTarget> = {
  activationRecord: QuirkydActivationRecord
  /** A compat runtime on hosts below the default runtime's glibc floor (design D6 rung B). */
  serverTarget: NodeRuntimeTarget
  connection: QuirkydHostTransport
  host: RemoteHostPlatform
  /**
   * What `~/.quirky-remote` hangs off: the login home, or this machine's own home when several
   * machines share one (see `quirkyd-machine-home.ts`). `userDataDir` follows the same choice.
   */
  remoteHome: string
  target: Target
  userDataDir: string
}

export async function resolveQuirkydRemoteContext<Target extends QuirkydHostTarget = SshTarget>(
  target: Target,
  connection: QuirkydHostTransport,
  signal?: AbortSignal,
  detectedHost?: RemoteHostPlatform
): Promise<QuirkydRemoteContext<Target>> {
  const host = detectedHost ?? (await detectRemoteHostPlatform(connection, { signal }))
  if (!host) {
    throw new QuirkydHostUnsupportedError(
      'Quirky’s server doesn’t support this SSH host’s platform.'
    )
  }
  const remote = { conn: connection, host, signal }
  const { quirkydHome: remoteHome, userDataDir } = await resolveQuirkydMachineHome(remote, true)
  const serverTarget = await resolveQuirkydRuntimeTarget({
    conn: connection,
    host,
    signal
  })
  rememberSshHostPlatform(target.id, host, serverTarget)
  if (isWindowsRemoteHost(host)) {
    // Every Windows host op, the activation record read included, runs on the pinned node.exe.
    await prepareWindowsQuirkydHost({
      conn: connection,
      host,
      remoteHome,
      serverTarget,
      signal
    })
  }
  const activationRecord = await readQuirkydActivationRecord({
    ...remote,
    remoteHome
  })
  return {
    activationRecord,
    serverTarget,
    connection,
    host,
    remoteHome,
    target,
    userDataDir
  }
}

/**
 * The directory quirkyd's state hangs off on this machine: the login home, or this machine's own
 * home under it. Windows and WSL keep the login home: neither shares one across machines.
 */
export async function resolveQuirkydMachineHome(
  remote: QuirkydRemoteExecTarget,
  keyByMachine: boolean
): Promise<{ loginHome: string; quirkydHome: string; userDataDir: string }> {
  const { host } = remote
  if (!keyByMachine || isWindowsRemoteHost(host)) {
    const loginHome = normalizeRemoteHome(
      await execQuirkydRemote(remote, readRemoteHomeCommand(host)),
      host
    )
    if (!validateRemoteHome(loginHome, host)) {
      throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
    }
    return {
      loginHome,
      quirkydHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.quirky')
    }
  }
  const probe = parseQuirkydMachineHomeProbe(
    await execQuirkydRemote(remote, quirkydMachineHomeProbeCommand(host)),
    host
  )
  const { loginHome } = probe
  let decision = decideQuirkydMachineHome(probe, host)
  if (decision.kind === 'unresolved') {
    throw new Error(
      quirkydMachineOwnershipUnresolvedMessage(
        decision.machineKey,
        probe.identity?.hostname ?? null,
        decision.cause
      )
    )
  }
  if (decision.kind === 'claim') {
    const won = readQuirkydMachineClaimAnswer(
      await execQuirkydRemote(
        remote,
        quirkydMachineClaimCommand(host, loginHome, decision.machineKey)
      )
    )
    if (won.state !== 'present') {
      throw new Error(won.message)
    }
    decision =
      won.machineKey === decision.machineKey
        ? { kind: 'login-home' }
        : { kind: 'machine-home', machineKey: decision.machineKey }
  }
  if (decision.kind === 'login-home') {
    return {
      loginHome,
      quirkydHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.quirky')
    }
  }
  const quirkydHome = quirkydMachineHomeDir(host, loginHome, decision.machineKey)
  await execQuirkydRemote(remote, `umask 077; mkdir -p ${quotePosixShell(quirkydHome)}`)
  return {
    loginHome,
    quirkydHome,
    userDataDir: quirkydMachineDataRoot(host, loginHome, decision.machineKey)
  }
}
