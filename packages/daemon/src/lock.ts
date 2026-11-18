import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDaemonAlive, isPidAlive, readRuntime, tryHomeLock, type HomeLock } from '@quirky/protocol/node'

export type DaemonLock = { release(): void }

export type LockOptions = {
  /** How long to wait for a live daemon to answer health before reporting that it holds the lock. */
  waitMs?: number
  /** How long an empty lock file (its writer is mid-create) is respected. */
  graceMs?: number
}

export function lockFilePath(home: string): string {
  return join(home, 'daemon.lock')
}

export class DaemonLockHeldError extends Error {
  readonly holderPid: number | null

  constructor(holderPid: number | null, message: string) {
    super(message)
    this.name = 'DaemonLockHeldError'
    this.holderPid = holderPid
  }
}

type LockPid = number | null | 'empty' | 'missing'

function readLockPid(path: string): LockPid {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  if (text === '') return 'empty'
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function heldError(path: string, holderPid: number | null): DaemonLockHeldError {
  const holder = holderPid === null ? 'an unknown process' : `process ${holderPid}`
  const remove = holderPid === null
    ? `if that process isn't quirkyd, remove ${path}`
    : `if process ${holderPid} isn't quirkyd, remove ${path}`
  return new DaemonLockHeldError(holderPid, `daemon.lock is held by ${holder} and did not answer health; ${remove}`)
}

function daemonLock(path: string, homeLock: HomeLock): DaemonLock {
  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        if (readLockPid(path) === process.pid) rmSync(path, { force: true })
      } finally {
        homeLock.release()
      }
    }
  }
}

/**
 * Acquires the daemon's kernel lock and refuses to replace a live daemon that has not answered health.
 */
export async function acquireDaemonLock(home: string, options: LockOptions = {}): Promise<DaemonLock | null> {
  const path = lockFilePath(home)
  const waitMs = options.waitMs ?? 20000
  const graceMs = options.graceMs ?? 2000
  const started = Date.now()

  for (;;) {
    const homeLock = tryHomeLock(home, 'daemon')
    if (!homeLock) {
      if (await isDaemonAlive(readRuntime(home))) return null
      if (Date.now() - started >= waitMs) {
        const pid = readLockPid(path)
        throw heldError(path, typeof pid === 'number' ? pid : null)
      }
      await Bun.sleep(50)
      continue
    }

    let returnedLock = false
    try {
      for (;;) {
        const pid = readLockPid(path)
        const waited = Date.now() - started
        const free =
          pid === 'missing' ||
          pid === null ||
          (pid === 'empty' && waited >= graceMs) ||
          (typeof pid === 'number' && (pid === homeLock.lastHolderPid || !isPidAlive(pid)))

        if (free) {
          rmSync(path, { force: true })
          homeLock.recordHolder()
          writeFileSync(path, String(process.pid), { mode: 0o600 })
          const lock = daemonLock(path, homeLock)
          returnedLock = true
          return lock
        }

        if (typeof pid === 'number') {
          const runtime = readRuntime(home)
          if (runtime?.pid === pid && (await isDaemonAlive(runtime))) return null
          if (waited >= waitMs) throw heldError(path, pid)
        }

        await Bun.sleep(50)
      }
    } finally {
      if (!returnedLock) homeLock.release()
    }
  }
}
