import { randomUUID } from 'node:crypto'
import { QUIRKYD_NODE_RUNTIME_IDENTITY } from '../../../shared/quirkyd-node-runtime-identity'
import { QUIRKYD_NODE_RUNTIME_MARKER_FILENAME } from '../../../shared/quirkyd-artifacts'
import {
  QUIRKYD_PROFILE_PREFLIGHT_FLAG,
  QUIRKYD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseQuirkydProfilePreflight
} from '../../../shared/quirkyd-profile-preflight'
import { assertPosixQuirkydHost } from './quirkyd-remote-host-support'
import {
  quirkydWindowsNodeCommandLine,
  quirkydWindowsSlotOpCommand,
  readQuirkydWindowsEncodedAnswer
} from './quirkyd-remote-windows-node'
import { readWindowsQuirkydSlotEntry } from './quirkyd-remote-launch-windows'
import { QUIRKYD_WINDOWS_RUNTIME_MARKER } from '../host-state/quirkyd-windows-host-script'
import {
  quirkydNodeSlotRuntimeCommand,
  selectQuirkydSlotEntryCommand
} from './quirkyd-remote-runtime'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'

export function quirkydProfilePreflightCommand(
  host: RemoteHostPlatform,
  directory: string,
  nonce: string
): string {
  assertPosixQuirkydHost(host)
  // Why no host-Node fallback: a candidate this client installed is always a Node slot.
  const marker = quotePosixShell(
    joinRemotePath(host, directory, QUIRKYD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const launch = [
    'QUIRKY_BACKGROUND_LAUNCH=1',
    '"$quirkyd_runtime"',
    '"$quirkyd_entry"',
    QUIRKYD_PROFILE_PREFLIGHT_FLAG,
    quotePosixShell(nonce)
  ].join(' ')
  return `[ -e ${marker} ] || exit 78; ${quirkydNodeSlotRuntimeCommand(host, directory)}${selectQuirkydSlotEntryCommand(host, directory)}; ${launch}`
}

/** Failure leaves the incumbent and its data untouched, including an unconfirmed SSH exit. */
export async function preflightInstalledQuirkyd(options: {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  remoteInstallDir: string
  fullVersion: string
  signal?: AbortSignal
}): Promise<void> {
  const nonce = randomUUID()
  const command = isWindowsRemoteHost(options.host)
    ? await windowsQuirkydProfilePreflightCommand(options, nonce)
    : quirkydProfilePreflightCommand(options.host, options.remoteInstallDir, nonce)
  const output = await execCommand(options.conn, command, {
    signal: options.signal,
    timeoutMs: QUIRKYD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    wrapCommand: !isWindowsRemoteHost(options.host)
  })
  parseQuirkydProfilePreflight(output, nonce, QUIRKYD_NODE_RUNTIME_IDENTITY, options.fullVersion)
}

/**
 * Windows: resolve the slot's node.exe, then run its selected entry with plain argv. No
 * QUIRKY_BACKGROUND_LAUNCH here: quirkyd opens no window, and argv cannot set environment.
 */
async function windowsQuirkydProfilePreflightCommand(
  options: {
    conn: QuirkydHostTransport
    host: RemoteHostPlatform
    remoteInstallDir: string
    signal?: AbortSignal
  },
  nonce: string
): Promise<string> {
  const { host, remoteInstallDir } = options
  const slotAnswer = await execCommand(
    options.conn,
    quirkydWindowsSlotOpCommand(host, remoteInstallDir, 'slot-runtime', [remoteInstallDir]),
    { signal: options.signal, wrapCommand: false }
  )
  const runtime = readQuirkydWindowsEncodedAnswer(slotAnswer, QUIRKYD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this quirkyd slot needs.')
  }
  return quirkydWindowsNodeCommandLine(runtime, [
    readWindowsQuirkydSlotEntry(slotAnswer, host, remoteInstallDir),
    QUIRKYD_PROFILE_PREFLIGHT_FLAG,
    nonce
  ])
}
