import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentCapabilities, AgentKey, Session, UiPluginContext } from '@quirky/protocol'
import { StatusDot } from '@quirky/ui'
import { childNeedsYou, isLive, listedAgents, outcomeLine, runningOrder, type AgentView } from './agents'
import { compactTokens } from './ChatHeader'
import { formatElapsed } from './elapsed'
import { Prose } from './Prose'
import { agentStatus, BlockView, blockKey } from './Turn'
import { groupTurns } from './turns'

/** Done agents listed before the group starts collapsed. */
const DONE_OPEN_UP_TO = 3
const INDENT = 'var(--ui-space-12)'

const frame = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const list = { display: 'flex', flex: '1 1 calc(160 * var(--ui-length-unit))', flexDirection: 'column', gap: 'var(--ui-space-2)', minWidth: 0 } satisfies CSSProperties
const transcript = { display: 'flex', flex: '2 1 calc(220 * var(--ui-length-unit))', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const group = {
  margin: 'var(--ui-space-6) var(--ui-space-4) var(--ui-space-2)',
  padding: 0,
  color: 'var(--ui-muted)',
  background: 'none',
  border: 0,
  font: 'inherit',
  fontSize: 'var(--ui-font-section)',
  letterSpacing: '0.06em',
  textAlign: 'start',
  textTransform: 'uppercase'
} satisfies CSSProperties
const rowBox = { position: 'relative', minWidth: 0 } satisfies CSSProperties
const rowButton = (selected: boolean, depth: number): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-2)',
  width: '100%',
  minWidth: 0,
  padding: `var(--ui-space-4) var(--ui-space-6) var(--ui-space-4) calc(var(--ui-space-6) + ${depth} * ${INDENT})`,
  color: 'var(--ui-text)',
  background: selected ? 'var(--ui-selected)' : 'var(--ui-transparent)',
  border: 0,
  borderRadius: 'var(--ui-radius-window)',
  font: 'inherit',
  fontSize: 'var(--ui-font-label)',
  textAlign: 'start',
  cursor: 'pointer'
})
const rowTop = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-6)', minWidth: 0 } satisfies CSSProperties
const rowSub = {
  paddingInlineStart: 'calc(var(--ui-status-dot-size) + var(--ui-space-6))',
  color: 'var(--ui-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
} satisfies CSSProperties
const rowStop = { position: 'absolute', insetBlockStart: 'var(--ui-space-4)', insetInlineEnd: 'var(--ui-space-4)' } satisfies CSSProperties
const smallButton = {
  padding: '0 var(--ui-space-6)',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)',
  font: 'inherit',
  fontSize: 'var(--ui-font-label)',
  cursor: 'pointer'
} satisfies CSSProperties
const muted = { color: 'var(--ui-muted)' } satisfies CSSProperties
const amber = { color: 'var(--ui-needs-you)' } satisfies CSSProperties
const red = { color: 'var(--ui-failing)' } satisfies CSSProperties
const mono = { color: 'var(--ui-muted)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'var(--ui-font-mono)' } satisfies CSSProperties
const header = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-2)',
  paddingBlockEnd: 'var(--ui-space-6)',
  borderBlockEnd: 'var(--ui-border-width) solid var(--ui-border)',
  fontSize: 'var(--ui-font-label)'
} satisfies CSSProperties
const headerTop = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-6)', minWidth: 0 } satisfies CSSProperties
const spacer = { flex: '1 1 auto' } satisfies CSSProperties
const prompt = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const promptBody = {
  margin: 'var(--ui-space-4) 0 0 var(--ui-space-4)',
  padding: '0 0 0 var(--ui-space-8)',
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere'
} satisfies CSSProperties
const liveLine = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-6)', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Why Stop is off for this agent, or undefined when it works. */
function stopDisabled(capabilities: AgentCapabilities | null): string | undefined {
  return capabilities?.stopAgent && !capabilities.stopAgent.ok ? capabilities.stopAgent.reason : undefined
}

/** Asks the daemon to stop one agent and its subagents; the turn and the other agents keep going. */
function stopAgent(context: UiPluginContext, sessionId: string, agent: AgentKey): void {
  context.call('quirky.structured/stopAgent', { session: sessionId, agent }).catch((error: unknown) => {
    context.toast('Could not stop the agent', messageOf(error), { kind: 'error' })
  })
}

function stateLabel(agent: AgentView, now: number) {
  if (agent.state === 'needs-you') return <span style={amber}>needs you</span>
  if (agent.state === 'quiet') return <span style={amber}>{`quiet ${Math.max(1, Math.floor((now - agent.lastAt) / 60_000))}m`}</span>
  if (agent.state === 'failed') return <span style={red}>failed</span>
  if (agent.state === 'stopped') return <span style={muted}>{agent.cutOff ? 'stopped · cut off' : 'stopped'}</span>
  return null
}

const elapsedOf = (agent: AgentView, now: number) => formatElapsed((agent.endedAt ?? now) - agent.startedAt)

function Row({
  agent,
  agents,
  depth,
  selected,
  now,
  stopReason,
  onSelect,
  onStop
}: {
  agent: AgentView
  agents: Map<AgentKey, AgentView>
  depth: number
  selected: boolean
  now: number
  stopReason: string | undefined
  onSelect: (id: AgentKey) => void
  onStop: (id: AgentKey) => void
}) {
  const [hover, setHover] = useState(false)
  const live = isLive(agent)
  return (
    <div
      style={rowBox}
      data-agent-row={agent.id}
      data-depth={depth}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(false)
      }}
    >
      <button type="button" style={rowButton(selected, depth)} aria-pressed={selected} onClick={() => onSelect(agent.id)}>
        <span style={rowTop}>
          <StatusDot status={agentStatus(agent)} />
          <b>{agent.name}</b>
          {stateLabel(agent, now)}
          {childNeedsYou(agent, agents) && <span style={amber}> · child needs you</span>}
          <span style={spacer} />
          <span style={mono}>{elapsedOf(agent, now)}</span>
        </span>
        <span style={rowSub}>{outcomeLine(agent)}</span>
      </button>
      {live && hover && (
        <button type="button" style={{ ...smallButton, ...rowStop }} aria-label={`Stop ${agent.name}`} disabled={stopReason !== undefined} title={stopReason} onClick={() => onStop(agent.id)}>
          Stop
        </button>
      )}
    </div>
  )
}

/**
 * The Agents card: every agent of the chat, running ones first (those needing you at the top) with
 * their subagents indented below, finished ones under Done, and the selected agent's read-only
 * transcript beside them. Stop ends one agent and its subagents, and is off with a reason when the
 * chat's agent cannot do that.
 */
export function AgentsCard({
  context,
  session,
  capabilities,
  agents,
  selected,
  now,
  onSelect
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  agents: Map<AgentKey, AgentView>
  selected: AgentKey | null
  now: number
  onSelect: (id: AgentKey) => void
}) {
  const [doneOpen, setDoneOpen] = useState(false)
  const onToggleDone = () => setDoneOpen(!doneOpen)
  const listed = useMemo(() => listedAgents(agents), [agents])
  const tops = listed.filter((agent) => agent.parent === undefined)
  const running = runningOrder(agents, tops.map((agent) => agent.id))
  const done = tops.filter((agent) => !isLive(agent))
  const collapsed = done.length > DONE_OPEN_UP_TO && !doneOpen
  const current = (selected !== null ? agents.get(selected) : undefined) ?? agents.get(running[0] ?? tops[0]?.id ?? '')
  const stopReason = stopDisabled(capabilities)

  const stop = (id: AgentKey) => stopAgent(context, session.id, id)

  const tree = (agent: AgentView, depth: number): ReactNode => (
    <div key={agent.id}>
      <Row agent={agent} agents={agents} depth={depth} selected={current?.id === agent.id} now={now} stopReason={stopReason} onSelect={onSelect} onStop={stop} />
      {agent.children.map((id) => agents.get(id)).flatMap((child) => (child === undefined || child.refused !== undefined ? [] : [tree(child, depth + 1)]))}
    </div>
  )

  return (
    <div style={frame} data-agents-card>
      <div style={list} aria-label="Agents list" role="group">
        {running.length > 0 && <div style={group}>{`Running · ${running.length}`}</div>}
        {running.map((id) => tree(agents.get(id)!, 0))}
        {done.length > DONE_OPEN_UP_TO ? (
          <button type="button" style={group} aria-expanded={!collapsed} onClick={onToggleDone}>{`Done · ${done.length} ${collapsed ? '▸' : '▾'}`}</button>
        ) : (
          done.length > 0 && <div style={group}>{`Done · ${done.length}`}</div>
        )}
        {!collapsed && done.map((agent) => tree(agent, 0))}
      </div>
      {current && <Transcript context={context} session={session} capabilities={capabilities} agents={agents} agent={current} now={now} stopReason={stopReason} onSelect={onSelect} onStop={stop} />}
    </div>
  )
}

function Transcript({
  context,
  session,
  capabilities,
  agents,
  agent,
  now,
  stopReason,
  onSelect,
  onStop
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  agents: Map<AgentKey, AgentView>
  agent: AgentView
  now: number
  stopReason: string | undefined
  onSelect: (id: AgentKey) => void
  onStop: (id: AgentKey) => void
}) {
  const blocks = useMemo(() => groupTurns(agent.items, { owner: agent.id }).flatMap((turn) => turn.blocks), [agent.items, agent.id])
  const onOpenBlockAgent = (id: AgentKey | null) => onSelect(id ?? agent.id)
  const live = isLive(agent)
  const parent = agent.parent === undefined ? undefined : agents.get(agent.parent)
  const hasProse = blocks.some((block) => block.kind === 'prose')
  const facts = [agent.model, elapsedOf(agent, now), agent.tokens === undefined ? undefined : `${compactTokens(agent.tokens)} tokens`].filter((part): part is string => part !== undefined)
  return (
    <section style={transcript} aria-label={`${agent.name} transcript`}>
      <div style={header}>
        <div style={headerTop}>
          <StatusDot status={agentStatus(agent)} />
          <b>{agent.name}</b>
          {parent && <span style={muted}>{`from ${parent.name}`}</span>}
          {stateLabel(agent, now)}
          <span style={spacer} />
          {live && (
            <button type="button" style={smallButton} disabled={stopReason !== undefined} title={stopReason} onClick={() => onStop(agent.id)}>
              Stop
            </button>
          )}
        </div>
        <div style={muted}>{agent.task}</div>
        <div style={mono}>{facts.join(' · ')}</div>
      </div>
      <details style={prompt}>
        <summary>Prompt it was given</summary>
        <div style={promptBody}>{agent.prompt ?? agent.task}</div>
      </details>
      {blocks.map((block) => (
        <BlockView key={blockKey(block)} context={context} session={session} capabilities={capabilities} block={block} agents={agents} onOpenAgent={onOpenBlockAgent} />
      ))}
      {!hasProse && agent.report !== undefined && !live && <Prose context={context} session={session} text={agent.report} streaming={false} />}
      {agent.state === 'failed' && agent.error !== undefined && <div style={red}>{agent.error}</div>}
      {agent.state === 'stopped' && <div style={muted}>{agent.cutOff ? 'Stopped · cut off when Quirky quit' : 'Stopped by you'}</div>}
      {live && (
        <div style={liveLine}>
          <StatusDot status={agentStatus(agent)} />
          <span>{agent.line}</span>
        </div>
      )}
      {agent.steps === 'none' && <div style={muted}>This agent doesn't report its subagents' steps</div>}
    </section>
  )
}
