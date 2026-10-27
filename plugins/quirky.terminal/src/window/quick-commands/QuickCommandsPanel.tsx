import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { QuickCommand } from '../../layout/types'
import { QuickCommandDialog } from './QuickCommandDialog'
import { searchQuickCommands } from './search'
import { PencilIcon, TrashIcon, confirmAndRemove, summaryOf, useQuickCommands } from './shared'
import { ensureQuickCommandStyles } from './styles'

export type ScopeFilter = 'all' | 'global' | 'repo'

/** What the panel tells the window: how many commands exist, and which of them its filter and search show. */
export type QuickCommandsReport = {
  count: number
  filter: ScopeFilter
  query: string
  rows: { id: string; label: string; scope: 'global' | 'repo' }[]
}

const EMPTY_TEXT = 'No quick commands saved. Run them from the Quick Commands button in the tab bar, or right-click inside any terminal.'
const FILTERS: { value: ScopeFilter; text: string }[] = [
  { value: 'all', text: 'All commands' },
  { value: 'global', text: 'Global' },
  { value: 'repo', text: 'Project' }
]

type Props = { context: UiPluginContext; report?(state: QuickCommandsReport): void; repo?: string | null }

/** The worktree the window's view shows, kept current as the layout changes. */
function useViewedWorktree(context: UiPluginContext): string | null {
  const read = () => {
    const worktree = (context.getLayout().view?.input as { worktree?: unknown } | null | undefined)?.worktree
    return typeof worktree === 'string' ? worktree : null
  }
  const [worktree, setWorktree] = useState(read)
  useEffect(() => {
    setWorktree(read())
    return context.onLayout(() => setWorktree(read()))
  }, [context])
  return worktree
}

/** The repo of the worktree the window is showing, or null when it shows none (or the floating workspace). */
function useCurrentRepo(context: UiPluginContext, override: string | null | undefined): string | null {
  const [repo, setRepo] = useState<string | null>(null)
  const worktree = useViewedWorktree(context)
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
  useState(ensureQuickCommandStyles)
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
    <div className="qc-panel">
      <header className="qc-header">
        <input className="qc-input" type="search" placeholder="Search quick commands" aria-label="Search quick commands" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select className="qc-select" aria-label="Filter by scope" value={filter} onChange={(event) => setFilter(event.target.value as ScopeFilter)}>
          {FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setDialog({ command: null })}>
          Add Command
        </button>
      </header>
      {!loaded ? null : commands.length === 0 ? (
        <p className="qc-empty">{EMPTY_TEXT}</p>
      ) : rows.length === 0 ? (
        <p className="qc-empty">{query.trim() ? 'No commands match this search.' : 'No commands in the selected scopes.'}</p>
      ) : (
        <ul className="qc-list">
          {rows.map((row) => (
            <li key={row.id} className="qc-row" data-command={row.id}>
              <div className="qc-row-main">
                <div className="qc-row-title">
                  <span className="qc-label">{row.label.trim() || 'Untitled'}</span>
                  <span className="qc-badge" title={row.scope === 'repo' ? (row.repo ?? undefined) : undefined}>
                    {row.scope === 'repo' ? 'Project' : 'Global'}
                  </span>
                  {row.kind === 'agent' ? <span className="qc-hint">Agent</span> : <span className="qc-hint">{row.appendEnter ? 'Enter' : 'Insert'}</span>}
                </div>
                <span className="qc-body">{row.command.trim() ? summaryOf(row) : 'No command text'}</span>
              </div>
              <span className="qc-actions">
                <button type="button" className="qc-icon-button" aria-label={`Edit ${row.label}`} title="Edit" onClick={() => setDialog({ command: row })}>
                  <PencilIcon />
                </button>
                <button type="button" className="qc-icon-button qc-danger" aria-label={`Delete ${row.label}`} title="Delete" onClick={() => void confirmAndRemove(context, row).then(refresh)}>
                  <TrashIcon />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {dialog ? <QuickCommandDialog key={dialog.command?.id ?? 'new'} context={context} command={dialog.command} repo={repo} onSaved={() => void refresh()} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}

/**
 * Mounts the panel `panel:quirky.terminal/quick-commands` into `element` and returns the function
 * that unmounts it. `report` receives the shown rows after every change; `repo` overrides the repo
 * the Add dialog preselects, which otherwise follows the worktree the window is showing.
 */
export function mountQuickCommandsPanel(context: UiPluginContext, element: HTMLElement, props: { report?(state: QuickCommandsReport): void; repo?: string | null } = {}): () => void {
  const root = createRoot(element)
  root.render(<QuickCommandsPanel context={context} report={props.report} repo={props.repo} />)
  return () => root.unmount()
}
