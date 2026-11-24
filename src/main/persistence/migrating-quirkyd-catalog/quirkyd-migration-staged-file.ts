/**
 * The destination's resumable staging files, shared by scrollback snapshots and migration blobs:
 * fsync'd appends whose retried ranges must match, size-as-progress, digest-checked hard-link
 * commits, and per-migration staging directories that abort and prune remove whole.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { syncDirectoryDurablySync } from '../../durable-file-write'

export const QUIRKYD_MIGRATION_STAGING_DIRECTORY = '.quirkyd-migration-staging'

/** Names the error codes, e.g. `quirkyd_migration_<channel>_offset_invalid`. */
export type QuirkydMigrationStagingChannel = 'snapshot' | 'blob'

export type QuirkydMigrationRequestIdentity = { migrationId: string; manifestSha256: string }

export type QuirkydMigrationStagedContent = { sha256: string; byteLength: number }

export type QuirkydMigrationStagedChunk = {
  channel: QuirkydMigrationStagingChannel
  path: string
  offset: number
  bytes: Buffer
  byteLength: number
}

/** Appends one chunk, or confirms an identical retry; returns the staged size afterwards. */
export function appendQuirkydMigrationStagedChunk(chunk: QuirkydMigrationStagedChunk): number {
  const { channel, path, offset, bytes } = chunk
  const descriptorFd = openStagedFile(path)
  try {
    const size = statSync(path).size
    if (offset > size || offset + bytes.length > chunk.byteLength) {
      throw new Error(`quirkyd_migration_${channel}_offset_invalid`)
    }
    if (offset < size) {
      if (offset + bytes.length > size) {
        throw new Error(`quirkyd_migration_${channel}_offset_invalid`)
      }
      const existing = Buffer.alloc(bytes.length)
      const read = readSync(descriptorFd, existing, 0, existing.length, offset)
      if (read !== bytes.length || !existing.equals(bytes)) {
        throw new Error(`quirkyd_migration_${channel}_retry_mismatch`)
      }
      return size
    }
    const written = writeSync(descriptorFd, bytes, 0, bytes.length, offset)
    if (written !== bytes.length) {
      throw new Error(`quirkyd_migration_${channel}_write_incomplete`)
    }
    fsyncSync(descriptorFd)
    return size + bytes.length
  } finally {
    closeSync(descriptorFd)
  }
}

export function quirkydMigrationStagedFileSize(path: string, byteLength: number): number {
  try {
    return Math.min(statSync(path).size, byteLength)
  } catch {
    return 0
  }
}

export function quirkydMigrationFileMatches(
  path: string,
  expected: QuirkydMigrationStagedContent
): boolean {
  try {
    const bytes = readFileSync(path)
    return (
      bytes.length === expected.byteLength &&
      createHash('sha256').update(bytes).digest('hex') === expected.sha256
    )
  } catch {
    return false
  }
}

export function inspectQuirkydMigrationFinalFile(
  path: string | null,
  expected: QuirkydMigrationStagedContent
): 'absent' | 'matching' | 'conflict' {
  if (!path || !existsSync(path)) {
    return 'absent'
  }
  return quirkydMigrationFileMatches(path, expected) ? 'matching' : 'conflict'
}

/**
 * Hard-links a verified staged file into place, then drops the staged name. A final file that
 * already holds the same bytes (an earlier commit attempt) counts as done; different bytes refuse.
 */
export function linkQuirkydMigrationStagedFile(args: {
  stagedPath: string
  finalPath: string
  expected: QuirkydMigrationStagedContent
  conflictError: string
}): void {
  if (inspectQuirkydMigrationFinalFile(args.finalPath, args.expected) !== 'matching') {
    try {
      linkSync(args.stagedPath, args.finalPath)
    } catch (error) {
      const finalStatus = inspectQuirkydMigrationFinalFile(args.finalPath, args.expected)
      if (finalStatus === 'conflict') {
        throw new Error(args.conflictError)
      }
      if (finalStatus !== 'matching') {
        throw error
      }
    }
  }
  rmSync(args.stagedPath, { force: true })
}

export function quirkydMigrationStagingDirectory(
  root: string,
  manifest: QuirkydMigrationManifest
): string {
  return join(root, QUIRKYD_MIGRATION_STAGING_DIRECTORY, quirkydMigrationStagingKey(manifest))
}

export function ensureQuirkydMigrationDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

export function removeQuirkydMigrationStagingDirectory(
  root: string,
  manifest: QuirkydMigrationManifest
): void {
  rmSync(quirkydMigrationStagingDirectory(root, manifest), { recursive: true, force: true })
  syncDirectoryDurablySync(join(root, QUIRKYD_MIGRATION_STAGING_DIRECTORY))
}

/** Removes staging for every migration the importer no longer holds staged. */
export function pruneQuirkydMigrationStagingDirectories(
  root: string,
  stagedManifests: readonly QuirkydMigrationManifest[]
): void {
  pruneQuirkydMigrationKeyedDirectories(
    join(root, QUIRKYD_MIGRATION_STAGING_DIRECTORY),
    stagedManifests
  )
}

/** Removes every per-migration directory under `parent` whose migration is not retained. */
export function pruneQuirkydMigrationKeyedDirectories(
  parent: string,
  retainedMigrations: readonly QuirkydMigrationRequestIdentity[]
): void {
  const retained = new Set(retainedMigrations.map(quirkydMigrationStagingKey))
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return
  }
  for (const entry of entries) {
    if (/^[a-f0-9]{32}$/.test(entry) && !retained.has(entry)) {
      rmSync(join(parent, entry), { recursive: true, force: true })
    }
  }
}

/** The importer's staged manifest for this request, or the channel's own refusal. */
export function requireStagedQuirkydMigrationManifest(
  staged: QuirkydMigrationManifest | null,
  request: QuirkydMigrationRequestIdentity,
  notStagedError: string
): QuirkydMigrationManifest {
  if (
    !staged ||
    staged.migrationId !== request.migrationId ||
    staged.manifestSha256 !== request.manifestSha256
  ) {
    throw new Error(notStagedError)
  }
  return staged
}

export function quirkydMigrationStagingKey(manifest: QuirkydMigrationRequestIdentity): string {
  return createHash('sha256')
    .update(`${manifest.migrationId}\0${manifest.manifestSha256}`)
    .digest('hex')
    .slice(0, 32)
}

function openStagedFile(path: string): number {
  try {
    return openSync(path, 'r+')
  } catch {
    try {
      return openSync(path, 'wx+', 0o600)
    } catch {
      return openSync(path, 'r+')
    }
  }
}
