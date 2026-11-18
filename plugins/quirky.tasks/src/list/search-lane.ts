import type { TasksState } from '../contracts'

export type SearchView = { mode: string; query: string }
export type SearchLane = {
  synced: SearchView | null
  own: (SearchView & { revision: number }) | null
  sent: string
  inFlight: number
  dirty: boolean
}

/** Keeps search drafts separate from daemon echoes without retaining past queries. */
export function createSearchLane(): SearchLane {
  return { synced: null, own: null, sent: '', inFlight: 0, dirty: false }
}

export function typed(lane: SearchLane): void {
  lane.dirty = true
}

export function committed(lane: SearchLane): void {
  lane.dirty = false
}

/** The next commit must supersede an unobserved send, even when reverting to the displayed query. */
export function expected(lane: SearchLane, observedQuery: string): string {
  return lane.inFlight > 0 ? lane.sent : observedQuery
}

export function sending(lane: SearchLane, query: string): void {
  lane.inFlight += 1
  lane.sent = query
}

/** Remembers only the newest successful reply when concurrent commits finish out of order. */
export function settled(lane: SearchLane, reply: TasksState | null): void {
  lane.inFlight -= 1
  if (reply !== null && (lane.own === null || lane.own.revision <= reply.revision)) {
    lane.own = { mode: reply.navigation.mode, query: reply.navigation.query, revision: reply.revision }
  }
}

/** Preserves newer typing for own echoes, while following external query and mode changes. */
export function observe(lane: SearchLane, observed: SearchView): 'keep' | 'adopt' | 'drop' {
  if (observed.mode === 'projects') {
    lane.dirty = false
    return 'drop'
  }
  if (lane.inFlight > 0) return 'keep'
  if (lane.synced?.mode === observed.mode && lane.synced.query === observed.query) {
    lane.own = null
    return 'keep'
  }
  if (lane.dirty && lane.own?.mode === observed.mode && lane.own.query === observed.query) {
    lane.synced = observed
    lane.own = null
    return 'keep'
  }
  lane.synced = observed
  lane.own = null
  lane.dirty = false
  return 'adopt'
}
