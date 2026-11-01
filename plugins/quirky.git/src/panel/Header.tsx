import { useState } from 'react'
import { Badge, Button, ContextMenu, ControlIcon, IconButton, TextField, ToolPanelActions } from '@quirky/ui'
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

/** The panel's filter toggle (frame rail) and "More source control actions" menu (frame header), with the filter box in the body. */
export function Header({ filter, filterOpen, onFilterOpen, onFilter, viewMode, onViewMode, onChangeBase, onRefreshCompare, notes = 0, onNotes }: HeaderProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; trigger: HTMLButtonElement } | null>(null)
  const select = (action?: () => void) => () => {
    menuAt?.trigger.focus()
    action?.()
  }
  const entries: ContextMenuItem[] = [
    viewMode === 'list' ? { label: 'View as tree', onSelect: select(() => onViewMode('tree')) } : { label: 'View as list', onSelect: select(() => onViewMode('list')) },
    { label: 'Change Base Ref…', onSelect: select(onChangeBase) },
    { label: 'Refresh branch compare', onSelect: select(onRefreshCompare) },
    ...(notes > 0 ? [{ label: `Notes ${notes}`, onSelect: select(onNotes) }] : [])
  ]
  const close = () => {
    onFilter('')
    onFilterOpen(false)
  }
  return (
    <>
      <ToolPanelActions>
        <IconButton
          label="Filter files by name"
          variant={filter.trim() !== '' ? 'primary' : 'secondary'}
          aria-pressed={filterOpen}
          title={filter.trim() !== '' ? `Filter: ${filter.trim()}` : 'Filter files by name'}
          onClick={() => (filterOpen ? close() : onFilterOpen(true))}
        >
          <ControlIcon name="magnifying-glass" />
        </IconButton>
        <IconButton
          label="More source control actions"
          aria-haspopup="menu"
          title="More source control actions"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenuAt({ x: box.right, y: box.bottom, trigger: event.currentTarget })
          }}
        >
          <ControlIcon name="dots-three" />
        </IconButton>
      </ToolPanelActions>
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
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} align="end" label="Source control actions" items={entries} returnFocusTo={menuAt.trigger} onClose={() => setMenuAt(null)} />}
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
      <div className="ui-cluster" data-branch-refs>
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
      </div>
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
