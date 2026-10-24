import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024

/**
 * A session's on-disk output: `output.log`, moved over `output.1.log` once it grows past
 * `maxBytes`. Starts empty, discarding anything a previous host left in the directory.
 */
export class RotatingLog {
  private fd: number | null
  private size = 0
  private readonly path: string
  private readonly rotatedPath: string

  constructor(
    dir: string,
    private readonly maxBytes = DEFAULT_LOG_MAX_BYTES
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.path = join(dir, 'output.log')
    this.rotatedPath = join(dir, 'output.1.log')
    if (existsSync(this.rotatedPath)) rmSync(this.rotatedPath)
    this.fd = openSync(this.path, 'w', 0o600)
  }

  append(bytes: Uint8Array): void {
    if (this.fd === null) return
    let written = 0
    while (written < bytes.length) written += writeSync(this.fd, bytes, written)
    this.size += bytes.length
    if (this.size > this.maxBytes) this.rotate()
  }

  close(): void {
    if (this.fd === null) return
    closeSync(this.fd)
    this.fd = null
  }

  private rotate(): void {
    if (this.fd === null) return
    closeSync(this.fd)
    renameSync(this.path, this.rotatedPath)
    this.fd = openSync(this.path, 'w', 0o600)
    this.size = 0
  }
}
