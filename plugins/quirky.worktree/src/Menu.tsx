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
  const sleeping = 'sleeping' in worktree && worktree.sleeping === true
  const archived = 'archivedAt' in worktree && (worktree as Worktree & { archivedAt: number | null }).archivedAt !== null
  const ownSection = worktree.kind === 'git' && repo?.kind === 'git'
  const currentSection = ownSection ? worktree.projectGroupId : repo?.groupId ?? null
  const sectionItems: ContextMenuItem[] = [
    ...groups.map((group) => ({
      label: group.name,
      checked: group.id === currentSection,
      enabled: group.id !== currentSection,
      onSelect: () => run('move-section', group.id)
    })),
    ...(currentSection !== null
      ? [{ label: 'Remove from section', separatorBefore: groups.length > 0, onSelect: () => run('move-section', null) }]
      : []),
    { label: 'New section…', separatorBefore: groups.length > 0 || currentSection !== null, onSelect: () => run('move-section', NEW_SECTION) }
  ]
  const sleepAction: RowAction = sleeping ? 'wake' : 'sleep'
  const sleepItems: ContextMenuItem[] = [
    { label: sleeping ? 'Wake' : 'Sleep', onSelect: () => run(sleepAction) },
    ...(descendants > 0
      ? [{ label: `${sleeping ? 'Wake' : 'Sleep'} with descendants (${descendants})`, onSelect: () => run(sleepAction, WITH_DESCENDANTS) }]
      : [])
  ]
  const del: ContextMenuItem = worktree.isMain
    ? { label: 'Delete…', enabled: false, danger: true, separatorBefore: true, title: PRIMARY_DELETE_TIP }
    : {
        label: descendants > 0 ? `Delete with descendants (${descendants})…` : 'Delete…',
        danger: true,
        separatorBefore: true,
        onSelect: () => run('delete')
      }
  return [
    { label: 'Rename', onSelect: () => run('rename') },
    { label: 'Tags…', onSelect: () => run('tags') },
    { label: 'Move to section', enabled: repo !== undefined, submenu: sectionItems },
    {
      label: 'Move to status',
      submenu: statuses.map((status) => ({
        label: `${status.icon ? `${status.icon} ` : ''}${status.label}`,
        checked: worktree.status === status.id,
        onSelect: () => run('move-status', status.id)
      }))
    },
    ...sleepItems,
    {
      label: 'Open in',
      separatorBefore: true,
      submenu: [
        { label: 'Terminal', onSelect: () => run('open-terminal') },
        { label: 'Changes', onSelect: () => run('open-changes') }
      ]
    },
    {
      label: 'Copy',
      submenu: [
        { label: 'Path', onSelect: () => run('copy-path') },
        { label: 'Worktree name', onSelect: () => run('copy-name') }
      ]
    },
    {
      label: 'More',
      submenu: [
        { label: 'Set parent…', onSelect: () => run('set-parent') },
        { label: 'Remove from parent', enabled: worktree.parentId !== null, onSelect: () => run('remove-parent') },
        worktree.unread
          ? { label: 'Mark read', onSelect: () => run('mark-read') }
          : { label: 'Mark unread', onSelect: () => run('mark-unread') },
        worktree.pinned
          ? { label: 'Unpin', onSelect: () => run('unpin') }
          : { label: 'Pin', onSelect: () => run('pin') },
        {
          label: archived ? 'Unarchive' : 'Archive',
          enabled: !worktree.isMain && worktree.kind === 'git',
          onSelect: () => run('archive', archived ? UNARCHIVE : null)
        },
        { label: 'Details…', onSelect: () => run('details') }
      ]
    },
    del
  ]
}

export type ProjectMenuHandlers = {
  openDialog(dialog: DialogState): void
  openLedger(): void
  /** Moves the project into `group`, or out of its group with null. */
  moveToGroup(repo: Repo, group: ProjectGroup | null): void
  /** Present only while the project order is manual; each side is null when the project can't move that way. */
  reorder?: { up: (() => void) | null; down: (() => void) | null }
}

/** The items of a project header's menu. */
export function projectMenu(repo: Repo, groups: ProjectGroup[], on: ProjectMenuHandlers): ContextMenuItem[] {
  const others = groups.filter((group) => group.id !== repo.groupId)
  const targets: ContextMenuItem[] = [
    ...others.map((group) => ({ label: group.name, onSelect: () => on.moveToGroup(repo, group) })),
    ...(repo.groupId !== null ? [{ label: 'No group', onSelect: () => on.moveToGroup(repo, null) }] : [])
  ]
  return [
    ...(repo.kind === 'git' ? [{ label: 'Open ledger', onSelect: on.openLedger }] : []),
    { label: 'Project Settings…', onSelect: () => on.openDialog({ kind: 'project-settings', repoId: repo.id }) },
    { label: 'New Group from Project…', onSelect: () => on.openDialog({ kind: 'group', action: 'new', repoId: repo.id }) },
    ...(targets.length > 0 ? [{ label: 'Move to Group', submenu: targets }] : []),
    ...(on.reorder
      ? [
          { label: 'Move up', enabled: on.reorder.up !== null, onSelect: () => on.reorder?.up?.() },
          { label: 'Move down', enabled: on.reorder.down !== null, onSelect: () => on.reorder?.down?.() }
        ]
      : []),
    { label: 'Remove Project…', onSelect: () => on.openDialog({ kind: 'remove-project', repoId: repo.id }) }
  ]
}

/** The items of a group header's menu. */
export function groupMenu(group: ProjectGroup, openDialog: (dialog: DialogState) => void, openLedger: () => void): ContextMenuItem[] {
  return [
    { label: 'Open ledger', onSelect: openLedger },
    { label: 'Rename…', onSelect: () => openDialog({ kind: 'group', action: 'rename', groupId: group.id }) },
    { label: 'Delete Group…', onSelect: () => openDialog({ kind: 'group', action: 'delete', groupId: group.id }) }
  ]
}
