/**
 * The record that tells a clean idle stop apart from a crash. Written just before an idle
 * stop and discarded if that stop fails; the next start reports it once and removes it, so a
 * later crash never inherits it.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  QUIRKYD_IDLE_STOP_RECORD_FILENAME,
  QuirkydIdleStopRecordSchema,
  type QuirkydIdleStopRecord
} from '../../shared/quirkyd-idle-exit'
import type { QuirkydIdleExitEvidence } from './quirkyd-idle-exit-monitor'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

const RECORD_MAX_BYTES = 16 * 1024

export function quirkydIdleStopRecordPath(userDataPath: string): string {
  return join(userDataPath, QUIRKYD_IDLE_STOP_RECORD_FILENAME)
}

export function writeQuirkydIdleStopRecord(
  userDataPath: string,
  evidence: QuirkydIdleExitEvidence,
  version: string
): void {
  const record: QuirkydIdleStopRecord = {
    schemaVersion: 1,
    kind: 'quirkyd_idle_stop',
    pid: process.pid,
    version,
    quietSince: new Date(evidence.quietSince).toISOString(),
    stoppedAt: new Date(evidence.stoppedAt).toISOString(),
    idleTimeoutMs: evidence.timeoutMs
  }
  if (!writeDurableSecureJsonFile(quirkydIdleStopRecordPath(userDataPath), record)) {
    throw new Error('quirkyd_idle_stop_record_permissions_unconfirmed')
  }
}

/** The previous run's idle stop, or null when it ended any other way (or never ran). */
export function consumeQuirkydIdleStopRecord(userDataPath: string): QuirkydIdleStopRecord | null {
  const path = quirkydIdleStopRecordPath(userDataPath)
  let record: QuirkydIdleStopRecord | null = null
  try {
    const raw = readNodeFileSyncWithinLimit(path, RECORD_MAX_BYTES).buffer.toString('utf8')
    record = QuirkydIdleStopRecordSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    console.error('[quirkyd] ignoring an unreadable idle-stop record:', error)
  }
  rmSync(path, { force: true })
  return record
}

export function discardQuirkydIdleStopRecord(userDataPath: string): void {
  rmSync(quirkydIdleStopRecordPath(userDataPath), { force: true })
}
