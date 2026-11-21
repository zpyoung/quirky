import type { CSSProperties } from 'react'
import type { AgentKey } from '@quirky/protocol'
import { StatusDot } from '@quirky/ui'
import { dockSummary, type AgentView } from './agents'
import { chatFrame, type ChatLayout } from './chatLayout'

const frame = { flex: 'none', paddingBlockStart: 'var(--ui-space-4)' } satisfies CSSProperties
const dock = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  width: '100%',
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  color: 'var(--ui-text)',
  background: 'var(--ui-selected)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)',
  font: 'inherit',
  fontSize: 'var(--ui-font-label)',
  textAlign: 'start',
  cursor: 'pointer'
} satisfies CSSProperties
const grow = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
const muted = { color: 'var(--ui-muted)' } satisfies CSSProperties
const amber = { color: 'var(--ui-needs-you)' } satisfies CSSProperties
const red = { color: 'var(--ui-failing)' } satisfies CSSProperties

/**
 * The one line above the composer that says how many agents run, with how many of them need you, are
 * quiet or failed. It is absent while nothing runs, and a click opens the Agents card on the agent
 * that most needs you.
 */
export function AgentDock({ agents, layout, onOpenAgent }: { agents: Map<AgentKey, AgentView>; layout: ChatLayout; onOpenAgent: (agent: AgentKey | null) => void }) {
  const summary = dockSummary(agents)
  if (summary === null) return null
  const { running, nested, needsYou, quiet, failed } = summary
  const attention = needsYou > 0 || quiet > 0
  return (
    <div style={{ ...frame, ...chatFrame(layout) }}>
      <button type="button" style={dock} data-dock onClick={() => onOpenAgent(null)}>
        <StatusDot status={attention ? 'needs-you' : 'working'} />
        <span style={grow}>
          {`${running} ${running === 1 ? 'agent' : 'agents'}`}
          {nested > 0 && <span style={muted}>{` (+${nested})`}</span>}
          {needsYou > 0 && <span style={amber}>{` · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`}</span>}
          {quiet > 0 && <span style={amber}>{` · ${quiet} quiet`}</span>}
          {failed > 0 && <span style={red}>{` · ${failed} failed`}</span>}
        </span>
        <span style={muted}>Agents ▸</span>
      </button>
    </div>
  )
}
