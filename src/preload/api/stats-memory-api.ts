import type { MemorySnapshot, StatsSummary } from '../../shared/process-stats-types'

export type StatsApi = {
  getSummary: () => Promise<StatsSummary>
}

export type MemoryApi = {
  getSnapshot: () => Promise<MemorySnapshot>
}
