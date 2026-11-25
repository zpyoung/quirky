import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

type TurnFields = Pick<AgentStatusEntry, 'state' | 'workingMode' | 'mainAgent'>

// Why mainAgent: background children keep a row `working` after the lead's turn ends, and that
// finished turn is still news; only the lead itself working again supersedes it.
function isMainAgentWorking(entry: TurnFields): boolean {
  return (
    entry.state === 'working' &&
    entry.workingMode !== 'monitoring' &&
    (entry.mainAgent === undefined || entry.mainAgent.state === 'working')
  )
}

/**
 * True when a pane's main agent begins a new turn, which supersedes the completion or question
 * that pane last raised: the attention it asked for is no longer what the agent is doing.
 */
export function startsNewAgentTurn(previous: TurnFields | undefined, next: TurnFields): boolean {
  return isMainAgentWorking(next) && !(previous && isMainAgentWorking(previous))
}
