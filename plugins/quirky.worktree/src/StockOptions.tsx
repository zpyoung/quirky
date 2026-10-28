import { useState } from 'react'
import type { Repo } from '@quirky/protocol'
import type { StockWorktreeOptions, WorktreeCardProperty } from './control-types'

type Props = {
  options: StockWorktreeOptions
  repos: Repo[]
  projectOrder: string[]
  hiddenSleepingCount: number
  hiddenFilteredCount: number
  revealSleeping: boolean
  revealFiltered: boolean
  changeOptions(patch: Partial<StockWorktreeOptions>): void
  changeProjectOrder(ids: string[]): void
  toggleSleepingReveal(): void
  toggleFilteredReveal(): void
  openCleanup(): void
}

const PROPERTIES: readonly { id: WorktreeCardProperty; label: string }[] = [
  { id: 'branch', label: 'Branch' },
  { id: 'notes', label: 'Notes' },
  { id: 'pullRequest', label: 'Pull request' },
  { id: 'issue', label: 'Issue' },
  { id: 'automation', label: 'Automation' },
  { id: 'activity', label: 'Agent activity' }
]
const hiddenSleepingLabel = (count: number) => `Show ${count} hidden sleeping ${count === 1 ? 'worktree' : 'worktrees'}`
const hiddenFilteredLabel = (count: number) => `Show ${count} filtered ${count === 1 ? 'worktree' : 'worktrees'}`

export function StockOptions({
  options,
  repos,
  projectOrder,
  hiddenSleepingCount,
  hiddenFilteredCount,
  revealSleeping,
  revealFiltered,
  changeOptions,
  changeProjectOrder,
  toggleSleepingReveal,
  toggleFilteredReveal,
  openCleanup
}: Props) {
  const [open, setOpen] = useState(false)
  const toggleProperty = (property: WorktreeCardProperty, checked: boolean) => {
    const next = checked
      ? [...options.showProperties, property]
      : options.showProperties.filter((item) => item !== property)
    changeOptions({
      showProperties: [...new Set(next)],
      ...(property === 'branch' ? { showBranch: checked } : {}),
      ...(property === 'notes' ? { showComment: checked } : {})
    })
  }
  const filterRepo = (repoId: string, checked: boolean) => {
    const selected = options.filterRepoIds.length === 0 ? repos.map((repo) => repo.id) : options.filterRepoIds
    const next = checked ? [...selected, repoId] : selected.filter((id) => id !== repoId)
    changeOptions({ filterRepoIds: [...new Set(next)].length === repos.length ? [] : [...new Set(next)] })
  }
  const moveProject = (repoId: string, direction: -1 | 1) => {
    const order = projectOrder.length === repos.length ? [...projectOrder] : repos.map((repo) => repo.id)
    const index = order.indexOf(repoId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    order.splice(index, 1)
    order.splice(target, 0, repoId)
    changeProjectOrder(order)
  }
  return (
    <div className="stock-worktree-controls">
      <button type="button" aria-label="Workspace options" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Workspace options
      </button>
      <button type="button" aria-label="Review worktree cleanup" onClick={openCleanup}>Review cleanup</button>
      {hiddenSleepingCount > 0 && (
        <button type="button" aria-label={revealSleeping ? 'Hide sleeping worktrees' : hiddenSleepingLabel(hiddenSleepingCount)} onClick={toggleSleepingReveal}>
          {revealSleeping ? `Hide ${hiddenSleepingCount} sleeping ${hiddenSleepingCount === 1 ? 'worktree' : 'worktrees'}` : hiddenSleepingLabel(hiddenSleepingCount)}
        </button>
      )}
      {hiddenFilteredCount > 0 && (
        <button type="button" aria-label={revealFiltered ? 'Hide filtered worktrees' : hiddenFilteredLabel(hiddenFilteredCount)} onClick={toggleFilteredReveal}>
          {revealFiltered ? `Hide ${hiddenFilteredCount} filtered ${hiddenFilteredCount === 1 ? 'worktree' : 'worktrees'}` : hiddenFilteredLabel(hiddenFilteredCount)}
        </button>
      )}
      {open && (
        <div className="stock-options-panel" role="group" aria-label="Workspace options">
          <label>
            Group by
            <select aria-label="Group by" value={options.groupBy} onChange={(event) => changeOptions({ groupBy: event.currentTarget.value as StockWorktreeOptions['groupBy'] })}>
              <option value="project">Project</option>
              <option value="status">Status</option>
              <option value="pr">Pull request</option>
              <option value="none">None</option>
            </select>
          </label>
          <label>
            Sort by
            <select aria-label="Sort by" value={options.sortBy} onChange={(event) => changeOptions({ sortBy: event.currentTarget.value as StockWorktreeOptions['sortBy'] })}>
              <option value="recent">Recent</option>
              <option value="agent-activity">Agent activity</option>
              <option value="name">Name</option>
              <option value="project">Project</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          {options.groupBy === 'project' && (
            <>
              <label>
                Project order
                <select aria-label="Project order" value={options.projectOrderBy} onChange={(event) => changeOptions({ projectOrderBy: event.currentTarget.value as StockWorktreeOptions['projectOrderBy'] })}>
                  <option value="manual">Manual</option>
                  <option value="recent">Recent activity</option>
                </select>
              </label>
              {options.projectOrderBy === 'manual' && repos.map((repo) => {
                const index = projectOrder.indexOf(repo.id)
                return (
                  <div className="project-order-control" key={repo.id}>
                    <span>{repo.displayName ?? repo.name}</span>
                    <button type="button" aria-label={`Move ${repo.displayName ?? repo.name} up`} disabled={index <= 0} onClick={() => moveProject(repo.id, -1)}>↑</button>
                    <button type="button" aria-label={`Move ${repo.displayName ?? repo.name} down`} disabled={index < 0 || index >= projectOrder.length - 1} onClick={() => moveProject(repo.id, 1)}>↓</button>
                  </div>
                )
              })}
            </>
          )}
          <label><input aria-label="Compact cards" type="checkbox" checked={options.compact} onChange={(event) => changeOptions({ compact: event.currentTarget.checked })} />Compact cards</label>
          <fieldset>
            <legend>Show properties</legend>
            {PROPERTIES.map(({ id, label }) => (
              <label key={id}>
                <input type="checkbox" aria-label={`Show ${label}`} checked={options.showProperties.includes(id)} onChange={(event) => toggleProperty(id, event.currentTarget.checked)} />
                {label}
              </label>
            ))}
          </fieldset>
          <label><input aria-label="Show sleeping" type="checkbox" checked={options.showSleeping} onChange={(event) => changeOptions({ showSleeping: event.currentTarget.checked })} />Show sleeping</label>
          <label><input aria-label="Hide CLI-created worktrees" type="checkbox" checked={options.hideCliCreated} onChange={(event) => changeOptions({ hideCliCreated: event.currentTarget.checked })} />Hide CLI-created</label>
          <label><input aria-label="Hide default branch" type="checkbox" checked={options.hideDefaultBranch} onChange={(event) => changeOptions({ hideDefaultBranch: event.currentTarget.checked })} />Hide default branch</label>
          <label><input aria-label="Hide detached HEAD" type="checkbox" checked={options.hideDetached} onChange={(event) => changeOptions({ hideDetached: event.currentTarget.checked })} />Hide detached HEAD</label>
          <label><input aria-label="Hide archived worktrees" type="checkbox" checked={options.hideArchived} onChange={(event) => changeOptions({ hideArchived: event.currentTarget.checked })} />Hide archived</label>
          <label>
            External worktrees by default
            <select aria-label="Default external worktree visibility" value={options.externalVisibilityDefault} onChange={(event) => changeOptions({ externalVisibilityDefault: event.currentTarget.value as StockWorktreeOptions['externalVisibilityDefault'] })}>
              <option value="hide">Hide</option>
              <option value="show">Show</option>
            </select>
          </label>
          <fieldset>
            <legend>Projects</legend>
            {repos.map((repo) => {
              const checked = options.filterRepoIds.length === 0 || options.filterRepoIds.includes(repo.id)
              return <label key={repo.id}><input type="checkbox" aria-label={`Show project ${repo.displayName ?? repo.name}`} checked={checked} onChange={(event) => filterRepo(repo.id, event.currentTarget.checked)} />{repo.displayName ?? repo.name}</label>
            })}
          </fieldset>
          <p className="muted">Host and other-client filters are unavailable because the worktree API exposes no authoritative host or client identity.</p>
        </div>
      )}
    </div>
  )
}
