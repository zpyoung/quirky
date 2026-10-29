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


/** What a workspace's menu items do; the dialog-opening ones are implemented by the section. */
export type WorkspaceMenuHandlers = {
  setStatus(worktree: Worktree, status: string): void
  setPinned(worktree: Worktree, pinned: boolean): void
  setUnread(worktree: Worktree, unread: boolean): void
  removeParent(worktree: Worktree): void
  copy(text: string): void
  openDialog(dialog: DialogState): void
  openDeleteDialog(worktree: Worktree, descendants: number): void
  setMembership(worktree: Worktree, group: ProjectGroup | null): void
  moveProject(repo: Repo, group: ProjectGroup | null): void
  setSleeping(worktree: Worktree, sleeping: boolean, withDescendants: boolean): void
  openIn(worktree: Worktree, target: 'terminal' | 'changes'): void
  archive(worktree: Worktree, archived: boolean): void
}

/** The items of a workspace card's menu, in order. */
export function workspaceMenu(
  worktree: Worktree,
  descendants: number,
  groups: ProjectGroup[],
  repo: Repo | undefined,
  on: WorkspaceMenuHandlers,
  statuses: readonly Pick<WorktreeStatusDefinition, 'id' | 'label' | 'icon'>[] = Object.entries(STATUS_LABELS).map(([id, label]) => ({ id, label }))
): ContextMenuItem[] {
  const del: ContextMenuItem = worktree.isMain
    ? { label: 'Delete', enabled: false, title: PRIMARY_DELETE_TIP }
    : {
        label: descendants > 0 ? `Delete with Descendants (${descendants})…` : 'Delete',
        onSelect: () => on.openDeleteDialog(worktree, descendants)
      }
  const sleeping = 'sleeping' in worktree && worktree.sleeping === true
  const sleepItems: ContextMenuItem[] = sleeping
    ? [
        { label: 'Wake', onSelect: () => on.setSleeping(worktree, false, false) },
        ...(descendants > 0 ? [{ label: `Wake with Descendants (${descendants})`, onSelect: () => on.setSleeping(worktree, false, true) }] : [])
      ]
    : [
        { label: 'Sleep', onSelect: () => on.setSleeping(worktree, true, false) },
        ...(descendants > 0 ? [{ label: `Sleep with Descendants (${descendants})`, onSelect: () => on.setSleeping(worktree, true, true) }] : [])
      ]
  const items: ContextMenuItem[] = [
    { label: 'Rename…', onSelect: () => on.openDialog({ kind: 'update', worktreeId: worktree.id }) },
    {
      label: 'archivedAt' in worktree && (worktree as Worktree & { archivedAt: number | null }).archivedAt !== null ? 'Unarchive' : 'Archive',
      enabled: !worktree.isMain && worktree.kind === 'git',
      onSelect: () => on.archive(
        worktree,
        !('archivedAt' in worktree) || (worktree as Worktree & { archivedAt: number | null }).archivedAt === null
      )
    },
    {
      label: 'Move to Status',
      submenu: statuses.map((status) => ({
        label: `${status.icon ? `${status.icon} ` : ''}${status.label}`,
        checked: worktree.status === status.id,
        onSelect: () => on.setStatus(worktree, status.id)
      }))
    },
    {
      label: 'Open in',
      submenu: [
        { label: 'Terminal', onSelect: () => on.openIn(worktree, 'terminal') },
        { label: 'Changes', onSelect: () => on.openIn(worktree, 'changes') }
      ]
    },
    { label: 'Copy Path', onSelect: () => on.copy(worktree.path) },
    { label: 'Copy Worktree Name', onSelect: () => on.copy(worktree.name) },
    worktree.pinned
      ? { label: 'Unpin', onSelect: () => on.setPinned(worktree, false) }
      : { label: 'Pin', onSelect: () => on.setPinned(worktree, true) },
    worktree.unread
      ? { label: 'Mark Read', onSelect: () => on.setUnread(worktree, false) }
      : { label: 'Mark Unread', onSelect: () => on.setUnread(worktree, true) },
    worktree.parentId
      ? { label: 'Remove from Parent', onSelect: () => on.removeParent(worktree) }
      : { label: 'Set Parent Worktree…', onSelect: () => on.openDialog({ kind: 'parent', worktreeId: worktree.id }) },
    ...sleepItems,
    del
  ]
  if (worktree.kind === 'git' && repo?.kind === 'git') {
    items.push({
      label: 'New group from worktree…',
      onSelect: () => on.openDialog({
        kind: 'group',
        action: 'new-worktree',
        worktreeId: worktree.id,
        initialName: `${worktree.name} group`,
        expectedInstanceId: worktree.instanceId,
        expectedProjectGroupId: worktree.projectGroupId
      })
    })
    if (groups.length > 0) {
      items.push({
        label: 'Add worktree to group',
        submenu: groups.map((group) => ({
          label: group.name,
          enabled: group.id !== worktree.projectGroupId,
          checked: group.id === worktree.projectGroupId,
          onSelect: () => on.setMembership(worktree, group)
        }))
      })
    }
    if (worktree.projectGroupId !== null) {
      items.push({ label: 'Remove worktree from group', onSelect: () => on.setMembership(worktree, null) })
    }
  }
  if (repo && !(worktree.kind === 'git' && repo.kind === 'git')) {
    items.push({
      label: 'New Group from Project…',
      onSelect: () => on.openDialog({ kind: 'group', action: 'new', repoId: repo.id })
    })
  }
  if (repo && groups.length > 0) {
    const targets: ContextMenuItem[] = groups.map((group) => ({
      label: group.name,
      enabled: group.id !== repo.groupId,
      checked: group.id === repo.groupId,
      onSelect: () => on.moveProject(repo, group)
    }))
    if (repo.groupId !== null) targets.push({ label: 'No group', onSelect: () => on.moveProject(repo, null) })
    items.push({ label: 'Move project to group', submenu: targets })
  }
  if (repo && !(worktree.kind === 'git' && repo.kind === 'git') && repo.groupId !== null) {
    items.push({ label: 'Remove project from group', onSelect: () => on.moveProject(repo, null) })
  }
  return items
}

export type ProjectMenuHandlers = {
  openDialog(dialog: DialogState): void
  openLedger(): void
  /** Moves the project into `group`, or out of its group with null. */
  moveToGroup(repo: Repo, group: ProjectGroup | null): void
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
