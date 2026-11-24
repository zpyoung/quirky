/** What the pre-activation snapshot holds; shared by the POSIX commands and the Windows host script. */

/**
 * Root-relative paths a rollback needs restored. Everything else under the data root is
 * either regenerable, or owned by a process that survives the rollback.
 */
export const QUIRKYD_SNAPSHOT_MEMBERS = [
  'quirky-profile-index.json',
  // Pre-profiles layout; still read as a migration source.
  'quirky-data.json',
  'profiles',
  // Cross-profile SQLite moves must survive an quirkyd rollback too.
  'profile-move-intents'
] as const

/** Never captured and never restored — see `quirkyd-state-snapshot.ts`. */
export const QUIRKYD_SNAPSHOT_EXCLUDED = ['daemon', 'logs'] as const

export const QUIRKYD_STATE_RESTORE_STAGE_DIRNAME = '.quirkyd-state-restore-stage'

/** Under `~/.quirky-remote`: held by one snapshot capture, restore or clear at a time. */
export const QUIRKYD_STATE_MUTATION_LOCK_DIRNAME = 'quirkyd-state-mutation.lock'

/**
 * How often a running mutation refreshes the activation fence's mtime. Why: the fence goes
 * stale by age (INSTALL_LOCK_STALE_MS), and a mutation may outlast that, so a live run keeps
 * it fresh while a dead one stops within a beat.
 */
export const QUIRKYD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS = 60
/** How long a lock an exited desktop process left must sit untouched before it is reclaimed. */
export const QUIRKYD_EXITED_OWN_LOCK_QUIET_SECONDS =
  3 * QUIRKYD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS

/** A state mutation found another still running, so it did nothing. */
export const QUIRKYD_STATE_MUTATION_BUSY = 'STATE_MUTATION_BUSY'
/** The host-side deadline killed a state mutation part way through. */
export const QUIRKYD_STATE_MUTATION_DEADLINE = 'STATE_MUTATION_DEADLINE'

/** Windows keeps the snapshot as a directory copy, where POSIX keeps `state.tar`. */
export const QUIRKYD_WINDOWS_SNAPSHOT_STATE_DIRNAME = 'state'

/** Prefixes the line a failed POSIX capture prints, ahead of `FAILED`, saying why. */
export const QUIRKYD_SNAPSHOT_FAILURE = 'SNAPSHOT_FAILURE'
