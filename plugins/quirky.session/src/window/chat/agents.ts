import type { AgentItem, AgentKey, AgentState, StructuredMessage } from '@quirky/protocol'

/** How long a working agent may produce nothing before it shows as quiet. */
export const QUIET_AFTER_MS = 120_000

/** One subagent as the chat shows it: its latest journaled snapshot plus what the UI derives from the items it tagged. */
export type AgentView = {
  id: AgentKey
  /** The agent that started this one; absent for top-level agents and for parents the journal has no record of. */
  parent?: AgentKey
  name: string
  task: string
  prompt?: string
  model?: string
  background: boolean
  /** The journaled state, or `quiet` when a working agent has gone silent. */
  state: AgentState | 'quiet'
  cutOff: boolean
  refused?: string
  startedAt: number
  endedAt?: number
  tokens?: number
  /** The current-action line: the agent's own summary, else its latest tool call, else its task. */
  line: string
  report?: string
  error?: string
  steps: 'full' | 'none'
  depth: number
  children: AgentKey[]
  spawnSeq: number
  /** The seq of the first snapshot that ended the agent. */
  endSeq?: number
  /** When the agent last did anything, in epoch ms; drives the quiet label. */
  lastAt: number
  /** The messages tagged with this agent: its own items and the `agent` items of its children. */
  items: StructuredMessage[]
}

const LIVE = new Set<AgentView['state']>(['working', 'needs-you', 'quiet'])
const TERMINAL = new Set<AgentState>(['done', 'failed', 'stopped'])

/** Whether an agent state is one that has ended. */
export const isTerminal = (state: AgentState): boolean => TERMINAL.has(state)

/** Whether the agent is running now, including needing you or being quiet. Refused spawns are never live. */
export const isLive = (agent: AgentView): boolean => agent.refused === undefined && LIVE.has(agent.state)

type Draft = { item: AgentItem; spawnSeq: number; endSeq?: number; lastAt: number; items: StructuredMessage[]; calls: Map<string, string>; latestTool?: string }

function toolLine(item: NonNullable<StructuredMessage['item']>): string | undefined {
  if (item.kind === 'activity') return item.summary
  if (item.kind === 'tests') return item.command
  return undefined
}

/**
 * Every subagent in `messages` (journal order), keyed by id. The newest `agent` item of an id is its
 * state; a working agent that has tagged nothing for two minutes, with no tagged call still running,
 * is `quiet` as of `now`. An agent that reports no steps (`steps: 'none'`) is never quiet.
 */
export function deriveAgents(messages: StructuredMessage[], now: number): Map<AgentKey, AgentView> {
  const drafts = new Map<AgentKey, Draft>()
  for (const message of messages) {
    const item = message.item
    if (!item) continue
    if (item.kind === 'agent') {
      const draft = drafts.get(item.id)
      if (draft) {
        draft.item = item
        draft.lastAt = Math.max(draft.lastAt, message.at)
        if (draft.endSeq === undefined && isTerminal(item.state)) draft.endSeq = message.seq
      } else {
        drafts.set(item.id, { item, spawnSeq: message.seq, ...(isTerminal(item.state) ? { endSeq: message.seq } : {}), lastAt: message.at, items: [], calls: new Map() })
      }
    }
  }
  for (const message of messages) {
    const item = message.item
    if (!item?.agent) continue
    const draft = drafts.get(item.agent)
    if (!draft) continue
    draft.items.push(message)
    draft.lastAt = Math.max(draft.lastAt, message.at)
    if (item.kind === 'activity' || item.kind === 'file-change' || item.kind === 'tests') draft.calls.set(item.callId, item.state)
    const line = toolLine(item)
    if (line !== undefined) draft.latestTool = line
  }

  const parentOf = (draft: Draft): AgentKey | undefined => (draft.item.agent !== undefined && drafts.has(draft.item.agent) && draft.item.agent !== draft.item.id ? draft.item.agent : undefined)
  const depthOf = (id: AgentKey): number => {
    let depth = 0
    const seen = new Set<AgentKey>([id])
    for (let parent = parentOf(drafts.get(id)!); parent !== undefined && !seen.has(parent); parent = parentOf(drafts.get(parent)!)) {
      seen.add(parent)
      depth += 1
    }
    return depth
  }

  const views = new Map<AgentKey, AgentView>()
  for (const [id, draft] of drafts) {
    const { item } = draft
    const callRunning = [...draft.calls.values()].some((state) => state === 'running')
    const quiet = item.state === 'working' && item.steps === 'full' && !callRunning && now - draft.lastAt >= QUIET_AFTER_MS
    const parent = parentOf(draft)
    views.set(id, {
      id,
      ...(parent === undefined ? {} : { parent }),
      name: item.name,
      task: item.task,
      ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
      ...(item.model === undefined ? {} : { model: item.model }),
      background: item.background === true,
      state: quiet ? 'quiet' : item.state,
      cutOff: item.cutOff === true,
      ...(item.refused === undefined ? {} : { refused: item.refused }),
      startedAt: item.startedAt,
      ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
      ...(item.tokens === undefined ? {} : { tokens: item.tokens }),
      line: item.summary ?? draft.latestTool ?? item.task,
      ...(item.report === undefined ? {} : { report: item.report }),
      ...(item.error === undefined ? {} : { error: item.error }),
      steps: item.steps,
      depth: depthOf(id),
      children: [],
      spawnSeq: draft.spawnSeq,
      ...(draft.endSeq === undefined ? {} : { endSeq: draft.endSeq }),
      lastAt: draft.lastAt,
      items: draft.items
    })
  }
  for (const view of views.values()) if (view.parent !== undefined) views.get(view.parent)!.children.push(view.id)
  return views
}

/** What the dock counts, or null when no agent is live. */
export type DockSummary = { running: number; nested: number; needsYou: number; quiet: number; failed: number }

/**
 * The dock's counts: `running` is live top-level agents and `nested` live deeper ones, while
 * `needsYou`, `quiet` and `failed` count every depth. Refused spawns are never counted.
 */
export function dockSummary(agents: Map<AgentKey, AgentView>): DockSummary | null {
  const counts: DockSummary = { running: 0, nested: 0, needsYou: 0, quiet: 0, failed: 0 }
  for (const agent of agents.values()) {
    if (agent.refused !== undefined) continue
    if (isLive(agent) && agent.depth === 0) counts.running += 1
    else if (isLive(agent)) counts.nested += 1
    if (agent.state === 'needs-you') counts.needsYou += 1
    if (agent.state === 'quiet') counts.quiet += 1
    if (agent.state === 'failed') counts.failed += 1
  }
  return counts.running + counts.nested === 0 ? null : counts
}

const RANK: Partial<Record<AgentView['state'], number>> = { 'needs-you': 0, quiet: 1, working: 2 }

/** The live agents among `ids`, those needing you first, then quiet ones, then working ones; ties keep spawn order. */
export function runningOrder(agents: Map<AgentKey, AgentView>, ids: readonly AgentKey[]): AgentKey[] {
  return ids
    .map((id) => agents.get(id))
    .filter((agent): agent is AgentView => agent !== undefined && isLive(agent))
    .sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || a.spawnSeq - b.spawnSeq)
    .map((agent) => agent.id)
}

/** Whether any descendant of `agent` is waiting on you. */
export function childNeedsYou(agent: AgentView, agents: Map<AgentKey, AgentView>): boolean {
  return agent.children.some((id) => {
    const child = agents.get(id)
    return child !== undefined && (child.state === 'needs-you' || childNeedsYou(child, agents))
  })
}

/** Every agent the Agents card lists: all but refused spawns, in spawn order. */
export const listedAgents = (agents: Map<AgentKey, AgentView>): AgentView[] =>
  [...agents.values()].filter((agent) => agent.refused === undefined).sort((a, b) => a.spawnSeq - b.spawnSeq)

/** The counts line of a folded group of markers: "9 running · 2 need you · 1 quiet · 3 done". */
export function foldCounts(agents: Map<AgentKey, AgentView>, ids: readonly AgentKey[]): string {
  const tally = { running: 0, needsYou: 0, quiet: 0, failed: 0, done: 0, stopped: 0 }
  for (const id of ids) {
    const agent = agents.get(id)
    if (!agent) continue
    if (isLive(agent)) tally.running += 1
    if (agent.state === 'needs-you') tally.needsYou += 1
    else if (agent.state === 'quiet') tally.quiet += 1
    else if (agent.state === 'failed') tally.failed += 1
    else if (agent.state === 'done') tally.done += 1
    else if (agent.state === 'stopped') tally.stopped += 1
  }
  const parts = [
    tally.running > 0 && `${tally.running} running`,
    tally.needsYou > 0 && `${tally.needsYou} ${tally.needsYou === 1 ? 'needs' : 'need'} you`,
    tally.quiet > 0 && `${tally.quiet} quiet`,
    tally.failed > 0 && `${tally.failed} failed`,
    tally.done > 0 && `${tally.done} done`,
    tally.stopped > 0 && `${tally.stopped} stopped`
  ].filter((part): part is string => part !== false)
  return parts.join(' · ')
}

/** The first line of `text`, or undefined when it is empty. */
export function firstLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').find((candidate) => candidate.trim() !== '')?.trim()
  return line === undefined || line === '' ? undefined : line
}

/** What a finished or running agent's row and marker say it did: its report, its error, how it stopped, or its current action. */
export function outcomeLine(agent: AgentView): string {
  if (agent.state === 'failed') return firstLine(agent.error) ?? 'Failed'
  if (agent.state === 'stopped') return agent.cutOff ? 'Cut off when Quirky quit' : 'Stopped by you'
  if (agent.state === 'done') return firstLine(agent.report) ?? firstLine(agent.line) ?? 'Done'
  return agent.line
}
