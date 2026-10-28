import { useState, type ChangeEvent } from 'react'
import type { StockWorktreeOptions } from './control-types'

type Props = {
  options: StockWorktreeOptions
  hiddenSleepingCount: number
  revealSleeping: boolean
  changeOptions(patch: Partial<StockWorktreeOptions>): void
  toggleSleepingReveal(): void
  openCleanup(): void
}

const hiddenLabel = (count: number): string => `Show ${count} hidden sleeping ${count === 1 ? 'worktree' : 'worktrees'}`

export function StockOptions({ options, hiddenSleepingCount, revealSleeping, changeOptions, toggleSleepingReveal, openCleanup }: Props) {
  const [open, setOpen] = useState(false)
  const groupBy = (event: ChangeEvent<HTMLSelectElement>) => changeOptions({ groupBy: event.currentTarget.value as StockWorktreeOptions['groupBy'] })
  const sortBy = (event: ChangeEvent<HTMLSelectElement>) => changeOptions({ sortBy: event.currentTarget.value as StockWorktreeOptions['sortBy'] })
  const checkbox = (key: 'compact' | 'showBranch' | 'showComment' | 'showSleeping', value: boolean) => {
    if (key === 'compact') changeOptions({ compact: value })
    else if (key === 'showBranch') changeOptions({ showBranch: value })
    else if (key === 'showComment') changeOptions({ showComment: value })
    else changeOptions({ showSleeping: value })
  }

  return (
    <div className="stock-worktree-controls">
      <button type="button" aria-label="Workspace options" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Workspace options
      </button>
      <button type="button" aria-label="Review worktree cleanup" onClick={openCleanup}>Review cleanup</button>
      {hiddenSleepingCount > 0 && (
        <button type="button" aria-label={revealSleeping ? 'Hide sleeping worktrees' : hiddenLabel(hiddenSleepingCount)} onClick={toggleSleepingReveal}>
          {revealSleeping ? `Hide ${hiddenSleepingCount} sleeping ${hiddenSleepingCount === 1 ? 'worktree' : 'worktrees'}` : hiddenLabel(hiddenSleepingCount)}
        </button>
      )}
      {open && (
        <div className="stock-options-panel" role="group" aria-label="Workspace options">
          <label>
            Group by
            <select aria-label="Group by" value={options.groupBy} onChange={groupBy}>
              <option value="project">Project</option>
              <option value="status">Status</option>
              <option value="none">None</option>
            </select>
          </label>
          <label>
            Sort by
            <select aria-label="Sort by" value={options.sortBy} onChange={sortBy}>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label><input aria-label="Compact cards" type="checkbox" checked={options.compact} onChange={(event) => checkbox('compact', event.currentTarget.checked)} />Compact cards</label>
          <label><input aria-label="Show branch" type="checkbox" checked={options.showBranch} onChange={(event) => checkbox('showBranch', event.currentTarget.checked)} />Show branch</label>
          <label><input aria-label="Show comment" type="checkbox" checked={options.showComment} onChange={(event) => checkbox('showComment', event.currentTarget.checked)} />Show comment</label>
          <label><input aria-label="Show sleeping" type="checkbox" checked={options.showSleeping} onChange={(event) => checkbox('showSleeping', event.currentTarget.checked)} />Show sleeping</label>
        </div>
      )}
    </div>
  )
}
