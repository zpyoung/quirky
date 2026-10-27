import type { AgentState, Child } from './types'

export type FoldResult = { state: AgentState; workingMode?: 'monitoring' }

type Liveness = 'waiting' | 'working' | 'monitoring' | null

/** Ranked: a child waiting on a human, then live agent work, then shells and crons alone. */
function childLiveness(children: readonly Child[], cronsActive: boolean): Liveness {
  let hasAgent = false
  let hasNonAgent = cronsActive
  for (const child of children) {
    if (child.state === 'done') continue
    if (child.state === 'waiting') return 'waiting'
    if (child.kind === 'agent') hasAgent = true
    else hasNonAgent = true
  }
  if (hasAgent) return 'working'
  return hasNonAgent ? 'monitoring' : null
}

/**
 * The row's state from the lead's own state and its live children. The lead asking for a human
 * wins; otherwise a child waiting on a human makes the row wait; a settled lead with live agent
 * work is still working, and with only shells or crons it is monitoring. How the lead's turn
 * ended is not an input: a cancel is a verdict on the lead, never on the work it left running.
 */
export function foldLead(leadState: AgentState, children: readonly Child[], cronsActive: boolean): FoldResult {
  if (leadState === 'waiting' || leadState === 'blocked') return { state: leadState }
  const liveness = childLiveness(children, cronsActive)
  if (liveness === 'waiting') return { state: 'waiting' }
  if (leadState !== 'done') return { state: leadState }
  if (liveness === 'working') return { state: 'working' }
  if (liveness === 'monitoring') return { state: 'working', workingMode: 'monitoring' }
  return { state: 'done' }
}
