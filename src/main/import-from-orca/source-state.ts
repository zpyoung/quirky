import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import Database from '../sqlite/sync-database'
import { SCHEMA_VERSION } from '../../shared/constants'
import { writeProfileStateAuthorityJsonExport } from '../persistence/profile-state/legacy-json/profile-state-authority-exports'
import { writeProfileStateDatabaseSnapshotAsync } from '../persistence/profile-state/profile-state-database-snapshot'
import { ImportFailure } from './import-failure'
import { SOURCE_PROFILE_INDEX_FILE, SOURCE_PROFILE_STATE_DB_FILE } from './constants'

export type SourceState = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveActiveProfileDatabase(sourceRoot: string): string {
  const indexPath = join(sourceRoot, SOURCE_PROFILE_INDEX_FILE)
  if (!existsSync(indexPath)) {
    throw new ImportFailure('SOURCE_MISSING', 'Orca Dev data was not found.')
  }
  let profileId: unknown
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
    profileId = isRecord(parsed) ? parsed.activeProfileId : undefined
  } catch {
    throw new ImportFailure('SOURCE_INCOMPATIBLE', 'The Orca Dev profile index is unreadable.')
  }
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId)) {
    throw new ImportFailure(
      'SOURCE_INCOMPATIBLE',
      'The Orca Dev profile index has no active profile.'
    )
  }
  const databasePath = join(sourceRoot, 'profiles', profileId, SOURCE_PROFILE_STATE_DB_FILE)
  if (!existsSync(databasePath)) {
    throw new ImportFailure('SOURCE_MISSING', 'The Orca Dev profile database was not found.')
  }
  return databasePath
}

/** Whether an Orca Dev profile database is present under `sourceRoot`; reads nothing from it. */
export function sourceDatabaseExists(sourceRoot: string): boolean {
  try {
    resolveActiveProfileDatabase(sourceRoot)
    return true
  } catch {
    return false
  }
}

const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const
const MAX_COPY_ATTEMPTS = 3

/**
 * Copies the database and its sidecar files into a fresh folder under `workDir`, then checks the
 * copy with `quick_check`. Orca Dev may write while the files are copied, so a torn copy is
 * thrown away and made again, up to `MAX_COPY_ATTEMPTS` times. The source is only ever read as
 * plain files, never opened as a database.
 */
async function copyConsistently(databasePath: string, workDir: string): Promise<string> {
  let lastError: unknown = new Error('no copy attempt ran')
  for (let attempt = 0; attempt < MAX_COPY_ATTEMPTS; attempt += 1) {
    const stagingDir = join(workDir, `staged-${attempt}`)
    await mkdir(stagingDir)
    const staged = join(stagingDir, basename(databasePath))
    try {
      await copyFile(databasePath, staged)
      for (const suffix of SIDECAR_SUFFIXES) {
        if (existsSync(`${databasePath}${suffix}`)) {
          await copyFile(`${databasePath}${suffix}`, `${staged}${suffix}`)
        }
      }
      const copy = new Database(staged, { fileMustExist: true })
      try {
        const result = copy.pragma('quick_check', { simple: true })
        if (result === 'ok') {
          return staged
        }
        lastError = new Error(`copy failed its integrity check: ${String(result)}`)
      } finally {
        copy.close()
      }
    } catch (error) {
      lastError = error
    }
    await rm(stagingDir, { recursive: true, force: true })
  }
  throw lastError
}

async function snapshotDatabase(
  databasePath: string,
  copyPath: string,
  workDir: string
): Promise<void> {
  const staged = await copyConsistently(databasePath, workDir)
  const copy = new Database(staged, { fileMustExist: true })
  try {
    await writeProfileStateDatabaseSnapshotAsync(copy, copyPath)
  } finally {
    copy.close()
  }
}

/**
 * Builds the source `PersistedState` without opening or writing anything under the source: the
 * database files are copied into `tempDir` and only that copy is opened. The temp copy is
 * removed before returning.
 */
export async function readSourceState(sourceRoot: string, tempDir: string): Promise<SourceState> {
  const databasePath = resolveActiveProfileDatabase(sourceRoot)
  const workDir = await mkdtemp(join(tempDir, 'import-from-orca-'))
  try {
    const copyPath = join(workDir, SOURCE_PROFILE_STATE_DB_FILE)
    try {
      await snapshotDatabase(databasePath, copyPath, workDir)
    } catch (error) {
      throw new ImportFailure(
        'SOURCE_INCOMPATIBLE',
        `The Orca Dev database could not be copied: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const exportPath = join(workDir, 'state.json')
    let parsed: unknown
    try {
      const copy = new Database(copyPath, { readonly: true, fileMustExist: true })
      try {
        writeProfileStateAuthorityJsonExport(copy, exportPath)
      } finally {
        copy.close()
      }
      parsed = JSON.parse(readFileSync(exportPath, 'utf8'))
    } catch (error) {
      throw new ImportFailure(
        'SOURCE_INCOMPATIBLE',
        `The Orca Dev database could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!isRecord(parsed)) {
      throw new ImportFailure('SOURCE_INCOMPATIBLE', 'The Orca Dev state is not an object.')
    }
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
      throw new ImportFailure(
        'SOURCE_INCOMPATIBLE',
        'Orca Dev uses a newer state version than this Quirky build understands.'
      )
    }
    return parsed
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
