/**
 * The pre-activation copy of shared profile state that makes rollback sound.
 *
 * `docs/design/shipping-quirkyd.html` §04's state-schema row asks for "backward-readable
 * migrations or a pre-activation snapshot". Only the second is available here, and not as a
 * preference: Quirky's persisted state carries **no schema version**. Migrations are cohort
 * and shape heuristics that run on load and rewrite in place, and the load path rebuilds
 * `settings` and `ui` from known fields — so a newer build's nested additions are silently
 * dropped by an older one rather than rejected. There is nothing to compare and nothing that
 * fails loudly, which rules out proving backward-readability and leaves the snapshot.
 *
 * What is snapshotted is deliberately narrow. `<root>/daemon` is EXCLUDED: it holds the live
 * daemon's socket, PID record and auth token, and that daemon outlives every quirkyd restart
 * by design. Restoring a stale copy of it over a running daemon would break the endpoint
 * fence that keeps its terminals adoptable — turning a rollback into the exact terminal
 * massacre the daemon exists to prevent.
 */
import {
  currentQuirkydFence,
  QUIRKYD_FENCE_LOST_EXIT,
  QUIRKYD_FENCE_LOST_MARKER,
  posixQuirkydFenceGuard,
  posixQuirkydFenceOwnedTest,
  type QuirkydFence
} from '../activation/quirkyd-activation-fence-scope'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import type { QuirkydWindowsHostStateOp } from './quirkyd-windows-host-state-ops'
import { pruneQuirkydSnapshotsScript } from './quirkyd-state-snapshot-space'
import {
  QUIRKYD_SNAPSHOT_FAILURE,
  QUIRKYD_SNAPSHOT_MEMBERS,
  QUIRKYD_STATE_MUTATION_BUSY,
  QUIRKYD_STATE_MUTATION_DEADLINE,
  QUIRKYD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS,
  QUIRKYD_STATE_MUTATION_LOCK_DIRNAME,
  QUIRKYD_STATE_RESTORE_STAGE_DIRNAME
} from './quirkyd-state-snapshot-members'
import { quirkydWindowsHostOpCommand } from '../install/quirkyd-remote-windows-node'
import {
  posixStateMutationGroupRecord,
  posixStateMutationPidRecord
} from './quirkyd-state-mutation-owner-record'

/**
 * The member names go into the commands' `for` lists unquoted, so they must be inert. They are
 * compile-time constants; this catches the edit that adds one with a space or a metacharacter.
 * Why one loop over the names rather than a test per member: every path is then sent once, which
 * keeps each op under the gateway exec limit (#30491).
 */
function plainMemberWords(): string {
  for (const member of QUIRKYD_SNAPSHOT_MEMBERS) {
    if (!/^[A-Za-z0-9._-]+$/.test(member)) {
      throw new Error(`Unsafe quirkyd snapshot member name: ${JSON.stringify(member)}`)
    }
  }
  return QUIRKYD_SNAPSHOT_MEMBERS.join(' ')
}

/** The Windows host-script op, or null on POSIX; `baseDir` is `~/.quirky-remote`. */
function windowsStateCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  op: QuirkydWindowsHostStateOp,
  args: string[]
): string | null {
  if (!isWindowsRemoteHost(host)) {
    return null
  }
  return quirkydWindowsHostOpCommand(host, baseDir, op, args)
}

/** Past this the host kills a capture, restore or clear; the client waits a minute longer. */
export const QUIRKYD_STATE_MUTATION_DEADLINE_SECONDS = 15 * 60

/**
 * Runs a state mutation under the host's lock and deadline. Why on the host: sshd keeps a
 * pty-less command running after its channel closes, so a client that stops waiting has not
 * stopped the work, and a rerun beside it would mix two restores in one stage.
 */
export function serializedStateMutationCommand(
  baseDir: string,
  script: string,
  heartbeatSeconds = QUIRKYD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS,
  // The holder's fence; null (a call outside any fence's run) refreshes no fence at all.
  owned: QuirkydFence | null = currentQuirkydFence()
): string {
  const lock = quotePosixShell(`${baseDir}/${QUIRKYD_STATE_MUTATION_LOCK_DIRNAME}`)
  const busy = `echo ${QUIRKYD_STATE_MUTATION_BUSY}; exit 0;`
  const staleMinutes = Math.max(1, Math.ceil((3 * heartbeatSeconds) / 60))
  const guarded = [
    `lock=${lock};`,
    `mkdir -p ${quotePosixShell(baseDir)} 2>/dev/null;`,
    'if ! mkdir "$lock" 2>/dev/null; then',
    'holder=$(cat "$lock/pid" 2>/dev/null); group=$(cat "$lock/pgid" 2>/dev/null);',
    // No pid yet: no work began, and the pid write is exclusive, so a late writer backs off.
    'if [ -z "$holder" ]; then',
    `[ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] || { ${busy} };`,
    // Why the group: a killed shell can leave its tar or rm running; any live member keeps it.
    `elif [ -n "$group" ]; then kill -0 "-$group" 2>/dev/null && { ${busy} };`,
    // No group recorded: a live pid, or a beat within three, still holds; past that it is gone.
    `elif kill -0 "$holder" 2>/dev/null || [ -z "$(find "$lock" -maxdepth 0 -mmin +${staleMinutes} 2>/dev/null)" ]; then ${busy}`,
    'fi;',
    `rm -rf "$lock"; mkdir "$lock" 2>/dev/null || { ${busy} }; fi;`,
    posixStateMutationPidRecord('"$lock"', busy),
    // Rechecked once the lock is held: an exited-owner steal holds it across the fence takeover.
    owned
      ? `${posixQuirkydFenceOwnedTest(owned)} || { rm -rf "$lock"; echo ${QUIRKYD_FENCE_LOST_MARKER}; exit ${QUIRKYD_FENCE_LOST_EXIT}; };`
      : '',
    posixStateMutationGroupRecord('"$lock"'),
    // `-c` never creates a fence that is gone; the beat ends within one sleep of this shell.
    // Only a fence this run still owns: a superseded or foreign one ages toward takeover.
    `beat_fence() { touch -c -m "$lock" 2>/dev/null; ${
      owned
        ? `${posixQuirkydFenceOwnedTest(owned)} && touch -c -m ${quotePosixShell(owned.lockDir)} 2>/dev/null;`
        : ':;'
    } };`,
    'beat_fence;',
    `( while sleep ${heartbeatSeconds} && kill -0 $$ 2>/dev/null; do beat_fence; done ) >/dev/null 2>&1 & beat=$!;`,
    // Reap quietly: some SSH gateways merge job-termination stderr into the snapshot verdict.
    `trap 'kill "$beat" 2>/dev/null; wait "$beat" 2>/dev/null; rm -rf "$lock"' EXIT;`,
    script
  ].join(' ')
  const run = `sh -c ${quotePosixShell(guarded)}`
  return [
    // Outermost: a superseded fence holder never takes the mutation lock or touches state.
    ...(owned ? [posixQuirkydFenceGuard(owned)] : []),
    // Its own process group, so the lock can name every process the mutation started.
    'quirky_state_group() { if command -v setsid >/dev/null 2>&1; then QUIRKY_STATE_MUTATION_GROUP=1 setsid "$@";',
    `elif command -v perl >/dev/null 2>&1; then QUIRKY_STATE_MUTATION_GROUP=1 perl -e ${quotePosixShell('setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127')} "$@";`,
    'else "$@"; fi; };',
    // Why timeout inside the group: KILL then reaches tar and rm, not only the shell.
    // The deadline is a word list, so the script is sent once, not once per branch.
    // BusyBox before 1.30 spells it `timeout -t SECS`, as the room probe found.
    `quirky_deadline=; if timeout 1 true 2>/dev/null; then quirky_deadline="timeout -s KILL ${QUIRKYD_STATE_MUTATION_DEADLINE_SECONDS}";`,
    `elif timeout -t 1 true 2>/dev/null; then quirky_deadline="timeout -t ${QUIRKYD_STATE_MUTATION_DEADLINE_SECONDS} -s KILL"; fi;`,
    `quirky_state_group $quirky_deadline ${run};`,
    `status=$?; ${owned ? `[ "$status" -eq ${QUIRKYD_FENCE_LOST_EXIT} ] && exit ${QUIRKYD_FENCE_LOST_EXIT}; ` : ''}if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then echo ${QUIRKYD_STATE_MUTATION_DEADLINE}; fi`
  ].join(' ')
}

export function quirkydSnapshotDirName(fullVersion: string, takenAtMs: number): string {
  // Why the version and the timestamp: two activations of one version (a re-deploy after a
  // rejected activation) must not overwrite each other's snapshot.
  return `pre-${fullVersion}-${takenAtMs}`
}

/** The newer build's state, kept so an interrupted rollback can put it back. */
export function quirkydRollbackRescueDirName(fullVersion: string, takenAtMs: number): string {
  return `rollback-rescue-${fullVersion}-${takenAtMs}`
}

/**
 * Capture the snapshot, or report why there is nothing to capture.
 *
 * Prints `CAPTURED`, or `EMPTY` when the data root holds none of the members — a first-ever
 * deployment, where there is no state to lose and therefore no snapshot to take. `EMPTY` is
 * reported rather than fabricating an empty archive, because a rollback that "restored" an
 * empty archive would wipe a root that had filled up in between. A failure prints its reason
 * and removes its partial archive, which would otherwise fill the disk a retry needs (#30491).
 */
export function captureQuirkydStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string,
  prune?: { snapshotsRoot: string; keep: readonly string[] }
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-capture', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  return serializedStateMutationCommand(
    baseDir,
    [
      `root=${quotePosixShell(userDataDir)}; dir=${quotePosixShell(snapshotDir)};`,
      `archive="$dir"/state.tar;`,
      `snapshot_fail() { printf '${QUIRKYD_SNAPSHOT_FAILURE} %s\\n' "$(printf %s "$1" | tr '\\n' ' ' | cut -c 1-400)"; echo FAILED; exit 0; };`,
      prune ? pruneQuirkydSnapshotsScript(prune.snapshotsRoot, prune.keep) : '',
      // Why `$members` is re-split bare: a quoted name would reach tar as one literal word.
      `members=; for m in ${plainMemberWords()}; do`,
      'if [ -e "$root/$m" ] || [ -L "$root/$m" ]; then',
      'links=$(find "$root/$m" -type l -print 2>&1) && [ -z "$links" ] ||',
      'snapshot_fail "$m holds a symbolic link or an entry Quirky cannot read: $links";',
      'members="$members $m"; fi; done;',
      // Umask first so the snapshot dir, not just the archive, is owner-only.
      'if [ -z "$members" ]; then echo EMPTY; else umask 077;',
      // Why a temp name then mv: a deploy killed mid-tar must not leave a truncated archive
      // that a later rollback would happily restore.
      'if err=$( { mkdir -p "$dir" && tar -C "$root" -cf "$archive.partial" $members &&',
      'mv "$archive.partial" "$archive"; } 2>&1 ); then echo CAPTURED; else',
      'rm -f "$archive.partial"; rmdir "$dir" 2>/dev/null; snapshot_fail "$err"; fi; fi'
    ].join(' ')
  )
}

export type QuirkydSnapshotCapture = 'captured' | 'empty' | 'failed'

/**
 * The last line that is one of `verdicts`. Why not simply the last line: a gateway that merges
 * stderr into stdout can append shell noise after the verdict (#30491).
 */
function lastVerdict(output: string, verdicts: readonly string[]): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => verdicts.includes(line))
}

export function parseQuirkydSnapshotCapture(output: string): QuirkydSnapshotCapture {
  const value = lastVerdict(output, ['CAPTURED', 'EMPTY', 'FAILED'])
  if (value === 'CAPTURED') {
    return 'captured'
  }
  return value === 'EMPTY' ? 'empty' : 'failed'
}

export function probeQuirkydStateSnapshotCommand(
  host: RemoteHostPlatform,
  snapshotDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-probe', [snapshotDir])
  if (windows) {
    return windows
  }
  const archive = quotePosixShell(joinRemotePath(host, snapshotDir, 'state.tar'))
  return `test -f ${archive} && echo PRESENT || echo ABSENT`
}

export type QuirkydSnapshotPresence = 'present' | 'absent' | 'unverifiable'

/** A lost probe is `unverifiable`, never `absent`. */
export function parseQuirkydSnapshotPresence(output: string): QuirkydSnapshotPresence {
  const value = lastVerdict(output, ['PRESENT', 'ABSENT', 'UNKNOWN'])
  if (value === 'PRESENT') {
    return 'present'
  }
  return value === 'ABSENT' ? 'absent' : 'unverifiable'
}

/**
 * Restore the snapshot over the data root.
 *
 * Three things make this safe to run: the archive is extracted into a stage first, so an
 * unreadable archive fails before live state is touched; the members are then removed before
 * the staged copies move in (so a file the new version added is gone rather than
 * half-shadowed); and neither step can reach `<root>/daemon`, because the member list never
 * names it.
 *
 * The caller must have stopped quirkyd first. This does not check — it cannot, from a shell —
 * so `quirkyd-remote-deploy.ts` owns that ordering.
 */
export function restoreQuirkydStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-restore', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  const members = plainMemberWords()
  return serializedStateMutationCommand(
    baseDir,
    [
      `root=${quotePosixShell(userDataDir)};`,
      `archive=${quotePosixShell(joinRemotePath(host, snapshotDir, 'state.tar'))};`,
      `stage="$root"/${QUIRKYD_STATE_RESTORE_STAGE_DIRNAME};`,
      'test -f "$archive" || { echo MISSING; exit 0; };',
      'umask 077;',
      'test -d "$root" || mkdir -p "$root";',
      // Re-extracting from the intact archive makes an interrupted restore safe to rerun.
      'rm -rf "$stage"; mkdir -p "$stage" || { echo FAILED; exit 0; };',
      // Extraction proves every archived byte is readable before live state is removed.
      'tar -C "$stage" -xf "$archive" 2>/dev/null || { rm -rf "$stage"; echo FAILED; exit 0; };',
      `ok=; for m in ${members}; do [ -e "$stage/$m" ] && ok=1; done;`,
      '[ -n "$ok" ] || { rm -rf "$stage"; echo FAILED; exit 0; };',
      removeMembersCommand(members),
      `[ -n "$ok" ] && for m in ${members}; do`,
      '[ ! -e "$stage/$m" ] || mv "$stage/$m" "$root/$m" || { ok=; break; }; done;',
      'if [ -n "$ok" ]; then rm -rf "$stage"; echo RESTORED; else echo FAILED; fi'
    ].join(' ')
  )
}

/** Restore an originally empty state root after a candidate populated it. */
export function clearQuirkydStateSnapshotMembersCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-clear', [userDataDir])
  if (windows) {
    return windows
  }
  return serializedStateMutationCommand(
    baseDir,
    [
      `root=${quotePosixShell(userDataDir)}; test -d "$root" || mkdir -p "$root"; ok=1;`,
      removeMembersCommand(plainMemberWords()),
      'if [ -n "$ok" ]; then echo RESTORED; else echo FAILED; fi'
    ].join(' ')
  )
}

/** Clears `ok` and stops at the first member it cannot remove, as an `&&` chain did. */
function removeMembersCommand(members: string): string {
  return `[ -n "$ok" ] && for m in ${members}; do rm -rf "$root/$m" || { ok=; break; }; done;`
}

export type QuirkydSnapshotRestore = 'restored' | 'missing' | 'failed'

export function parseQuirkydSnapshotRestore(output: string): QuirkydSnapshotRestore {
  const value = lastVerdict(output, ['RESTORED', 'MISSING', 'FAILED'])
  if (value === 'RESTORED') {
    return 'restored'
  }
  return value === 'MISSING' ? 'missing' : 'failed'
}

/** Compare after stopping the candidate; a changed root cannot be handed to an older build. */
export function compareQuirkydStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-compare', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  const unknown = '{ echo UNKNOWN; exit 0; };'
  return [
    `root=${quotePosixShell(userDataDir)}; dir=${quotePosixShell(snapshotDir)};`,
    `archive="$dir"/state.tar;`,
    `test -d "$root" && test -r "$root" && test -x "$root" || ${unknown}`,
    `test -f "$archive" || ${unknown}`,
    `comparison=$(mktemp -d "$dir"/compare.XXXXXX) || ${unknown}`,
    `trap 'rm -rf "$comparison"' EXIT HUP INT TERM;`,
    `tar -C "$comparison" -xf "$archive" || ${unknown}`,
    `links=$(find "$comparison" -type l -print) && [ -z "$links" ] || ${unknown}`,
    `verdict=UNCHANGED; for m in ${plainMemberWords()}; do`,
    'if [ -e "$root/$m" ] || [ -L "$root/$m" ]; then',
    `links=$(find "$root/$m" -type l -print) && [ -z "$links" ] || ${unknown}`,
    'diff -r "$root/$m" "$comparison/$m" >/dev/null 2>&1 || verdict=CHANGED;',
    'elif [ -e "$comparison/$m" ] || [ -L "$comparison/$m" ]; then verdict=CHANGED; fi; done;',
    'echo "$verdict"'
  ].join(' ')
}

export function quirkydSnapshotIsUnchanged(output: string): boolean {
  return lastVerdict(output, ['UNCHANGED', 'CHANGED', 'UNKNOWN']) === 'UNCHANGED'
}
