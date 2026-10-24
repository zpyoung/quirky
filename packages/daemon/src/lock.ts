import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isDaemonAlive, readRuntime } from '@quirky/protocol/node'

export type DaemonLock = { release(): void }

export type LockOptions = {
  /** How long a live holder gets to become healthy before its lock is treated as stale. */
  waitMs?: number
  /** How long an empty lock file (its writer is mid-create) is respected. */
  graceMs?: number
}

export function lockFilePath(home: string): string {
  return join(home, 'daemon.lock')
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLockPid(path: string): number | null | 'missing' {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch {
    return 'missing'
  }
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function tryCreate(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, String(process.pid))
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Moves aside the lock we judged stale. Renaming is atomic, so when two contenders both judged it
 * stale only one removes it; if what we moved turns out not to be the stale pid we saw, a live
 * daemon's fresh lock was caught by mistake and is put back.
 */
function removeStale(path: string, stalePid: number | null): void {
  const aside = `${path}.stale.${process.pid}`
  try {
    renameSync(path, aside)
  } catch {
    return
  }
  const moved = readLockPid(aside)
  if (moved !== 'missing' && moved !== stalePid) {
    try {
      linkSync(aside, path)
    } catch {
      // another contender already took the lock again
    }
  }
  rmSync(aside, { force: true })
}

/**
 * Takes `<home>/daemon.lock` exclusively, or returns null when a live, healthy daemon already
 * holds it. A lock is stale when its pid is dead, or alive but still not answering health after
 * `waitMs`. Holders that are still starting get that time to publish their runtime file.
 */
export async function acquireDaemonLock(home: string, options: LockOptions = {}): Promise<DaemonLock | null> {
  const path = lockFilePath(home)
  const waitMs = options.waitMs ?? 20000
  const graceMs = options.graceMs ?? 2000
  const started = Date.now()

  for (;;) {
    if (tryCreate(path)) {
      return {
        release() {
          if (readLockPid(path) === process.pid) rmSync(path, { force: true })
        }
      }
    }
    const pid = readLockPid(path)
    if (pid === 'missing') continue
    const waited = Date.now() - started
    if (pid === null) {
      if (waited >= graceMs) removeStale(path, null)
    } else if (!pidIsAlive(pid)) {
      removeStale(path, pid)
    } else {
      const runtime = readRuntime(home)
      if (runtime?.pid === pid && (await isDaemonAlive(runtime))) return null
      if (waited >= waitMs) removeStale(path, pid)
    }
    await Bun.sleep(50)
  }
}
