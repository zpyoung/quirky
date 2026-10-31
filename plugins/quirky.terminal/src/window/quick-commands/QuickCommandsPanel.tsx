import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { QuickCommand } from '../../layout/types'
import { Badge, ControlIcon, EmptyState, FormRow, IconButton, ListRow, ToolPanelFrame } from '@quirky/ui'
import { QuickCommandDialog } from './QuickCommandDialog'
import { searchQuickCommands } from './search'
import { PencilIcon, TrashIcon, confirmAndRemove, summaryOf, useQuickCommands } from './shared'

export type ScopeFilter = 'all' | 'global' | 'repo'

/** What the panel tells the window: how many commands exist, and which of them its filter and search show. */
export type QuickCommandsReport = {
  count: number
  filter: ScopeFilter
  query: string
  rows: { id: string; label: string; scope: 'global' | 'repo' }[]
}

const EMPTY_TEXT = 'No quick commands saved. Run them from the Command button in the tab bar, or right-click inside any terminal.'
const FILTERS: { value: ScopeFilter; text: string }[] = [
  { value: 'all', text: 'All commands' },
  { value: 'global', text: 'Global' },
  { value: 'repo', text: 'Project' }
]

type Props = { context: UiPluginContext; report?(state: QuickCommandsReport): void; repo?: string | null }

/** The selected worktree, kept current as the window layout changes. */
function useSelectedWorktree(context: UiPluginContext): string | null {
  const read = () => {
    const worktree = context.getLayout().worktree
    return typeof worktree === 'string' && worktree !== '' ? worktree : null
  }
  const [worktree, setWorktree] = useState(read)
  useEffect(() => {
    setWorktree(read())
    return context.onLayout(() => setWorktree(read()))
  }, [context])
  return worktree
}

/** The repo of the selected worktree, or null when none is selected (or the floating workspace). */
function useCurrentRepo(context: UiPluginContext, override: string | null | undefined): string | null {
  const [repo, setRepo] = useState<string | null>(null)
  const worktree = useSelectedWorktree(context)
  useEffect(() => {
    if (override !== undefined) return
    if (worktree === null || worktree === 'floating') {
      setRepo(null)
      return
    }
    let live = true
    void (async () => {
      try {
        const resolved = (await context.call('quirky.worktree/resolve', { selector: `id:${worktree}` })) as { repoId: string }
        if (live) setRepo(resolved.repoId)
      } catch {
        if (live) setRepo(null)
      }
    })()
    return () => {
      live = false
    }
  }, [context, override, worktree])
  return override !== undefined ? override : repo
}

/**
 * The Quick Commands panel: every saved command with its scope, a scope filter and a search box,
 * and Add, Edit and Delete. It lists all commands, not only the current repo's, because this is
 * where they are managed.
 */
export function QuickCommandsPanel({ context, report, repo: repoOverride }: Props) {
  const { commands, loaded, refresh } = useQuickCommands(context, 'all')
  const repo = useCurrentRepo(context, repoOverride)
  const [filter, setFilter] = useState<ScopeFilter>('all')
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ command: QuickCommand | null } | null>(null)

  const rows = useMemo(() => searchQuickCommands(commands.filter((entry) => filter === 'all' || entry.scope === filter), query), [commands, filter, query])

  useEffect(() => {
    report?.({ count: commands.length, filter, query, rows: rows.map((row) => ({ id: row.id, label: row.label, scope: row.scope })) })
  }, [report, commands.length, filter, query, rows])

  return (
    <div className="tt-tool-panel-fill qc-panel-shell">
      <ToolPanelFrame
        title="Quick Commands"
        tools={
          <IconButton label="Add Command" title="Add Command" onClick={() => setDialog({ command: null })}>
            <ControlIcon name="plus" />
          </IconButton>
        }
      >
        <div className="qc-panel">
          <div className="qc-filters">
            <FormRow label="Search" htmlFor="quick-command-search">
              <input
                id="quick-command-search"
                className="ui-text-field__input"
                type="search"
                placeholder="Search quick commands"
                aria-label="Search quick commands"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </FormRow>
            <FormRow label="Scope" htmlFor="quick-command-scope">
              <select
                id="quick-command-scope"
                className="ui-text-field__input"
                aria-label="Filter by scope"
                value={filter}
                onChange={(event) => setFilter(event.target.value as ScopeFilter)}
              >
                {FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.text}
                  </option>
                ))}
              </select>
            </FormRow>
          </div>
          {!loaded ? null : commands.length === 0 ? (
            <EmptyState message={EMPTY_TEXT} />
          ) : rows.length === 0 ? (
            <EmptyState message={query.trim() ? 'No commands match this search.' : 'No commands in the selected scopes.'} />
          ) : (
            <ul className="qc-list">
              {rows.map((row) => (
                <li key={row.id} className="qc-row" data-command={row.id}>
                  <ListRow
                    title={
                      <span className="qc-row-title">
                        <span className="qc-label">{row.label.trim() || 'Untitled'}</span>
                        <span className="qc-badge" title={row.scope === 'repo' ? (row.repo ?? undefined) : undefined}>
                          <Badge>{row.scope === 'repo' ? 'Project' : 'Global'}</Badge>
                        </span>
                        <span className="qc-hint">
                          <Badge>{row.kind === 'agent' ? 'Agent' : row.appendEnter ? 'Enter' : 'Insert'}</Badge>
                        </span>
                      </span>
                    }
                    description={<span className="qc-body">{row.command.trim() ? summaryOf(row) : 'No command text'}</span>}
                    trailing={
                      <span className="qc-actions">
                        <IconButton label={`Edit ${row.label}`} title="Edit" onClick={() => setDialog({ command: row })}>
                          <PencilIcon />
                        </IconButton>
                        <IconButton
                          label={`Delete ${row.label}`}
                          title="Delete"
                          variant="destructive"
                          onClick={() => void confirmAndRemove(context, row).then(refresh)}
                        >
                          <TrashIcon />
                        </IconButton>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </ToolPanelFrame>
      {dialog ? <QuickCommandDialog key={dialog.command?.id ?? 'new'} context={context} command={dialog.command} repo={repo} onSaved={() => void refresh()} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}

/**
 * Mounts the panel `panel:quirky.terminal/quick-commands` into `element` and returns the function
 * that unmounts it. `report` receives the shown rows after every change; `repo` overrides the repo
 * the Add dialog preselects, which otherwise follows the selected worktree.
 */
export function mountQuickCommandsPanel(context: UiPluginContext, element: HTMLElement, props: { report?(state: QuickCommandsReport): void; repo?: string | null } = {}): () => void {
  const root = createRoot(element)
  root.render(<QuickCommandsPanel context={context} report={props.report} repo={props.repo} />)
  return () => root.unmount()
}
