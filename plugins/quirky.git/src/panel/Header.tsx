import { useRef, useState } from 'react'
import type { GitCompare, GitStatus } from '@quirky/protocol'
import type { ViewMode } from './data'
import { PopupMenu, type MenuEntry } from './Menu'

const FILTER_LABEL = 'Filter files…'

type HeaderProps = {
  filter: string
  filterOpen: boolean
  onFilterOpen(open: boolean): void
  onFilter(query: string): void
  viewMode: ViewMode
  onViewMode(mode: ViewMode): void
  onChangeBase(): void
  onRefreshCompare(): void
  /** How many notes the worktree has; the overflow menu lists a Notes item only when above 0. */
  notes?: number
  onNotes?(): void
}

/** The panel's title bar: the filter toggle and the "More source control actions" menu, with the filter box under it. */
export function Header({ filter, filterOpen, onFilterOpen, onFilter, viewMode, onViewMode, onChangeBase, onRefreshCompare, notes = 0, onNotes }: HeaderProps) {
  const more = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const entries: MenuEntry[] = [
    viewMode === 'list' ? { label: 'View as tree', onSelect: () => onViewMode('tree') } : { label: 'View as list', onSelect: () => onViewMode('list') },
    { label: 'Change Base Ref…', onSelect: onChangeBase },
    { label: 'Refresh branch compare', onSelect: onRefreshCompare },
    ...(notes > 0 ? [{ label: `Notes ${notes}`, onSelect: onNotes }] : [])
  ]
  const close = () => {
    onFilter('')
    onFilterOpen(false)
  }
  return (
    <>
      <div className="scm-header">
        <strong>Source control</strong>
        <span className="scm-header-actions">
          <button
            type="button"
            className={`icon-button${filter.trim() !== '' ? ' active' : ''}`}
            aria-label="Filter files by name"
            aria-pressed={filterOpen}
            title={filter.trim() !== '' ? `Filter: ${filter.trim()}` : 'Filter files by name'}
            onClick={() => (filterOpen ? close() : onFilterOpen(true))}
          >
            {'⌕'}
          </button>
          <button
            ref={more}
            type="button"
            className="icon-button"
            aria-label="More source control actions"
            aria-haspopup="menu"
            title="More source control actions"
            onClick={() => {
              const box = more.current?.getBoundingClientRect()
              setMenuAt({ x: box?.left ?? 0, y: box?.bottom ?? 0 })
            }}
          >
            {'⋯'}
          </button>
        </span>
      </div>
      {filterOpen && (
        <div className="scm-filter">
          <input
            type="text"
            autoFocus
            placeholder={FILTER_LABEL}
            aria-label={FILTER_LABEL}
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                close()
              }
            }}
          />
          <button type="button" className="icon-button" aria-label="Clear and close filter" title="Clear and close filter" onClick={close}>
            {'×'}
          </button>
        </div>
      )}
      {menuAt && <PopupMenu x={menuAt.x} y={menuAt.y} label="Source control actions" items={entries} onClose={() => setMenuAt(null)} />}
    </>
  )
}

type BranchProps = {
  status: GitStatus
  compare: GitCompare | null
  onChangeBase(): void
}

/** The branch, the base it is compared with, how far it is from its upstream, and the committed line totals. */
export function BranchRow({ status, compare, onChangeBase }: BranchProps) {
  const base = compare?.base ?? null
  const ready = compare?.status === 'ready'
  return (
    <div className="scm-branch">
      <span className="scm-branch-name">{status.branch ?? (status.detached ? 'detached HEAD' : 'no branch')}</span>
      {base !== null && (
        <>
          <span className="muted" aria-hidden="true">
            {'→'}
          </span>
          <button type="button" className="scm-base" title="Change base ref" onClick={onChangeBase}>
            {base}
          </button>
        </>
      )}
      {status.ahead > 0 && (
        <span className="scm-ahead" title={`${status.ahead} commit(s) to push`}>
          {`↑${status.ahead}`}
        </span>
      )}
      {status.behind > 0 && (
        <span className="scm-behind" title={`${status.behind} commit(s) to pull`}>
          {`↓${status.behind}`}
        </span>
      )}
      {ready && compare && (compare.added > 0 || compare.removed > 0) && (
        <span className="scm-chip" title="Lines changed on this branch">
          <span className="scm-added">{`+${compare.added}`}</span> <span className="scm-removed">{`−${compare.removed}`}</span>
        </span>
      )}
    </div>
  )
}
