import { PopupMenu, type PopupItem } from '@quirky/ui'
import type { GroupBy, RowFact, SortBy, ViewDisplay } from './view-types'

const GROUP_BY: readonly { id: GroupBy; label: string }[] = [
  { id: 'section-project', label: 'Section and project' },
  { id: 'project', label: 'Project' },
  { id: 'status', label: 'Status' },
  { id: 'tag', label: 'Tag' },
  { id: 'pull-request', label: 'Pull request' },
  { id: 'none', label: 'None' }
]
const SORT_BY: readonly { id: SortBy; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'agent-activity', label: 'Agent activity' },
  { id: 'name', label: 'Name' },
  { id: 'project', label: 'Project' },
  { id: 'manual', label: 'Manual' }
]
const PROJECT_ORDER: readonly { id: ViewDisplay['projectOrder']; label: string }[] = [
  { id: 'manual', label: 'Manual' },
  { id: 'recent', label: 'Recent activity' }
]
export const ROW_FACT_LABELS: Record<RowFact, string> = {
  pr: 'Pull request',
  'last-activity': 'Last activity',
  branch: 'Branch',
  status: 'Status'
}

type Props = {
  anchor: HTMLElement
  display: ViewDisplay
  rowFact: RowFact
  onDisplay(patch: Partial<ViewDisplay>): void
  onRowFact(fact: RowFact): void
  onSaveAsView(): void
  onClose(): void
}

/** The Display menu: how the tree is grouped, sorted and annotated. Choices apply at once and the menu closes. */
export function DisplayMenu({ anchor, display, rowFact, onDisplay, onRowFact, onSaveAsView, onClose }: Props) {
  const items: PopupItem[] = [
    { label: 'Group by', heading: true },
    ...GROUP_BY.map(({ id, label }) => ({ label, checked: display.groupBy === id, onSelect: () => onDisplay({ groupBy: id }) })),
    { label: 'Sort by', heading: true, separatorBefore: true },
    ...SORT_BY.map(({ id, label }) => ({ label, checked: display.sortBy === id, onSelect: () => onDisplay({ sortBy: id }) })),
    { label: 'Project order', heading: true, separatorBefore: true },
    ...PROJECT_ORDER.map(({ id, label }) => ({ label, checked: display.projectOrder === id, onSelect: () => onDisplay({ projectOrder: id }) })),
    { label: 'Right side shows', heading: true, separatorBefore: true },
    ...(Object.keys(ROW_FACT_LABELS) as RowFact[]).map((id) => ({ label: ROW_FACT_LABELS[id], checked: rowFact === id, onSelect: () => onRowFact(id) })),
    { label: 'Show asleep', checked: display.showAsleep, separatorBefore: true, onSelect: () => onDisplay({ showAsleep: !display.showAsleep }) },
    { label: 'Show nested children', checked: display.showNested, onSelect: () => onDisplay({ showNested: !display.showNested }) },
    { label: 'Save as view…', separatorBefore: true, onSelect: onSaveAsView }
  ]
  return <PopupMenu anchor={anchor} title="Display" items={items} onClose={onClose} />
}
