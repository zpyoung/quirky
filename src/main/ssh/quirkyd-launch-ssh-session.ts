/**
 * macOS Local Network privacy pins a process's responsible process at spawn. quirkyd started over
 * SSH with `nohup` stays attributed to the launching `sshd-session`, and once that session ends,
 * non-platform binaries in its terminals get EHOSTUNREACH for LAN addresses (#25934). No launch
 * mode keeps both Full Disk Access and LAN access (Apple TN3179), so the launch records which SSH
 * session started it and a connect reports when that session is gone.
 *
 * The record is `<quirkyd pid> <sshd pid> <sshd start time>` in the data root, written only by a
 * macOS launch. Its quirkyd pid must match the slot's `.quirkyd-pid`: a launch by an older client
 * leaves no record of its own, and an earlier launch's record must not describe it. Terminals are
 * spawned by the daemon, which outlives quirkyd restarts and keeps the attribution it was spawned
 * with, so a launch that finds a live daemon carries the earlier session forward.
 */
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { QUIRKYD_PID_FILENAME } from '../managed-server/install/quirkyd-remote-host-support'

export const QUIRKYD_LAUNCH_SSH_SESSION_FILENAME = '.quirkyd-launch-ssh-session'

/** The first macOS with Local Network privacy. */
const LOCAL_NETWORK_PRIVACY_MAJOR = 15
// Bounds the ancestor walk; real chains are a few processes deep.
const MAX_ANCESTOR_DEPTH = 32

export function recordsQuirkydLaunchSshSession(host: RemoteHostPlatform): boolean {
  return host.os === 'darwin'
}

/**
 * Prints `<pid> <lstart>` of the nearest `sshd*` ancestor of `$1`. The nearest one is the
 * session's own process, which exits with it; a long-lived listener higher up never would.
 */
export function quirkydSshSessionAncestorShellFunction(): string {
  return (
    'quirkyd_ssh_session() { quirkyd_sp=$1; quirkyd_si=0; ' +
    `while [ "$quirkyd_si" -lt ${MAX_ANCESTOR_DEPTH} ]; do ` +
    'case "$quirkyd_sp" in "" | *[!0-9]* | 0 | 1) return 1;; esac; ' +
    'quirkyd_sc=$(ps -o comm= -p "$quirkyd_sp" 2>/dev/null) || return 1; ' +
    'case "${quirkyd_sc##*/}" in sshd*) ' +
    'quirkyd_ss=$(ps -o lstart= -p "$quirkyd_sp" 2>/dev/null) || return 1; ' +
    // Why unquoted: normalizes lstart's padding so a later read compares equal.
    'echo "$quirkyd_sp" $quirkyd_ss; return 0;; esac; ' +
    'quirkyd_sp=$(ps -o ppid= -p "$quirkyd_sp" 2>/dev/null | tr -d " "); ' +
    'quirkyd_si=$((quirkyd_si + 1)); done; return 1; };'
  )
}

/** Runs in the launching shell, before the detached launch; never fails the launch. */
export function captureQuirkydLaunchSshSessionCommand(): string {
  return (
    `${quirkydSshSessionAncestorShellFunction()} ` +
    'quirkyd_session=$(quirkyd_ssh_session "$$" 2>/dev/null) || quirkyd_session=;'
  )
}

function recordPath(host: RemoteHostPlatform, userDataDir: string): string {
  return quotePosixShell(joinRemotePath(host, userDataDir, QUIRKYD_LAUNCH_SSH_SESSION_FILENAME))
}

/**
 * Returns 0 when a terminal daemon this data root published is still running, 1 when none is,
 * and 2 when a live PID's command line can't be read. Like `commandLineMatchesDaemon`, a PID
 * counts only when its command line is this root's daemon: a stale PID file after a reboot can
 * name an unrelated process.
 */
function liveDaemonShellFunction(host: RemoteHostPlatform, userDataDir: string): string {
  const daemonDir = quotePosixShell(joinRemotePath(host, userDataDir, 'daemon'))
  return (
    `quirkyd_daemon_live() { quirkyd_ddir=${daemonDir}; for quirkyd_df in "$quirkyd_ddir"/daemon-v*.pid; do ` +
    '[ -f "$quirkyd_df" ] || continue; ' +
    'quirkyd_dp=$(sed -n \'s/.*"pid":\\([0-9][0-9]*\\).*/\\1/p\' "$quirkyd_df" | head -n 1); ' +
    '[ -n "$quirkyd_dp" ] || continue; ' +
    'kill -0 "$quirkyd_dp" 2>/dev/null || continue; ' +
    'quirkyd_da=$(ps -o args= -p "$quirkyd_dp" 2>/dev/null); [ -n "$quirkyd_da" ] || return 2; ' +
    'case "$quirkyd_da" in *daemon-entry*"$quirkyd_ddir"* | *"$quirkyd_ddir"*daemon-entry*) return 0;; esac; ' +
    'done; return 1; };'
  )
}

/**
 * Runs after `$!` is recorded. With a live daemon, the earlier record's session carries over
 * (or none, when unknown); otherwise this launch's own session is recorded.
 */
export function writeQuirkydLaunchSshSessionCommand(
  host: RemoteHostPlatform,
  userDataDir: string
): string {
  const file = recordPath(host, userDataDir)
  return (
    // Why mkdir: on a first deploy the detached server may not have created its data root yet.
    `{ quirkyd_bg=$!; ( umask 077; mkdir -p ${quotePosixShell(userDataDir)} ); ` +
    `${liveDaemonShellFunction(host, userDataDir)} ` +
    'quirkyd_daemon_live; quirkyd_dl=$?; ' +
    'if [ "$quirkyd_dl" = 0 ]; then ' +
    `quirkyd_prev=$(cat ${file}); rm -f ${file}; set -- $quirkyd_prev; ` +
    `[ "$#" -lt 3 ] || { shift; ( umask 077; echo "$quirkyd_bg" "$@" > ${file} ); }; ` +
    // An unreadable daemon leaves the attribution unknown, never this launch's.
    `elif [ "$quirkyd_dl" = 2 ]; then rm -f ${file}; ` +
    `else rm -f ${file}; [ -z "$quirkyd_session" ] || ` +
    `( umask 077; echo "$quirkyd_bg" $quirkyd_session > ${file} ); fi; :; } 2>/dev/null`
  )
}

/** Answers LIVE, EXITED, UNVERIFIABLE, NOT_RECORDED or NOT_APPLICABLE. */
export function quirkydLaunchSshSessionProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  userDataDir: string
): string {
  const file = recordPath(host, userDataDir)
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, QUIRKYD_PID_FILENAME))
  return [
    'quirkyd_mac=$(sw_vers -productVersion 2>/dev/null) || { echo NOT_APPLICABLE; exit 0; };',
    'quirkyd_major=${quirkyd_mac%%.*};',
    'case "$quirkyd_major" in "" | *[!0-9]*) echo UNVERIFIABLE; exit 0;; esac;',
    `[ "$quirkyd_major" -ge ${LOCAL_NETWORK_PRIVACY_MAJOR} ] || { echo NOT_APPLICABLE; exit 0; };`,
    `quirkyd_rec=$(cat ${file} 2>/dev/null) || { echo NOT_RECORDED; exit 0; };`,
    `quirkyd_pid=$(cat ${pidFile} 2>/dev/null);`,
    'set -- $quirkyd_rec;',
    'case "$1:$2" in *[!0-9:]* | :* | *:) echo NOT_RECORDED; exit 0;; esac;',
    '[ "$1" = "$quirkyd_pid" ] || { echo NOT_RECORDED; exit 0; };',
    'quirkyd_sshd=$2; shift 2; quirkyd_want=$*;',
    // A ps that can't list this shell can't prove another process absent.
    'ps -o pid= -p "$$" >/dev/null 2>&1 || { echo UNVERIFIABLE; exit 0; };',
    'quirkyd_now=$(ps -o lstart= -p "$quirkyd_sshd" 2>/dev/null); quirkyd_now=$(echo $quirkyd_now);',
    // A reused PID with another start time is a different process: the session is gone.
    'if [ -z "$quirkyd_now" ] || [ "$quirkyd_now" != "$quirkyd_want" ]; then echo EXITED; else echo LIVE; fi'
  ].join(' ')
}

/** `not-recorded` covers older launches and clients: the condition is unknown, never assumed. */
export type QuirkydLaunchSshSession =
  | 'live'
  | 'exited'
  | 'unverifiable'
  | 'not-recorded'
  | 'not-applicable'

export function parseQuirkydLaunchSshSession(output: string): QuirkydLaunchSshSession {
  switch (output.trim().split('\n').pop()?.trim() ?? '') {
    case 'LIVE':
      return 'live'
    case 'EXITED':
      return 'exited'
    case 'NOT_RECORDED':
      return 'not-recorded'
    case 'NOT_APPLICABLE':
      return 'not-applicable'
    default:
      return 'unverifiable'
  }
}
