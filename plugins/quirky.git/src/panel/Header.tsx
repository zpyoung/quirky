import { useState } from 'react'
import { Badge, Button, ContextMenu, IconButton, SectionHeader, TextField } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { GitCompare, GitStatus } from '@quirky/protocol'
import type { ViewMode } from './data'

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
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const entries: ContextMenuItem[] = [
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
      <SectionHeader
        title="Source control"
        actions={
          <div className="ui-cluster">
            <IconButton
              label="Filter files by name"
              variant={filter.trim() !== '' ? 'primary' : 'secondary'}
              aria-pressed={filterOpen}
              title={filter.trim() !== '' ? `Filter: ${filter.trim()}` : 'Filter files by name'}
              onClick={() => (filterOpen ? close() : onFilterOpen(true))}
            >
              {'⌕'}
            </IconButton>
            <IconButton
              label="More source control actions"
              aria-haspopup="menu"
              title="More source control actions"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect()
                setMenuAt({ x: box.left, y: box.bottom })
              }}
            >
              {'⋯'}
            </IconButton>
          </div>
        }
      />
      {filterOpen && (
        <div className="ui-cluster">
          <TextField
            label={FILTER_LABEL}
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
          <IconButton label="Clear and close filter" title="Clear and close filter" onClick={close}>
            {'×'}
          </IconButton>
        </div>
      )}
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} label="Source control actions" items={entries} onClose={() => setMenuAt(null)} />}
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
    <div className="ui-cluster" data-branch-row>
      <span data-branch-name>{status.branch ?? (status.detached ? 'detached HEAD' : 'no branch')}</span>
      {base !== null && (
        <>
          <span className="ui-text-muted" aria-hidden="true">
            {'→'}
          </span>
          <Button data-base-ref title="Change base ref" onClick={onChangeBase}>
            {base}
          </Button>
        </>
      )}
      {status.ahead > 0 && <Badge tone="working" label={`${status.ahead} commit(s) to push`}>{`↑${status.ahead}`}</Badge>}
      {status.behind > 0 && <Badge tone="needs-you" label={`${status.behind} commit(s) to pull`}>{`↓${status.behind}`}</Badge>}
      {ready && compare && (compare.added > 0 || compare.removed > 0) && (
        <Badge tone="neutral" label="Lines changed on this branch">
          <span style={{ color: 'var(--ui-working)' }}>{`+${compare.added}`}</span> <span style={{ color: 'var(--ui-failing)' }}>{`−${compare.removed}`}</span>
        </Badge>
      )}
    </div>
  )
}
