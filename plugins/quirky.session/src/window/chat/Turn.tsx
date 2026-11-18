import type { CSSProperties } from 'react'
import type { AgentCapabilities, Session, UiPluginContext } from '@quirky/protocol'
import { MessageRow } from '../MessageRow'
import { Activity } from './Activity'
import { FileChange } from './cards/FileChange'
import { Steps } from './cards/Steps'
import { TestResults } from './cards/TestResults'
import { ViewError } from './cards/ViewError'
import { Embedded } from './Embedded'
import { ErrorRow } from './ErrorRow'
import { planRowText } from './plan'
import { Prose, renderUserMarkdown } from './Prose'
import { formatDuration, type Block, type Turn as TurnData } from './turns'

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

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The reason "Allow for this session" is off for this agent, or undefined when it is on or unknown. */
export function sessionApproveDisabled(capabilities: AgentCapabilities | null): string | undefined {
  return capabilities && !capabilities.approveForSession.ok ? capabilities.approveForSession.reason : undefined
}

function BlockView({
  context,
  session,
  capabilities,
  block,
  onShowPlan
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  block: Block
  onShowPlan?: (version: number) => void
}) {
  switch (block.kind) {
    case 'prose':
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
    case 'ask': {
      const disabled = sessionApproveDisabled(capabilities)
      return (
        <Embedded
          context={context}
          viewId={ASK_VIEW}
          input={{ askId: block.item.askId, ...(disabled === undefined ? {} : { sessionApproveDisabled: disabled }) }}
          fallback="This question is waiting in the Questions panel."
        />
      )
    }
    case 'view':
      return <Embedded context={context} viewId={VIEW_RENDER_VIEW} input={{ viewId: block.item.viewId }} fallback="A view was opened here, but views are turned off." />
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

/** One turn: a separator, the user's message and the agent's blocks in order, ending with a note when it stopped or failed. */
export function TurnView({
  context,
  session,
  capabilities,
  data,
  index,
  onOpenPlan
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  data: TurnData
  index: number
  /** Opens the plan panel on a version; the plan rows are inert without it. */
  onOpenPlan?: (version: number) => void
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
        <BlockView key={block.seq} context={context} session={session} capabilities={capabilities} block={block} onShowPlan={onOpenPlan} />
      ))}
      {data.end?.state === 'stopped' && <div style={quiet}>{duration ? `Stopped after ${duration}` : 'Stopped'}</div>}
      {data.end?.state === 'failed' && <div style={failed}>{duration ? `Turn failed after ${duration}` : 'Turn failed'}</div>}
    </section>
  )
}
