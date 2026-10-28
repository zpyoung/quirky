import type { ActivityPreferences } from './useSidebarActivity'
import type { MembershipTarget } from './membership'
import type { AgentDisplayState, ProjectGroup, Repo, Session, Worktree, WorktreeStatus } from '@quirky/protocol'
import { worktreeGlyph, worktreeStatus, type DisplayStatus } from './status'

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
  | { kind: 'group'; action: 'new-worktree'; worktreeId: string; initialName: string; expectedInstanceId: string; expectedProjectGroupId: string | null }
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

/** One workspace row: visible-section nesting plus the complete canonical delete lineage. */
export type TreeRow = {
  worktree: Worktree
  depth: number
  /** Direct children visible in this section, for the "N child" chip. */
  childCount: number
  /** Every canonical workspace nested below it, regardless of section or activity filtering. */
  descendants: string[]
  /** IDs of visible rows above it, so a collapsed ancestor can hide it. */
  ancestors: string[]
  /** Set only for loose Git rows shown directly under a group. */
  repoName?: string
}

export type ProjectNode = { repo: Repo; rows: TreeRow[]; pending: PendingCreate[] }
export type GroupNode = { group: ProjectGroup; parentId: string | null; projects: ProjectNode[]; rows: TreeRow[]; looseRows: TreeRow[]; children: GroupNode[]; depth: number }

/** What the sidebar draws: pinned workspaces, nested groups, and ungrouped projects. */
export type TreeModel = { pinned: Worktree[]; groups: GroupNode[]; projects: ProjectNode[] }

export type SeparatorReport = { enabled: boolean; eligibleBoundaries: string[] }
export type ActivityReport = {
  preferences: ActivityPreferences
  visibleIds: string[]
  hiddenIds: string[]
  hiddenCount: number
  filterCount: number
  reviewHiddenIds?: string[]
  reviewHiddenCount?: number
}
export type FilterStatus = 'loading' | 'available' | 'missing' | 'error'
export type DropPreviewReport = MembershipTarget

/** Projects eligible hairline boundaries from ordered logical top-level sections and sticky headers. */
export function projectSeparatorBoundaries(
  sectionKeys: readonly string[],
  stickySections: ReadonlySet<string>,
  enabled: boolean
): string[] {
  if (!enabled) return []
  const boundaries: string[] = []
  for (let index = 1; index < sectionKeys.length; index++) {
    const previous = sectionKeys[index - 1]!
    const current = sectionKeys[index]!
    if (!stickySections.has(previous) && !stickySections.has(current)) boundaries.push(current)
  }
  return boundaries
}

const groupOrder = (a: ProjectGroup, b: ProjectGroup) => a.order - b.order || a.id.localeCompare(b.id)

function flattenGroups(groups: GroupNode[]): GroupNode[] {
  return groups.flatMap((group) => [group, ...flattenGroups(group.children)])
}

function groupParentMap(groups: ProjectGroup[]): Map<string, string | null> {
  const ids = new Set(groups.map((group) => group.id))
  const parent = new Map(groups.map((group) => [
    group.id,
    group.parentId && group.parentId !== group.id && ids.has(group.parentId) ? group.parentId : null
  ]))
  const finished = new Set<string>()
  for (const group of [...groups].sort(groupOrder)) {
    const path: string[] = []
    const seen = new Set<string>()
    let current: string | null = group.id
    while (current !== null && !finished.has(current)) {
      if (seen.has(current)) {
        const closing = path[path.length - 1]
        if (closing) parent.set(closing, null)
        break
      }
      seen.add(current)
      path.push(current)
      current = parent.get(current) ?? null
    }
    for (const id of path) finished.add(id)
  }
  return parent
}

/**
 * Orders `worktrees` for display: roots first (the primary leading), each followed by its children
 * in the order given. A parent outside `worktrees`, or a parent cycle, leaves a workspace as a root.
 */
export function arrangeRows(worktrees: Worktree[]): TreeRow[] {
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const children = new Map<string, Worktree[]>()
  const roots: Worktree[] = []
  for (const worktree of worktrees) {
    const parent = worktree.parentId ? byId.get(worktree.parentId) : undefined
    if (parent && parent.id !== worktree.id && parent.repoId === worktree.repoId) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), worktree])
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
  pending: PendingCreate[],
  visibleIds?: ReadonlySet<string> | null
): TreeModel {
  const known = new Set(groups.map((group) => group.id))
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  const canonicalDescendants = new Map<string, string[]>()
  const worktreesByRepo = new Map<string, Worktree[]>()
  for (const worktree of worktrees) {
    const list = worktreesByRepo.get(worktree.repoId) ?? []
    list.push(worktree)
    worktreesByRepo.set(worktree.repoId, list)
  }
  for (const rows of worktreesByRepo.values()) {
    for (const row of arrangeRows(rows)) canonicalDescendants.set(row.worktree.id, row.descendants)
  }

  const rowsFor = (sectionWorktrees: Worktree[], looseRows = false): TreeRow[] => {
    const visible = visibleIds ? sectionWorktrees.filter((worktree) => visibleIds.has(worktree.id)) : sectionWorktrees
    return arrangeRows(visible).map((row) => ({
      ...row,
      descendants: canonicalDescendants.get(row.worktree.id) ?? row.descendants,
      ...(looseRows && row.worktree.kind === 'git'
        ? { repoName: reposById.get(row.worktree.repoId) ? repoLabel(reposById.get(row.worktree.repoId)!) : row.worktree.repoId }
        : {})
    }))
  }
  const node = (repo: Repo): ProjectNode => ({
    repo,
    rows: rowsFor(worktrees.filter((worktree) =>
      worktree.repoId === repo.id && !(worktree.kind === 'git' && worktree.projectGroupId && known.has(worktree.projectGroupId))
    )),
    pending: pending.filter((create) => create.repoId === repo.id)
  })
  const orderedGroups = [...groups].sort(groupOrder)
  const parents = groupParentMap(orderedGroups)
  const nodes = new Map<string, GroupNode>()
  const claimedRepos = new Set<string>()
  for (const group of orderedGroups) {
    const members: Repo[] = []
    for (const id of group.repoIds) {
      const repo = reposById.get(id)
      if (repo && !claimedRepos.has(repo.id) && (repo.groupId === null || repo.groupId === group.id)) {
        members.push(repo)
        claimedRepos.add(repo.id)
      }
    }
    for (const repo of repos) {
      if (repo.groupId === group.id && !claimedRepos.has(repo.id)) {
        members.push(repo)
        claimedRepos.add(repo.id)
      }
    }
    members.sort((left, right) => Number(right.kind === 'folder') - Number(left.kind === 'folder'))
    nodes.set(group.id, {
      group,
      projects: members.map(node),
      rows: rowsFor(worktrees.filter((worktree) => worktree.repoId === `group:${group.id}`)),
      looseRows: rowsFor(
        worktrees.filter((worktree) => worktree.repoId !== `group:${group.id}` && worktree.kind === 'git' && worktree.projectGroupId === group.id),
        true
      ),
      parentId: parents.get(group.id) ?? null,
      children: [],
      depth: 0
    })
  }
  const roots: GroupNode[] = []
  for (const group of orderedGroups) {
    const node = nodes.get(group.id)!
    const parentId = parents.get(group.id)
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const setDepth = (node: GroupNode, depth: number) => {
    node.depth = depth
    for (const child of node.children) setDepth(child, depth + 1)
  }
  for (const root of roots) setDepth(root, 0)

  return {
    pinned: worktrees.filter((worktree) => worktree.pinned && (!visibleIds || visibleIds.has(worktree.id))),
    groups: roots,
    projects: repos.filter((repo) => !claimedRepos.has(repo.id)).map(node)
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
  /** Present when an agent's display state, not the coarse `status`, is what the card draws. */
  display?: AgentDisplayState
  label?: string
  /** Execution project chip on a loose Git workspace row. */
  repoName?: string
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
  activityStatus: FilterStatus
  activityError: string | null
  appliedFilter: ActivityPreferences | null
  visibleIds: string[] | null
  hiddenIds: string[]
  hiddenCount: number
  reviewHiddenIds: string[]
  reviewHiddenCount: number
  filterCount: number
  groupDepths: Record<string, number>
  groupParents: Record<string, string | null>
  separators: SeparatorReport
  dropPreview: DropPreviewReport | null
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
  visibleIds?: ReadonlySet<string> | null
  activity?: ActivityReport | null
  activityStatus?: FilterStatus
  activityError?: string | null
  separators?: SeparatorReport
  dropPreview?: DropPreviewReport | null
  /** The clock the agent glyph's staleness is judged against; defaults to the current time. */
  now?: number
}

/** The report for what the section shows, in tree order. */
export function buildReport(input: ReportInput): WorktreesReport {
  const { sessions, selectedId } = input
  const now = input.now ?? Date.now()
  const model = buildTreeModel(input.repos, input.groups, input.worktrees, input.pending, input.visibleIds)
  const workspace = ({ worktree, depth, repoName }: TreeRow): WorkspaceReport => {
    const glyph = sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)
    return {
      id: worktree.id,
      name: worktree.name,
      branch: worktree.branch,
      kind: worktree.kind,
      primary: worktree.isMain,
      status: sessions === null ? null : worktreeStatus(sessions, worktree.id),
      ...(glyph?.kind === 'agent' ? { display: glyph.display, label: glyph.label } : {}),
      ...(repoName ? { repoName } : {}),
      workspaceStatus: worktree.status,
      pinned: worktree.pinned,
      unread: worktree.unread,
      parentId: worktree.parentId,
      depth,
      pending: false,
      removing: worktree.removing,
      selected: worktree.id === selectedId
    }
  }
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
  const groups = flattenGroups(model.groups)
  const activity = input.activity ?? null
  return {
    pinned: model.pinned.map((worktree) => worktree.id),
    groups: groups.map(({ group, projects, rows, looseRows }) => ({
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
      worktrees: [...rows, ...looseRows].map(workspace),
      projects: projects.map(project)
    })),
    projects: model.projects.map(project),
    dialog: input.dialog,
    notices: input.notices ?? [],
    activityStatus: input.activityStatus ?? 'loading',
    activityError: input.activityError ?? null,
    appliedFilter: activity?.preferences ?? null,
    visibleIds: input.visibleIds ? [...input.visibleIds] : null,
    hiddenIds: activity?.hiddenIds ?? [],
    hiddenCount: activity?.hiddenCount ?? 0,
    reviewHiddenIds: activity?.reviewHiddenIds ?? [],
    reviewHiddenCount: activity?.reviewHiddenCount ?? 0,
    filterCount: activity?.filterCount ?? 0,
    groupDepths: Object.fromEntries(groups.map(({ group, depth }) => [group.id, depth])),
    groupParents: Object.fromEntries(groups.map(({ group, parentId }) => [group.id, parentId])),
    separators: input.separators ?? { enabled: true, eligibleBoundaries: [] },
    dropPreview: input.dropPreview ?? null
  }
}
