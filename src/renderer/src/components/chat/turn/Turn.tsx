import type { AgentJournalMessageItem } from '../../../../../shared/agent-session-journal-types'
import { NativeChatRewindAction } from '../../native-chat/NativeChatRewindAction'
import { AgentsCard } from '../cards/AgentsCard'
import { ChangesCard } from '../cards/ChangesCard'
import { FileChange } from '../cards/FileChange'
import { TestResults } from '../cards/TestResults'
import type { ChatBlock, ChatTurn } from '../chat-turns'
import { Activity } from './Activity'
import { AskRow } from './AskRow'
import { useChatTurnEnv } from './chat-turn-env'
import { formatDuration } from './elapsed'
import { ErrorRow } from './ErrorRow'
import { ForkRow } from './ForkRow'
import { InterruptedRow } from './InterruptedRow'
import { ModeMarkerRow } from './ModeMarkerRow'
import { PlanChip } from './PlanChip'
import { Prose } from './Prose'
import { VisualChip } from './VisualChip'

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path

function userText(message: AgentJournalMessageItem): { text: string; images: string[] } {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n')
  const images = message.blocks.flatMap((block) =>
    block.type === 'image-ref' ? [block.path ?? block.url ?? block.alt ?? 'image'] : []
  )
  return { text, images }
}

function UserMessage({ turn }: { turn: ChatTurn }): React.JSX.Element | null {
  const { rewind } = useChatTurnEnv()
  const user = turn.user
  if (!user || user.body.kind !== 'message') {
    return null
  }
  const { text, images } = userText(user.body)
  const canRewind =
    rewind !== undefined && (!rewind.eligibleItemIds || rewind.eligibleItemIds.has(user.itemId))
  return (
    <div className="group/user flex flex-col items-end gap-1" data-chat-row="user">
      <div
        aria-label="Your message"
        className="max-w-[80%] rounded-lg border border-border bg-accent px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere]"
      >
        {text !== '' && <p className="whitespace-pre-wrap">{text}</p>}
        {images.length > 0 && (
          <div
            className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground"
            aria-label="Attached images"
          >
            {images.map((path) => (
              <span key={path} title={path}>
                {basename(path)}
              </span>
            ))}
          </div>
        )}
      </div>
      {canRewind && (
        <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
          <NativeChatRewindAction itemId={user.itemId} rewind={rewind} />
        </div>
      )}
    </div>
  )
}

function BlockView({
  block,
  turnEnded
}: {
  block: ChatBlock
  turnEnded: boolean
}): React.JSX.Element | null {
  const { roster } = useChatTurnEnv()
  switch (block.type) {
    case 'prose':
      return <Prose text={block.text} streaming={block.streaming} />
    case 'activity':
      return <Activity calls={block.calls} turnEnded={turnEnded} />
    case 'file-change':
      return <FileChange item={block.item} />
    case 'test-result':
      return <TestResults item={block.item} />
    case 'changes':
      return <ChangesCard item={block.item} />
    case 'ask':
      return <AskRow item={block.item} />
    case 'plan':
      return <PlanChip item={block.item} />
    case 'visual':
      return <VisualChip item={block.item} />
    case 'agents':
      return <AgentsCard agentIds={block.agentIds} roster={roster} />
    case 'mode':
      return <ModeMarkerRow item={block.item} />
    case 'fork':
      return <ForkRow item={block.item} />
    case 'error':
      return <ErrorRow item={block.item} />
    case 'status':
      return (
        <div className="text-xs text-chat-foreground-faint">
          {block.item.body.kind === 'status'
            ? block.item.body.text
            : block.item.body.kind === 'message'
              ? userText(block.item.body).text
              : null}
        </div>
      )
  }
}

function blockKey(block: ChatBlock, index: number): string {
  switch (block.type) {
    case 'prose':
      return block.itemId
    case 'activity':
      return `activity-${block.calls[0]?.itemId ?? index}`
    case 'agents':
      return `agents-${index}`
    default:
      return block.item.itemId
  }
}

/** One turn: a separator, the owner's message, then the agent's blocks in order, ending with how the turn stopped. */
export function Turn({ turn, index }: { turn: ChatTurn; index: number }): React.JSX.Element {
  const end = turn.end
  const duration = end?.durationMs === undefined ? '' : formatDuration(end.durationMs)
  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      aria-label={`Turn ${index + 1}`}
      data-turn-key={turn.key}
    >
      <div
        aria-hidden="true"
        className="my-1.5 flex items-center gap-2 text-2xs uppercase tracking-wide text-chat-foreground-faint"
      >
        <span className="h-px flex-1 bg-border" />
        <span>{`Turn ${index + 1} · ${timeOf(turn.at)}`}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <UserMessage turn={turn} />
      {turn.blocks.map((block, blockIndex) => (
        <BlockView key={blockKey(block, blockIndex)} block={block} turnEnded={end !== null} />
      ))}
      {end?.state === 'stopped' && (
        <div className="text-xs text-chat-foreground-faint">
          {duration ? `Stopped after ${duration}` : 'Stopped'}
        </div>
      )}
      {end?.state === 'failed' && (
        <div className="text-xs text-destructive">
          {duration ? `Turn failed after ${duration}` : 'Turn failed'}
        </div>
      )}
      {end?.state === 'interrupted' && (
        <InterruptedRow {...(end.durationMs === undefined ? {} : { durationMs: end.durationMs })} />
      )}
    </section>
  )
}
