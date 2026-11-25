import { useEffect, useRef, useState } from 'react'
import { GitFork } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { StructuredAgentContextUsage } from '../../../../../shared/structured-agent-session-context-usage'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { forkStructuredAgentSession } from '@/runtime/structured-agent-session-v1-chat-client'
import { formatElapsed } from '../turn/elapsed'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import { cacheExpiresSoon, cacheMsRemaining, formatCacheClock } from './cache-timer'
import { useClock } from './use-clock'

export type ChatHeaderStatus =
  | { kind: 'working'; startedAt: number | null }
  | { kind: 'waiting' }
  | { kind: 'ready'; agentsRunning: number }
  | { kind: 'done'; agentsRunning: number }

const FORK_FAILURE_WORDS = {
  unsupported: "This agent can't fork a chat.",
  busy: 'Wait for the turn to finish, then fork.',
  failed: 'Could not fork this chat.'
} as const

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

function agentsRunningWords(count: number): string {
  return count > 0 ? ` · ${count} ${count === 1 ? 'agent' : 'agents'} running` : ''
}

function statusWords(status: ChatHeaderStatus, now: number): string {
  switch (status.kind) {
    case 'working':
      return `Working · ${formatElapsed(now - (status.startedAt ?? now))}`
    case 'waiting':
      return 'Waiting on you'
    case 'ready':
      return `Ready${agentsRunningWords(status.agentsRunning)}`
    case 'done':
      return `Done${agentsRunningWords(status.agentsRunning)}`
  }
}

function TitleField({
  title,
  onRename
}: {
  title: string
  onRename: ((title: string) => void) | undefined
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)
  useEffect(() => {
    if (editing) {
      cancelled.current = false
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])
  const save = (): void => {
    if (cancelled.current) {
      return
    }
    const next = (input.current?.value ?? '').trim()
    setEditing(false)
    if (next !== '' && next !== title) {
      onRename?.(next)
    }
  }
  if (editing && onRename) {
    return (
      <Input
        ref={input}
        aria-label="Chat title"
        defaultValue={title}
        maxLength={200}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            save()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelled.current = true
            setEditing(false)
          }
        }}
      />
    )
  }
  return onRename ? (
    <button
      type="button"
      aria-label={`Rename chat: ${title}`}
      onClick={() => setEditing(true)}
      className="block max-w-full cursor-text truncate rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {title}
    </button>
  ) : (
    <span className="block max-w-full truncate">{title}</span>
  )
}

/**
 * The row above the transcript: the chat's title (click to rename when a setter is wired), its
 * status, the context window in use, Claude's cache timer, and Fork where the host supports it.
 */
export function ChatHeader({
  title,
  agentLabel,
  status,
  contextUsage,
  journalItems,
  sessionAgent,
  target,
  sessionId,
  forkAvailable,
  onRename,
  onForked
}: {
  title: string
  agentLabel: string
  status: ChatHeaderStatus
  contextUsage: StructuredAgentContextUsage | null
  /** The loaded journal, which carries the newest turn's cache facts. */
  journalItems: readonly AgentJournalRenderItem[]
  sessionAgent: string
  target: RuntimeClientTarget
  sessionId: string
  /** The host advertises `agentSession.fork`. */
  forkAvailable: boolean
  onRename: ((title: string) => void) | undefined
  onForked: ((sessionId: string) => void) | undefined
}): React.JSX.Element {
  const [cacheWarm, setCacheWarm] = useState(false)
  const now = useClock(status.kind === 'working' || cacheWarm, journalItems)
  const cacheMsLeft = cacheMsRemaining(journalItems, sessionAgent, now)
  const cacheTicking = cacheMsLeft !== null
  useEffect(() => {
    setCacheWarm(cacheTicking)
  }, [cacheTicking])
  const [forking, setForking] = useState(false)
  const [forkUnsupported, setForkUnsupported] = useState(false)
  const turnBusy = status.kind === 'working' || status.kind === 'waiting'
  const fork = (): void => {
    setForking(true)
    void forkStructuredAgentSession(target, sessionId)
      .then((result) => {
        if (result.ok) {
          onForked?.(result.sessionId)
          return
        }
        setForkUnsupported(result.reason === 'unsupported')
        toast.error(FORK_FAILURE_WORDS[result.reason])
      })
      .finally(() => setForking(false))
  }
  return (
    <header className="flex min-h-10 min-w-0 items-center gap-3 border-b border-border px-3 text-xs text-muted-foreground">
      <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
        <TitleField title={title || agentLabel} onRename={onRename} />
      </h2>
      <span className="flex shrink-0 items-center gap-1.5" role="status">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            status.kind === 'working' && 'animate-pulse bg-chat-warning motion-reduce:animate-none',
            status.kind === 'waiting' && 'bg-chat-warning',
            (status.kind === 'ready' || status.kind === 'done') && 'bg-chat-foreground-faint'
          )}
        />
        {statusWords(status, now)}
      </span>
      {contextUsage && (
        <span
          className="shrink-0"
          title={`${contextUsage.usedTokens.toLocaleString()} of ${contextUsage.windowTokens.toLocaleString()} tokens${contextUsage.estimated ? ' (estimated)' : ''}`}
        >
          {`${compact.format(contextUsage.usedTokens)} / ${compact.format(contextUsage.windowTokens)} tokens`}
        </span>
      )}
      {cacheMsLeft !== null && (
        <span
          className={cn('shrink-0', cacheExpiresSoon(cacheMsLeft) && 'text-chat-warning')}
          title="Time left before the agent's prompt cache expires"
        >
          {`Cache ${formatCacheClock(cacheMsLeft)}`}
        </span>
      )}
      {forkAvailable && !forkUnsupported && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={turnBusy || forking}
          title={turnBusy ? 'Available when the turn ends' : 'Fork this chat'}
          onClick={fork}
        >
          <GitFork aria-hidden="true" />
          Fork
        </Button>
      )}
    </header>
  )
}
