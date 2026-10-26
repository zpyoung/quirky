import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A serialized screen taken when the emulator had parsed exactly `offset` output bytes, so
 * replaying the log from `offset` on top of `ansi` reproduces the live screen.
 */
export type Checkpoint = {
  version: 1
  offset: number
  cols: number
  rows: number
  ansi: string
  cwd: string
  title: string | null
  savedAt: number
}

/**
 * Replaces `<dir>/<name>` with `content` so a reader sees the old file or the new one, never a
 * partial write: temp file, fsync, rename, fsync of the directory.
 */
export function writeFileAtomic(dir: string, name: string, content: string): void {
  const tmp = join(dir, `${name}.tmp`)
  try {
    const fd = openSync(tmp, 'w', 0o600)
    try {
      fchmodSync(fd, 0o600)
      const bytes = Buffer.from(content)
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, join(dir, name))
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function writeCheckpoint(dir: string, cp: Checkpoint): void {
  writeFileAtomic(dir, 'checkpoint.json', JSON.stringify(cp))
}

/** The stored checkpoint, or null when it is missing, unparsable or not shaped like one. */
export function readCheckpoint(dir: string): Checkpoint | null {
  const value = readJsonFile(join(dir, 'checkpoint.json'))
  if (!isRecord(value)) return null
  const { version, offset, cols, rows, ansi, cwd, title, savedAt } = value
  if (
    version !== 1 ||
    !isCount(offset) ||
    !isCount(cols) ||
    !isCount(rows) ||
    typeof ansi !== 'string' ||
    typeof cwd !== 'string' ||
    !(title === null || typeof title === 'string') ||
    typeof savedAt !== 'number' ||
    !Number.isFinite(savedAt)
  ) {
    return null
  }
  return { version, offset, cols, rows, ansi, cwd, title, savedAt }
}
