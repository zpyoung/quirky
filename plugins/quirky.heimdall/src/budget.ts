import type { BudgetPolicy, BudgetUsage, JournalEntry } from './contracts'

export const ACTIVE_TIME_SAMPLE_MS = 15_000
export const ACTIVE_TIME_CHECKPOINT_MS = 60_000

export interface OpenBudgetInterval {
  intervalId: string
  generation: string
  cause: string
  attemptId?: string
  openedAtMs: number
  checkpointAtMs: number
}

export function budgetGeneration(journal: JournalEntry[], watcherId?: string): string {
  const last = [...journal].reverse().find((entry) => entry.kind === 'evidence' && entry.evidenceKind === 'budget-generation')
  if (typeof last?.generation === 'string') return last.generation
  if (last) return last.eventId
  const id = watcherId ?? journal[0]?.watcherId ?? ''
  return `initial:${id}`
}

export function openBudgetIntervals(journal: JournalEntry[]): OpenBudgetInterval[] {
  const intervals = new Map<string, OpenBudgetInterval>()
  for (const entry of journal) {
    if (entry.kind === 'interval-open' && typeof entry.intervalId === 'string') {
      const atMs = typeof entry.atMs === 'number' ? entry.atMs : entry.openedAtMs
      if (typeof atMs !== 'number') continue
      intervals.set(entry.intervalId, {
        intervalId: entry.intervalId,
        generation: typeof entry.generation === 'string' ? entry.generation : budgetGeneration(journal, entry.watcherId),
        cause: typeof entry.cause === 'string' ? entry.cause : 'work',
        ...(typeof entry.attemptId === 'string' ? { attemptId: entry.attemptId } : {}),
        openedAtMs: atMs,
        checkpointAtMs: atMs
      })
      continue
    }
    if (entry.kind !== 'interval-checkpoint' && entry.kind !== 'interval-close') continue
    if (typeof entry.intervalId !== 'string') continue
    const interval = intervals.get(entry.intervalId)
    if (!interval) continue
    const atMs = typeof entry.checkpointAtMs === 'number'
      ? entry.checkpointAtMs
      : typeof entry.atMs === 'number' ? entry.atMs : undefined
    if (atMs !== undefined) interval.checkpointAtMs = Math.max(interval.checkpointAtMs, atMs)
    if (entry.kind === 'interval-close') intervals.delete(entry.intervalId)
  }
  return [...intervals.values()]
}

interface IntervalState {
  start: number
  end: number
  generation: string | undefined
  openedSeq: number
  closed: boolean
}

function intervalRows(journal: JournalEntry[], generation: string, generationSeq: number, nowMs: number): Array<{ start: number; end: number }> {
  const intervals = new Map<string, IntervalState>()
  for (const entry of journal) {
    if (entry.kind === 'interval-open' && typeof entry.intervalId === 'string') {
      const start = typeof entry.atMs === 'number' ? entry.atMs : entry.openedAtMs
      if (typeof start !== 'number') continue
      intervals.set(entry.intervalId, {
        start,
        end: start,
        generation: typeof entry.generation === 'string' ? entry.generation : undefined,
        openedSeq: entry.seq,
        closed: false
      })
      continue
    }
    if (entry.kind !== 'interval-checkpoint' && entry.kind !== 'interval-close') continue
    if (typeof entry.intervalId !== 'string') continue
    const interval = intervals.get(entry.intervalId)
    if (!interval) continue
    const checkpoint = typeof entry.checkpointAtMs === 'number'
      ? entry.checkpointAtMs
      : typeof entry.atMs === 'number' ? entry.atMs : undefined
    if (checkpoint !== undefined) interval.end = Math.max(interval.end, checkpoint)
    if (entry.kind === 'interval-close') interval.closed = true
  }
  return [...intervals.values()]
    .filter((interval) => interval.generation === generation || (interval.generation === undefined && interval.openedSeq > generationSeq))
    .map((interval) => ({ start: interval.start, end: interval.closed ? interval.end : Math.max(interval.end, nowMs) }))
}

export function budgetUsage(journal: JournalEntry[], nowMs: number, policy?: BudgetPolicy): BudgetUsage {
  const generationEntry = [...journal].reverse().find((entry) => entry.kind === 'evidence' && entry.evidenceKind === 'budget-generation')
  const generationSeq = generationEntry?.seq ?? -1
  const generation = budgetGeneration(journal, generationEntry?.watcherId)
  const intervals = intervalRows(journal, generation, generationSeq, nowMs)
  intervals.sort((left, right) => left.start - right.start || left.end - right.end)
  let activeMs = 0
  let start: number | null = null
  let end = 0
  for (const interval of intervals) {
    if (interval.end <= interval.start) continue
    if (start === null) {
      start = interval.start
      end = interval.end
    } else if (interval.start <= end) {
      end = Math.max(end, interval.end)
    } else {
      activeMs += end - start
      start = interval.start
      end = interval.end
    }
  }
  if (start !== null) activeMs += end - start

  const turns = new Set<string>()
  for (const entry of journal) {
    if (entry.kind !== 'turn') continue
    if (entry.generation !== generation && !(entry.generation === undefined && entry.seq > generationSeq)) continue
    if (typeof entry.dispatchId === 'string') turns.add(entry.dispatchId)
  }
  const exhausted = policy?.wallClockActiveMs != null && activeMs >= policy.wallClockActiveMs
    ? 'budget-wall-clock'
    : policy?.turns != null && turns.size >= policy.turns ? 'budget-turns' : null
  return { activeMs, turns: turns.size, exhausted }
}
