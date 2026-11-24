import { homedir } from 'node:os'
import { wslGatedAccess } from './wsl-transcript-fs-access'
import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { readOpenCodeTranscriptSignalViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import {
  compareOpenCodeClaimPriority,
  listOpenCodeDatabases
} from '../opencode-usage/opencode-database-discovery'

// ZCode sessions belong only to its own store.
function zcodeTranscriptDatabasePaths(): string[] {
  return [join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')]
}

export async function discoverOpenCodeTranscriptDatabase(
  sessionId?: string,
  signal?: AbortSignal,
  agent?: 'zcode'
): Promise<string | null> {
  signal?.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(
    () =>
      deadline.abort(new Error('OpenCode transcript database discovery exceeded its time limit')),
    5000
  )
  timer.unref?.()
  const boundedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const refusals: Error[] = []
  const onRefusal = (_path: string, error: Error): void => {
    refusals.push(error)
  }
  const probed = new Set<string>()
  async function findSession(paths: readonly string[]): Promise<string | null> {
    for (const dbPath of [...new Set(paths)].sort(compareOpenCodeClaimPriority)) {
      if (probed.size >= 32) {
        break
      }
      if (probed.has(dbPath)) {
        continue
      }
      boundedSignal.throwIfAborted()
      probed.add(dbPath)
      try {
        if (
          agent === 'zcode' &&
          !(await waitForPromiseWithSignal(
            wslGatedAccess(dbPath, 'exact', boundedSignal),
            boundedSignal
          ))
        ) {
          continue
        }
        if (!sessionId) {
          return dbPath
        }
        if (
          await waitForPromiseWithSignal(
            readOpenCodeTranscriptSignalViaWorker(
              { dbPath, sessionId, ...(agent ? { agent } : {}) },
              boundedSignal
            ),
            boundedSignal
          )
        ) {
          return dbPath
        }
      } catch (error) {
        boundedSignal.throwIfAborted()
        if (
          agent === 'zcode' &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue
        }
        refusals.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return null
  }
  try {
    const found =
      agent === 'zcode'
        ? await findSession(zcodeTranscriptDatabasePaths())
        : await findSession(
            await waitForPromiseWithSignal(
              listOpenCodeDatabases(onRefusal, undefined, boundedSignal),
              boundedSignal
            )
          )
    if (found) {
      return found
    }
    if (refusals[0]) {
      throw refusals[0]
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}
