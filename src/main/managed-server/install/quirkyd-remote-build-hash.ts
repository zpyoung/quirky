/** The installed entry bytes, hashed as the server reports them for activation and rollback. */
import { QUIRKYD_LAUNCHER_FILENAME } from '../../../shared/quirkyd-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { execQuirkydRemote, type QuirkydRemoteExecTarget } from './quirkyd-remote-runtime-control'
import { quirkydWindowsSlotOpCommand } from './quirkyd-remote-windows-node'
import { QUIRKYD_BUILD_HASH_MARKER as BUILD_HASH_MARKER } from '../host-state/quirkyd-windows-host-script'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

export async function readRemoteQuirkydBuildHash(
  target: QuirkydRemoteExecTarget,
  remoteInstallDir: string
): Promise<string> {
  const output = await execQuirkydRemote(
    target,
    remoteQuirkydBuildHashCommand(target.host, remoteInstallDir)
  )
  const match = output.match(new RegExp(`${BUILD_HASH_MARKER}\\s+([a-fA-F0-9]{16})`, 'u'))
  if (!match?.[1]) {
    throw new Error('Could not verify the installed quirkyd build hash.')
  }
  return match[1].toLowerCase()
}

export function remoteQuirkydBuildHashCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return quirkydWindowsSlotOpCommand(host, remoteInstallDir, 'build-hash', [
      joinRemotePath(host, remoteInstallDir, QUIRKYD_LAUNCHER_FILENAME)
    ])
  }
  const path = quotePosixShell(joinRemotePath(host, remoteInstallDir, QUIRKYD_LAUNCHER_FILENAME))
  // Why both tools: GNU/busybox ship sha256sum, macOS ships shasum; either prints the digest first.
  return [
    `[ -f ${path} ] && [ -r ${path} ] || exit 1;`,
    `quirky_hash=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum ${path} | awk '{print $1}';`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${path} | awk '{print $1}'; fi);`,
    `case "$quirky_hash" in [0-9a-fA-F][0-9a-fA-F]*) printf '%s %.16s\\n' ${quotePosixShell(BUILD_HASH_MARKER)} "$quirky_hash";; esac`
  ].join(' ')
}
