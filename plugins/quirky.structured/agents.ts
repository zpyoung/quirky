import type { AgentItem, AgentKey, AgentState } from '@quirky/protocol'
import type { ItemEntry } from './items'

/** The synthetic agent that receives events whose real agent Quirky cannot find. */
export const UNATTRIBUTED: AgentKey = 'unattributed'

/** Everything `AgentRegistry.spawn` records about a new agent; `parent` is absent for a top-level agent. */
export type AgentInit = {
  id: AgentKey
  parent?: AgentKey
  name: string
  task: string
  prompt?: string
  model?: string
  background?: boolean
  steps: 'full' | 'none'
  nativeId?: string
  startedAt?: number
}

/** The fields of an agent snapshot a runner may change after spawn; an `undefined` value clears the field. */
export type AgentPatch = Partial<Omit<AgentItem, 'kind' | 'id' | 'startedAt'>>

type TerminalState = Exclude<AgentState, 'working' | 'needs-you'>

const entryOf = (item: AgentItem, parent: AgentKey | undefined): ItemEntry => ({
  role: 'tool',
  text: `Agent ${item.name}: ${item.state}`,
  data: null,
  item: parent === undefined ? { ...item } : { ...item, agent: parent }
})

/**
 * The subagents of one run, shared by every runner adapter. It owns each agent's latest snapshot and
 * parent, and hands back the journal entry to append for every change.
 *
 * Contract: every returned entry carries a full snapshot, never a patch, and an `agent` item's own
 * `agent` tag is its parent's key. The registry never journals anything itself; the caller appends
 * what it returns. A registry lives for one run, so a new run starts with none.
 */
export class AgentRegistry {
  private readonly agents = new Map<AgentKey, AgentItem>()
  private readonly parents = new Map<AgentKey, AgentKey | undefined>()

  /**
   * Records a new agent as `working` and returns the entry that journals its spawn. Spawning an id
   * already known replaces its record. A parent that is the agent itself, or whose ancestry contains
   * it, would form a cycle, so it is treated as absent and the agent becomes top-level.
   */
  spawn(rawInit: AgentInit): ItemEntry {
    const init = this.wouldCycle(rawInit.id, rawInit.parent) ? { ...rawInit, parent: undefined } : rawInit
    const item: AgentItem = {
      kind: 'agent',
      id: init.id,
      name: init.name,
      task: init.task,
      state: 'working',
      startedAt: init.startedAt ?? Date.now(),
      steps: init.steps
    }
    if (init.prompt !== undefined) item.prompt = init.prompt
    if (init.model !== undefined) item.model = init.model
    if (init.background !== undefined) item.background = init.background
    if (init.nativeId !== undefined) item.nativeId = init.nativeId
    this.agents.set(init.id, item)
    this.parents.set(init.id, init.parent)
    return entryOf(item, init.parent)
  }

  /**
   * Merges `patch` into the stored snapshot and returns the full new snapshot, or null for an unknown
   * id. Once an agent has ended, its `state`, `cutOff` and `endedAt` can no longer change, so a late
   * event cannot revive it.
   */
  update(id: AgentKey, patch: AgentPatch): ItemEntry | null {
    const current = this.agents.get(id)
    if (!current) return null
    const next: Record<string, unknown> = { ...current }
    const frozen = !this.isLive(id)
    for (const [key, value] of Object.entries(patch)) {
      if (frozen && (key === 'state' || key === 'cutOff' || key === 'endedAt')) continue
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    const item = next as AgentItem
    this.agents.set(id, item)
    return entryOf(item, this.parents.get(id))
  }

  /**
   * Ends a live agent in a terminal state, stamping `endedAt` (default now), and returns its final
   * snapshot. Null for an unknown agent or one that already ended, so a second end never journals twice.
   */
  end(id: AgentKey, state: TerminalState, extra: AgentPatch = {}): ItemEntry | null {
    const current = this.agents.get(id)
    if (!current || !this.isLive(id)) return null
    const { endedAt, ...rest } = extra
    return this.update(id, { ...rest, state, endedAt: endedAt ?? Date.now() })
  }

  /**
   * Puts an ended agent back to `working` because the native agent was given new work, clearing
   * `endedAt`, `cutOff`, `report` and `error`, and returns the new snapshot. Null for an unknown or
   * live id. `update` still ignores late events for an ended agent, so only a runner's explicit
   * new-work signal should call this.
   */
  reopen(id: AgentKey): ItemEntry | null {
    const current = this.agents.get(id)
    if (!current || this.isLive(id)) return null
    const { endedAt: _endedAt, cutOff: _cutOff, report: _report, error: _error, ...rest } = current
    const item: AgentItem = { ...rest, state: 'working' }
    this.agents.set(id, item)
    return entryOf(item, this.parents.get(id))
  }

  /** A copy of the agent's latest snapshot, or undefined for an unknown id. */
  get(id: AgentKey): AgentItem | undefined {
    const item = this.agents.get(id)
    return item ? { ...item } : undefined
  }

  /** Whether the registry knows the agent, live or ended. */
  has(id: AgentKey): boolean {
    return this.agents.has(id)
  }

  /** Whether the agent is `working` or `needs-you`. False for an unknown id. */
  isLive(id: AgentKey): boolean {
    const state = this.agents.get(id)?.state
    return state === 'working' || state === 'needs-you'
  }

  /** The keys of every live agent, in spawn order. */
  live(): AgentKey[] {
    return [...this.agents.keys()].filter((id) => this.isLive(id))
  }

  private wouldCycle(id: AgentKey, parent: AgentKey | undefined): boolean {
    const seen = new Set<AgentKey>()
    for (let cur = parent; cur !== undefined && !seen.has(cur); cur = this.parents.get(cur)) {
      if (cur === id) return true
      seen.add(cur)
    }
    return false
  }

  /** The agent's parent, or undefined for a top-level or unknown agent. */
  parentOf(id: AgentKey): AgentKey | undefined {
    return this.parents.get(id)
  }

  /**
   * Every live agent below `id` at any depth, deepest first, so stopping them in order never orphans
   * a running child. Ended agents are walked through but not returned, so a live agent beneath one is
   * still found.
   */
  descendants(id: AgentKey): AgentKey[] {
    const found: { id: AgentKey; depth: number }[] = []
    const visited = new Set<AgentKey>([id])
    const walk = (parent: AgentKey, depth: number): void => {
      for (const [child, owner] of this.parents) {
        if (owner !== parent || visited.has(child)) continue
        visited.add(child)
        if (this.isLive(child)) found.push({ id: child, depth })
        walk(child, depth + 1)
      }
    }
    walk(id, 1)
    return found.sort((a, b) => b.depth - a.depth).map((entry) => entry.id)
  }

  /**
   * Attributes an event to an agent. An empty, null or undefined key is the main agent. A known key
   * is returned as is. An unknown key becomes `unattributed`, and the first such event also returns
   * the spawn entry for that synthetic agent, which the caller must journal before the event.
   */
  resolve(key: string | null | undefined): { agent?: AgentKey; entries: ItemEntry[] } {
    if (key === undefined || key === null || key === '') return { entries: [] }
    if (this.agents.has(key)) return { agent: key, entries: [] }
    if (this.agents.has(UNATTRIBUTED)) return { agent: UNATTRIBUTED, entries: [] }
    const entry = this.spawn({
      id: UNATTRIBUTED,
      name: 'Unattributed',
      task: 'Events whose agent Quirky could not find',
      steps: 'full'
    })
    return { agent: UNATTRIBUTED, entries: [entry] }
  }

  /** Returns a copy of `entry` tagged as produced by `agent`; an undefined agent leaves it as the main agent's. */
  tag(entry: ItemEntry, agent?: AgentKey): ItemEntry {
    if (agent === undefined) return entry
    return { ...entry, item: { ...entry.item, agent } }
  }

  /** Ends every live agent as `stopped` with `cutOff: true`, for a run that ended under them. */
  cutOff(now: number = Date.now()): ItemEntry[] {
    const entries: ItemEntry[] = []
    for (const id of this.live()) {
      const entry = this.end(id, 'stopped', { cutOff: true, endedAt: now })
      if (entry) entries.push(entry)
    }
    return entries
  }

  /** The `createAsk` labels for an ask raised by this agent: `from` and the title "<name> asks". */
  askOptions(id: AgentKey): { from: AgentKey; title: string } {
    return { from: id, title: `${this.agents.get(id)?.name ?? id} asks` }
  }

  /**
   * Flips a live agent between `working` and `needs-you` while an ask is pending. Returns the new
   * snapshot, or null when the agent is unknown, ended, or already in that state.
   */
  setAsking(id: AgentKey, asking: boolean): ItemEntry | null {
    const current = this.agents.get(id)
    if (!current || !this.isLive(id)) return null
    const state: AgentState = asking ? 'needs-you' : 'working'
    if (current.state === state) return null
    return this.update(id, { state })
  }

  /** Snapshots without `summary` for every live agent that has one, so a switch to latest-tool drops stale AI lines. */
  clearSummaries(): ItemEntry[] {
    const entries: ItemEntry[] = []
    for (const id of this.live()) {
      if (this.agents.get(id)?.summary === undefined) continue
      const entry = this.update(id, { summary: undefined })
      if (entry) entries.push(entry)
    }
    return entries
  }
}
