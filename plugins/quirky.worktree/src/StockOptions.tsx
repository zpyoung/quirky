import { Button, FormRow, IconButton } from '@quirky/ui'
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
    <div className="ui-stack">
      <div className="ui-cluster ui-toolbar">
        {hiddenSleepingCount > 0 && (
          <Button type="button" aria-label={revealSleeping ? 'Hide sleeping worktrees' : hiddenSleepingLabel(hiddenSleepingCount)} onClick={toggleSleepingReveal}>
            {revealSleeping ? `Hide ${hiddenSleepingCount} sleeping ${hiddenSleepingCount === 1 ? 'worktree' : 'worktrees'}` : hiddenSleepingLabel(hiddenSleepingCount)}
          </Button>
        )}
        {hiddenFilteredCount > 0 && (
          <Button type="button" aria-label={revealFiltered ? 'Hide filtered worktrees' : hiddenFilteredLabel(hiddenFilteredCount)} onClick={toggleFilteredReveal}>
            {revealFiltered ? `Hide ${hiddenFilteredCount} filtered ${hiddenFilteredCount === 1 ? 'worktree' : 'worktrees'}` : hiddenFilteredLabel(hiddenFilteredCount)}
          </Button>
        )}
      </div>
      <details className="ui-disclosure">
        <summary>Workspace options</summary>
        <div className="ui-stack">
          <div className="ui-form-grid">
            <FormRow label="Group by" htmlFor="worktree-options-group-by">
              <select id="worktree-options-group-by" className="ui-text-field__input" aria-label="Group by" value={options.groupBy} onChange={(event) => changeOptions({ groupBy: event.currentTarget.value as StockWorktreeOptions['groupBy'] })}>
                <option value="project">Project</option>
                <option value="status">Status</option>
                <option value="pr">Pull request</option>
                <option value="none">None</option>
              </select>
            </FormRow>
            <FormRow label="Sort by" htmlFor="worktree-options-sort-by">
              <select id="worktree-options-sort-by" className="ui-text-field__input" aria-label="Sort by" value={options.sortBy} onChange={(event) => changeOptions({ sortBy: event.currentTarget.value as StockWorktreeOptions['sortBy'] })}>
                <option value="recent">Recent</option>
                <option value="agent-activity">Agent activity</option>
                <option value="name">Name</option>
                <option value="project">Project</option>
                <option value="manual">Manual</option>
              </select>
            </FormRow>
            {options.groupBy === 'project' && (
              <FormRow label="Project order" htmlFor="worktree-options-project-order">
                <select id="worktree-options-project-order" className="ui-text-field__input" aria-label="Project order" value={options.projectOrderBy} onChange={(event) => changeOptions({ projectOrderBy: event.currentTarget.value as StockWorktreeOptions['projectOrderBy'] })}>
                  <option value="manual">Manual</option>
                  <option value="recent">Recent activity</option>
                </select>
              </FormRow>
            )}
            <FormRow label="External worktrees by default" htmlFor="worktree-options-external-visibility">
              <select id="worktree-options-external-visibility" className="ui-text-field__input" aria-label="Default external worktree visibility" value={options.externalVisibilityDefault} onChange={(event) => changeOptions({ externalVisibilityDefault: event.currentTarget.value as StockWorktreeOptions['externalVisibilityDefault'] })}>
                <option value="hide">Hide</option>
                <option value="show">Show</option>
              </select>
            </FormRow>
          </div>
          {options.groupBy === 'project' && options.projectOrderBy === 'manual' && (
            <div className="ui-stack" role="group" aria-label="Manual project order">
              <span className="ui-text-muted">Manual project order</span>
              {repos.map((repo) => {
                const index = projectOrder.indexOf(repo.id)
                const name = repo.displayName ?? repo.name
                return (
                  <div className="ui-cluster" key={repo.id}>
                    <span>{name}</span>
                    <IconButton label={`Move ${name} up`} disabled={index <= 0} onClick={() => moveProject(repo.id, -1)}>↑</IconButton>
                    <IconButton label={`Move ${name} down`} disabled={index < 0 || index >= projectOrder.length - 1} onClick={() => moveProject(repo.id, 1)}>↓</IconButton>
                  </div>
                )
              })}
            </div>
          )}
          <div className="ui-stack">
            <label className="ui-checkbox-label">
              <input aria-label="Compact cards" type="checkbox" checked={options.compact} onChange={(event) => changeOptions({ compact: event.currentTarget.checked })} />
              <span>Compact cards</span>
            </label>
            <div className="ui-stack" role="group" aria-label="Show properties">
              <span className="ui-text-muted">Show properties</span>
              {PROPERTIES.map(({ id, label }) => (
                <label className="ui-checkbox-label" key={id}>
                  <input type="checkbox" aria-label={`Show ${label}`} checked={options.showProperties.includes(id)} onChange={(event) => toggleProperty(id, event.currentTarget.checked)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <label className="ui-checkbox-label">
              <input aria-label="Show sleeping" type="checkbox" checked={options.showSleeping} onChange={(event) => changeOptions({ showSleeping: event.currentTarget.checked })} />
              <span>Show sleeping</span>
            </label>
            <label className="ui-checkbox-label">
              <input aria-label="Hide CLI-created worktrees" type="checkbox" checked={options.hideCliCreated} onChange={(event) => changeOptions({ hideCliCreated: event.currentTarget.checked })} />
              <span>Hide CLI-created</span>
            </label>
            <label className="ui-checkbox-label">
              <input aria-label="Hide worktrees from other desktop clients" type="checkbox" checked={options.hideOtherClients} onChange={(event) => changeOptions({ hideOtherClients: event.currentTarget.checked })} />
              <span>Hide worktrees from other desktop clients</span>
            </label>
            <label className="ui-checkbox-label">
              <input aria-label="Hide default branch" type="checkbox" checked={options.hideDefaultBranch} onChange={(event) => changeOptions({ hideDefaultBranch: event.currentTarget.checked })} />
              <span>Hide default branch</span>
            </label>
            <label className="ui-checkbox-label">
              <input aria-label="Hide detached HEAD" type="checkbox" checked={options.hideDetached} onChange={(event) => changeOptions({ hideDetached: event.currentTarget.checked })} />
              <span>Hide detached HEAD</span>
            </label>
            <label className="ui-checkbox-label">
              <input aria-label="Hide archived worktrees" type="checkbox" checked={options.hideArchived} onChange={(event) => changeOptions({ hideArchived: event.currentTarget.checked })} />
              <span>Hide archived</span>
            </label>
            <div className="ui-stack" role="group" aria-label="Projects">
              <span className="ui-text-muted">Projects</span>
              {repos.map((repo) => {
                const checked = options.filterRepoIds.length === 0 || options.filterRepoIds.includes(repo.id)
                return (
                  <label className="ui-checkbox-label" key={repo.id}>
                    <input type="checkbox" aria-label={`Show project ${repo.displayName ?? repo.name}`} checked={checked} onChange={(event) => filterRepo(repo.id, event.currentTarget.checked)} />
                    <span>{repo.displayName ?? repo.name}</span>
                  </label>
                )
              })}
            </div>
          </div>
          <p className="ui-help-text">Other-client filtering hides only worktrees known to come from a different authenticated desktop installation. Unknown, paired-phone, plugin and CLI origins stay visible; remote host filtering remains unavailable without authoritative host identity.</p>
          <Button type="button" onClick={openCleanup}>Review cleanup</Button>
        </div>
      </details>
    </div>
  )
}
