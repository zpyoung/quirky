import { join } from 'node:path'
import { isCount, isRecord, readJsonFile, writeFileAtomic } from './checkpoint'

export type ExitCause = 'exited' | 'killed' | 'host-restart' | 'host-lost'

const EXIT_CAUSES: readonly string[] = ['exited', 'killed', 'host-restart', 'host-lost']

/** What survives of a session on disk: enough to list it, end it, or restore it after a host restart. */
export type SessionMeta = {
  version: 1
  sessionId: string
  argv: string[]
  startCwd: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  endedAt: number | null
  exitCode: number | null
  exitSignal: string | null
  exitCause: ExitCause | null
  restorable: boolean
}

function isNullable<T>(value: unknown, check: (v: unknown) => v is T): value is T | null {
  return value === null || check(value)
}
const isString = (v: unknown): v is string => typeof v === 'string'
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function writeMeta(dir: string, meta: SessionMeta): void {
  writeFileAtomic(dir, 'meta.json', JSON.stringify(meta))
}

/** The stored meta, or null when it is missing, unparsable or not shaped like one. */
export function readMeta(dir: string): SessionMeta | null {
  const value = readJsonFile(join(dir, 'meta.json'))
  if (!isRecord(value)) return null
  const { version, sessionId, argv, startCwd, cwd, cols, rows, createdAt, endedAt, exitCode, exitSignal, exitCause, restorable } = value
  if (
    version !== 1 ||
    !isString(sessionId) ||
    !Array.isArray(argv) ||
    !argv.every(isString) ||
    !isString(startCwd) ||
    !isString(cwd) ||
    !isCount(cols) ||
    !isCount(rows) ||
    !isFiniteNumber(createdAt) ||
    !isNullable(endedAt, isFiniteNumber) ||
    !isNullable(exitCode, isFiniteNumber) ||
    !isNullable(exitSignal, isString) ||
    !(exitCause === null || (typeof exitCause === 'string' && EXIT_CAUSES.includes(exitCause))) ||
    typeof restorable !== 'boolean'
  ) {
    return null
  }
  return {
    version,
    sessionId,
    argv,
    startCwd,
    cwd,
    cols,
    rows,
    createdAt,
    endedAt,
    exitCode,
    exitSignal,
    exitCause: exitCause as ExitCause | null,
    restorable
  }
}
