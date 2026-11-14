import type { ProbeRecord, RefreshExample, RefreshSummary } from './contracts'

const DIAGNOSTIC_PREFIX = 'notification-worktree-refresh '
const SLOW_THRESHOLD_MS = 2000
const HARD_DEADLINE_MS = 30_000
const RECORD_KEYS: Record<string, true> = {
  v: true,
  id: true,
  event: true,
  startedAt: true,
  at: true,
  elapsedMs: true,
  loopLagMs: true,
  outcome: true,
}
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/

type RefreshRecord = {
  v: 1
  id: string
  event: 'slow' | 'finished'
  startedAt: string
  startedAtMs: number
  at: string
  atMs: number
  elapsedMs: number
  loopLagMs: number
  outcome?: 'ok' | 'error' | 'timeout'
}

type RefreshEntry = {
  id: string
  startedAt: string
  startedAtMs: number
  records: Set<string>
  slow?: RefreshRecord
  finished?: RefreshRecord
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = TIMESTAMP_PATTERN.exec(value)
  if (!match) return null

  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  const [, year, month, day, hour, minute, second] = match
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) return null
  return milliseconds
}

function parseRecord(payload: string): RefreshRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const value = parsed as Record<string, unknown>
  if (Object.keys(value).some((key) => RECORD_KEYS[key] !== true)) return null
  if (
    value.v !== 1 ||
    typeof value.id !== 'string' || value.id.trim().length === 0 ||
    (value.event !== 'slow' && value.event !== 'finished') ||
    typeof value.startedAt !== 'string' ||
    typeof value.at !== 'string' ||
    typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 ||
    typeof value.loopLagMs !== 'number' || !Number.isFinite(value.loopLagMs) || value.loopLagMs < 0
  ) return null

  const startedAtMs = timestamp(value.startedAt)
  const atMs = timestamp(value.at)
  if (startedAtMs === null || atMs === null) return null

  if (value.event === 'slow') {
    if (Object.hasOwn(value, 'outcome') || value.elapsedMs < SLOW_THRESHOLD_MS) return null
    return {
      v: 1,
      id: value.id,
      event: 'slow',
      startedAt: value.startedAt,
      startedAtMs,
      at: value.at,
      atMs,
      elapsedMs: value.elapsedMs,
      loopLagMs: value.loopLagMs,
    }
  }

  if (value.outcome !== 'ok' && value.outcome !== 'error' && value.outcome !== 'timeout') return null
  if ((value.outcome === 'timeout') !== (value.elapsedMs >= HARD_DEADLINE_MS)) return null
  return {
    v: 1,
    id: value.id,
    event: 'finished',
    startedAt: value.startedAt,
    startedAtMs,
    at: value.at,
    atMs,
    elapsedMs: value.elapsedMs,
    loopLagMs: value.loopLagMs,
    outcome: value.outcome,
  }
}


function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function phase(startedAtMs: number, runStartedAtMs: number | null): RefreshExample['phase'] {
  if (runStartedAtMs === null) return 'unknown'
  return startedAtMs < runStartedAtMs ? 'setup' : 'run'
}

function maxProbeOwnLag(
  startedAtMs: number,
  elapsedMs: number,
  runStartedAtMs: number | null,
  probes: readonly ProbeRecord[],
): number | null {
  if (runStartedAtMs === null) return null
  const refreshEndMs = startedAtMs + elapsedMs
  let maximum: number | null = null

  for (const probe of probes) {
    if (
      !Number.isFinite(probe.at) || probe.at < 0 ||
      !Number.isFinite(probe.ms) || probe.ms <= 0 ||
      !Number.isFinite(probe.ownLagMs) || probe.ownLagMs < 0
    ) continue

    const probeStartMs = runStartedAtMs + probe.at * 1000
    const probeEndMs = probeStartMs + probe.ms
    if (probeStartMs < refreshEndMs && probeEndMs > startedAtMs) {
      maximum = maximum === null ? probe.ownLagMs : Math.max(maximum, probe.ownLagMs)
    }
  }
  return maximum
}

/** Accounts for versioned background worktree refresh diagnostics in a daemon log. */
export function summarizeWorktreeRefreshes(
  text: string,
  startedAt: string | undefined,
  probes: readonly ProbeRecord[],
): RefreshSummary {
  const runStartedAtMs = startedAt === undefined ? null : timestamp(startedAt)
  const entries = new Map<string, RefreshEntry>()
  const seenPayloads = new Set<string>()
  let invalid = 0

  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf(DIAGNOSTIC_PREFIX)
    if (marker < 0) continue

    const payload = line.slice(marker + DIAGNOSTIC_PREFIX.length)
    if (seenPayloads.has(payload)) continue
    seenPayloads.add(payload)
    const record = parseRecord(payload)
    if (record === null) {
      invalid++
      continue
    }

    let entry = entries.get(record.id)
    if (entry === undefined) {
      entry = {
        id: record.id,
        startedAt: record.startedAt,
        startedAtMs: record.startedAtMs,
        records: new Set(),
      }
      entries.set(record.id, entry)
    }

    const duplicateKey = JSON.stringify(record)
    if (entry.records.has(duplicateKey)) continue
    entry.records.add(duplicateKey)
    if (entry.startedAt !== record.startedAt) {
      invalid++
      continue
    }

    const previous = record.event === 'slow' ? entry.slow : entry.finished
    if (previous !== undefined) {
      invalid++
      continue
    }
    if (record.event === 'slow') entry.slow = record
    else entry.finished = record
  }

  let slow = 0
  let completed = 0
  let failed = 0
  let pending = 0
  const examples: RefreshExample[] = []

  for (const entry of entries.values()) {
    const { slow: slowRecord, finished } = entry
    if (slowRecord !== undefined) slow++

    if (finished !== undefined) {
      if (finished.outcome === 'error' || finished.outcome === 'timeout') failed++
      else if (slowRecord !== undefined) completed++

      if (slowRecord === undefined && finished.outcome !== 'error') invalid++
      if (slowRecord !== undefined && (
        finished.atMs < slowRecord.atMs ||
        finished.elapsedMs < slowRecord.elapsedMs ||
        finished.loopLagMs < slowRecord.loopLagMs
      )) invalid++
    } else if (slowRecord !== undefined) {
      pending++
    }

    if (slowRecord === undefined && (finished === undefined || finished.outcome === 'ok')) continue
    const measured = finished ?? slowRecord!
    const outcome = finished?.outcome ?? 'pending'
    examples.push({
      id: entry.id,
      startedAt: entry.startedAt,
      phase: phase(entry.startedAtMs, runStartedAtMs),
      elapsedMs: measured.elapsedMs,
      loopLagMs: measured.loopLagMs,
      maxProbeOwnLagMs: maxProbeOwnLag(
        entry.startedAtMs,
        measured.elapsedMs,
        runStartedAtMs,
        probes,
      ),
      outcome,
    })
  }

  examples.sort((left, right) => right.elapsedMs - left.elapsedMs || compareText(left.id, right.id))
  return { slow, completed, failed, pending, invalid, examples: examples.slice(0, 10) }
}
