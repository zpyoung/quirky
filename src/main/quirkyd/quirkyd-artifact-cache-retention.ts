/**
 * Bounds the desktop's `<userData>/quirkyd-artifacts` slot cache: per target, keep the most
 * recently used slots and evict the rest at startup. The cache survives uninstall (it lives in userData); this is what keeps it small.
 *
 * Never evicted: a slot this process materialized (an SSH deploy may be reading it), the slot
 * a live local quirkyd serve runs from (named by the profile's instance lock), and the slot a
 * surviving terminal daemon runs from (named by its PID record). A record from another machine or
 * boot is unverifiable, so its slot is kept too.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nodeRuntimeAsset } from '../../shared/node-runtime-pin'
import {
  QUIRKYD_LOCK_FILE_NAME,
  quirkydPeerPidIsJudgeableHere,
  readQuirkydInstanceLockRecord
} from './quirkyd-instance-lock'
import { materializedQuirkydArtifactVersions } from './quirkyd-artifact-materializer'
import { isProcessAlive } from '../daemon/daemon-process-inspection'
import {
  defaultQuirkydSlotPeerJudge,
  liveDaemonQuirkydSlots,
  type QuirkydSlotPeerJudge
} from './quirkyd-daemon-slot-pins'

/** The in-use slot plus the two most recent others (the newest three when none is in use). */
export const QUIRKYD_ARTIFACT_CACHE_KEEP = 3

const REPAIR_SUFFIX = /\.repair-\d+$/u

export type QuirkydArtifactCachePruneOptions = {
  keep?: number
  /** Slot versions to keep whatever their age. */
  inUseVersions?: ReadonlySet<string>
}

/** Removes the stale slots under `cacheRoot` and returns their paths. Best effort per entry. */
export async function pruneQuirkydArtifactCache(
  cacheRoot: string,
  options: QuirkydArtifactCachePruneOptions = {}
): Promise<string[]> {
  const keep = options.keep ?? QUIRKYD_ARTIFACT_CACHE_KEEP
  const inUse = options.inUseVersions ?? new Set<string>()
  const removed: string[] = []
  for (const target of await listNames(cacheRoot)) {
    // Only target directories hold slots; `node/` is the runtime archive cache.
    if (!nodeRuntimeAsset(target)) {
      continue
    }
    const targetRoot = join(cacheRoot, target)
    const slots = await Promise.all(
      // Dot entries are staging directories another process may be filling right now.
      (await listNames(targetRoot))
        .filter((name) => !name.startsWith('.'))
        .map(async (name) => ({ name, mtimeMs: await mtimeOf(join(targetRoot, name)) }))
    )
    const present = slots.filter(
      (slot): slot is { name: string; mtimeMs: number } => slot.mtimeMs !== null
    )
    const isInUse = (name: string): boolean => inUse.has(name.replace(REPAIR_SUFFIX, ''))
    // The in-use version counts toward `keep`; with none in use, the newest stands in for it.
    const othersToKeep = present.some((slot) => isInUse(slot.name)) ? keep - 1 : keep
    const others = present
      .filter((slot) => !isInUse(slot.name))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    for (const [index, slot] of others.entries()) {
      if (index < othersToKeep) {
        continue
      }
      const path = join(targetRoot, slot.name)
      try {
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      } catch (error) {
        console.warn(`[quirkyd-artifacts] could not evict ${path}:`, error)
      }
    }
  }
  return removed
}

/** A pass over `<userData>/quirkyd-artifacts` that never evicts a slot something still runs from. */
export function pruneDesktopQuirkydArtifactCache(
  userDataPath: string,
  alsoInUse: readonly string[] = []
): Promise<string[]> {
  const cacheRoot = join(userDataPath, 'quirkyd-artifacts')
  const judge = defaultQuirkydSlotPeerJudge()
  const daemonSlots = liveDaemonQuirkydSlots(userDataPath, cacheRoot, isProcessAlive, judge)
  if (!daemonSlots) {
    // An unreadable daemon record could name any slot; evicting nothing is the safe answer.
    return Promise.resolve([])
  }
  const live = liveLocalQuirkydServeVersion(userDataPath, isProcessAlive, judge)
  return pruneQuirkydArtifactCache(cacheRoot, {
    inUseVersions: new Set([
      ...materializedQuirkydArtifactVersions(),
      ...(live ? [live] : []),
      ...daemonSlots.map((slot) => slot.replace(REPAIR_SUFFIX, '')),
      ...alsoInUse
    ])
  })
}

/**
 * The slot version a live local quirkyd serve runs from, or null when none holds the profile. A
 * serve on another machine or boot (a shared home) is unverifiable from here, so its slot stays.
 */
export function liveLocalQuirkydServeVersion(
  userDataPath: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  judge: QuirkydSlotPeerJudge = defaultQuirkydSlotPeerJudge()
): string | null {
  const record = readQuirkydInstanceLockRecord(join(userDataPath, QUIRKYD_LOCK_FILE_NAME))
  if (!record || record.role === 'desktop') {
    return null
  }
  const judgeable = quirkydPeerPidIsJudgeableHere(record, judge.self, () =>
    judge.dataRootIsOnLocalDisk(userDataPath)
  )
  return !judgeable || isAlive(record.pid) ? record.version : null
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? info.mtimeMs : null
  } catch {
    return null
  }
}
