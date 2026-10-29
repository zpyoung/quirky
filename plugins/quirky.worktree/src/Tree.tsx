import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { ProjectGroup, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { Badge, Button, ContextMenu, IconButton, ListRow, SectionHeader, StatusDot as UiStatusDot, type ContextMenuItem, type UiStatus } from '@quirky/ui'
import { DEFAULT_STOCK_OPTIONS, type StockWorktreeOptions, type WorktreeControl } from './control-types'
import type { HeimdallWorktreeStatus } from './useTree'
import { resolveMembershipTarget, type MembershipTarget } from './membership'
import { changeGroup, copyText, currentWindowId, setWorkspaceSleeping, setWorktree } from './actions'
import { groupMenu, projectMenu, workspaceMenu } from './Menu'
import { projectSeparatorBoundaries, repoLabel, type AutomationAvailabilitySnapshot, type DialogState, type GroupNode, type ProjectNode, type TreeModel, type TreeRow } from './report'
import type { WorktreeProjectIdentity, WorktreeStatusDefinition } from './parity-types'
import { semanticStatus, UnreadBell } from './StatusDot'
import { worktreeGlyph, type WorktreeGlyph } from './status'
import { OrchestrationRows, type OrchestrationWorkerRow } from './OrchestrationRows'
import { useOrchestrationRows } from './useOrchestrationRows'
import { useWorktreeAttention } from './useWorktreeAttention'
import { LoopGlyph } from './LoopGlyph'
import type { LoopProjection } from './loop-status'

export type TreeProps = {
  context: UiPluginContext
  model: TreeModel
  groups: ProjectGroup[]
  sessions: Session[] | null
  selectedId: string | null
  automationExpandedId: string | null
  automationAvailability: AutomationAvailabilitySnapshot | null
  onToggleAutomationDetails(worktreeId: string): void
  /** The clock agent glyphs are judged stale against. */
  now: number
  separatorEnabled: boolean
  options?: StockWorktreeOptions
  statusDefinitions: WorktreeStatusDefinition[]
  projectIdentities: Record<string, WorktreeProjectIdentity>
  allWorktrees?: WorktreeControl[]
  onReorder?(worktrees: string[]): void
  openDialog(dialog: DialogState): void
  /** Starts a delete of `worktree`, with the workspaces nested below it when `descendants` is above 0. */
  requestDelete(worktree: Worktree, descendants: number): void
  onDropPreviewChange(target: MembershipTarget | null): void
  onSeparatorStateChange(state: { enabled: boolean; eligibleBoundaries: string[] }): void
  loopsByWorktree?: ReadonlyMap<string, LoopProjection>
}

type OpenMenu = { x: number; y: number; label: string; items: ContextMenuItem[] }

const plural = (count: number) => `${count} ${count === 1 ? 'child' : 'children'}`
const EMPTY_LOOP_PROJECTIONS: ReadonlyMap<string, LoopProjection> = new Map()
const ACTIVITY_LABELS: Record<string, string> = {
  waiting: 'Needs you',
  permission: 'Permission needed',
  blocked: 'Blocked',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unverifiable: 'Activity unverifiable',
  unconfirmed: 'Unconfirmed',
  monitoring: 'Monitoring',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
  running: 'Running',
  exited: 'Exited'
}

function isHeimdallWorktreeStatus(value: unknown): value is HeimdallWorktreeStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Record<string, unknown>
  return typeof status.watcherId === 'string' && typeof status.watcherName === 'string' &&
    typeof status.state === 'string' && (status.ownerContact === 'live' || status.ownerContact === 'unverifiable') &&
    typeof status.observedAtMs === 'number' &&
    (status.detail === undefined || typeof status.detail === 'string') &&
    (status.consecutiveErrors === undefined || typeof status.consecutiveErrors === 'number')
}

function heimdallStatusOf(worktree: Worktree): HeimdallWorktreeStatus | null {
  if (!('heimdallStatus' in worktree)) return null
  return isHeimdallWorktreeStatus(worktree.heimdallStatus) ? worktree.heimdallStatus : null
}

function HeimdallGlyph({ status, now }: { status: HeimdallWorktreeStatus; now: number }) {
  let label = status.state
  let dotStatus: UiStatus = 'idle'
  if (status.ownerContact === 'unverifiable') {
    const ageSeconds = Math.max(0, Math.floor((now - status.observedAtMs) / 1_000))
    label = `Host unreachable · last confirmed ${ageSeconds}s ago`
    dotStatus = 'needs-you'
  } else if (status.state === 'escalated' || status.state === 'parked') {
    dotStatus = 'needs-you'
  } else if (status.state === 'held' && (status.reason === 'tick-error' || (status.consecutiveErrors ?? 0) > 0)) {
    label = 'Error · retrying'
    dotStatus = 'needs-you'
  } else if (status.state === 'held') {
    label = status.reason ? `Held · ${status.reason}` : 'Held'
    dotStatus = 'needs-you'
  } else if (status.state === 'acting' || status.state === 'watching') {
    dotStatus = 'working'
  } else if (status.state === 'unreachable' || status.state === 'malformed') {
    dotStatus = 'failing'
  }
  const title = [`${status.watcherName}: ${label}`, status.reason, status.detail].filter(Boolean).join(' · ')
  return (
    <span title={title}>
      <UiStatusDot status={dotStatus} label={`Heimdall ${label}`} />
    </span>
  )
}

function sameGlyph(candidate: WorktreeGlyph | null, expected: WorktreeGlyph): boolean {
  if (!candidate || candidate.kind !== expected.kind) return false
  if (candidate.kind === 'agent' && expected.kind === 'agent') {
    return candidate.display === expected.display && candidate.label === expected.label && candidate.percent === expected.percent
  }
  return candidate.kind === 'coarse' && expected.kind === 'coarse' && candidate.status === expected.status
}


function activityFor(sessions: Session[] | null, worktreeId: string, now: number, glyph: WorktreeGlyph | null): string {
  if (sessions === null) return 'Activity unavailable'
  if (!glyph) return 'Idle'
  const session = sessions.find((item) =>
    item.worktreeId === worktreeId && sameGlyph(worktreeGlyph([item], worktreeId, now), glyph)
  )
  const activity = glyph.kind === 'agent'
    ? glyph.label.trim() || (ACTIVITY_LABELS[glyph.display] ?? glyph.display)
    : ACTIVITY_LABELS[glyph.status] ?? glyph.status
  if (!session) return activity
  return [session.agent, session.kind, session.title.trim() || null, activity].filter(Boolean).join(' · ')
}

type CardProps = {
  context: UiPluginContext
  worktree: Worktree
  depth: number
  childCount: number
  collapsed: boolean
  sessions: Session[] | null
  pendingAskCount: number | null
  orchestrationWorkers: readonly OrchestrationWorkerRow[]
  loop?: LoopProjection
  now: number
  selected: boolean
  repoName?: string
  options: StockWorktreeOptions
  statusDefinitions: WorktreeStatusDefinition[]
  automationExpanded: boolean
  automationAvailability: AutomationAvailabilitySnapshot | null
  onToggle(): void
  onToggleAutomationDetails(): void
  onMenu(worktree: Worktree, x: number, y: number): void
  onDragStart(worktree: Worktree, event: DragEvent<HTMLLIElement>): void
  onDragEnd(): void
}

function WorktreeCard({
  context,
  worktree,
  depth,
  childCount,
  collapsed,
  sessions,
  pendingAskCount,
  orchestrationWorkers,
  loop,
  now,
  selected,
  repoName,
  options,
  statusDefinitions,
  automationExpanded,
  automationAvailability,
  onToggle,
  onToggleAutomationDetails,
  onMenu,
  onDragStart,
  onDragEnd
}: CardProps) {
  const sleeping = 'sleeping' in worktree && worktree.sleeping === true
  const needsYou = pendingAskCount !== null && pendingAskCount > 0
  const attentionLabel = needsYou ? `${pendingAskCount} pending ${pendingAskCount === 1 ? 'question' : 'questions'}` : ''
  const glyph = sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)
  const archivedAt = 'archivedAt' in worktree ? (worktree as Worktree & { archivedAt: number | null }).archivedAt : null
  const activity = worktree.removing
    ? 'Deleting…'
    : glyph
      ? activityFor(sessions, worktree.id, now, glyph)
      : sleeping
        ? 'Sleeping'
        : archivedAt !== null
          ? 'Archived'
          : sessions === null
            ? 'Activity unavailable'
            : 'Idle'
  const rowStatus: UiStatus | undefined = needsYou
    ? 'needs-you'
    : options.showProperties.includes('activity')
      ? worktree.removing
        ? 'queued'
        : glyph
          ? semanticStatus(glyph.kind === 'agent' ? glyph.display : glyph.status)
          : sessions === null
            ? 'queued'
            : 'idle'
      : undefined
  const progress = !needsYou && options.showProperties.includes('activity') && glyph?.kind === 'agent'
    ? glyph.percent ?? undefined
    : undefined
  const open = async () => {
    try {
      await context.call('quirky.worktree/navigate', { worktree: worktree.id })
      if (worktree.unread) void setWorktree(context, worktree.id, { unread: false })
    } catch (error) {
      context.toast('Could not open workspace', error instanceof Error ? error.message : String(error))
    }
  }
  const linkedPR = worktree.linkedPR
  const linkedIssue = worktree.linkedIssue
  const statusLabel = statusDefinitions.find((status) => status.id === worktree.status)?.label ?? worktree.status
  const description = [
    options.showProperties.includes('activity') ? activity : null,
    worktree.status !== 'in-progress' ? statusLabel : null,
    sleeping && glyph ? 'Sleeping' : null,
    archivedAt !== null && glyph ? 'Archived' : null,
    repoName,
    options.showBranch && options.showProperties.includes('branch') ? worktree.branch : null,
    options.showComment && options.showProperties.includes('notes') ? worktree.comment : null,
  ].filter(Boolean).join(' · ')
  const className = [
    'worktree',
    'ui-tree-item',
    'ui-indent',
    selected && 'selected',
    worktree.removing && 'removing',
    sleeping && 'sleeping',
    options.compact && 'compact'
  ].filter(Boolean).join(' ')
  const heimdall = heimdallStatusOf(worktree)
  const provenance = worktree.automationProvenance?.kind === 'created-by-automation'
    ? worktree.automationProvenance
    : null
  const currentAutomationAvailability = automationAvailability
  const availability = provenance !== null &&
    currentAutomationAvailability?.worktreeId === worktree.id &&
    currentAutomationAvailability.automationId === provenance.automationId &&
    currentAutomationAvailability.runId === provenance.runId
      ? currentAutomationAvailability
      : null
  const definitionStatus = availability?.definition ?? 'checking'
  const runHistoryStatus = availability?.runHistory ?? 'checking'
  const openAutomation = () => {
    if (!provenance) return
    void context.call('quirky.automations/uiNavigate', {
      page: 'detail',
      automationId: provenance.automationId
    }).catch((error: unknown) => {
      context.toast('Could not open automation', error instanceof Error ? error.message : String(error))
    })
  }
  const openRun = () => {
    if (!provenance) return
    void context.call('quirky.automations/uiNavigate', {
      page: 'run',
      automationId: provenance.automationId,
      runId: provenance.runId
    }).catch((error: unknown) => {
      context.toast('Could not open automation run', error instanceof Error ? error.message : String(error))
    })
  }
  return (
    <li
      className={className}
      data-worktree-id={worktree.id}
      data-parent-id={worktree.parentId ?? ''}
      data-project-group-id={worktree.projectGroupId ?? ''}
      style={{ '--depth': depth } as CSSProperties}
      draggable={worktree.kind === 'git'}
      onDragStart={(event) => onDragStart(worktree, event)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(worktree, event.clientX, event.clientY)
      }}
    >
      <ListRow
        title={
          <span className="ui-cluster">
            {worktree.unread ? <UnreadBell /> : loop ? <LoopGlyph label={loop.label} /> : null}
            <span className={`${worktree.unread ? 'worktree-name worktree-name-unread' : 'worktree-name'} ui-text-ellipsis`} title={worktree.name}>{worktree.name}</span>
            {heimdall && <HeimdallGlyph status={heimdall} now={now} />}
          </span>
        }
        description={description ? <span className="ui-text-ellipsis" title={description}>{description}</span> : undefined}
        status={rowStatus}
        progress={progress}
        selected={selected}
        compact={options.compact}
        mainTitle={worktree.path}
        mainLabel={`${sleeping ? 'Wake and open' : 'Open'} ${worktree.name}`}
        onClick={() => void open()}
        trailing={
          <span className="ui-cluster">
            {needsYou && <Badge tone="needs-you" label={attentionLabel}>{pendingAskCount}</Badge>}
            {worktree.isMain && <Badge tone="accent">Primary</Badge>}
            <IconButton
              className="worktree-menu"
              label={`Actions for ${worktree.name}`}
              aria-haspopup="menu"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect()
                onMenu(worktree, box.left, box.bottom)
              }}
            >
              ⋯
            </IconButton>
          </span>
        }
      />
      <div className="ui-cluster ui-row-details">
            {options.showProperties.includes('pullRequest') && linkedPR && (
              <a
                href={linkedPR.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Pull request #${linkedPR.number}: ${linkedPR.title}`}
              >
                <Badge tone="accent">PR #{linkedPR.number}</Badge>
              </a>
            )}
            {options.showProperties.includes('issue') && linkedIssue && (
              <a
                href={linkedIssue.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Issue #${linkedIssue.number}: ${linkedIssue.title}`}
              >
                <Badge tone="accent">Issue #{linkedIssue.number}</Badge>
              </a>
            )}
            {options.showProperties.includes('automation') && provenance && (
              <Badge tone="accent">Created by automation</Badge>
            )}
            {options.showProperties.includes('automation') && provenance && (
              <Button
                aria-label={`Automation details for ${worktree.id}`}
                aria-expanded={automationExpanded}
                onClick={onToggleAutomationDetails}
              >
                Automation details
              </Button>
            )}
            {childCount > 0 && (
              <Button className="ui-disclosure" aria-expanded={!collapsed} onClick={onToggle}>
                {plural(childCount)}
              </Button>
            )}
      </div>
      {options.showProperties.includes('automation') && provenance && automationExpanded && (
        <section className="automation-detail ui-stack ui-panel-content" role="group" aria-label="Automation details">
          <SectionHeader title="Automation" />
          <p><strong>Automation name:</strong> {provenance.automationName}</p>
          <p><strong>Run:</strong> {provenance.runTitle}</p>
          {(definitionStatus === 'checking' || runHistoryStatus === 'checking') && (
            <p className="ui-text-muted" role="status">Checking automation availability...</p>
          )}
          {definitionStatus === 'available' && <p className="ui-text-muted" role="status">Automation available.</p>}
          {runHistoryStatus === 'available' && <p className="ui-text-muted" role="status">Run history available.</p>}
          {definitionStatus === 'missing' && <p className="ui-text-muted" role="status">Automation no longer available.</p>}
          {runHistoryStatus === 'missing' && <p className="ui-text-muted" role="status">Run history no longer available.</p>}
          {(definitionStatus === 'error' || runHistoryStatus === 'error') && (
            <p className="ui-text-muted" role="status">Automation availability could not be checked.</p>
          )}
          {(definitionStatus === 'unavailable' || runHistoryStatus === 'unavailable') && (
            <p className="ui-text-muted" role="status">Automations plugin unavailable.</p>
          )}
          <div className="ui-actions">
            <Button onClick={openAutomation} disabled={definitionStatus !== 'available'}>Open automation</Button>
            <Button onClick={openRun} disabled={runHistoryStatus !== 'available'}>Open run</Button>
          </div>
        </section>
      )}
      <OrchestrationRows context={context} workers={orchestrationWorkers} sessions={sessions} worktreeId={worktree.id} />
    </li>
  )
}


function PendingCard({ name }: { name: string }) {
  return (
    <li className="worktree pending ui-tree-item ui-indent">
      <ListRow title={name} description="Creating…" status="queued" />
    </li>
  )
}

/** The workspace tree the sidebar section draws: Pinned, then groups, then ungrouped projects. */
export function Tree({
  context,
  model,
  groups,
  sessions,
  selectedId,
  automationExpandedId,
  automationAvailability,
  onToggleAutomationDetails,
  now,
  separatorEnabled,
  options = DEFAULT_STOCK_OPTIONS,
  statusDefinitions,
  projectIdentities,
  allWorktrees = [],
  onReorder = () => {},
  openDialog,
  requestDelete,
  onDropPreviewChange,
  onSeparatorStateChange,
  loopsByWorktree = EMPTY_LOOP_PROJECTIONS
}: TreeProps) {
  const orchestrationWorkers = useOrchestrationRows(context)
  const pendingAsksByWorktree = useWorktreeAttention(context)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [dropPreview, setDropPreview] = useState<MembershipTarget | null>(null)
  const [stickySections, setStickySections] = useState<ReadonlySet<string>>(new Set())
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const treeRoot = useRef<HTMLDivElement>(null)
  const draggedWorktree = useRef<Worktree | null>(null)
  const previewRef = useRef<MembershipTarget | null>(null)
  const allGroupNodes = useMemo(() => {
    const result: GroupNode[] = []
    const visit = (nodes: GroupNode[]) => {
      for (const node of nodes) {
        result.push(node)
        visit(node.children)
      }
    }
    visit(model.groups)
    return result
  }, [model])
  const allProjects = useMemo(() => [
    ...model.projects,
    ...allGroupNodes.flatMap((node) => node.projects)
  ], [allGroupNodes, model])
  const repoById = useMemo(() => new Map(allProjects.map((project) => [project.repo.id, project.repo])), [allProjects])
  const descendantsOf = new Map<string, number>()
  for (const node of allGroupNodes) {
    for (const row of [...node.rows, ...node.looseRows, ...node.projects.flatMap((project) => project.rows)]) {
      descendantsOf.set(row.worktree.id, row.descendants.length)
    }
  }
  for (const project of model.projects) {
    for (const row of project.rows) descendantsOf.set(row.worktree.id, row.descendants.length)
  }

  const topSections = useMemo(() => [
    ...(model.pinned.length > 0 ? [{ key: 'pinned' }] : []),
    ...model.groups.map((node) => ({ key: `group:${node.group.id}` })),
    ...model.projects.map((node) => ({ key: `repo:${node.repo.id}` }))
  ], [model])
  const eligibleBoundaries = useMemo(
    () => projectSeparatorBoundaries(topSections.map((section) => section.key), stickySections, separatorEnabled),
    [separatorEnabled, stickySections, topSections]
  )

  useLayoutEffect(() => {
    const root = treeRoot.current
    const next = new Set<string>()
    if (root) {
      for (const section of root.querySelectorAll<HTMLElement>('[data-top-level-section]')) {
        const key = section.dataset.topLevelSection
        const header = section.querySelector<HTMLElement>(':scope > header')
        if (key && header && globalThis.getComputedStyle(header).position === 'sticky') next.add(key)
      }
    }
    setStickySections((previous) => {
      if (previous.size === next.size && [...previous].every((key) => next.has(key))) return previous
      return next
    })
  }, [model, separatorEnabled])

  useEffect(() => {
    onSeparatorStateChange({ enabled: separatorEnabled, eligibleBoundaries })
  }, [eligibleBoundaries, onSeparatorStateChange, separatorEnabled])

  const toggleFold = (id: string) => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const updatePreview = (target: MembershipTarget | null) => {
    const previous = previewRef.current
    if (previous?.kind === target?.kind && previous?.id === target?.id) return
    previewRef.current = target
    setDropPreview(target)
    onDropPreviewChange(target)
  }
  useEffect(() => {
    if (options.groupBy === 'project' || previewRef.current === null) return
    previewRef.current = null
    setDropPreview(null)
    onDropPreviewChange(null)
  }, [onDropPreviewChange, options.groupBy])

  const resolveAt = (clientX: number, clientY: number, worktree: Worktree): MembershipTarget | null => {
    const root = treeRoot.current
    if (!root || options.groupBy !== 'project' || worktree.kind !== 'git' || repoById.get(worktree.repoId)?.kind !== 'git') return null
    const groupHeaders = [...root.querySelectorAll<HTMLElement>('[data-group-target]')].map((header) => {
      const bounds = header.getBoundingClientRect()
      return { id: header.dataset.groupTarget!, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    })
    const repoHeaders = [...root.querySelectorAll<HTMLElement>('[data-repo-target]')].map((header) => {
      const bounds = header.getBoundingClientRect()
      return { id: header.dataset.repoTarget!, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    })
    const target = resolveMembershipTarget(clientX, clientY, groupHeaders, repoHeaders, worktree.repoId)
    if (target?.kind === 'group' && target.id === worktree.projectGroupId) return null
    if (target?.kind === 'repo' && worktree.projectGroupId === null) return null
    return target
  }

  const changeMembership = async (worktree: Worktree, group: ProjectGroup | null) => {
    const groupId = group?.id ?? null
    if (worktree.kind !== 'git' || repoById.get(worktree.repoId)?.kind !== 'git' || groupId === worktree.projectGroupId) return
    const changed = await changeGroup(context, 'Could not change worktree group', () =>
      context.call('quirky.worktree/set', {
        worktree: worktree.id,
        projectGroupId: groupId,
        expectedInstanceId: worktree.instanceId,
        expectedProjectGroupId: worktree.projectGroupId
      })
    )
    if (changed && draggedWorktree.current?.id === worktree.id) {
      draggedWorktree.current = { ...draggedWorktree.current, projectGroupId: groupId }
    }
  }

  const moveProject = (repo: Repo, group: ProjectGroup | null) => {
    if ((group?.id ?? null) === repo.groupId) return
    void changeGroup(context, 'Could not move project', () =>
      group
        ? context.call('quirky.repo/groupAdd', { group: group.id, repo: repo.id })
        : context.call('quirky.repo/groupRemove', { group: repo.groupId, repo: repo.id })
    )
  }

  const openWorkspaceMenu = (worktree: Worktree, x: number, y: number) => {
    const repo = repoById.get(worktree.repoId)
    setMenu({
      x,
      y,
      label: `Actions for ${worktree.name}`,
      items: workspaceMenu(worktree, descendantsOf.get(worktree.id) ?? 0, groups, repo, {
        setStatus: (item, status) => void setWorktree(context, item.id, { status }),
        setPinned: (item, pinned) => void setWorktree(context, item.id, { pinned }),
        setUnread: (item, unread) => void setWorktree(context, item.id, { unread }),
        removeParent: (item) => void setWorktree(context, item.id, { noParent: true }),
        copy: (text) => void copyText(context, text),
        openDialog,
        openDeleteDialog: requestDelete,
        setMembership: changeMembership,
        moveProject,
        setSleeping: (item, sleeping, withDescendants) => void setWorkspaceSleeping(context, item.id, sleeping, withDescendants),
        openIn: (item, target) => {
          void currentWindowId(context).then((window) =>
            context.call('quirky.worktree/openIn', { worktree: item.id, target, window })
          ).catch((error: unknown) =>
            context.toast(`Could not open ${target}`, error instanceof Error ? error.message : String(error))
          )
        },
        archive: (item, archived) => {
          void context.call('quirky.worktree/archive', { worktree: item.id, archivedAt: archived ? Date.now() : null }).catch((error: unknown) =>
            context.toast(`Could not ${archived ? 'archive' : 'unarchive'} workspace`, error instanceof Error ? error.message : String(error))
          )
        }
      }, statusDefinitions)
      })
  }

  const openProjectMenu = (repo: Repo, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: `Actions for ${repoLabel(repo)}`,
      items: projectMenu(repo, groups, {
        openDialog,
        openLedger: () => context.openView('view:quirky.ledger/ledger', { target: { owner: { tier: 'project', id: repo.id } } }),
        moveToGroup: moveProject
      })
    })

  const openGroupMenu = (group: ProjectGroup, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: `Actions for group ${group.name}`,
      items: groupMenu(group, openDialog, () => context.openView('view:quirky.ledger/ledger', { target: { owner: { tier: 'group', id: group.id } } }))
    })

  const rows = (list: TreeRow[]) =>
    list
      .filter((row) => !row.ancestors.some((id) => folded.has(id)))
      .map((row) => {
        const worktree = row.worktree
        const looseRepo = worktree.kind === 'git' && groups.some((group) => group.id === worktree.projectGroupId)
          ? repoById.get(worktree.repoId)
          : undefined
        const projectRepo = repoById.get(worktree.repoId)
        const repoName = row.repoName ?? (looseRepo ? repoLabel(looseRepo) : options.groupBy !== 'project' && projectRepo ? repoLabel(projectRepo) : undefined)
        return (
          <WorktreeCard
            key={worktree.id}
            context={context}
            worktree={worktree}
            depth={row.depth}
            childCount={row.childCount}
            collapsed={folded.has(worktree.id)}
            pendingAskCount={pendingAsksByWorktree === null ? null : pendingAsksByWorktree.get(worktree.id) ?? 0}
            sessions={sessions}
            orchestrationWorkers={worktree.pinned ? [] : orchestrationWorkers}
            loop={loopsByWorktree.get(worktree.id)}
            now={now}
            selected={worktree.id === selectedId}
            repoName={repoName}
            options={options}
            statusDefinitions={statusDefinitions}
            automationExpanded={automationExpandedId === worktree.id}
            automationAvailability={automationAvailability?.worktreeId === worktree.id ? automationAvailability : null}
            onToggleAutomationDetails={() => onToggleAutomationDetails(worktree.id)}
            onToggle={() => toggleFold(worktree.id)}
            onMenu={openWorkspaceMenu}
            onDragStart={(item, event) => {
              if (item.kind !== 'git') return
              draggedWorktree.current = item
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', item.id)
              updatePreview(null)
            }}
            onDragEnd={() => {
              draggedWorktree.current = null
              updatePreview(null)
            }}
          />
        )
      })
  const groupedRows = (list: TreeRow[]) => {
    if (options.groupBy !== 'status' && options.groupBy !== 'pr') return rows(list)
    const byId = new Map(list.map((row) => [row.worktree.id, row]))
    const rootById = new Map<string, string>()
    for (const row of list) {
      let current = row.worktree
      const seen = new Set([current.id])
      while (current.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
        seen.add(current.parentId)
        current = byId.get(current.parentId)!.worktree
      }
      rootById.set(row.worktree.id, current.id)
    }
    const lanes = new Map<string, { label: string; icon?: string; roots: Set<string> }>()
    for (const row of list) {
      const rootId = rootById.get(row.worktree.id)!
      if (rootId !== row.worktree.id) continue
      let key: string
      let label: string
      let icon: string | undefined
      if (options.groupBy === 'status') {
        key = `status:${row.worktree.status}`
        const definition = statusDefinitions.find((status) => status.id === row.worktree.status)
        label = definition?.label ?? row.worktree.status
        icon = definition?.icon
      } else if (row.worktree.linkedPR) {
        key = `pr:${row.worktree.linkedPR.number}:${row.worktree.linkedPR.url}`
        label = `PR #${row.worktree.linkedPR.number} · ${row.worktree.linkedPR.title}`
      } else {
        key = 'pr:none'
        label = 'No pull request'
      }
      const lane = lanes.get(key) ?? { label, ...(icon ? { icon } : {}), roots: new Set<string>() }
      lane.roots.add(rootId)
      lanes.set(key, lane)
    }
    return [...lanes].map(([key, lane]) => {
      const laneRows = list.filter((row) => lane.roots.has(rootById.get(row.worktree.id)!))
      return (
        <li className="worktree-status-lane ui-tree-item ui-stack" key={key}>
          <SectionHeader title={`${lane.icon ? `${lane.icon} ` : ''}${lane.label}`} />
          <ul className="worktree-list ui-tree">{rows(laneRows)}</ul>
        </li>
      )
    })
  }

  const project = (node: ProjectNode, topLevel = false, depth = 0) => {
    const { repo, rows: projectRows, pending: pendingCreates } = node
    const identity = projectIdentities[repo.id]
    const sectionKey = `repo:${repo.id}`
    const separator = topLevel && eligibleBoundaries.includes(sectionKey)
    const previewing = dropPreview?.kind === 'repo' && dropPreview.id === repo.id
    const className = ['repo', 'ui-stack', 'ui-indent', separator && 'ui-section-separated'].filter(Boolean).join(' ')
    return (
      <section
        className={className}
        key={repo.id}
        data-top-level-section={topLevel ? sectionKey : undefined}
        style={{ '--depth': depth } as CSSProperties}
      >
        <SectionHeader
          hidden={options.groupBy !== 'project'}
          className={`repo-header${previewing ? ' ui-drop-target--active' : ''}`}
          title={`${identity?.icon ? `${identity.icon} ` : ''}${repoLabel(repo)}`}
          titleTooltip={repo.path}
          data-repo-target={repo.id}
          onContextMenu={(event) => {
            event.preventDefault()
            openProjectMenu(repo, event.clientX, event.clientY)
          }}
          actions={
            <span className="ui-cluster repo-actions">
              {previewing && <Badge tone="accent">Drop worktree here</Badge>}
              {identity?.trackerProject && <Badge>{identity.trackerProject}</Badge>}
              <IconButton
                label={`New worktree in ${repoLabel(repo)}`}
                title="New worktree"
                onClick={() => openDialog({ kind: 'create', repoId: repo.id })}
              >
                +
              </IconButton>
              <IconButton
                className="project-menu"
                label={`Actions for ${repoLabel(repo)}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect()
                  openProjectMenu(repo, bounds.left, bounds.bottom)
                }}
              >
                ⋯
              </IconButton>
            </span>
          }
        />
        <ul className="worktree-list ui-tree">
          {groupedRows(projectRows)}
          {pendingCreates.map((create) => <PendingCard key={create.name} name={create.name} />)}
        </ul>
      </section>
    )
  }

  const groupSection = (node: GroupNode, topLevel = false, depth = 0) => {
    const { group, projects, rows: groupRows, looseRows, children } = node
    const sectionKey = `group:${group.id}`
    const separator = topLevel && eligibleBoundaries.includes(sectionKey)
    const previewing = dropPreview?.kind === 'group' && dropPreview.id === group.id
    const className = ['group', 'ui-stack', 'ui-indent', separator && 'ui-section-separated'].filter(Boolean).join(' ')
    return (
      <section
        className={className}
        key={group.id}
        data-top-level-section={topLevel ? sectionKey : undefined}
        style={{ '--depth': depth } as CSSProperties}
      >
        <SectionHeader
          className={`group-header${previewing ? ' ui-drop-target--active' : ''}`}
          title={group.name}
          data-group-target={group.id}
          onContextMenu={(event) => event.preventDefault()}
          actions={
            <span className="ui-cluster">
              {previewing && <Badge tone="accent">Drop worktree here</Badge>}
              <IconButton
                className="ui-disclosure group-toggle"
                label={`${group.collapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
                aria-expanded={!group.collapsed}
                onClick={() =>
                  void context.call('quirky.repo/groupCollapse', { group: group.id, collapsed: !group.collapsed }).catch((error: unknown) => {
                    context.toast('Could not collapse group', error instanceof Error ? error.message : String(error))
                  })
                }
              >
                {group.collapsed ? '▸' : '▾'}
              </IconButton>
              <IconButton
                className="group-menu"
                label={`Actions for group ${group.name}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect()
                  openGroupMenu(group, bounds.left, bounds.bottom)
                }}
              >
                ⋯
              </IconButton>
            </span>
          }
        />
        {!group.collapsed && (
          <>
            {groupRows.length > 0 && <ul className="worktree-list ui-tree">{groupedRows(groupRows)}</ul>}
            {projects.filter((projectNode) => projectNode.repo.kind === 'folder').map((projectNode) => project(projectNode, false, depth + 1))}
            {looseRows.length > 0 && <ul className="worktree-list ui-tree">{groupedRows(looseRows)}</ul>}
            {projects.filter((projectNode) => projectNode.repo.kind === 'git').map((projectNode) => project(projectNode, false, depth + 1))}
            {children.map((child) => groupSection(child, false, depth + 1))}
          </>
        )}
      </section>
    )
  }

  const worktreeCardAt = (target: EventTarget): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[data-worktree-id]') : null

  const reorderManual = (sourceId: string, targetId: string, below: boolean): boolean => {
    if (options.sortBy !== 'manual') return false
    const source = allWorktrees.find((worktree) => worktree.id === sourceId)
    const target = allWorktrees.find((worktree) => worktree.id === targetId)
    if (!source || !target) return false
    if (source.id === target.id) return true
    if (
      source.isMain || target.isMain ||
      source.repoId !== target.repoId ||
      source.parentId !== target.parentId ||
      source.projectGroupId !== target.projectGroupId
    ) return false
    const siblings = allWorktrees
      .filter((worktree) =>
        !worktree.isMain &&
        worktree.repoId === source.repoId &&
        worktree.parentId === source.parentId &&
        worktree.projectGroupId === source.projectGroupId
      )
      .sort((left, right) => right.manualOrder - left.manualOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    const ordered = siblings.map((worktree) => worktree.id)
    const sourceIndex = ordered.indexOf(source.id)
    const targetIndex = ordered.indexOf(target.id)
    if (sourceIndex < 0 || targetIndex < 0) return false
    ordered.splice(sourceIndex, 1)
    const nextTargetIndex = ordered.indexOf(target.id)
    ordered.splice(nextTargetIndex + (below ? 1 : 0), 0, source.id)
    onReorder(ordered)
    return true
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const worktree = draggedWorktree.current
    if (!worktree) return
    const card = worktreeCardAt(event.target)
    if (options.sortBy === 'manual' && card?.dataset.worktreeId) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      updatePreview(null)
      return
    }
    const target = resolveAt(event.clientX, event.clientY, worktree)
    if (!target) {
      updatePreview(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    updatePreview(target)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const worktree = draggedWorktree.current
    draggedWorktree.current = null
    const card = worktreeCardAt(event.target)
    if (worktree && options.sortBy === 'manual' && card?.dataset.worktreeId) {
      const bounds = card.getBoundingClientRect()
      if (reorderManual(worktree.id, card.dataset.worktreeId, event.clientY > bounds.top + bounds.height / 2)) {
        event.preventDefault()
        updatePreview(null)
        return
      }
    }
    const target = worktree ? resolveAt(event.clientX, event.clientY, worktree) : null
    if (!worktree || !target) {
      updatePreview(null)
      return
    }
    event.preventDefault()
    if (target.kind === 'group') {
      const group = groups.find((item) => item.id === target.id)
      if (group) changeMembership(worktree, group)
    } else {
      changeMembership(worktree, null)
    }
    updatePreview(null)
  }

  return (
    <div
      className="worktree-tree ui-stack"
      ref={treeRoot}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(event) => {
        if (event.relatedTarget && treeRoot.current?.contains(event.relatedTarget as Node)) return
        updatePreview(null)
      }}
      onDragEnd={() => {
        draggedWorktree.current = null
        updatePreview(null)
      }}
    >
      {model.pinned.length > 0 && (
        <section
          className={['pinned', 'ui-stack', eligibleBoundaries.includes('pinned') && 'ui-section-separated'].filter(Boolean).join(' ')}
          data-top-level-section="pinned"
        >
          <SectionHeader className="repo-header" title="Pinned" />
          <ul className="worktree-list ui-tree">
            {model.pinned.map((worktree) => {
              const repo = repoById.get(worktree.repoId)
              const repoName = worktree.kind === 'git' && groups.some((group) => group.id === worktree.projectGroupId) && repo
                ? repoLabel(repo)
                : undefined
              return (
                <WorktreeCard
                  key={worktree.id}
                  context={context}
                  worktree={worktree}
                  depth={0}
                  childCount={0}
                  collapsed={false}
                  pendingAskCount={pendingAsksByWorktree === null ? null : pendingAsksByWorktree.get(worktree.id) ?? 0}
                  sessions={sessions}
                  orchestrationWorkers={orchestrationWorkers}
                  loop={loopsByWorktree.get(worktree.id)}
                  now={now}
                  selected={worktree.id === selectedId}
                  repoName={repoName}
                  options={options}
                  statusDefinitions={statusDefinitions}
                  automationExpanded={automationExpandedId === worktree.id}
                  automationAvailability={automationAvailability?.worktreeId === worktree.id ? automationAvailability : null}
                  onToggleAutomationDetails={() => onToggleAutomationDetails(worktree.id)}
                  onToggle={() => {}}
                  onMenu={openWorkspaceMenu}
                  onDragStart={(item, event) => {
                    if (item.kind !== 'git') return
                    draggedWorktree.current = item
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item.id)
                    updatePreview(null)
                  }}
                  onDragEnd={() => {
                    draggedWorktree.current = null
                    updatePreview(null)
                  }}
                />
              )
            })}
          </ul>
        </section>
      )}
      {model.groups.map((node) => groupSection(node, true))}
      {model.projects.map((node) => project(node, true))}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
