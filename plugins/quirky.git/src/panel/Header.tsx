import { useState } from 'react'
import { Button, ContextMenu, ControlIcon, IconButton, TextField, ToolPanelActions } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { ReviewModel } from '@quirky/protocol'
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
  onRefresh(): void
  /** Offered while Source Control AI actions are on. */
  onSummarize?(): void
  /** The pull-request AI actions, listed after Summarize while a pull request is open for the branch. */
  prActions?: ReadonlyArray<{ label: string; onSelect(): void }>
  /** Opens the Source Control AI settings view. */
  onAiSettings?(): void
  /** How many files "Revert all…" would revert; 0 leaves it disabled. */
  revertable: number
  onRevertAll(): void
}

/** The panel's filter toggle and ⋯ menu (frame header), with the filter box in the body. */
export function Header({ filter, filterOpen, onFilterOpen, onFilter, viewMode, onViewMode, onChangeBase, onRefresh, onSummarize, prActions = [], onAiSettings, revertable, onRevertAll }: HeaderProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; trigger: HTMLButtonElement } | null>(null)
  const select = (action?: () => void) => () => {
    menuAt?.trigger.focus()
    action?.()
  }
  const entries: ContextMenuItem[] = [
    { label: 'List', checked: viewMode === 'list', onSelect: select(() => onViewMode('list')) },
    { label: 'Tree', checked: viewMode === 'tree', onSelect: select(() => onViewMode('tree')) },
    { label: 'Change base…', separatorBefore: true, onSelect: select(onChangeBase) },
    { label: 'Refresh', onSelect: select(onRefresh) },
    ...(onSummarize ? [{ label: 'Summarize branch with AI', onSelect: select(onSummarize) }] : []),
    ...prActions.map((item) => ({ label: item.label, onSelect: select(item.onSelect) })),
    ...(onAiSettings ? [{ label: 'AI settings…', separatorBefore: true, onSelect: select(onAiSettings) }] : []),
    {
      label: 'Revert all…',
      separatorBefore: true,
      danger: true,
      enabled: revertable > 0,
      title: revertable > 0 ? undefined : 'No files to revert',
      onSelect: select(onRevertAll)
    }
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
  branch: string
  base: string | null
  totals: ReviewModel['totals'] | null
  onChangeBase(): void
}

/** The header line: the branch, the base chip that opens Change Base Ref, and the +/− line totals. */
export function BranchRow({ branch, base, totals, onChangeBase }: BranchProps) {
  return (
    <div className="ui-cluster" data-branch-row>
      <div className="ui-cluster" data-branch-refs>
        <span data-branch-name>{branch}</span>
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
      {totals !== null && (totals.added > 0 || totals.removed > 0) && (
        <span className="git-totals" aria-label="Lines changed on this branch">
          <span className="git-totals__added">{`+${totals.added}`}</span> <span className="git-totals__removed">{`−${totals.removed}`}</span>
        </span>
      )}
    </div>
  )
}

/** The count line: `2 of 4 reviewed · 1 uncommitted`, without the uncommitted part when nothing is. */
export function countLine(counts: ReviewModel['counts']): string {
  const reviewed = `${counts.reviewed} of ${counts.files} reviewed`
  return counts.uncommitted > 0 ? `${reviewed} · ${counts.uncommitted} uncommitted` : reviewed
}

/** The line under the header line that says how much of the review is done. */
export function CountLine({ counts }: { counts: ReviewModel['counts'] }) {
  return <p className="ui-text-muted git-count-line" data-count-line>{countLine(counts)}</p>
}
