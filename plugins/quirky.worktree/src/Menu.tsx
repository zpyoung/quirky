import type { ContextMenuItem } from '@quirky/ui'
import type { ProjectGroup, Repo, Worktree, WorktreeStatus } from '@quirky/protocol'
import type { WorktreeStatusDefinition } from './parity-types'
import type { DialogState } from './report'

export const PRIMARY_DELETE_TIP = 'the primary worktree cannot be deleted; remove the project instead'

export const STATUS_LABELS: Record<WorktreeStatus, string> = {
  todo: 'Todo',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done'
}


/** What a row's menu can ask for; `move-section`, `move-status` and the sleep pair take an argument. */
export type RowAction =
  | 'rename' | 'tags' | 'move-section' | 'move-status' | 'sleep' | 'wake' | 'open-terminal' | 'open-changes'
  | 'copy-path' | 'copy-name' | 'set-parent' | 'remove-parent' | 'mark-unread' | 'mark-read' | 'pin' | 'unpin'
  | 'archive' | 'details' | 'delete'

/** The `move-section` argument that opens the new-section dialog instead of naming a section. */
export const NEW_SECTION = '@new-section'
/** The `sleep` and `wake` argument that takes the worktree's descendants along. */
export const WITH_DESCENDANTS = 'with-descendants'
/** The `archive` argument that restores an archived worktree. */
export const UNARCHIVE = 'unarchive'

export type RowActionRunner = (action: RowAction, arg?: string | null) => void

/**
 * A row's menu in the order the redesign fixes: everyday actions, then Open in, Copy and More, then
 * Delete set apart. Each item only names its action; the caller decides what it does.
 */
export function workspaceMenu(
  worktree: Worktree,
  descendants: number,
  groups: ProjectGroup[],
  repo: Repo | undefined,
  run: RowActionRunner,
  statuses: readonly Pick<WorktreeStatusDefinition, 'id' | 'label' | 'icon'>[] = Object.entries(STATUS_LABELS).map(([id, label]) => ({ id, label }))
): ContextMenuItem[] {
  const onRun = run
  const sleeping = 'sleeping' in worktree && worktree.sleeping === true
  const archived = 'archivedAt' in worktree && (worktree as Worktree & { archivedAt: number | null }).archivedAt !== null
  const ownSection = worktree.kind === 'git' && repo?.kind === 'git'
  const currentSection = ownSection ? worktree.projectGroupId : repo?.groupId ?? null
  const sectionItems: ContextMenuItem[] = [
    ...groups.map((group) => ({
      label: group.name,
      checked: group.id === currentSection,
      enabled: group.id !== currentSection,
      onSelect: () => onRun('move-section', group.id)
    })),
    ...(currentSection !== null
      ? [{ label: 'Remove from section', separatorBefore: groups.length > 0, onSelect: () => onRun('move-section', null) }]
      : []),
    { label: 'New section…', separatorBefore: groups.length > 0 || currentSection !== null, onSelect: () => onRun('move-section', NEW_SECTION) }
  ]
  const sleepAction: RowAction = sleeping ? 'wake' : 'sleep'
  const sleepItems: ContextMenuItem[] = [
    { label: sleeping ? 'Wake' : 'Sleep', onSelect: () => onRun(sleepAction) },
    ...(descendants > 0
      ? [{ label: `${sleeping ? 'Wake' : 'Sleep'} with descendants (${descendants})`, onSelect: () => onRun(sleepAction, WITH_DESCENDANTS) }]
      : [])
  ]
  const del: ContextMenuItem = worktree.isMain
    ? { label: 'Delete…', enabled: false, danger: true, separatorBefore: true, title: PRIMARY_DELETE_TIP }
    : {
        label: descendants > 0 ? `Delete with descendants (${descendants})…` : 'Delete…',
        danger: true,
        separatorBefore: true,
        onSelect: () => onRun('delete')
      }
  return [
    { label: 'Rename', onSelect: () => onRun('rename') },
    { label: 'Tags…', onSelect: () => onRun('tags') },
    { label: 'Move to section', enabled: repo !== undefined, submenu: sectionItems },
    {
      label: 'Move to status',
      submenu: statuses.map((status) => ({
        label: `${status.icon ? `${status.icon} ` : ''}${status.label}`,
        checked: worktree.status === status.id,
        onSelect: () => onRun('move-status', status.id)
      }))
    },
    ...sleepItems,
    {
      label: 'Open in',
      separatorBefore: true,
      submenu: [
        { label: 'Terminal', onSelect: () => onRun('open-terminal') },
        { label: 'Changes', onSelect: () => onRun('open-changes') }
      ]
    },
    {
      label: 'Copy',
      submenu: [
        { label: 'Path', onSelect: () => onRun('copy-path') },
        { label: 'Worktree name', onSelect: () => onRun('copy-name') }
      ]
    },
    {
      label: 'More',
      submenu: [
        { label: 'Set parent…', onSelect: () => onRun('set-parent') },
        { label: 'Remove from parent', enabled: worktree.parentId !== null, onSelect: () => onRun('remove-parent') },
        worktree.unread
          ? { label: 'Mark read', onSelect: () => onRun('mark-read') }
          : { label: 'Mark unread', onSelect: () => onRun('mark-unread') },
        worktree.pinned
          ? { label: 'Unpin', onSelect: () => onRun('unpin') }
          : { label: 'Pin', onSelect: () => onRun('pin') },
        {
          label: archived ? 'Unarchive' : 'Archive',
          enabled: !worktree.isMain && worktree.kind === 'git',
          onSelect: () => onRun('archive', archived ? UNARCHIVE : null)
        },
        { label: 'Details…', onSelect: () => onRun('details') }
      ]
    },
    del
  ]
}

export type ProjectMenuHandlers =
  | {
      openDialog(dialog: DialogState): void
      openLedger(): void
      /** Moves the project into `group`, or out of its group with null. */
      moveToGroup(repo: Repo, group: ProjectGroup | null): void
      /** Present only while the project order is manual; each side is null when the project can't move that way. */
      reorder?: { up: (() => void) | null; down: (() => void) | null }
    }
  | {
      onOpenDialog(dialog: DialogState): void
      onOpenLedger(): void
      onMoveToGroup(repo: Repo, group: ProjectGroup | null): void
      onMoveUp?: (() => void) | null
      onMoveDown?: (() => void) | null
    }

/** The items of a project header's menu. */
export function projectMenu(repo: Repo, groups: ProjectGroup[], on: ProjectMenuHandlers): ContextMenuItem[] {
  const onStyle = 'onOpenDialog' in on
  const onOpenDialog = onStyle ? on.onOpenDialog : on.openDialog
  const onOpenLedger = onStyle ? on.onOpenLedger : on.openLedger
  const onMoveToGroup = onStyle ? on.onMoveToGroup : on.moveToGroup
  const onMoveUp = onStyle ? on.onMoveUp ?? null : on.reorder?.up ?? null
  const onMoveDown = onStyle ? on.onMoveDown ?? null : on.reorder?.down ?? null
  const showReorder = onStyle
    ? on.onMoveUp !== undefined || on.onMoveDown !== undefined
    : on.reorder !== undefined
  const others = groups.filter((group) => group.id !== repo.groupId)
  const targets: ContextMenuItem[] = [
    ...others.map((group) => ({ label: group.name, onSelect: () => onMoveToGroup(repo, group) })),
    ...(repo.groupId !== null ? [{ label: 'No section', onSelect: () => onMoveToGroup(repo, null) }] : [])
  ]
  return [
    ...(repo.kind === 'git' ? [{ label: 'Open ledger', onSelect: onOpenLedger }] : []),
    { label: 'Project Settings…', onSelect: () => onOpenDialog({ kind: 'project-settings', repoId: repo.id }) },
    { label: 'New section from project…', onSelect: () => onOpenDialog({ kind: 'group', action: 'new', repoId: repo.id }) },
    ...(targets.length > 0 ? [{ label: 'Move to section', submenu: targets }] : []),
    ...(showReorder
      ? [
          { label: 'Move up', enabled: onMoveUp !== null, onSelect: () => onMoveUp?.() },
          { label: 'Move down', enabled: onMoveDown !== null, onSelect: () => onMoveDown?.() }
        ]
      : []),
    { label: 'Remove Project…', onSelect: () => onOpenDialog({ kind: 'remove-project', repoId: repo.id }) }
  ]
}

/** The items of a group header's menu. */
export function groupMenu(group: ProjectGroup, openDialog: (dialog: DialogState) => void, openLedger: () => void): ContextMenuItem[] {
  const onOpenDialog = openDialog
  const onOpenLedger = openLedger
  return [
    { label: 'Open ledger', onSelect: onOpenLedger },
    { label: 'Rename…', onSelect: () => onOpenDialog({ kind: 'group', action: 'rename', groupId: group.id }) },
    { label: 'Delete section…', onSelect: () => onOpenDialog({ kind: 'group', action: 'delete', groupId: group.id }) }
  ]
}
