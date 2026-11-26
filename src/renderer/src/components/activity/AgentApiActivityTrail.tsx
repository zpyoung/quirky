import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import {
  getAgentActivitySnapshot,
  subscribeAgentActivity,
  type AgentActivityEntry
} from '@/lib/agent-activity-trail-store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const ALL_WORKSPACES = 'all'
const RELATIVE_TIME_REFRESH_MS = 30_000

type CallerGroup = { key: string; label: string; entries: AgentActivityEntry[] }

function groupByCaller(entries: readonly AgentActivityEntry[]): CallerGroup[] {
  const groups = new Map<string, CallerGroup>()
  for (const entry of entries.toReversed()) {
    const key = `${entry.caller.kind}:${entry.caller.label}`
    const group = groups.get(key) ?? { key, label: entry.caller.label, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function useWorkspaceName(): (workspaceId: string) => string | null {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  return (workspaceId) =>
    findWorktreeById(worktreesByRepo, workspaceId)?.displayName ??
    folderWorkspaces.find((workspace) => workspace.id === workspaceId)?.name ??
    null
}

function useRefreshingNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function EmptyTrail(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-5 py-8 text-center">
      <div className="mb-3 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="size-4" />
      </div>
      <h3 className="text-sm font-medium text-foreground">
        {translate('components.activity.agentApiTrail.empty', 'No agent actions yet')}
      </h3>
      <p className="mt-1 max-w-64 text-xs leading-relaxed text-muted-foreground">
        {translate(
          'components.activity.agentApiTrail.emptyDescription',
          'Changes that agents and scripts make through the Quirky API appear here.'
        )}
      </p>
    </div>
  )
}

/**
 * What agents and scripts changed through the public API during this session, newest first and
 * grouped by who did it. Kept in memory only, so it starts empty after a restart.
 */
export function AgentApiActivityTrail(): React.JSX.Element {
  const entries = useSyncExternalStore(subscribeAgentActivity, getAgentActivitySnapshot)
  const workspaceName = useWorkspaceName()
  const now = useRefreshingNow()
  const [expanded, setExpanded] = useState(true)
  const [workspaceFilter, setWorkspaceFilter] = useState(ALL_WORKSPACES)

  const workspaceIds = useMemo(
    () => [
      ...new Set(
        entries.toReversed().flatMap((entry) => (entry.workspaceId ? [entry.workspaceId] : []))
      )
    ],
    [entries]
  )
  const visibleEntries = useMemo(
    () =>
      workspaceFilter === ALL_WORKSPACES
        ? entries
        : entries.filter((entry) => entry.workspaceId === workspaceFilter),
    [entries, workspaceFilter]
  )
  const groups = useMemo(() => groupByCaller(visibleEntries), [visibleEntries])
  const title = translate('components.activity.agentApiTrail.title', 'Agent activity')

  return (
    <section aria-label={title} className="shrink-0 border-t border-border">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronDown
            className={cn(
              'transition-transform motion-reduce:transition-none',
              !expanded && '-rotate-90'
            )}
          />
          {title}
        </Button>
        {entries.length > 0 ? <Badge variant="secondary">{entries.length}</Badge> : null}
        {expanded && workspaceIds.length > 0 ? (
          <Select value={workspaceFilter} onValueChange={setWorkspaceFilter}>
            <SelectTrigger
              size="sm"
              className="ml-auto h-7 w-[180px] text-xs"
              aria-label={translate(
                'components.activity.agentApiTrail.workspaceFilter',
                'Filter by workspace'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_WORKSPACES}>
                {translate('components.activity.agentApiTrail.allWorkspaces', 'All workspaces')}
              </SelectItem>
              {workspaceIds.map((workspaceId) => (
                <SelectItem key={workspaceId} value={workspaceId}>
                  {workspaceName(workspaceId) ?? workspaceId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {expanded ? (
        <div className="scrollbar-sleek max-h-56 overflow-y-auto pb-2">
          {entries.length === 0 ? (
            <EmptyTrail />
          ) : (
            groups.map((group) => (
              <div key={group.key}>
                <h4 className="px-3 pb-0.5 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </h4>
                <ul>
                  {group.entries.map((entry, index) => {
                    const where = entry.workspaceId ? workspaceName(entry.workspaceId) : null
                    return (
                      <li
                        key={`${entry.at}:${entry.method}:${index}`}
                        className="flex items-baseline gap-2 px-3 py-0.5 text-xs hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {entry.summary}
                          {where ? (
                            <span className="text-muted-foreground">
                              {' '}
                              {translate(
                                'components.activity.agentApiTrail.inWorkspace',
                                'in {{workspace}}',
                                {
                                  workspace: where
                                }
                              )}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {formatUiRelativeTime(entry.at - now)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  )
}
