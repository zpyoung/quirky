import { useEffect, useRef, useState } from 'react'
import type { ProjectGroup, Repo, Worktree, WorktreeStatus } from '@quirky/protocol'
import type { DialogState } from './report'

export const PRIMARY_DELETE_TIP = 'the primary worktree cannot be deleted; remove the project instead'

export const STATUS_LABELS: Record<WorktreeStatus, string> = {
  todo: 'Todo',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done'
}

export type MenuItem = {
  label: string
  onSelect?(): void
  disabled?: boolean
  /** Explains why an item is disabled. */
  title?: string
  /** Items shown under this one when it is opened. */
  submenu?: MenuItem[]
  /** Marks the item that matches the current value. */
  current?: boolean
}

type Props = {
  /** Viewport position of the menu's top-left corner. */
  x: number
  y: number
  label: string
  items: MenuItem[]
  onClose(): void
}

const MENU_WIDTH = 220

function Items({ items, onPick }: { items: MenuItem[]; onPick(item: MenuItem): void }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <>
      {items.map((item, index) => (
        <li key={item.label} role="none" title={item.title}>
          <button
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            data-current={item.current ? '' : undefined}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? open === index : undefined}
            onClick={() => (item.submenu ? setOpen(open === index ? null : index) : onPick(item))}
          >
            {item.label}
            {item.submenu && (
              <span className="menu-arrow" aria-hidden>
                ▸
              </span>
            )}
          </button>
          {item.submenu && open === index && (
            <ul className="menu-sub" role="menu" aria-label={item.label}>
              <Items items={item.submenu} onPick={onPick} />
            </ul>
          )}
        </li>
      ))}
    </>
  )
}

/** A menu opened at a screen position; Escape, a click outside or picking an item closes it. */
export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const root = useRef<HTMLUListElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const enabled = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    enabled()[0]?.focus()
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return close.current()
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = enabled()
      if (buttons.length === 0) return
      event.preventDefault()
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(at + step + buttons.length) % buttons.length]!.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH))
  return (
    <ul ref={root} className="menu menu-context" role="menu" aria-label={label} style={{ left, top: y }}>
      <Items
        items={items}
        onPick={(item) => {
          onClose()
          item.onSelect?.()
        }}
      />
    </ul>
  )
}

/** What a workspace's menu items do; the dialog-opening ones are implemented by the section. */
export type WorkspaceMenuHandlers = {
  setStatus(worktree: Worktree, status: WorktreeStatus): void
  setPinned(worktree: Worktree, pinned: boolean): void
  setUnread(worktree: Worktree, unread: boolean): void
  removeParent(worktree: Worktree): void
  copy(text: string): void
  openDialog(dialog: DialogState): void
  openDeleteDialog(worktree: Worktree, descendants: number): void
  setMembership(worktree: Worktree, group: ProjectGroup | null): void
  moveProject(repo: Repo, group: ProjectGroup | null): void
  setSleeping(worktree: Worktree, sleeping: boolean, withDescendants: boolean): void
}

/** The items of a workspace card's menu, in order. */
export function workspaceMenu(
  worktree: Worktree,
  descendants: number,
  groups: ProjectGroup[],
  repo: Repo | undefined,
  on: WorkspaceMenuHandlers
): MenuItem[] {
  const del: MenuItem = worktree.isMain
    ? { label: 'Delete', disabled: true, title: PRIMARY_DELETE_TIP }
    : {
        label: descendants > 0 ? `Delete with Descendants (${descendants})…` : 'Delete',
        onSelect: () => on.openDeleteDialog(worktree, descendants)
      }
  const sleeping = 'sleeping' in worktree && worktree.sleeping === true
  const sleepItems: MenuItem[] = sleeping
    ? [
        { label: 'Wake', onSelect: () => on.setSleeping(worktree, false, false) },
        ...(descendants > 0 ? [{ label: `Wake with Descendants (${descendants})`, onSelect: () => on.setSleeping(worktree, false, true) }] : [])
      ]
    : [
        { label: 'Sleep', onSelect: () => on.setSleeping(worktree, true, false) },
        ...(descendants > 0 ? [{ label: `Sleep with Descendants (${descendants})`, onSelect: () => on.setSleeping(worktree, true, true) }] : [])
      ]
  const items: MenuItem[] = [
    { label: 'Update…', onSelect: () => on.openDialog({ kind: 'update', worktreeId: worktree.id }) },
    {
      label: 'Move to Status',
      submenu: (Object.keys(STATUS_LABELS) as WorktreeStatus[]).map((status) => ({
        label: STATUS_LABELS[status],
        current: worktree.status === status,
        onSelect: () => on.setStatus(worktree, status)
      }))
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
  if (worktree.kind === 'git') {
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
          disabled: group.id === worktree.projectGroupId,
          current: group.id === worktree.projectGroupId,
          onSelect: () => on.setMembership(worktree, group)
        }))
      })
      if (worktree.projectGroupId !== null) {
        items.push({ label: 'Remove worktree from group', onSelect: () => on.setMembership(worktree, null) })
      }
    }
  }
  if (repo && groups.length > 0) {
    const targets: MenuItem[] = groups.map((group) => ({
      label: group.name,
      disabled: group.id === repo.groupId,
      current: group.id === repo.groupId,
      onSelect: () => on.moveProject(repo, group)
    }))
    if (repo.groupId !== null) targets.push({ label: 'No group', onSelect: () => on.moveProject(repo, null) })
    items.push({ label: 'Move project to group', submenu: targets })
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
export function projectMenu(repo: Repo, groups: ProjectGroup[], on: ProjectMenuHandlers): MenuItem[] {
  const others = groups.filter((group) => group.id !== repo.groupId)
  const targets: MenuItem[] = [
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
export function groupMenu(group: ProjectGroup, openDialog: (dialog: DialogState) => void, openLedger: () => void): MenuItem[] {
  return [
    { label: 'Open ledger', onSelect: openLedger },
    { label: 'Rename…', onSelect: () => openDialog({ kind: 'group', action: 'rename', groupId: group.id }) },
    { label: 'Delete Group…', onSelect: () => openDialog({ kind: 'group', action: 'delete', groupId: group.id }) }
  ]
}
