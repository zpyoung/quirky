import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

export type HomeLock = {
  readonly path: string
  /** The pid in `<name>.oslock.pid`: the last process that held this lock and recorded itself. Its holder has ended. */
  readonly lastHolderPid: number | null
  /** Writes this process's pid to `<name>.oslock.pid`, replacing the file in one rename. */
  recordHolder(): void
  /** Empties `<name>.oslock.pid` when it names this process, then lets the kernel lock go. */
  release(): void
}

export function homeLockPath(home: string, name: 'daemon' | 'pty'): string {
  return join(home, `${name}.oslock`)
}

function holderPidPath(home: string, name: 'daemon' | 'pty'): string {
  return join(home, `${name}.oslock.pid`)
}

function readHolderPid(path: string): number | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  if (!/^\d+$/.test(text)) return null
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function secureLockFile(path: string): void {
  const fd = openSync(path, 'a', 0o600)
  try {
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}

function writeHolderPid(path: string): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, String(process.pid), { flag: 'wx', mode: 0o600 })
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, path)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

/** Null while another live process, or this one, holds the lock. Throws when the file can't be opened. */
export function tryHomeLock(home: string, name: 'daemon' | 'pty'): HomeLock | null {
  const path = homeLockPath(home, name)
  const pidPath = holderPidPath(home, name)
  let recoveredCorruption = false

  for (;;) {
    let database: Database | undefined
    try {
      secureLockFile(path)
      database = new Database(path, { create: true })
      database.exec('PRAGMA busy_timeout = 0')
      database.query('PRAGMA schema_version').get()
      database.exec('PRAGMA locking_mode = EXCLUSIVE')
      database.exec('BEGIN EXCLUSIVE')
      const lastHolderPid = readHolderPid(pidPath)
      let released = false

      return {
        path,
        lastHolderPid,
        recordHolder() {
          writeHolderPid(pidPath)
        },
        release() {
          if (released) return
          released = true
          try {
            if (readHolderPid(pidPath) === process.pid) {
              writeFileSync(pidPath, '', { mode: 0o600 })
              chmodSync(pidPath, 0o600)
            }
          } finally {
            database!.close()
          }
        }
      }
    } catch (error) {
      try {
        database?.close()
      } catch {}

      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'SQLITE_BUSY') return null
      if (!recoveredCorruption && (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT')) {
        try {
          truncateSync(path, 0)
        } catch (recoveryError) {
          const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          throw new Error(`could not repair home lock ${path}: ${detail}`, { cause: recoveryError })
        }
        recoveredCorruption = true
        continue
      }

      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`could not open home lock ${path}: ${detail}`, { cause: error })
    }
  }
}

/** True when a process with this pid exists, whoever owns it. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
