import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { normalizeSubagentState } from '../../../../../shared/native-chat-subagent-summary'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentState
} from '../../../../../shared/native-chat-types'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/structured-agent-session-subagent-roster'
import { cn } from '@/lib/utils'
import { FOLD_AT } from '../chat-turns'
import { Card } from './Card'

const STATE_WORDS: Record<NativeChatSubagentState, string> = {
  working: 'working',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  unverifiable: 'lost contact'
}

function entryFor(roster: StructuredAgentSubagentRoster, id: string): NativeChatSubagentEntry {
  return roster.get(id)?.entry ?? { id, label: id, state: 'idle' }
}

function countsLine(entries: readonly NativeChatSubagentEntry[]): string {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const word = STATE_WORDS[normalizeSubagentState(entry.state)]
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts].map(([word, count]) => `${count} ${word}`).join(' · ')
}

function AgentRow({ entry }: { entry: NativeChatSubagentEntry }): React.JSX.Element {
  const state = normalizeSubagentState(entry.state)
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5" data-agent-state={state}>
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          state === 'working' && 'animate-pulse bg-chat-warning motion-reduce:animate-none',
          (state === 'completed' || state === 'idle') && 'bg-chat-foreground-faint',
          (state === 'failed' || state === 'stopped' || state === 'unverifiable') &&
            'bg-destructive'
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate font-medium" title={entry.label}>
        {entry.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{STATE_WORDS[state]}</span>
      {entry.tokens !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {`${new Intl.NumberFormat('en', { notation: 'compact' }).format(entry.tokens)} tokens`}
        </span>
      )}
    </li>
  )
}

/** The subagents a turn started. Past `FOLD_AT` of them the card shows one counts line that opens to the list. */
export function AgentsCard({
  agentIds,
  roster
}: {
  agentIds: readonly string[]
  roster: StructuredAgentSubagentRoster
}): React.JSX.Element {
  const entries = agentIds.map((id) => entryFor(roster, id))
  const folded = entries.length >= FOLD_AT
  const [open, setOpen] = useState(!folded)
  const noun = entries.length === 1 ? 'agent' : 'agents'
  return (
    <Card
      label="Agents"
      ariaLabel={`${entries.length} ${noun}`}
      header={
        folded ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
            className="flex min-w-0 items-center gap-1.5 rounded-md text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform motion-reduce:transition-none',
                open && 'rotate-90'
              )}
              aria-hidden="true"
            />
            {`${entries.length} ${noun} · ${countsLine(entries)}`}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">{countsLine(entries)}</span>
        )
      }
    >
      {open ? (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <AgentRow key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : undefined}
    </Card>
  )
}
