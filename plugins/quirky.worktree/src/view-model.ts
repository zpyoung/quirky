import type { AgentDisplayState, ProjectGroup, Repo, Session } from '@quirky/protocol'
import type { WorktreeControl } from './control-types'
import { worktreeGlyph, type DisplayStatus } from './status'
import type { ActivityMarkState, GroupBy, SortBy, Tag, ViewId, ViewSpec } from './view-types'

export type ChecksState = 'pending' | 'success' | 'failure' | 'neutral'
export type Attention = 'none' | 'waiting' | 'error'

export type ViewRow = {
  worktree: WorktreeControl
  depth: number
  mark: ActivityMarkState
  childCount: number
  childAttention: Attention
  inSectionFromProject?: string
}
export type ViewGroup = {
  key: string
  kind: 'pinned' | 'section' | 'project' | 'status' | 'tag' | 'untagged' | 'pr' | 'flat'
  title: string
  attention: Attention
  attentionCount: number
  rows: ViewRow[]
}
export type ViewTree = {
  groups: ViewGroup[]
  hidden: { count: number; reasons: string[] }
  needsYouCount: number
  erroredCount: number
}

/** The part of the sidebar-extras activity projection the view model reads. */
export type ViewProjection = {
  visibleIds: readonly string[]
  automationHiddenIds?: readonly string[]
  reviewHiddenIds?: readonly string[]
  workspaces?: readonly { worktreeId: string; reviewReason?: 'completed' | 'passing' | 'unknown' }[]
}

export type BuildTreeInput = {
  worktrees: readonly WorktreeControl[]
  repos: readonly Repo[]
  groups: readonly ProjectGroup[]
  tags: readonly Tag[]
  spec: ViewSpec
  viewId: ViewId
  projection: ViewProjection | null
  marks: ReadonlyMap<string, ActivityMarkState>
  checks: ReadonlyMap<string, ChecksState | null>
  /** Manual project order (`stock-project-order`); projects it omits go last. */
  projectOrder?: readonly string[]
  /** Sessions for the agent-activity sort; without them a waiting mark stands in. */
  sessions?: readonly Session[] | null
  /** Facts behind "hide other desktop clients"; absent means no other client is known. */
  otherClients?: { authenticated: boolean; byWorktree: ReadonlyMap<string, boolean | null> }
  /** Status order and labels for status grouping; defaults to the four built-in statuses. */
  statuses?: readonly { id: string; label: string }[]
  /** What the filter line's Show action has revealed. */
  reveal?: { filtered?: boolean; asleep?: boolean }
}

const CREATE_GRACE_MS = 5 * 60 * 1_000
const DEFAULT_STATUSES = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'in-review', label: 'In review' },
  { id: 'done', label: 'Done' }
]
const HIDDEN_REASON_ORDER = [
  'external',
  'other project',
  'CLI-created',
  'other desktop client',
  'default branch',
  'detached HEAD',
  'archived',
  'no matching tag',
  'other section',
  'other status',
  'asleep',
  'automation-created',
  'completed review',
  'passing checks',
  'inactive'
] as const
type HiddenReason = (typeof HIDDEN_REASON_ORDER)[number]

function markOfDisplay(value: AgentDisplayState | DisplayStatus): ActivityMarkState {
  switch (value) {
    case 'working':
    case 'monitoring':
    case 'running':
      return 'running'
    case 'waiting':
    case 'permission':
    case 'blocked':
      return 'waiting'
    case 'failed':
      return 'error'
    default:
      return 'idle'
  }
}

/**
 * The agent-activity mark a worktree's row shows. A pending ask wins, then a removal in flight,
 * then sleep, then the most urgent session. `pendingAsks` is the worktree's own count or a count
 * per worktree id; null means unknown. `sessions` null means the session plugin is off.
 */
export function activityMark(
  worktree: WorktreeControl,
  sessions: Session[] | null,
  pendingAsks: number | ReadonlyMap<string, number> | null,
  now: number
): ActivityMarkState {
  const asks = typeof pendingAsks === 'number' ? pendingAsks : pendingAsks?.get(worktree.id) ?? 0
  if (asks > 0) return 'waiting'
  if (worktree.removing) return 'running'
  if (worktree.sleeping) return 'asleep'
  if (sessions === null) return 'running'
  const glyph = worktreeGlyph(sessions, worktree.id, now)
  if (glyph === null) return 'idle'
  return markOfDisplay(glyph.kind === 'agent' ? glyph.display : glyph.status)
}

/** Whether a worktree belongs in the Needs you view, its tab count and the rail badge. */
export function needsYou(worktree: WorktreeControl, mark: ActivityMarkState, checks: ChecksState | null): boolean {
  return mark === 'waiting' || mark === 'error' || worktree.unread || checks === 'failure'
}

const attentionOf = (mark: ActivityMarkState): Attention => (mark === 'error' ? 'error' : mark === 'waiting' ? 'waiting' : 'none')
const worse = (a: Attention, b: Attention): Attention => (a === 'error' || b === 'error' ? 'error' : a === 'waiting' || b === 'waiting' ? 'waiting' : 'none')

function sortWorktrees(
  worktrees: readonly WorktreeControl[],
  groupBy: GroupBy,
  sortBy: SortBy,
  repoNames: ReadonlyMap<string, string>,
  waitingIds: ReadonlySet<string>
): WorktreeControl[] {
  const recentAt = (worktree: WorktreeControl) => Math.max(worktree.lastActivityAt, worktree.createdAt + CREATE_GRACE_MS)
  return [...worktrees].sort((left, right) => {
    if (!(groupBy === 'none' && sortBy === 'name') && left.isMain !== right.isMain) return left.isMain ? -1 : 1
    if (sortBy === 'name') return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    if (sortBy === 'project') {
      const project = (repoNames.get(left.repoId) ?? left.repoId).localeCompare(repoNames.get(right.repoId) ?? right.repoId)
      if (project !== 0) return project
    }
    if (sortBy === 'recent' || sortBy === 'agent-activity' || sortBy === 'project') {
      if (sortBy === 'agent-activity') {
        const waiting = Number(waitingIds.has(right.id)) - Number(waitingIds.has(left.id))
        if (waiting !== 0) return waiting
      }
      return recentAt(right) - recentAt(left) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    }
    return right.manualOrder - left.manualOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  })
}

function makeGroup(key: string, kind: ViewGroup['kind'], title: string, rows: ViewRow[]): ViewGroup {
  let attention: Attention = 'none'
  let attentionCount = 0
  for (const row of rows) {
    const own = attentionOf(row.mark)
    if (own !== 'none') attentionCount++
    attention = worse(attention, own)
  }
  return { key, kind, title, attention, attentionCount, rows }
}

/**
 * The sidebar's tree for one view: filtered, sorted and grouped, with attention folded into
 * parents and groups. Pure, and tolerant of stale ids so it never throws.
 */
export function buildTree(input: BuildTreeInput): ViewTree {
  const { worktrees, repos, groups, tags, projection, marks, checks } = input
  const needsYouView = input.viewId === 'needs-you'
  const markOf = (worktree: WorktreeControl): ActivityMarkState => marks.get(worktree.id) ?? (worktree.sleeping ? 'asleep' : 'idle')
  const needs = (worktree: WorktreeControl) => needsYou(worktree, markOf(worktree), checks.get(worktree.id) ?? null)

  let needsYouCount = 0
  let erroredCount = 0
  for (const worktree of worktrees) {
    if (!needs(worktree)) continue
    needsYouCount++
    if (markOf(worktree) === 'error') erroredCount++
  }

  const filter = input.spec.filter
  const display = needsYouView
    ? { ...input.spec.display, groupBy: 'section-project' as const, showAsleep: true }
    : input.spec.display

  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  const repoLabelOf = (repoId: string) => {
    const repo = reposById.get(repoId)
    return repo ? repo.displayName ?? repo.name : repoId
  }
  const known = new Map(groups.map((group) => [group.id, group]))
  const sections = [...groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const sectionOfRepo = (repo: Repo): string | null => {
    if (repo.groupId !== null && known.has(repo.groupId)) return repo.groupId
    if (repo.groupId !== null) return null
    return sections.find((group) => group.repoIds.includes(repo.id))?.id ?? null
  }
  const looseSectionOf = (worktree: WorktreeControl): string | null =>
    worktree.kind === 'git' && worktree.projectGroupId !== null && known.has(worktree.projectGroupId) ? worktree.projectGroupId : null
  const folderSectionOf = (worktree: WorktreeControl): string | null => {
    if (!worktree.repoId.startsWith('group:')) return null
    const id = worktree.repoId.slice('group:'.length)
    return known.has(id) ? id : null
  }
  const sectionOf = (worktree: WorktreeControl): string | null => {
    const direct = looseSectionOf(worktree) ?? folderSectionOf(worktree)
    if (direct !== null) return direct
    const repo = reposById.get(worktree.repoId)
    return repo ? sectionOfRepo(repo) : null
  }

  const waitingIds = new Set<string>(
    input.sessions
      ? input.sessions.filter((session) => session.status === 'waiting').map((session) => session.worktreeId)
      : worktrees.filter((worktree) => markOf(worktree) === 'waiting').map((worktree) => worktree.id)
  )
  const repoNames = new Map(repos.map((repo) => [repo.id, repo.displayName ?? repo.name]))
  const sorted = sortWorktrees(worktrees, display.groupBy, display.sortBy, repoNames, waitingIds)

  const knownTagIds = new Set(tags.map((tag) => tag.id))
  const tagFilter = filter.tagIds.filter((id) => knownTagIds.has(id))
  const sectionFilter = filter.sectionIds.filter((id) => known.has(id))
  const statusFilter = filter.statuses
  const alwaysShowPrimary = filter.activity.alwaysShowDefaultBranchWorkspace
  const visible = projection ? new Set(projection.visibleIds) : null
  const automationHidden = new Set(projection?.automationHiddenIds ?? [])
  const reviewHidden = new Set(projection?.reviewHiddenIds ?? [])
  const reviewReasons = new Map((projection?.workspaces ?? []).map((entry) => [entry.worktreeId, entry.reviewReason]))
  const otherClients = input.otherClients

  const filterReason = (worktree: WorktreeControl): HiddenReason | null => {
    if (worktree.externalVisible === false) return 'external'
    if (filter.repoIds.length > 0 && !filter.repoIds.includes(worktree.repoId)) return 'other project'
    if (filter.hideCliCreated && worktree.createdBy === 'cli') return 'CLI-created'
    if (filter.hideOtherDesktopClients && otherClients?.authenticated && otherClients.byWorktree.get(worktree.id) === true) return 'other desktop client'
    if (filter.hideDefaultBranch && worktree.isMain) return 'default branch'
    if (filter.hideDetachedHead && worktree.kind === 'git' && !worktree.isMain && worktree.branch === null) return 'detached HEAD'
    if (filter.hideArchived && worktree.archivedAt !== null) return 'archived'
    if (tagFilter.length > 0 && !(worktree.tagIds ?? []).some((id) => tagFilter.includes(id))) return 'no matching tag'
    if (sectionFilter.length > 0) {
      const section = sectionOf(worktree)
      if (section === null || !sectionFilter.includes(section)) return 'other section'
    }
    if (statusFilter.length > 0 && !statusFilter.includes(worktree.status)) return 'other status'
    return null
  }
  const hiddenReason = (worktree: WorktreeControl): HiddenReason | null => {
    if (!input.reveal?.filtered) {
      const reason = filterReason(worktree)
      if (reason !== null) return reason
    }
    if (worktree.sleeping && !display.showAsleep && !input.reveal?.asleep && !(worktree.isMain && alwaysShowPrimary)) return 'asleep'
    if (visible !== null && !visible.has(worktree.id)) {
      if (automationHidden.has(worktree.id)) return 'automation-created'
      if (reviewHidden.has(worktree.id)) {
        const review = reviewReasons.get(worktree.id)
        if (review === 'completed') return 'completed review'
        if (review === 'passing') return 'passing checks'
      }
      return 'inactive'
    }
    return null
  }

  const candidates: WorktreeControl[] = []
  const hiddenReasons = new Set<HiddenReason>()
  let hiddenCount = 0
  for (const worktree of sorted) {
    if (needsYouView) {
      if (needs(worktree)) candidates.push(worktree)
      continue
    }
    const reason = hiddenReason(worktree)
    if (reason === null) {
      candidates.push(worktree)
    } else {
      hiddenCount++
      hiddenReasons.add(reason)
    }
  }
  const hidden = { count: hiddenCount, reasons: HIDDEN_REASON_ORDER.filter((reason) => hiddenReasons.has(reason)) }

  const nested = display.showNested && display.groupBy !== 'none'
  const arrange = (items: readonly WorktreeControl[], label?: (worktree: WorktreeControl) => string | undefined): ViewRow[] => {
    const row = (worktree: WorktreeControl, depth: number): ViewRow => {
      const from = label?.(worktree)
      return { worktree, depth, mark: markOf(worktree), childCount: 0, childAttention: 'none', ...(from === undefined ? {} : { inSectionFromProject: from }) }
    }
    if (!nested) return items.map((worktree) => row(worktree, 0))
    const byId = new Map(items.map((worktree) => [worktree.id, worktree]))
    const children = new Map<string, WorktreeControl[]>()
    const roots: WorktreeControl[] = []
    for (const worktree of items) {
      const parent = worktree.parentId === null ? undefined : byId.get(worktree.parentId)
      if (parent && parent.id !== worktree.id) children.set(parent.id, [...(children.get(parent.id) ?? []), worktree])
      else roots.push(worktree)
    }
    const ordered = [...roots.filter((worktree) => worktree.isMain), ...roots.filter((worktree) => !worktree.isMain)]
    const rows: ViewRow[] = []
    const seen = new Set<string>()
    const visit = (worktree: WorktreeControl, depth: number): Attention => {
      seen.add(worktree.id)
      const own = row(worktree, depth)
      rows.push(own)
      let below: Attention = 'none'
      for (const child of children.get(worktree.id) ?? []) {
        if (seen.has(child.id)) continue
        own.childCount++
        below = worse(below, worse(attentionOf(markOf(child)), visit(child, depth + 1)))
      }
      own.childAttention = below
      return below
    }
    for (const root of ordered) visit(root, 0)
    // a parent cycle has no root; its members still show
    for (const worktree of items) if (!seen.has(worktree.id)) visit(worktree, 0)
    return rows
  }

  const pinned = candidates.filter((worktree) => worktree.pinned)
  const rest = candidates.filter((worktree) => !worktree.pinned)
  const result: ViewGroup[] = []
  const looseLabel = (worktree: WorktreeControl) => (looseSectionOf(worktree) === null ? undefined : repoLabelOf(worktree.repoId))
  if (pinned.length > 0) result.push(makeGroup('pinned', 'pinned', 'Pinned', arrange(pinned, looseLabel)))

  const activityByRepo = new Map<string, number>()
  for (const worktree of worktrees) {
    const at = Math.max(worktree.lastActivityAt, worktree.createdAt + CREATE_GRACE_MS)
    activityByRepo.set(worktree.repoId, Math.max(activityByRepo.get(worktree.repoId) ?? 0, at))
  }
  const manualIndex = new Map((input.projectOrder ?? []).map((id, index) => [id, index]))
  const projectKeys = [...new Set([...repos.map((repo) => repo.id), ...worktrees.map((worktree) => worktree.repoId)])]
  const orderedProjectKeys = projectKeys.sort((left, right) => {
    const byLabel = () => repoLabelOf(left).localeCompare(repoLabelOf(right)) || left.localeCompare(right)
    if (display.projectOrder === 'recent') return (activityByRepo.get(right) ?? 0) - (activityByRepo.get(left) ?? 0) || byLabel()
    return (manualIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (manualIndex.get(right) ?? Number.MAX_SAFE_INTEGER) || byLabel()
  })
  const projectTitle = (key: string) => {
    if (reposById.has(key)) return repoLabelOf(key)
    const section = key.startsWith('group:') ? known.get(key.slice('group:'.length)) : undefined
    return section ? section.name : key
  }
  const byProject = (items: readonly WorktreeControl[]) => {
    const rows = new Map<string, WorktreeControl[]>()
    for (const worktree of items) rows.set(worktree.repoId, [...(rows.get(worktree.repoId) ?? []), worktree])
    return rows
  }

  switch (display.groupBy) {
    case 'section-project': {
      const sectionRows = new Map<string, WorktreeControl[]>()
      const projectRows = new Map<string, WorktreeControl[]>()
      for (const worktree of rest) {
        const section = looseSectionOf(worktree) ?? folderSectionOf(worktree)
        const target = section === null ? projectRows : sectionRows
        const key = section ?? worktree.repoId
        target.set(key, [...(target.get(key) ?? []), worktree])
      }
      const assigned = new Set<string>()
      for (const worktree of worktrees) {
        const section = sectionOf(worktree)
        if (section !== null) assigned.add(section)
      }
      for (const repo of repos) {
        const section = sectionOfRepo(repo)
        if (section !== null) assigned.add(section)
      }
      const unfiltered = !needsYouView && tagFilter.length === 0 && sectionFilter.length === 0 && statusFilter.length === 0 && filter.repoIds.length === 0
      const memberOf = (key: string) => {
        const repo = reposById.get(key)
        return repo ? sectionOfRepo(repo) : null
      }
      const projectGroup = (key: string) => {
        const items = projectRows.get(key) ?? []
        if (items.length > 0) result.push(makeGroup(`project:${key}`, 'project', projectTitle(key), arrange(items)))
      }
      for (const section of sections) {
        const items = sectionRows.get(section.id) ?? []
        if (items.length > 0 || (unfiltered && !assigned.has(section.id))) {
          result.push(makeGroup(`section:${section.id}`, 'section', section.name, arrange(items, looseLabel)))
        }
        for (const key of orderedProjectKeys) if (memberOf(key) === section.id) projectGroup(key)
      }
      for (const key of orderedProjectKeys) if (memberOf(key) === null) projectGroup(key)
      break
    }
    case 'project': {
      const rows = byProject(rest)
      for (const key of orderedProjectKeys) {
        const items = rows.get(key) ?? []
        if (items.length > 0) result.push(makeGroup(`project:${key}`, 'project', projectTitle(key), arrange(items)))
      }
      break
    }
    case 'status':
    case 'pull-request': {
      const byId = new Map(rest.map((worktree) => [worktree.id, worktree]))
      const rootOf = (worktree: WorktreeControl): WorktreeControl => {
        if (!nested) return worktree
        let current = worktree
        const seen = new Set([current.id])
        while (current.parentId !== null && byId.has(current.parentId) && !seen.has(current.parentId)) {
          seen.add(current.parentId)
          current = byId.get(current.parentId)!
        }
        return current
      }
      const statuses = input.statuses ?? DEFAULT_STATUSES
      const lanes = new Map<string, { title: string; items: WorktreeControl[] }>()
      for (const worktree of rest) {
        const root = rootOf(worktree)
        let key: string
        let title: string
        if (display.groupBy === 'status') {
          key = `status:${root.status}`
          title = statuses.find((status) => status.id === root.status)?.label ?? root.status
        } else if (root.linkedPR) {
          key = `pr:${root.linkedPR.number}:${root.linkedPR.url}`
          title = `PR #${root.linkedPR.number} · ${root.linkedPR.title}`
        } else {
          key = 'pr:none'
          title = 'No pull request'
        }
        const lane = lanes.get(key) ?? { title, items: [] }
        lane.items.push(worktree)
        lanes.set(key, lane)
      }
      let keys = [...lanes.keys()]
      if (display.groupBy === 'status') {
        const position = (key: string) => {
          const index = statuses.findIndex((status) => `status:${status.id}` === key)
          return index < 0 ? Number.MAX_SAFE_INTEGER : index
        }
        keys = keys.sort((a, b) => position(a) - position(b))
      } else {
        keys = [...keys.filter((key) => key !== 'pr:none'), ...keys.filter((key) => key === 'pr:none')]
      }
      for (const key of keys) {
        const lane = lanes.get(key)!
        result.push(makeGroup(key, display.groupBy === 'status' ? 'status' : 'pr', lane.title, arrange(lane.items)))
      }
      break
    }
    case 'tag': {
      const untagged: WorktreeControl[] = []
      const byTag = new Map<string, WorktreeControl[]>()
      for (const worktree of rest) {
        const own = (worktree.tagIds ?? []).filter((id) => knownTagIds.has(id))
        if (own.length === 0) untagged.push(worktree)
        for (const id of new Set(own)) byTag.set(id, [...(byTag.get(id) ?? []), worktree])
      }
      for (const tag of tags) {
        const items = byTag.get(tag.id) ?? []
        if (items.length > 0) result.push(makeGroup(`tag:${tag.id}`, 'tag', tag.name, arrange(items)))
      }
      if (untagged.length > 0) result.push(makeGroup('untagged', 'untagged', 'Untagged', arrange(untagged)))
      break
    }
    case 'none': {
      if (rest.length > 0) result.push(makeGroup('flat', 'flat', 'Worktrees', arrange(rest)))
      break
    }
  }

  return { groups: result, hidden, needsYouCount, erroredCount }
}
