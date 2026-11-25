import { useEffect, useState } from 'react'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/structured-agent-session-subagent-roster'
import { dockSummary } from './agent-dock-summary'
import './panels.css'

const TICK_MS = 1000

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export type AgentDockProps = {
  roster: StructuredAgentSubagentRoster
  /** Opens the turn's Agents card. */
  onOpen?: () => void
}

/**
 * The strip above the composer while subagents run: who is running, what state they report and for
 * how long. It is absent while none runs; the finished agents move to the turn's Agents card.
 */
export function AgentDock({ roster, onOpen }: AgentDockProps) {
  const running = [...roster.values()].some((held) => held.entry.state === 'working')
  const now = useClock(running)
  const summary = dockSummary(roster, now)
  if (summary === null) {
    return null
  }
  const count = summary.running.length
  return (
    <section className="native-chat-panel-dock" aria-label="Running agents" data-agent-dock>
      <div className="native-chat-panel-dock-head">
        <span className="native-chat-panel-dot" aria-hidden="true" />
        <span className="native-chat-panel-dock-count">{`${count} ${count === 1 ? 'agent' : 'agents'} running`}</span>
        {summary.failed > 0 && (
          <span className="native-chat-panel-bad">{`· ${summary.failed} failed`}</span>
        )}
        {summary.unverifiable > 0 && (
          <span className="native-chat-panel-muted">{`· ${summary.unverifiable} not reporting`}</span>
        )}
        {onOpen !== undefined && (
          <button type="button" className="native-chat-panel-dock-open" onClick={onOpen}>
            Agents
          </button>
        )}
      </div>
      <ul className="native-chat-panel-dock-list">
        {summary.running.map((agent) => (
          <li key={agent.id} className="native-chat-panel-dock-row">
            <span className="native-chat-panel-clip">{agent.name}</span>
            <span className="native-chat-panel-muted native-chat-panel-clip">
              {agent.statusLine}
            </span>
            {agent.elapsed !== null && (
              <span className="native-chat-panel-muted native-chat-panel-mono">
                {agent.elapsed}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
