/**
 * Single-instance ownership of quirkyd's data root, taken BEFORE the profile is loaded.
 *
 * Two quirkyds on one data root corrupt it quietly: both load the same profile, both write
 * the same store file, and the loser's writes disappear on the next flush. The refusal is
 * therefore a startup gate, not a warning.
 *
 * What this lock does NOT cover, and must not: the terminal daemon. The daemon is a second
 * long-lived process living under `<root>/daemon`, it deliberately outlives the quirkyd that
 * spawned it, and it fences its own endpoint with a PID record of its own. A lock that
 * asked "is any process using this root" would refuse every restart that a live daemon
 * makes worthwhile. This lock scopes exactly one role — who is the runtime — so releasing
 * it says nothing about the daemon, which is what makes a non-destructive restart possible.
 */
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import {
  compareQuirkydProcessIdentity,
  readQuirkydProcessIncarnation,
  readQuirkydProcessName,
  readQuirkydProcessStartedAtMs,
  type QuirkydProcessIdentityVerdict,
  type QuirkydProcessIncarnation
} from './quirkyd-process-start-time'
import {
  assertQuirkydDataRootIsPrivate,
  QuirkydInstanceLockError,
  type QuirkydDataRootPrivacyHooks
} from './quirkyd-data-root-privacy'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { quirkydDataRootIsOnLocalDisk } from './quirkyd-data-root-locality'
import {
  MAX_QUIRKYD_LOCK_BYTES,
  readBoundedLockFile,
  reclaimAndPublish,
  unlinkQuietly,
  type QuirkydLockRecoveryOwner
} from './quirkyd-instance-lock-reclaim'

export const QUIRKYD_LOCK_FILE_NAME = 'quirkyd.lock'
// A writer finishes in milliseconds; a garbled record older than this has no live writer.
const GARBLED_LOCK_GRACE_MS = 10_000

const QuirkydLockRecordSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Null where the platform cannot read it; PID alone is then the (weaker) fence. */
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /**
   * Linux only, absent from older writers: drift-free identity preferred over `startedAtMs`.
   * Salvaged rather than refused, so a future encoding never makes the whole lock unreadable.
   */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  /** POSIX uid, or the Windows username. Compared as an opaque string. */
  identity: z.string().min(1).max(1_024),
  version: z.string().min(1).max(255),
  acquiredAt: z.iso.datetime({ offset: true }),
  /** Distinguishes our record from a replacement written after we lost the race. */
  nonce: z.string().min(1).max(255),
  /** Absent in records quirkyd wrote before the desktop app shared this lock. */
  role: z.enum(['quirkyd', 'desktop']).optional(),
  /**
   * The holder's machine (as profile-state owners record it). Absent from older writers. A PID is
   * evidence only on the machine that issued it, and a shared home can put two on one data root.
   */
  machineIdentity: z.string().min(1).max(255).optional().catch(undefined)
})

export type QuirkydLockRecord = z.infer<typeof QuirkydLockRecordSchema>

/** `null` when absent, unreadable, oversized or malformed; callers must not read that as free. */
export function readQuirkydInstanceLockRecord(path: string): QuirkydLockRecord | null {
  return parseQuirkydInstanceLockRecord(readBoundedLockFile(path) ?? '')
}

export type QuirkydInstanceLock = {
  readonly path: string
  readonly record: QuirkydLockRecord
  release(): void
}

export type QuirkydInstanceLockHooks = QuirkydDataRootPrivacyHooks & {
  identity?: () => string
  version?: () => string
  now?: () => Date
  /** Whether a PID is running. EPERM counts as alive: it proves the process exists. */
  processIsAlive?: (pid: number) => boolean
  startedAtMs?: (pid: number) => number | null
  incarnation?: (pid: number) => QuirkydProcessIncarnation | null
  ownerUid?: (pid: number) => number | null
  processName?: (pid: number) => string | null
  /** Only `differs` frees a live holder's PID; anything less proves nothing. */
  holderIdentity?: (record: QuirkydLockRecord) => QuirkydProcessIdentityVerdict
  /**
   * Who takes the profile. The desktop app takes it too, so the two refuse each other; it must
   * hold Electron's single-instance lock first, which is what lets it reclaim a desktop record.
   */
  role?: 'quirkyd' | 'desktop'
  machineIdentity?: () => string | null
  /** Whether no other machine can reach the data root, for records that name no machine. */
  dataRootIsOnLocalDisk?: (dataRoot: string) => boolean
}

function defaultIdentity(): string {
  // Why uid and not the name on POSIX: two accounts can share a login name across a
  // container boundary while the uid is what the filesystem actually enforces.
  return process.platform === 'win32'
    ? (userInfo().username ?? 'unknown')
    : String(process.getuid?.() ?? 'unknown')
}

/** `null` for anything that is not a complete record; never a reason to treat a lock as free. */
export function parseQuirkydInstanceLockRecord(content: string): QuirkydLockRecord | null {
  try {
    const result = QuirkydLockRecordSchema.safeParse(JSON.parse(content))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * Take the lock, or throw an `QuirkydInstanceLockError` naming why.
 *
 * A dead holder's record is reclaimed; a live one, or one belonging to a different identity,
 * is never touched.
 */
export function acquireQuirkydInstanceLock(
  dataRoot: string,
  hooks: QuirkydInstanceLockHooks = {}
): QuirkydInstanceLock {
  const identity = (hooks.identity ?? defaultIdentity)()
  const isAlive = hooks.processIsAlive ?? isProcessAlive
  const readStartedAt = hooks.startedAtMs ?? readQuirkydProcessStartedAtMs
  const readIncarnation = hooks.incarnation ?? readQuirkydProcessIncarnation
  const holderIdentity =
    hooks.holderIdentity ??
    ((holder: QuirkydLockRecord) =>
      compareQuirkydProcessIdentity(holder.pid, holder, {
        startedAtMs: readStartedAt,
        incarnation: readIncarnation,
        ownerUid: hooks.ownerUid,
        platform: hooks.platform
      }))

  try {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new QuirkydInstanceLockError(
      'quirkyd_data_root_unusable',
      `Cannot create the quirkyd data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  // The desktop's profile keeps the permissions it was created with; quirkyd tightens its own.
  if ((hooks.role ?? 'quirkyd') === 'quirkyd') {
    assertQuirkydDataRootIsPrivate(dataRoot, hooks)
  }

  const lockPath = join(dataRoot, QUIRKYD_LOCK_FILE_NAME)
  const machineIdentity = (hooks.machineIdentity ?? profileStateAccessMachineIdentity)()
  const record: QuirkydLockRecord = {
    pid: process.pid,
    startedAtMs: readStartedAt(process.pid),
    ...readIncarnation(process.pid),
    identity,
    version: (hooks.version ?? (() => process.env.QUIRKY_VERSION ?? 'unknown'))(),
    acquiredAt: (hooks.now ?? (() => new Date()))().toISOString(),
    nonce: randomUUID(),
    role: hooks.role ?? 'quirkyd',
    ...(machineIdentity ? { machineIdentity } : {})
  }
  const serialized = JSON.stringify(record)

  // Staged then hard-linked: the canonical path only ever holds a complete record, never a torn one.
  const publish = (): boolean => {
    const staged = `${lockPath}.staged-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(staged, serialized, { flag: 'wx', mode: 0o600 })
      linkSync(staged, lockPath)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        return false
      }
      throw new QuirkydInstanceLockError(
        'quirkyd_data_root_unusable',
        `Cannot write the quirkyd instance lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      unlinkQuietly(staged)
    }
  }

  if (publish()) {
    return makeLock(lockPath, record)
  }

  const dataRootIsLocal = (): boolean =>
    (hooks.dataRootIsOnLocalDisk ?? quirkydDataRootIsOnLocalDisk)(dataRoot)
  // A recovery lock is ours by the same record, and broken only on the same proof of exit.
  const recoveryOwner: QuirkydLockRecoveryOwner = {
    record: serialized,
    exited: (ownerRecord) => {
      const owner = parseQuirkydInstanceLockRecord(ownerRecord)
      return Boolean(
        owner &&
        owner.identity === identity &&
        quirkydLockHolderLocality(owner, record, dataRootIsLocal) === 'local' &&
        (!isAlive(owner.pid) || holderIdentity(owner) === 'differs')
      )
    }
  }

  const existingContents = readBoundedLockFile(lockPath)
  if (existingContents === null) {
    // Why fail closed: a record we cannot read proves nothing about its holder having exited.
    throw new QuirkydInstanceLockError(
      'quirkyd_instance_lock_unreadable',
      `The quirkyd instance lock at ${lockPath} is unreadable or larger than ` +
        `${MAX_QUIRKYD_LOCK_BYTES} bytes. Refusing to reclaim it without proof that its holder ` +
        'has exited. Stop quirkyd and remove the stale lock manually.'
    )
  }
  const existing = parseQuirkydInstanceLockRecord(existingContents)
  if (!existing) {
    // Only a torn write (an older build, or a crash mid-write) leaves this; once it has aged
    // past any live writer, no owner can be behind it.
    if (garbledLockIsAbandoned(lockPath)) {
      reclaimAndPublish(lockPath, dataRoot, existingContents, publish, recoveryOwner)
      return makeLock(lockPath, record)
    }
    throw new QuirkydInstanceLockError(
      'quirkyd_instance_lock_held',
      `The quirkyd instance lock at ${lockPath} is still being written by another process. Retry.`
    )
  }
  if (existing.identity !== identity) {
    throw new QuirkydInstanceLockError(
      'quirkyd_instance_lock_foreign_identity',
      `The quirkyd data root ${dataRoot} is locked by identity ${existing.identity} (pid ` +
        `${existing.pid}); this process runs as ${identity}. Two identities sharing one data ` +
        'root corrupts it. Give each its own QUIRKY_USER_DATA.'
    )
  }
  const locality = quirkydLockHolderLocality(existing, record, dataRootIsLocal)
  if (locality !== 'local') {
    // Its PID means nothing here, so neither a missing nor a reused one proves it exited.
    throw new QuirkydInstanceLockError(
      'quirkyd_instance_lock_held',
      `${describeLockHolder(existing)} (pid ${existing.pid}, started ${existing.acquiredAt}) ` +
        `holds the data root ${dataRoot}${locality === 'foreign' ? ' from another machine' : ''}. ` +
        'Quirky cannot check from here whether it is still running, because this data root may be ' +
        `shared with other machines. Stop it there, or if it is not running anywhere, delete ` +
        `${lockPath} and try again.`
    )
  }
  // The desktop takes this lock only after Electron's single-instance lock, which already proves
  // no other desktop runs; a desktop record is then stale even when its PID was reused.
  const staleDesktopRecord = hooks.role === 'desktop' && existing.role === 'desktop'
  const verdict = staleDesktopRecord || !isAlive(existing.pid) ? null : holderIdentity(existing)
  if (verdict === 'unproven' && !existing.bootId) {
    throw possiblyReusedPidError(lockPath, existing, hooks.processName ?? readQuirkydProcessName)
  }
  if (verdict !== null && verdict !== 'differs') {
    throw new QuirkydInstanceLockError(
      'quirkyd_instance_lock_held',
      `${describeLockHolder(existing)} (pid ${existing.pid}, started ` +
        `${existing.acquiredAt || 'unknown'}) already owns the data root ${dataRoot}. Stop it ` +
        'before starting another, or use a different QUIRKY_USER_DATA.'
    )
  }
  reclaimAndPublish(lockPath, dataRoot, existingContents, publish, recoveryOwner)
  return makeLock(lockPath, record)
}

/**
 * Same machine: the same machine identity, or (records without one) the same kernel boot. A record
 * that names neither is local only when no other machine can reach the data root.
 */
function quirkydLockHolderLocality(
  holder: QuirkydPeerMachine,
  self: QuirkydPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): 'local' | 'foreign' | 'unknown' {
  if (holder.machineIdentity && self.machineIdentity) {
    return holder.machineIdentity === self.machineIdentity ? 'local' : 'foreign'
  }
  if (holder.bootId && holder.bootId === self.bootId) {
    return 'local'
  }
  return dataRootIsOnLocalDisk() ? 'local' : 'unknown'
}

export type QuirkydPeerMachine = Pick<QuirkydLockRecord, 'machineIdentity' | 'bootId'>

export function currentQuirkydPeerMachine(): QuirkydPeerMachine {
  const machineIdentity = profileStateAccessMachineIdentity()
  const bootId = readQuirkydProcessIncarnation(process.pid)?.bootId
  return { ...(machineIdentity ? { machineIdentity } : {}), ...(bootId ? { bootId } : {}) }
}

/**
 * Whether a peer's recorded PID means anything here: same machine and kernel boot. A different or
 * unprovable one leaves the peer unverifiable, never exited.
 */
export function quirkydPeerPidIsJudgeableHere(
  peer: QuirkydPeerMachine,
  self: QuirkydPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): boolean {
  if (peer.bootId && self.bootId && peer.bootId !== self.bootId) {
    return false
  }
  return quirkydLockHolderLocality(peer, self, dataRootIsOnLocalDisk) === 'local'
}

/** A record without a boot id cannot tell its holder from a reused PID; say so. */
function possiblyReusedPidError(
  lockPath: string,
  existing: QuirkydLockRecord,
  processName: (pid: number) => string | null
): QuirkydInstanceLockError {
  const name = processName(existing.pid)
  const holder = existing.role === 'desktop' ? 'the Quirky desktop app' : 'quirkyd'
  return new QuirkydInstanceLockError(
    'quirkyd_instance_lock_held',
    `The quirkyd instance lock at ${lockPath} names pid ${existing.pid}, which is still running ` +
      `(as ${name ? `"${name}"` : 'an unknown program'}). This lock, written by ${holder} at ` +
      `${existing.acquiredAt}, does not record which boot it came from, so Quirky cannot tell ` +
      `whether that process is still ${holder} or an unrelated program that reused the PID. ` +
      `If you are sure ${holder} is not running for this data root, delete ${lockPath} and ` +
      'try again, or use a different QUIRKY_USER_DATA.'
  )
}

function garbledLockIsAbandoned(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > GARBLED_LOCK_GRACE_MS
  } catch {
    return false
  }
}

function describeLockHolder(record: QuirkydLockRecord): string {
  return record.role === 'desktop' ? 'The Quirky desktop app' : 'Another quirkyd'
}

function makeLock(lockPath: string, record: QuirkydLockRecord): QuirkydInstanceLock {
  let released = false
  return {
    path: lockPath,
    record,
    release: () => {
      if (released) {
        return
      }
      released = true
      // Why re-read before unlinking: a reclaim by a later quirkyd (after, say, a SIGKILL that
      // this process somehow survived enough to run handlers) leaves a record that is not
      // ours. Deleting it would unlock a live runtime.
      const current = parseQuirkydInstanceLockRecord(readBoundedLockFile(lockPath) ?? '')
      if (!current || current.nonce !== record.nonce) {
        return
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // Best-effort: a leftover record with a dead pid is reclaimed on the next start.
      }
    }
  }
}
