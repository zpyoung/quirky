import type { ProjectGroup, Repo, Session, Worktree, WorktreeStatus } from '@quirky/protocol'
import { worktreeStatus, type DisplayStatus } from './status'

/** A create the window has sent and not yet seen finish; shown as a pending row under its project. */
export type PendingCreate = { repoId: string; name: string }

/** The dialog the section has open, as `ui state` reports it. */
export type DialogState =
  | { kind: 'create'; repoId: string }
  | { kind: 'update' | 'parent' | 'base-fallback'; worktreeId: string }
  | { kind: 'delete'; worktreeId: string; withDescendants: boolean }
  | { kind: 'trust'; repoId: string }
  | { kind: 'project-settings' | 'remove-project'; repoId: string }
  | { kind: 'add-project' }
  | { kind: 'import'; path: string }
  | { kind: 'open-as-folder'; path: string }
  | { kind: 'group'; action: 'new'; repoId: string }
  | { kind: 'group'; action: 'rename' | 'delete'; groupId: string }

/** Whether the add-project flow is the open dialog, at whichever question it has reached. */
export function isAddFlow(dialog: DialogState | null): boolean {
  switch (dialog?.kind) {
    case 'add-project':
    case 'import':
    case 'open-as-folder':
      return true
    default:
      return false
  }
}

/** A notice shown inside the section until it is acted on or dismissed. */
export type NoticeReport = { kind: 'kept-branch'; branch: string; repoId: string }

/** One workspace row: where it sits in its project's nesting. */
export type TreeRow = {
  worktree: Worktree
  depth: number
  /** Direct children, for the "N child" chip. */
  childCount: number
  /** Every workspace nested below it, for "Delete with Descendants (N)". */
  descendants: string[]
  /** IDs of the rows above it, so a collapsed ancestor can hide it. */
  ancestors: string[]
}

export type ProjectNode = { repo: Repo; rows: TreeRow[]; pending: PendingCreate[] }
export type GroupNode = { group: ProjectGroup; projects: ProjectNode[]; rows: TreeRow[] }

/** What the sidebar draws: the pinned workspaces, the groups with their projects, and the ungrouped projects. */
export type TreeModel = { pinned: Worktree[]; groups: GroupNode[]; projects: ProjectNode[] }

/**
 * Orders `worktrees` for display: roots first (the primary leading), each followed by its children
 * in the order given. A parent outside `worktrees`, or a parent cycle, leaves a workspace as a root.
 */
export function arrangeRows(worktrees: Worktree[]): TreeRow[] {
  const ids = new Set(worktrees.map((w) => w.id))
  const children = new Map<string, Worktree[]>()
  const roots: Worktree[] = []
  for (const worktree of worktrees) {
    if (worktree.parentId && worktree.parentId !== worktree.id && ids.has(worktree.parentId)) {
      children.set(worktree.parentId, [...(children.get(worktree.parentId) ?? []), worktree])
    } else {
      roots.push(worktree)
    }
  }
  roots.sort((a, b) => Number(b.isMain) - Number(a.isMain))

  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const visit = (worktree: Worktree, depth: number, ancestors: string[]): string[] => {
    seen.add(worktree.id)
    const row: TreeRow = { worktree, depth, childCount: 0, descendants: [], ancestors }
    rows.push(row)
    for (const child of children.get(worktree.id) ?? []) {
      if (seen.has(child.id)) continue
      row.childCount++
      row.descendants.push(child.id, ...visit(child, depth + 1, [...ancestors, worktree.id]))
    }
    return row.descendants
  }
  for (const root of roots) visit(root, 0, [])
  // a cycle has no root; its members still show, flat
  for (const worktree of worktrees) if (!seen.has(worktree.id)) visit(worktree, 0, [])
  return rows
}

/** The label a project goes by in the sidebar. */
export const repoLabel = (repo: Repo): string => repo.displayName ?? repo.name

/** How a workspace reads in a picker: `name · project · branch`. */
export function workspaceOption(worktree: Worktree, repos: Repo[]): string {
  const repo = repos.find((r) => r.id === worktree.repoId)
  return [worktree.name, repo ? repoLabel(repo) : worktree.repoId, worktree.branch ?? 'detached'].join(' · ')
}

export function buildTreeModel(
  repos: Repo[],
  groups: ProjectGroup[],
  worktrees: Worktree[],
  pending: PendingCreate[]
): TreeModel {
  const known = new Set(groups.map((g) => g.id))
  const node = (repo: Repo): ProjectNode => ({
    repo,
    rows: arrangeRows(worktrees.filter((w) => w.repoId === repo.id)),
    pending: pending.filter((p) => p.repoId === repo.id)
  })
  const ordered = [...groups].sort((a, b) => a.order - b.order)
  return {
    pinned: worktrees.filter((w) => w.pinned),
    groups: ordered.map((group) => {
      const byId = new Map(repos.map((r) => [r.id, r]))
      const members = group.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => r !== undefined)
      for (const repo of repos) if (repo.groupId === group.id && !members.includes(repo)) members.push(repo)
      return {
        group,
        projects: members.map(node),
        rows: arrangeRows(worktrees.filter((w) => w.repoId === `group:${group.id}`))
      }
    }),
    projects: repos.filter((r) => r.groupId === null || !known.has(r.groupId)).map(node)
  }
}

export type WorkspaceReport = {
  id: string
  name: string
  branch: string | null
  kind: 'git' | 'folder'
  primary: boolean
  /** The most urgent session status; null with no sessions or while `quirky.session` is off. */
  status: DisplayStatus | null
  workspaceStatus: WorktreeStatus
  pinned: boolean
  unread: boolean
  parentId: string | null
  depth: number
  pending: boolean
  removing: boolean
  selected: boolean
}

export type ProjectReport = { id: string; name: string; kind: 'git' | 'folder'; worktrees: WorkspaceReport[] }

/** What the sidebar section reports to `ui.state`. */
export type WorktreesReport = {
  pinned: string[]
  groups: { id: string; name: string; collapsed: boolean; worktrees: WorkspaceReport[]; projects: ProjectReport[] }[]
  projects: ProjectReport[]
  dialog: DialogState | null
  notices: NoticeReport[]
}

export type ReportInput = {
  repos: Repo[]
  groups: ProjectGroup[]
  worktrees: Worktree[]
  /** Null when `quirky.session` is off, in which case no workspace has a status. */
  sessions: Session[] | null
  selectedId: string | null
  pending: PendingCreate[]
  dialog: DialogState | null
  notices?: NoticeReport[]
}

/** The report for what the section shows, in tree order. */
export function buildReport(input: ReportInput): WorktreesReport {
  const { sessions, selectedId } = input
  const model = buildTreeModel(input.repos, input.groups, input.worktrees, input.pending)
  const workspace = ({ worktree, depth }: TreeRow): WorkspaceReport => ({
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    kind: worktree.kind,
    primary: worktree.isMain,
    status: sessions === null ? null : worktreeStatus(sessions, worktree.id),
    workspaceStatus: worktree.status,
    pinned: worktree.pinned,
    unread: worktree.unread,
    parentId: worktree.parentId,
    depth,
    pending: false,
    removing: worktree.removing,
    selected: worktree.id === selectedId
  })
  const project = ({ repo, rows, pending }: ProjectNode): ProjectReport => ({
    id: repo.id,
    name: repoLabel(repo),
    kind: repo.kind,
    worktrees: [
      ...rows.map(workspace),
      ...pending.map((create) => ({
        id: `pending:${create.name}`,
        name: create.name,
        branch: null,
        kind: repo.kind,
        primary: false,
        status: null,
        workspaceStatus: 'in-progress' as const,
        pinned: false,
        unread: false,
        parentId: null,
        depth: 0,
        pending: true,
        removing: false,
        selected: false
      }))
    ]
  })
  return {
    pinned: model.pinned.map((w) => w.id),
    groups: model.groups.map(({ group, projects, rows }) => ({
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
      worktrees: rows.map(workspace),
      projects: projects.map(project)
    })),
    projects: model.projects.map(project),
    dialog: input.dialog,
    notices: input.notices ?? []
  }
}
