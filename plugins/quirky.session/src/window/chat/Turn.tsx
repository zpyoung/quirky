import { useState, type CSSProperties } from 'react'
import type { AgentCapabilities, AgentKey, Session, UiPluginContext } from '@quirky/protocol'
import { IconButton, StatusDot, type UiStatus } from '@quirky/ui'
import { MessageRow } from '../MessageRow'
import { foldCounts, isLive, outcomeLine, type AgentView } from './agents'
import { Activity } from './Activity'
import { FileChange } from './cards/FileChange'
import { Steps } from './cards/Steps'
import { TestResults } from './cards/TestResults'
import { ViewError } from './cards/ViewError'
import { Embedded } from './Embedded'
import { ErrorRow } from './ErrorRow'
import { planRowText } from './plan'
import { Prose, renderUserMarkdown } from './Prose'
import { formatDuration, type Block, type MarkerPhase, type Turn as TurnData } from './turns'
import { VisualChip } from './VisualChip'
import type { ViewIndex } from './VisualPanel'

export const ASK_VIEW = 'view:quirky.ask/card'
export const VIEW_RENDER_VIEW = 'view:quirky.view/render'
export const VIEW_PANE_VIEW = 'view:quirky.view/pane'
export const TURN_CHANGES_VIEW = 'view:quirky.git/turn-changes'

const turn = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const separator = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  margin: 'var(--ui-space-6) 0',
  color: 'var(--ui-muted)',
  fontSize: 'var(--ui-font-section)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase'
} satisfies CSSProperties
const rule = { flex: '1 1 auto', height: 'var(--ui-border-width)', background: 'var(--ui-border)' } satisfies CSSProperties
const you = {
  alignSelf: 'flex-end',
  maxWidth: '80%',
  padding: 'var(--ui-space-8) var(--ui-space-12)',
  overflowWrap: 'anywhere',
  background: 'var(--ui-selected)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)'
} satisfies CSSProperties
const images = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4)', marginTop: 'var(--ui-space-4)', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const quiet = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const failed = { ...quiet, color: 'var(--ui-failing)' } satisfies CSSProperties
const planRow = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  color: 'var(--ui-muted)',
  background: 'var(--ui-transparent)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)',
  font: 'inherit',
  fontSize: 'var(--ui-font-label)',
  textAlign: 'start',
  cursor: 'pointer'
} satisfies CSSProperties
const planRowLive = { ...planRow, color: 'var(--ui-text)', border: 'var(--ui-border-width) solid var(--ui-accent)' } satisfies CSSProperties

const markerRow = { ...planRow, gap: 'var(--ui-space-6)', minWidth: 0, border: 'var(--ui-border-width) solid var(--ui-transparent)' } satisfies CSSProperties
const markerText = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } satisfies CSSProperties
const markerName = { color: 'var(--ui-text)', fontWeight: 600 } satisfies CSSProperties
const markerOpen = {
  flex: 'none',
  padding: '0 var(--ui-space-6)',
  color: 'var(--ui-muted)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)',
  fontSize: 'var(--ui-font-label)'
} satisfies CSSProperties
const foldList = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-2)',
  marginInlineStart: 'var(--ui-space-8)',
  paddingInlineStart: 'var(--ui-space-8)',
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const askRow = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', alignItems: 'flex-start' } satisfies CSSProperties
const askOpen = { ...markerOpen, background: 'var(--ui-transparent)', font: 'inherit', fontSize: 'var(--ui-font-label)', cursor: 'pointer' } satisfies CSSProperties

const proseBox = { position: 'relative', minWidth: 0 } satisfies CSSProperties
const visualizeButton = { position: 'absolute', insetBlockStart: 0, insetInlineEnd: 0 } satisfies CSSProperties

/** The most of an agent block quoted when asking for a visual of it. */
const VISUALIZE_QUOTE_CHARS = 600

/** What Visualize sends the agent for the block `text`. */
export const visualizeRequest = (text: string): string =>
  `Visualize this part of your earlier reply as a visual in the panel:\n\n> ${text.slice(0, VISUALIZE_QUOTE_CHARS)}`

/** What the turn's blocks offer to do with the visual panel: ask for a visual of a block, and open a visual at a version. */
export type VisualActions = {
  views: ViewIndex
  /** The seq of the block whose Visualize request is waiting on its visual, or null. */
  busySeq: number | null
  onVisualize: (seq: number, request: string) => void
  onOpen: (viewId: string, version: number) => void
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The reason "Allow for this session" is off for this agent, or undefined when it is on or unknown. */
export function sessionApproveDisabled(capabilities: AgentCapabilities | null): string | undefined {
  return capabilities && !capabilities.approveForSession.ok ? capabilities.approveForSession.reason : undefined
}

/** An agent's prose with the ◈ Visualize icon, which shows on hover or keyboard focus and stays while its request is pending. */
function VisualizableProse({ context, session, block, actions }: { context: UiPluginContext; session: Session; block: Extract<Block, { kind: 'prose' }>; actions: VisualActions }) {
  const [shown, setShown] = useState(false)
  const busy = actions.busySeq === block.seq
  return (
    <div
      style={proseBox}
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      onFocus={() => setShown(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShown(false)
      }}
    >
      <Prose context={context} session={session} text={block.text} streaming={block.streaming} />
      {!block.streaming && (
        <IconButton
          label="Visualize"
          title={busy ? 'Visualizing' : 'Visualize'}
          aria-busy={busy || undefined}
          disabled={busy}
          style={{ ...visualizeButton, opacity: shown || busy ? 1 : 0 }}
          onClick={() => actions.onVisualize(block.seq, visualizeRequest(block.text))}
        >
          <span aria-hidden="true">◈</span>
        </IconButton>
      )}
    </div>
  )
}

/** A React key unique within a turn: a first snapshot that already ended gives a spawn and a return marker the same seq. */
export const blockKey = (block: Block): string => (block.kind === 'agent-marker' || block.kind === 'agent-fold' ? `${block.seq}-${block.phase}` : String(block.seq))

const NO_AGENTS: ReadonlyMap<AgentKey, AgentView> = new Map()

/** The dot status of an agent: working, needs you, failed, or finished. */
export function agentStatus(agent: AgentView | undefined): UiStatus {
  if (!agent) return 'idle'
  if (agent.state === 'needs-you' || agent.state === 'quiet') return 'needs-you'
  if (agent.state === 'working') return 'working'
  if (agent.state === 'failed') return 'failing'
  return agent.state === 'done' ? 'done' : 'idle'
}

/** One spawn or return marker: a quiet row that opens the agent in the Agents card. */
function AgentMarker({ agent, id, phase, onOpenAgent }: { agent: AgentView | undefined; id: AgentKey; phase: MarkerPhase; onOpenAgent?: (agent: AgentKey | null) => void }) {
  const name = agent?.name ?? 'Agent'
  if (agent?.refused !== undefined && phase === 'spawn') {
    return (
      <div style={{ ...markerRow, color: 'var(--ui-failing)' }} data-marker="refused">
        <span style={markerText}>{`${name} was not started · ${agent.refused}`}</span>
      </div>
    )
  }
  const failedReturn = phase === 'return' && agent?.state === 'failed'
  const label = phase === 'spawn' ? 'Spawned' : null
  return (
    <button type="button" style={markerRow} data-marker={phase} data-agent={id} onClick={() => onOpenAgent?.(id)}>
      <StatusDot status={phase === 'spawn' && !(agent && isLive(agent)) ? 'done' : agentStatus(agent)} />
      <span style={markerText}>
        {label !== null ? (
          <>
            {`${label} `}
            <span style={markerName}>{name}</span>
            {`${agent?.background ? ' in background' : ''} · ${agent?.task ?? ''}`}
          </>
        ) : (
          <>
            <span style={markerName}>{name}</span>
            {failedReturn ? <span style={{ color: 'var(--ui-failing)' }}> failed</span> : agent?.state === 'stopped' ? ' stopped' : ' returned'}
            {` · ${agent ? outcomeLine(agent) : ''}`}
          </>
        )}
      </span>
      <span style={markerOpen}>Open</span>
    </button>
  )
}

/** Four or more markers of one phase as one counts line that expands to the markers themselves. */
function AgentFold({ ids, phase, agents, onOpenAgent }: { ids: AgentKey[]; phase: MarkerPhase; agents: ReadonlyMap<AgentKey, AgentView>; onOpenAgent?: (agent: AgentKey | null) => void }) {
  const [open, setOpen] = useState(false)
  const onToggleFold = () => setOpen(!open)
  const all = agents as Map<AgentKey, AgentView>
  const counts = foldCounts(all, ids)
  const needs = ids.some((id) => agents.get(id)?.state === 'needs-you' || agents.get(id)?.state === 'quiet')
  const running = ids.some((id) => agents.get(id) !== undefined && isLive(agents.get(id)!))
  return (
    <>
      <button type="button" style={markerRow} aria-expanded={open} data-marker={`${phase}-fold`} onClick={onToggleFold}>
        <StatusDot status={phase === 'spawn' && needs ? 'needs-you' : phase === 'spawn' && running ? 'working' : 'done'} />
        <span style={markerText}>
          {phase === 'spawn' ? `Spawned ${ids.length} agents` : `${ids.length} agents returned`}
          {counts !== '' && ` · ${counts}`}
        </span>
        <span aria-hidden="true">{open ? '\u25be' : '\u25b8'}</span>
      </button>
      {open && (
        <div style={foldList}>
          {ids.map((id) => (
            <AgentMarker key={id} id={id} agent={agents.get(id)} phase={phase} onOpenAgent={onOpenAgent} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * One piece of a turn as drawn in the chat or in an agent's transcript. `agents` names the agents
 * the markers and asks point at, and `onOpenAgent` opens one in the Agents card.
 */
export function BlockView({
  context,
  session,
  capabilities,
  block,
  onShowPlan,
  visual,
  agents = NO_AGENTS,
  onOpenAgent
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  block: Block
  onShowPlan?: (version: number) => void
  visual?: VisualActions
  agents?: ReadonlyMap<AgentKey, AgentView>
  onOpenAgent?: (agent: AgentKey | null) => void
}) {
  switch (block.kind) {
    case 'prose':
      if (visual) return <VisualizableProse context={context} session={session} block={block} actions={visual} />
      return <Prose context={context} session={session} text={block.text} streaming={block.streaming} />
    case 'activity':
      return <Activity calls={block.calls} />
    case 'file-change':
      return <FileChange item={block.item} root={session.cwd} />
    case 'tests':
      return <TestResults item={block.item} />
    case 'steps':
      return <Steps item={block.item} state={block.state} />
    case 'plan':
      return (
        <button type="button" style={block.item.status === 'waiting' ? planRowLive : planRow} onClick={() => onShowPlan?.(block.item.version)}>
          {planRowText(block.item)}
        </button>
      )
    case 'agent-marker':
      return <AgentMarker id={block.agent} agent={agents.get(block.agent)} phase={block.phase} onOpenAgent={onOpenAgent} />
    case 'agent-fold':
      return <AgentFold ids={block.agents} phase={block.phase} agents={agents} onOpenAgent={onOpenAgent} />
    case 'ask': {
      const disabled = sessionApproveDisabled(capabilities)
      const from = block.item.from
      const embedded = (
        <Embedded
          context={context}
          viewId={ASK_VIEW}
          input={{ askId: block.item.askId, ...(disabled === undefined ? {} : { sessionApproveDisabled: disabled }) }}
          fallback="This question is waiting in the Questions panel."
        />
      )
      if (from === undefined || !onOpenAgent) return embedded
      return (
        <div style={askRow}>
          {embedded}
          <button type="button" style={askOpen} onClick={() => onOpenAgent(from)}>{`Open ${agents.get(from)?.name ?? 'agent'}`}</button>
        </div>
      )
    }
    case 'view': {
      const inline = <Embedded context={context} viewId={VIEW_RENDER_VIEW} input={{ viewId: block.item.viewId }} fallback="A view was opened here, but views are turned off." />
      if (!visual || visual.views.status === 'unavailable') return inline
      if (visual.views.status === 'loading') return null
      const record = visual.views.byId.get(block.item.viewId)
      if (record?.placement === 'inline') return inline
      const version = block.item.version ?? 1
      return <VisualChip title={record?.title ?? 'Visual'} version={version} onOpen={() => visual.onOpen(block.item.viewId, version)} />
    }
    case 'changes':
      return (
        <Embedded
          context={context}
          viewId={TURN_CHANGES_VIEW}
          input={{ worktree: block.item.worktree, fromTree: block.item.fromTree, toTree: block.item.toTree }}
          fallback={`This turn changed ${block.item.files} ${block.item.files === 1 ? 'file' : 'files'}.`}
        />
      )
    case 'view-error':
      return <ViewError title={block.item.title} errors={block.item.errors} source={block.item.source} agent={session.agent} />
    case 'error':
      return <ErrorRow context={context} session={session} item={block.item} capabilities={capabilities} />
    case 'status':
      return <div style={quiet}>{block.text}</div>
    case 'legacy':
      return <MessageRow message={block.message} />
  }
}

/**
 * One turn: a separator, the user's message and the agent's blocks in order, ending with a note when it
 * stopped or failed. With `visual`, a view the agent placed in the panel shows as a chip that opens it
 * and agent prose offers Visualize; a view placed inline shows as its card, and without `visual` every
 * view does.
 */
export function TurnView({
  context,
  session,
  capabilities,
  data,
  index,
  onOpenPlan,
  visual,
  agents,
  onOpenAgent
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  data: TurnData
  index: number
  /** Opens the plan panel on a version; the plan rows are inert without it. */
  onOpenPlan?: (version: number) => void
  visual?: VisualActions
  /** The chat's subagents, for the markers and ask links; without it markers still draw, unnamed. */
  agents?: ReadonlyMap<AgentKey, AgentView>
  /** Opens an agent in the Agents card, or the first running one for null; the Open controls are inert without it. */
  onOpenAgent?: (agent: AgentKey | null) => void
}) {
  const duration = data.end?.durationMs === undefined ? '' : formatDuration(data.end.durationMs)
  return (
    <section style={turn} aria-label={`Turn ${index + 1}`}>
      <div style={separator} aria-hidden="true">
        <span style={rule} />
        <span>{`Turn ${index + 1} · ${timeOf(data.at)}`}</span>
        <span style={rule} />
      </div>
      {data.user && (
        <div style={you} aria-label="Your message">
          {renderUserMarkdown(data.user.text)}
          {data.user.images.length > 0 && (
            <div style={images} aria-label="Attached images">
              {data.user.images.map((path) => (
                <span key={path} title={path}>{basename(path)}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {data.blocks.map((block) => (
        <BlockView key={blockKey(block)} context={context} session={session} capabilities={capabilities} block={block} onShowPlan={onOpenPlan} visual={visual} agents={agents} onOpenAgent={onOpenAgent} />
      ))}
      {data.end?.state === 'stopped' && <div style={quiet}>{duration ? `Stopped after ${duration}` : 'Stopped'}</div>}
      {data.end?.state === 'failed' && <div style={failed}>{duration ? `Turn failed after ${duration}` : 'Turn failed'}</div>}
    </section>
  )
}
