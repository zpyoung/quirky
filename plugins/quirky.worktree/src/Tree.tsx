import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import type { ProjectGroup, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { resolveMembershipTarget, type MembershipTarget } from './membership'
import { changeGroup, copyText, SESSION_VIEW, setWorktree } from './actions'
import { ContextMenu, groupMenu, projectMenu, STATUS_LABELS, workspaceMenu, type MenuItem } from './Menu'
import { projectSeparatorBoundaries, repoLabel, type DialogState, type GroupNode, type ProjectNode, type TreeModel, type TreeRow } from './report'
import { StatusDot, UnreadBell } from './StatusDot'
import { worktreeGlyph } from './status'

export type TreeProps = {
  context: UiPluginContext
  model: TreeModel
  groups: ProjectGroup[]
  sessions: Session[] | null
  selectedId: string | null
  /** The clock agent glyphs are judged stale against. */
  now: number
  separatorEnabled: boolean
  openDialog(dialog: DialogState): void
  /** Starts a delete of `worktree`, with the workspaces nested below it when `descendants` is above 0. */
  requestDelete(worktree: Worktree, descendants: number): void
  onDropPreviewChange(target: MembershipTarget | null): void
  onSeparatorStateChange(state: { enabled: boolean; eligibleBoundaries: string[] }): void
}

type OpenMenu = { x: number; y: number; label: string; items: MenuItem[] }

const plural = (count: number) => `${count} ${count === 1 ? 'child' : 'children'}`

type CardProps = {
  context: UiPluginContext
  worktree: Worktree
  depth: number
  childCount: number
  collapsed: boolean
  sessions: Session[] | null
  now: number
  selected: boolean
  repoName?: string
  onToggle(): void
  onMenu(worktree: Worktree, x: number, y: number): void
  onDragStart(worktree: Worktree, event: DragEvent<HTMLLIElement>): void
  onDragEnd(): void
}

function WorktreeCard({ context, worktree, depth, childCount, collapsed, sessions, now, selected, repoName, onToggle, onMenu, onDragStart, onDragEnd }: CardProps) {
  const open = () => {
    context.openView(SESSION_VIEW, { worktree: worktree.id })
    if (worktree.unread) void setWorktree(context, worktree.id, { unread: false })
  }
  const className = ['worktree', selected && 'selected', worktree.removing && 'removing'].filter(Boolean).join(' ')
  return (
    <li
      className={className}
      style={{ '--depth': depth } as CSSProperties}
      draggable={worktree.kind === 'git'}
      onDragStart={(event) => onDragStart(worktree, event)}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(worktree, event.clientX, event.clientY)
      }}
    >
      <button className="worktree-main" onClick={open} title={worktree.path}>
        {worktree.unread ? <UnreadBell /> : <StatusDot glyph={sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)} />}
        <span className={worktree.unread ? 'worktree-name worktree-name-unread' : 'worktree-name'}>{worktree.name}</span>
        {repoName && <span className="tag tag-repo">{repoName}</span>}
        {worktree.isMain && <span className="tag tag-primary">primary</span>}
        {worktree.status !== 'in-progress' && <span className="tag tag-status">{STATUS_LABELS[worktree.status]}</span>}
        {worktree.removing && <span className="tag tag-state">Deleting…</span>}
      </button>
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
  now,
  separatorEnabled,
  openDialog,
  requestDelete,
  onDropPreviewChange,
  onSeparatorStateChange
}: TreeProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [dropPreview, setDropPreview] = useState<MembershipTarget | null>(null)
  const [stickySections, setStickySections] = useState<ReadonlySet<string>>(new Set())
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
      items: projectMenu(repo, groups, { openDialog, moveToGroup: moveProject })
    })

  const openGroupMenu = (group: ProjectGroup, x: number, y: number) =>
    setMenu({ x, y, label: `Actions for group ${group.name}`, items: groupMenu(group, openDialog) })

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
            now={now}
            selected={worktree.id === selectedId}
            repoName={repoName}
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
                  now={now}
                  selected={worktree.id === selectedId}
                  repoName={repoName}
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
