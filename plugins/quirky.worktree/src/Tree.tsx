import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import type { ProjectGroup, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import type { HeimdallWorktreeStatus } from './useTree'
import { resolveMembershipTarget, type MembershipTarget } from './membership'
import { changeGroup, copyText, SESSION_VIEW, setWorktree } from './actions'
import { ContextMenu, groupMenu, projectMenu, STATUS_LABELS, workspaceMenu, type MenuItem } from './Menu'
import { projectSeparatorBoundaries, repoLabel, type AutomationAvailabilitySnapshot, type DialogState, type GroupNode, type ProjectNode, type TreeModel, type TreeRow } from './report'
import { StatusDot, UnreadBell } from './StatusDot'
import { worktreeGlyph } from './status'
import { OrchestrationRows, type OrchestrationWorkerRow } from './OrchestrationRows'
import { useOrchestrationRows } from './useOrchestrationRows'
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
  openDialog(dialog: DialogState): void
  /** Starts a delete of `worktree`, with the workspaces nested below it when `descendants` is above 0. */
  requestDelete(worktree: Worktree, descendants: number): void
  onDropPreviewChange(target: MembershipTarget | null): void
  onSeparatorStateChange(state: { enabled: boolean; eligibleBoundaries: string[] }): void
  loopsByWorktree?: ReadonlyMap<string, LoopProjection>
}

type OpenMenu = { x: number; y: number; label: string; items: MenuItem[] }

const plural = (count: number) => `${count} ${count === 1 ? 'child' : 'children'}`
const EMPTY_LOOP_PROJECTIONS: ReadonlyMap<string, LoopProjection> = new Map()

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
  let color = 'var(--muted)'
  if (status.ownerContact === 'unverifiable') {
    const ageSeconds = Math.max(0, Math.floor((now - status.observedAtMs) / 1_000))
    label = `Host unreachable · last confirmed ${ageSeconds}s ago`
    color = 'var(--amber)'
  } else if (status.state === 'escalated' || status.state === 'parked') {
    color = 'var(--amber)'
  } else if (status.state === 'held' && (status.reason === 'tick-error' || (status.consecutiveErrors ?? 0) > 0)) {
    label = 'Error · retrying'
    color = 'var(--amber)'
  } else if (status.state === 'held') {
    label = status.reason ? `Held · ${status.reason}` : 'Held'
    color = 'var(--amber)'
  } else if (status.state === 'acting' || status.state === 'watching') {
    color = 'var(--green)'
  } else if (status.state === 'unreachable' || status.state === 'malformed') {
    color = 'var(--danger)'
  }
  const title = [`${status.watcherName}: ${label}`, status.reason, status.detail].filter(Boolean).join(' · ')
  return (
    <span role="img" aria-label={`Heimdall ${label}`} title={title} style={{ display: 'inline-flex', color, flex: '0 0 auto', alignItems: 'center' }}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="6" cy="6" r="1.8" fill="currentColor" />
      </svg>
    </span>
  )
}

type CardProps = {
  context: UiPluginContext
  worktree: Worktree
  depth: number
  childCount: number
  collapsed: boolean
  sessions: Session[] | null
  orchestrationWorkers: readonly OrchestrationWorkerRow[]
  loop?: LoopProjection
  now: number
  selected: boolean
  repoName?: string
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
  orchestrationWorkers,
  loop,
  now,
  selected,
  repoName,
  automationExpanded,
  automationAvailability,
  onToggle,
  onToggleAutomationDetails,
  onMenu,
  onDragStart,
  onDragEnd
}: CardProps) {
  const open = () => {
    context.openView(SESSION_VIEW, { worktree: worktree.id })
    if (worktree.unread) void setWorktree(context, worktree.id, { unread: false })
  }
  const linkedWork = worktree.linkedPR ?? worktree.linkedIssue
  const className = ['worktree', selected && 'selected', worktree.removing && 'removing'].filter(Boolean).join(' ')
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
      style={{ '--depth': depth, flexWrap: 'wrap' } as CSSProperties}
      draggable={worktree.kind === 'git'}
      onDragStart={(event) => onDragStart(worktree, event)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(worktree, event.clientX, event.clientY)
      }}
    >
      <button className="worktree-main" onClick={open} title={worktree.path}>
        {worktree.unread ? <UnreadBell /> : loop ? <LoopGlyph label={loop.label} /> : <StatusDot glyph={sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)} />}
        {heimdall && <HeimdallGlyph status={heimdall} now={now} />}
        <span className={worktree.unread ? 'worktree-name worktree-name-unread' : 'worktree-name'}>{worktree.name}</span>
        {repoName && <span className="tag tag-repo">{repoName}</span>}
        {worktree.isMain && <span className="tag tag-primary">primary</span>}
        {worktree.status !== 'in-progress' && <span className="tag tag-status">{STATUS_LABELS[worktree.status]}</span>}
        {worktree.removing && <span className="tag tag-state">Deleting…</span>}
      </button>
      {linkedWork && (
        <a
          className="tag tag-github"
          href={linkedWork.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${linkedWork.kind === 'pullRequest' ? 'Pull request' : 'Issue'} #${linkedWork.number}: ${linkedWork.title}`}
        >
          {linkedWork.kind === 'pullRequest' ? 'PR' : 'Issue'} #{linkedWork.number}
        </a>
      )}
      {provenance && (
        <>
          <span className="tag tag-automation-created">Created by automation</span>
          <button
            type="button"
            className="tag tag-automation-details"
            aria-label={`Automation details for ${worktree.id}`}
            aria-expanded={automationExpanded}
            onClick={onToggleAutomationDetails}
          >
            Automation details
          </button>
          {automationExpanded && (
            <section className="automation-detail" role="group" aria-label="Automation details" style={{ flexBasis: '100%' }}>
              <h3>Automation</h3>
              <p><strong>Automation name:</strong> {provenance.automationName}</p>
              <p><strong>Run:</strong> {provenance.runTitle}</p>
              {(definitionStatus === 'checking' || runHistoryStatus === 'checking') && (
                <p role="status">Checking automation availability...</p>
              )}
              {definitionStatus === 'available' && <p role="status">Automation available.</p>}
              {runHistoryStatus === 'available' && <p role="status">Run history available.</p>}
              {definitionStatus === 'missing' && <p role="status">Automation no longer available.</p>}
              {runHistoryStatus === 'missing' && <p role="status">Run history no longer available.</p>}
              {(definitionStatus === 'error' || runHistoryStatus === 'error') && (
                <p role="status">Automation availability could not be checked.</p>
              )}
              {(definitionStatus === 'unavailable' || runHistoryStatus === 'unavailable') && (
                <p role="status">Automations plugin unavailable.</p>
              )}
              <button type="button" onClick={openAutomation} disabled={definitionStatus !== 'available'}>Open automation</button>
              <button type="button" onClick={openRun} disabled={runHistoryStatus !== 'available'}>Open run</button>
            </section>
          )}
        </>
      )}
      {childCount > 0 && (
        <button className="children-chip" aria-expanded={!collapsed} onClick={onToggle}>
          {plural(childCount)}
        </button>
      )}
      <button
        className="icon-button worktree-menu"
        aria-label={`Actions for ${worktree.name}`}
        aria-haspopup="menu"
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          const box = event.currentTarget.getBoundingClientRect()
          onMenu(worktree, box.left, box.bottom)
        }}
      >
        ⋯
      </button>
      <OrchestrationRows context={context} workers={orchestrationWorkers} sessions={sessions} worktreeId={worktree.id} />
    </li>
  )
}


function PendingCard({ name }: { name: string }) {
  return (
    <li className="worktree pending" style={{ '--depth': 0 } as CSSProperties}>
      <span className="worktree-main">
        <span className="dot dot-none" aria-hidden />
        <span className="worktree-name">{name}</span>
        <span className="tag tag-state">Creating…</span>
      </span>
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
  openDialog,
  requestDelete,
  onDropPreviewChange,
  onSeparatorStateChange,
  loopsByWorktree = EMPTY_LOOP_PROJECTIONS
}: TreeProps) {
  const orchestrationWorkers = useOrchestrationRows(context)
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

  const resolveAt = (clientX: number, clientY: number, worktree: Worktree): MembershipTarget | null => {
    const root = treeRoot.current
    if (!root || worktree.kind !== 'git') return null
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
    if (worktree.kind !== 'git' || groupId === worktree.projectGroupId) return
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
        moveProject
      })
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
        const repoName = row.repoName ?? (looseRepo ? repoLabel(looseRepo) : undefined)
        return (
          <WorktreeCard
            key={worktree.id}
            context={context}
            worktree={worktree}
            depth={row.depth}
            childCount={row.childCount}
            collapsed={folded.has(worktree.id)}
            sessions={sessions}
            orchestrationWorkers={worktree.pinned ? [] : orchestrationWorkers}
            loop={loopsByWorktree.get(worktree.id)}
            now={now}
            selected={worktree.id === selectedId}
            repoName={repoName}
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

  const project = (node: ProjectNode, topLevel = false) => {
    const { repo, rows: projectRows, pending: pendingCreates } = node
    const sectionKey = `repo:${repo.id}`
    const className = ['repo', eligibleBoundaries.includes(sectionKey) && 'section-separator'].filter(Boolean).join(' ')
    return (
      <section className={className} key={repo.id} data-top-level-section={topLevel ? sectionKey : undefined}>
        <header
          className={`repo-header${dropPreview?.kind === 'repo' && dropPreview.id === repo.id ? ' membership-drop-preview' : ''}`}
          data-repo-target={repo.id}
          onContextMenu={(event) => {
            event.preventDefault()
            openProjectMenu(repo, event.clientX, event.clientY)
          }}
        >
          <span className="repo-name" title={repo.path}>{repoLabel(repo)}</span>
          <span className="repo-actions">
            <button
              className="icon-button"
              aria-label={`New worktree in ${repoLabel(repo)}`}
              title="New worktree"
              onClick={() => openDialog({ kind: 'create', repoId: repo.id })}
            >
              +
            </button>
            <button
              className="icon-button project-menu"
              aria-label={`Actions for ${repoLabel(repo)}`}
              aria-haspopup="menu"
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                openProjectMenu(repo, bounds.left, bounds.bottom)
              }}
            >
              ⋯
            </button>
          </span>
        </header>
        <ul className="worktree-list">
          {rows(projectRows)}
          {pendingCreates.map((create) => <PendingCard key={create.name} name={create.name} />)}
        </ul>
      </section>
    )
  }

  const groupSection = (node: GroupNode, topLevel = false) => {
    const { group, projects, rows: groupRows, looseRows, children } = node
    const sectionKey = `group:${group.id}`
    const className = ['group', topLevel && eligibleBoundaries.includes(sectionKey) && 'section-separator'].filter(Boolean).join(' ')
    return (
      <section className={className} key={group.id} data-top-level-section={topLevel ? sectionKey : undefined}>
        <header
          className={`group-header${dropPreview?.kind === 'group' && dropPreview.id === group.id ? ' membership-drop-preview' : ''}`}
          data-group-target={group.id}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="group-toggle"
            aria-expanded={!group.collapsed}
            onClick={() =>
              void context.call('quirky.repo/groupCollapse', { group: group.id, collapsed: !group.collapsed }).catch((error: unknown) => {
                context.toast('Could not collapse group', error instanceof Error ? error.message : String(error))
              })
            }
          >
            <span className="group-chevron" aria-hidden>{group.collapsed ? '▸' : '▾'}</span>
            <span className="group-name">{group.name}</span>
          </button>
          <button
            className="icon-button group-menu"
            aria-label={`Actions for group ${group.name}`}
            aria-haspopup="menu"
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              openGroupMenu(group, bounds.left, bounds.bottom)
            }}
          >
            ⋯
          </button>
        </header>
        {!group.collapsed && (
          <>
            {groupRows.length > 0 && <ul className="worktree-list">{rows(groupRows)}</ul>}
            {projects.filter((projectNode) => projectNode.repo.kind === 'folder').map((projectNode) => project(projectNode))}
            {looseRows.length > 0 && <ul className="worktree-list">{rows(looseRows)}</ul>}
            {projects.filter((projectNode) => projectNode.repo.kind === 'git').map((projectNode) => project(projectNode))}
            {children.map((child) => groupSection(child))}
          </>
        )}
      </section>
    )
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const worktree = draggedWorktree.current
    if (!worktree) return
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
      className="worktree-tree"
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
          className={['pinned', eligibleBoundaries.includes('pinned') && 'section-separator'].filter(Boolean).join(' ')}
          data-top-level-section="pinned"
        >
          <header className="repo-header"><span className="section-title">Pinned</span></header>
          <ul className="worktree-list">
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
                  sessions={sessions}
                  orchestrationWorkers={orchestrationWorkers}
                  loop={loopsByWorktree.get(worktree.id)}
                  now={now}
                  selected={worktree.id === selectedId}
                  repoName={repoName}
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
