import { useRef } from 'react'
import { Button, ContextMenu, ControlIcon, IconButton, TextField, ToolPanelActions } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { ReviewModel } from '@quirky/protocol'
import type { FixAction } from '../ai/types'
import type { ViewMode } from './data'

const FILTER_LABEL = 'Filter files…'

type HeaderAction = 'view-mode' | 'change-base' | 'refresh' | 'ai-customize' | 'ai-settings' | 'revert-all'
type HeaderProps = {
  filter: string
  filterOpen: boolean
  onFilterControl(action: 'filter-open' | 'filter-close'): void
  onFilter(query: string): void
  viewMode: ViewMode
  menuGeneration: string | null
  menuPosition: { x: number; y: number } | null
  onMenuOpen(position: { x: number; y: number }): void
  onMenuClose(): void
  onMenuAction(action: HeaderAction, data?: Record<string, unknown>): void
  summarize: boolean
  prActions?: ReadonlyArray<{ label: string; action: FixAction }>
  aiSettings: boolean
  revertable: number
}

/** The panel's filter toggle and ⋯ menu (frame header), with the filter box in the body. */
export function Header({
  filter,
  filterOpen,
  onFilterControl,
  onFilter,
  viewMode,
  menuGeneration,
  menuPosition,
  onMenuOpen,
  onMenuClose,
  onMenuAction,
  summarize,
  prActions = [],
  aiSettings,
  revertable
}: HeaderProps) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const select = (action: HeaderAction, data?: Record<string, unknown>) => () => {
    menuTriggerRef.current?.focus()
    onMenuAction(action, data)
  }
  const entries: ContextMenuItem[] = [
    { label: 'List', checked: viewMode === 'list', onSelect: select('view-mode', { mode: 'list' }) },
    { label: 'Tree', checked: viewMode === 'tree', onSelect: select('view-mode', { mode: 'tree' }) },
    { label: 'Change base…', separatorBefore: true, onSelect: select('change-base') },
    { label: 'Refresh', onSelect: select('refresh') },
    ...(summarize ? [{ label: 'Summarize branch with AI', onSelect: select('ai-customize', { action: 'branchSummary' }) }] : []),
    ...prActions.map((item) => ({
      label: item.label,
      onSelect: select('ai-customize', { action: item.action })
    })),
    ...(aiSettings ? [{ label: 'AI settings…', separatorBefore: true, onSelect: select('ai-settings') }] : []),
    {
      label: 'Revert all…',
      separatorBefore: true,
      danger: true,
      enabled: revertable > 0,
      title: revertable > 0 ? undefined : 'No files to revert',
      onSelect: select('revert-all')
    }
  ]
  const closeFilter = () => onFilterControl('filter-close')
  return (
    <>
      <ToolPanelActions>
        <IconButton
          label="Filter files by name"
          variant={filter.trim() !== '' ? 'primary' : 'secondary'}
          aria-pressed={filterOpen}
          title={filter.trim() !== '' ? `Filter: ${filter.trim()}` : 'Filter files by name'}
          onClick={() => onFilterControl(filterOpen ? 'filter-close' : 'filter-open')}
        >
          <ControlIcon name="magnifying-glass" />
        </IconButton>
        <IconButton
          label="More source control actions"
          aria-haspopup="menu"
          title="More source control actions"
          ref={menuTriggerRef}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            onMenuOpen({ x: box.right, y: box.bottom })
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
                event.preventDefault()
                event.stopPropagation()
                closeFilter()
              }
            }}
          />
          <IconButton label="Clear and close filter" title="Clear and close filter" onClick={closeFilter}>
            {'×'}
          </IconButton>
        </div>
      )}
      {menuGeneration !== null && menuPosition !== null && (
        <ContextMenu
          key={menuGeneration}
          x={menuPosition.x}
          y={menuPosition.y}
          align="end"
          label="Source control actions"
          items={entries}
          returnFocusTo={menuTriggerRef.current ?? undefined}
          onClose={onMenuClose}
        />
      )}
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
