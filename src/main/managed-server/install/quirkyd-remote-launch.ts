/**
 * Starting a candidate quirkyd on the host and reading back what it says about itself.
 *
 * This is the piece `docs/design/shipping-quirkyd.html` §02 marks **fork**, not reuse: the
 * relay launches detached and proves itself by printing an `QUIRKY-RELAY` sentinel, and quirkyd
 * has no such interface. It publishes a single `quirky_server_ready` JSON line on stdout,
 * carrying the health payload activation is gated on — so the handshake here is "capture
 * that line", not "match a marker".
 *
 * The candidate is launched detached with stdout redirected to a file inside its own version
 * directory. Reading readiness off the exec channel would mean holding the channel open for
 * the process's whole life; redirecting means the deploy can disconnect and the supervisor
 * still owns a running service.
 */
import type { QuirkydLaunchEnvEntry } from '../../ssh/quirkyd-host-transport'
import {
  QUIRKYD_LAUNCHER_FILENAME,
  QUIRKYD_SERVER_ENTRY_FILENAME
} from '../../../shared/quirkyd-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  remoteDirname,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { QUIRKYD_WSL_HOST_ENV } from '../../ipc/wsl-guest-windows-drive-path'
import {
  assertPosixQuirkydHost as assertPosixHost,
  QUIRKYD_LOG_FILENAME,
  QUIRKYD_PID_FILENAME,
  QUIRKYD_READINESS_FILENAME,
  QUIRKYD_READINESS_MAX_BYTES,
  posixProcessAliveShellFunction
} from './quirkyd-remote-host-support'
import type { ServeReadiness } from '../../server/serve-readiness'
import { selectQuirkydSlotRuntimeCommand } from './quirkyd-remote-runtime'
import { QUIRKYD_STOP_REQUEST_FILENAME } from '../../../shared/quirkyd-stop-request'
import { quirkydWindowsSlotOpCommand } from './quirkyd-remote-windows-node'
import {
  captureQuirkydLaunchSshSessionCommand,
  recordsQuirkydLaunchSshSession,
  writeQuirkydLaunchSshSessionCommand
} from '../../ssh/quirkyd-launch-ssh-session'
import {
  QUIRKYD_E2E_IDLE_TIMEOUT_ENV,
  readQuirkydE2EIdleTimeoutMs
} from '../../../shared/quirkyd-idle-exit'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/quirkyd-managed-launch-env'

export type QuirkydLaunchSpec = {
  remoteInstallDir: string
  nodePath: string
  fullVersion: string
  /** Shared across versions, and the reason rollback needs a snapshot. */
  userDataDir: string
  /** Loopback by default; the client reaches it through an SSH local port-forward. */
  bindHost: string
  port: number
  /** The host's activation fence. Every SSH launch is client-managed, so every one may idle out. */
  activationRoot: string
}

/** Env a managed launch adds; an older quirkyd ignores both. */
export function quirkydManagedLaunchEnv(
  spec: QuirkydLaunchSpec,
  env: NodeJS.ProcessEnv = process.env
): [string, string][] {
  const e2eTimeout = readQuirkydE2EIdleTimeoutMs(env)
  return [
    [QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV, spec.activationRoot],
    ...(e2eTimeout === null
      ? []
      : [[QUIRKYD_E2E_IDLE_TIMEOUT_ENV, String(e2eTimeout)] satisfies [string, string]])
  ]
}

/**
 * How the candidate leaves the exec's session. `nohup … &` dies with its `wsl.exe --exec` session
 * on a distro without systemd, so a WSL slot starts in a session of its own.
 */
export type QuirkydLaunchDetach = 'nohup' | 'setsid'

const QUIRKYD_SETSID_PID_WAIT_TRIES = 100

/**
 * Launch the candidate detached and echo its PID.
 *
 * Why `--bind` is always passed explicitly: quirkyd defaults to loopback, but a default is a
 * thing a future version can change. The deploy states the posture it intends rather than
 * inheriting whatever the installed build happens to default to.
 */
export function quirkydLaunchCommand(
  host: RemoteHostPlatform,
  spec: QuirkydLaunchSpec,
  detach: QuirkydLaunchDetach = 'nohup',
  hostEnv: readonly QuirkydLaunchEnvEntry[] = []
): string {
  assertPosixHost(host)
  const dir = quotePosixShell(spec.remoteInstallDir)
  // Relative to the `cd` below, which every use follows in the same shell: the slot path is most
  // of the sent bytes.
  const readiness = quotePosixShell(QUIRKYD_READINESS_FILENAME)
  const log = quotePosixShell(QUIRKYD_LOG_FILENAME)
  // Absolute: a nohup launch backgrounds the whole list, `cd` included, then writes this outside it.
  const pidFile = quotePosixShell(joinRemotePath(host, spec.remoteInstallDir, QUIRKYD_PID_FILENAME))
  // Absolute: liveness matches the runtime's args against this path.
  const entry = quotePosixShell(
    joinRemotePath(host, spec.remoteInstallDir, QUIRKYD_LAUNCHER_FILENAME)
  )
  const baseDir = remoteDirname(spec.remoteInstallDir.replace(/\/+$/u, ''), host)
  // Only `~/.quirky-remote` itself; never tighten an unrelated parent a custom slot path names.
  const privateDirs = [
    ...(remoteBasename(baseDir, host) === RELAY_REMOTE_DIR ? [baseDir] : []),
    spec.remoteInstallDir
  ]
  // Why in the launching shell: the detached list below runs in a subshell whose variables are lost.
  const recordSession = detach === 'nohup' && recordsQuirkydLaunchSshSession(host)
  const launchEnv = [
    `QUIRKY_VERSION=${quotePosixShell(spec.fullVersion)}`,
    `QUIRKY_USER_DATA=${quotePosixShell(spec.userDataDir)}`,
    ...quirkydManagedLaunchEnv(spec).map(([name, value]) => `${name}=${quotePosixShell(value)}`)
  ]
  return [
    ...(recordSession ? [captureQuirkydLaunchSshSessionCommand()] : []),
    // The daemon gets this back: the git, terminals and agents it spawns create the user's files.
    'quirkyd_login_umask=$(umask);',
    // Why before anything is created: the readiness file carries the pairing offer's device token,
    // so every file this launch creates must be owner-only from birth. Why `;`: a nohup launch
    // backgrounds the `&&` list below, and the PID file is written outside it.
    'umask 077;',
    // Best effort: directories and files an earlier build left 0755/0644 keep their old modes.
    `{ chmod 700 ${privateDirs.map(quotePosixShell).join(' ')} 2>/dev/null || :; } &&`,
    `cd ${dir} &&`,
    `${selectQuirkydSlotRuntimeCommand(host, spec.remoteInstallDir, spec.nodePath)} &&`,
    // Why truncate: a re-launch into a dir that already holds a previous readiness line would
    // otherwise let the deploy activate on the OLD process's health payload.
    `: > ${readiness} &&`,
    // Required, not best effort: a truncating redirect keeps an earlier build's 0644 mode.
    `chmod 600 ${readiness} &&`,
    `{ chmod 600 ${pidFile} ${log} 2>/dev/null || :; } &&`,
    // A stop request the previous process never consumed must not stop this one.
    `rm -f ${quotePosixShell(QUIRKYD_STOP_REQUEST_FILENAME)} &&`,
    ...(detach === 'setsid' ? [`rm -f ${pidFile} &&`] : []),
    ...(detach === 'setsid'
      ? setsidLaunchTail(entry, spec, readiness, log, pidFile, launchEnv, hostEnv)
      : [
          // Why a group: its redirects open under 077 before the daemon gets the login umask back.
          '{ umask "$quirkyd_login_umask" &&',
          ...launchEnv,
          // Keep $! equal to the runtime PID rather than a waiting shell's PID.
          // Older clients identify the live PID by quirkyd.js; the pinned launcher loads the body in-place.
          `exec nohup "$quirkyd_runtime" ${entry}`,
          `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)};`,
          `} > ${readiness} 2>> ${log} < /dev/null &`,
          `echo $! > ${pidFile} &&`,
          ...(recordSession
            ? [`${writeQuirkydLaunchSshSessionCommand(host, spec.userDataDir)} &&`]
            : []),
          `cat ${pidFile}`
        ])
  ].join(' ')
}

/**
 * The forked child records its own PID (`$$` survives its exec into the runtime) because the
 * `setsid -f` parent exits at once. busybox `setsid` has no `-f`; backgrounding it is equivalent
 * there because a background child of a non-interactive shell never leads a process group.
 */
function setsidLaunchTail(
  entry: string,
  spec: QuirkydLaunchSpec,
  readiness: string,
  log: string,
  pidFile: string,
  launchEnv: readonly string[],
  hostEnv: readonly QuirkydLaunchEnvEntry[]
): string[] {
  return [
    ...launchEnv,
    // Only a setsid (WSL host) launch marks itself; SSH keeps its byte-for-byte command.
    `${QUIRKYD_WSL_HOST_ENV}=1`,
    ...hostEnv.map(([name, value]) => `${assertEnvName(name)}=${quotePosixShell(value)}`),
    'sh -c \'quirkyd_detach() { if setsid -f true >/dev/null 2>&1; then setsid -f "$@"; ' +
      'else setsid "$@" & fi; }; quirkyd_detach "$@"\' quirkyd-detach',
    // The PID file is written under 077 before the daemon gets the login umask back.
    `sh -c 'echo $$ > "$1" && umask "$2" && shift 2 && exec "$@"' quirkyd-launch ${pidFile}`,
    '"$quirkyd_login_umask"',
    `"$quirkyd_runtime" ${entry}`,
    `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)}`,
    `> ${readiness} 2>> ${log} < /dev/null &&`,
    `quirkyd_wait=0; while [ ! -s ${pidFile} ] && [ "$quirkyd_wait" -lt ${QUIRKYD_SETSID_PID_WAIT_TRIES} ];`,
    'do sleep 0.05; quirkyd_wait=$((quirkyd_wait + 1)); done;',
    `cat ${pidFile}`
  ]
}

function assertEnvName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`quirkyd_launch_env_name_invalid:${name}`)
  }
  return name
}

export function readQuirkydReadinessCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  assertPosixHost(host)
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, QUIRKYD_READINESS_FILENAME)
  )
  // One byte over the cap is enough to tell an oversized payload from a full one.
  return `head -c ${QUIRKYD_READINESS_MAX_BYTES + 1} ${readiness} 2>/dev/null || true`
}

/**
 * Is the process recorded in this version dir still running?
 *
 * Answers `LIVE`, `DEAD`, or `UNKNOWN`. `UNKNOWN` covers a missing or unparseable PID file
 * and a `kill -0` that failed for a reason other than "no such process" — a permission
 * error means someone else's process holds that PID, which is evidence of neither. A slot with
 * neither a PID file nor a readiness file (which a launch creates first) answers
 * `NEVER_LAUNCHED`: nothing was ever started from it, so like `DEAD` it is proven exit.
 */
export function quirkydLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    // Windows: PID plus process creation time (PIDs are reused); anything unanswerable is UNKNOWN, never DEAD.
    return quirkydWindowsSlotOpCommand(host, remoteInstallDir, 'liveness', [remoteInstallDir])
  }
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, QUIRKYD_PID_FILENAME))
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, QUIRKYD_READINESS_FILENAME)
  )
  const launcher = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, QUIRKYD_LAUNCHER_FILENAME)
  )
  const server = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, QUIRKYD_SERVER_ENTRY_FILENAME)
  )
  return [
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    // A PID is no identity once reused: a process whose command line does not run this slot's
    // entry is not it. No `ps` answer leaves the plain liveness check to decide.
    `quirkyd_launcher=${launcher}; quirkyd_server=${server};`,
    'quirkyd_reused() { args=$(ps -o args= -p "$1" 2>/dev/null) && [ -n "$args" ] && ' +
      'case "$args" in *"$quirkyd_launcher"* | *"$quirkyd_server"*) return 1;; *) return 0;; esac; };',
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in',
    `"" ) if [ -e ${pidFile} ] || [ -e ${readiness} ]; then echo UNKNOWN; else echo ${QUIRKYD_NEVER_LAUNCHED}; fi;;`,
    '*[!0-9]* ) echo UNKNOWN;;',
    '* ) if quirkyd_reused "$pid"; then echo DEAD; elif quirkyd_alive "$pid"; then echo LIVE; else echo DEAD; fi;;',
    'esac'
  ].join(' ')
}

export const QUIRKYD_NEVER_LAUNCHED = 'NEVER_LAUNCHED'

export type QuirkydLiveness = 'LIVE' | 'DEAD' | 'UNKNOWN' | typeof QUIRKYD_NEVER_LAUNCHED

/** The probe's last line; anything but a known word is `UNKNOWN`, never a guess. */
export function parseQuirkydLiveness(output: string): QuirkydLiveness {
  const value = output.trim().split('\n').pop()?.trim()
  return value === 'LIVE' || value === 'DEAD' || value === QUIRKYD_NEVER_LAUNCHED
    ? value
    : 'UNKNOWN'
}

/**
 * Proven exit: a dead PID, or a slot nothing was ever started from. `UNKNOWN` proves nothing,
 * so a reader that would start, replace or remove must not act on it.
 */
export function quirkydLivenessProvenExited(liveness: QuirkydLiveness): boolean {
  return liveness === 'DEAD' || liveness === QUIRKYD_NEVER_LAUNCHED
}

/** GC's reading of a liveness answer: a slot that never launched holds nothing and is removable. */
export function quirkydLivenessAnswerBlocksGc(output: string): boolean {
  return quirkydLivenessBlocksGc(parseQuirkydLiveness(output))
}

/** True when GC must leave this directory alone. Inconclusive counts as in use. */
export function quirkydLivenessBlocksGc(liveness: QuirkydLiveness): boolean {
  return !quirkydLivenessProvenExited(liveness)
}

export type QuirkydReadinessParse =
  | { state: 'ready'; readiness: ServeReadiness }
  | { state: 'pending' }
  | { state: 'malformed'; reason: string }

/**
 * Pull the `quirky_server_ready` payload out of whatever the candidate has written so far.
 *
 * Why scan for the type tag rather than parsing the last line: stdout is a file being
 * appended to, so a poll can catch a half-written line. A partial JSON line is `pending`,
 * not `malformed` — reporting a parse failure for a race would fail deploys that were fine.
 */
export function parseQuirkydReadinessOutput(raw: string): QuirkydReadinessParse {
  if (Buffer.byteLength(raw, 'utf8') > QUIRKYD_READINESS_MAX_BYTES) {
    return { state: 'malformed', reason: 'readiness payload exceeds the 256 KiB limit' }
  }
  const lines = raw.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Only the unterminated last line can still be mid-write; a finished bad line will stay bad.
      return index === lines.length - 1
        ? { state: 'pending' }
        : { state: 'malformed', reason: 'readiness line is not valid JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue
    }
    const payload = parsed as { type?: unknown }
    if (payload.type !== 'quirky_server_ready') {
      return {
        state: 'malformed',
        reason: `expected an quirky_server_ready line, got type=${JSON.stringify(payload.type)}`
      }
    }
    return { state: 'ready', readiness: toServeReadiness(payload as Record<string, unknown>) }
  }
  return { state: 'pending' }
}

function toServeReadiness(payload: Record<string, unknown>): ServeReadiness {
  return {
    runtimeId: typeof payload.runtimeId === 'string' ? payload.runtimeId : '',
    boundEndpoint: typeof payload.boundEndpoint === 'string' ? payload.boundEndpoint : null,
    advertisedEndpoint:
      typeof payload.advertisedEndpoint === 'string' ? payload.advertisedEndpoint : null,
    managedWslCliReconciliation:
      payload.managedWslCliReconciliation === 'pending' ||
      payload.managedWslCliReconciliation === 'failed'
        ? payload.managedWslCliReconciliation
        : 'settled',
    pairing: payload.pairing as ServeReadiness['pairing'],
    ...(payload.health ? { health: payload.health as ServeReadiness['health'] } : {})
  }
}
