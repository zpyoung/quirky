/**
 * Starting a candidate quirkyd on a Windows SSH host.
 *
 * Win32-OpenSSH kills the session's job when the session ends, so quirkyd must leave that job.
 * The server entry's `--windows-breakaway-launch` mode does it the way the relay does: one CreateProcessW with
 * CREATE_BREAKAWAY_FROM_JOB through the slot's staged process-tree addon. Unlike the relay there
 * is no WMI fallback: Win32_Process.Create is EDR-scored remote execution and refused to a
 * standard user's network logon, so a host that cannot break away refuses the launch.
 *
 * Two execs, neither through PowerShell: the host script resolves the runtime the slot's marker
 * names (and drops a stale stop request), then that node.exe runs the launcher with plain argv.
 * The launcher records the PID with its creation time; a PID alone is not an identity on Windows.
 */
import {
  QUIRKYD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_ENV_FLAG,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG
} from '../../../shared/windows-breakaway-launch'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  quirkydWindowsNodeCommandLine,
  quirkydWindowsSlotOpCommand,
  readQuirkydWindowsEncodedAnswer
} from './quirkyd-remote-windows-node'
import {
  QUIRKYD_WINDOWS_ENTRY_MARKER,
  QUIRKYD_WINDOWS_RUNTIME_MARKER
} from '../host-state/quirkyd-windows-host-script'
import {
  QUIRKYD_LOG_FILENAME,
  QUIRKYD_READINESS_FILENAME,
  QUIRKYD_WINDOWS_PROCESS_FILENAME
} from './quirkyd-remote-host-support'
import { quirkydManagedLaunchEnv, type QuirkydLaunchSpec } from './quirkyd-remote-launch'
import { QUIRKYD_WINDOWS_LAUNCH_REFUSED_CODE } from '../../quirkyd/quirkyd-host-unavailable'

export class QuirkydWindowsLaunchRefusedError extends Error {
  readonly code = QUIRKYD_WINDOWS_LAUNCH_REFUSED_CODE
  constructor(reason: string) {
    super(
      `The Windows host refused to start quirkyd outside the SSH session (${reason}). quirkyd needs ` +
        'a job that allows breakaway and a slot with the process-tree launcher; it never falls ' +
        'back to WMI.'
    )
    this.name = 'QuirkydWindowsLaunchRefusedError'
  }
}

/** Resolves the slot's node.exe and clears a stop request the previous process never consumed. */
export function windowsQuirkydLaunchRuntimeCommand(
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return quirkydWindowsSlotOpCommand(host, slotDir, 'slot-runtime', [slotDir, 'clear-stop-request'])
}

export function readWindowsQuirkydSlotRuntime(output: string): string {
  const runtime = readQuirkydWindowsEncodedAnswer(output, QUIRKYD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this quirkyd slot needs.')
  }
  return runtime
}

/** Older host-script answers omit the entry; those slots used the single-file launcher. */
export function readWindowsQuirkydSlotEntry(
  output: string,
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return (
    readQuirkydWindowsEncodedAnswer(output, QUIRKYD_WINDOWS_ENTRY_MARKER) ??
    joinRemotePath(host, slotDir, 'quirkyd.js')
  )
}

export function windowsQuirkydLaunchCommand(
  host: RemoteHostPlatform,
  spec: QuirkydLaunchSpec,
  slotRuntime: string,
  slotEntry = joinRemotePath(host, spec.remoteInstallDir, 'quirkyd.js')
): string {
  const dir = spec.remoteInstallDir
  return quirkydWindowsNodeCommandLine(slotRuntime, [
    slotEntry,
    WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    // The addon creates both with CREATE_ALWAYS, so a previous run's readiness line is gone
    // before the launcher returns.
    WINDOWS_BREAKAWAY_STDOUT_FLAG,
    joinRemotePath(host, dir, QUIRKYD_READINESS_FILENAME),
    WINDOWS_BREAKAWAY_STDERR_FLAG,
    joinRemotePath(host, dir, QUIRKYD_LOG_FILENAME),
    // POSIX appends quirkyd.log; keep the last run's (a crash cause) across a restart here too.
    WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
    WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
    joinRemotePath(host, dir, QUIRKYD_WINDOWS_PROCESS_FILENAME),
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `QUIRKY_VERSION=${spec.fullVersion}`,
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `QUIRKY_USER_DATA=${spec.userDataDir}`,
    ...quirkydManagedLaunchEnv(spec).flatMap(([name, value]) => [
      WINDOWS_BREAKAWAY_ENV_FLAG,
      `${name}=${value}`
    ]),
    QUIRKYD_WINDOWS_BREAKAWAY_CONTRACT.argsFlag,
    '--json',
    '--bind',
    spec.bindHost,
    '--port',
    String(spec.port)
  ])
}

/** The launched PID, or a refusal (no breakaway route) or failure the deploy must surface. */
export function readWindowsQuirkydLaunchReport(output: string): number {
  const report = parseWindowsBreakawayLaunchReport(QUIRKYD_WINDOWS_BREAKAWAY_CONTRACT, output)
  if (report?.method === 'breakaway') {
    return report.pid
  }
  if (report?.method === 'unavailable') {
    throw new QuirkydWindowsLaunchRefusedError(
      report.step ? `${report.reason} at ${report.step}` : report.reason
    )
  }
  const detail =
    report?.method === 'failed'
      ? `${report.reason}${report.step ? ` at ${report.step}` : ''} (code ${String(report.code ?? 0)})`
      : 'no launch report'
  throw new Error(`quirkyd's Windows launcher did not start the candidate: ${detail}.`)
}
