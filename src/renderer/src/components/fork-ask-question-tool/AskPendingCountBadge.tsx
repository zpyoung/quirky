import { useMemo } from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { selectPendingAskCount } from '../../store/slices/fork-ask-question-tool/asks'
import { buildPendingAskEntries, type PendingAskEntry } from './pending-ask-entries'
import { jumpToPendingAsk } from './jump-to-pending-ask'
import { cancelAsk } from './cancel-ask'

function pendingAskCountLabel(count: number): string {
  return count === 1
    ? translate(
        'components.fork-ask-question-tool.badge.pendingCountLabel_one',
        '{{count}} pending question',
        { count }
      )
    : translate(
        'components.fork-ask-question-tool.badge.pendingCountLabel_other',
        '{{count}} pending questions',
        { count }
      )
}

function entryLocation(entry: PendingAskEntry): string {
  const parts = [entry.worktreeLabel, entry.tabTitle]
  if (entry.paneClosed) {
    parts.push(translate('components.fork-ask-question-tool.pendingList.paneClosed', 'Pane closed'))
  }
  return parts.filter(Boolean).join(' · ')
}

function PendingAskMenuItems(): React.JSX.Element {
  const slices = useAppStore(
    useShallow((state) => ({
      pendingAsksByPaneKey: state.pendingAsksByPaneKey,
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      getKnownWorktreeById: state.getKnownWorktreeById
    }))
  )
  const entries = useMemo(() => buildPendingAskEntries(slices), [slices])

  return (
    <>
      <DropdownMenuLabel>
        {translate('components.fork-ask-question-tool.pendingList.heading', 'Pending questions')}
      </DropdownMenuLabel>
      {entries.map((entry) => (
        <DropdownMenuItem
          key={entry.askId}
          className="flex-col items-start"
          onSelect={() => {
            if (entry.paneClosed) {
              cancelAsk(entry.askId)
            } else {
              jumpToPendingAsk(entry)
            }
          }}
        >
          <span className="max-w-72 truncate text-sm">
            {entry.question ??
              translate('components.fork-ask-question-tool.pendingList.untitled', 'Question')}
          </span>
          <span className="mt-0.5 max-w-72 truncate text-xs text-muted-foreground">
            {entryLocation(entry)}
          </span>
          {entry.paneClosed ? (
            <span className="text-xs font-medium text-destructive">
              {translate('components.fork-ask-question-tool.pendingList.dismiss', 'Dismiss')}
            </span>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** Counts asks awaiting an answer across every pane; opens a list that jumps to the asking pane. */
export function AskPendingCountBadge(): React.JSX.Element | null {
  const count = useAppStore(selectPendingAskCount)
  if (count === 0) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="sidebar-toggle" aria-label={pendingAskCountLabel(count)}>
          <MessageCircleQuestionMark className="mr-1 size-3.5 text-agent-question" />
          <Badge variant="secondary">{count}</Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        <PendingAskMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
