import { useState, type CSSProperties, type MouseEvent } from 'react'
import type { ProjectGroup, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import type { HeimdallWorktreeStatus } from './useTree'
import { changeGroup, copyText, SESSION_VIEW, setWorktree } from './actions'
import { ContextMenu, groupMenu, projectMenu, STATUS_LABELS, workspaceMenu, type MenuItem } from './Menu'
import { repoLabel, type DialogState, type GroupNode, type ProjectNode, type TreeModel, type TreeRow } from './report'
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
  openDialog(dialog: DialogState): void
  /** Starts a delete of `worktree`, with the workspaces nested below it when `descendants` is above 0. */
  requestDelete(worktree: Worktree, descendants: number): void
}

type OpenMenu = { x: number; y: number; label: string; items: MenuItem[] }

const plural = (count: number) => `${count} ${count === 1 ? 'child' : 'children'}`

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
  now: number
  selected: boolean
  onToggle(): void
  onMenu(worktree: Worktree, x: number, y: number): void
}

function WorktreeCard({ context, worktree, depth, childCount, collapsed, sessions, now, selected, onToggle, onMenu }: CardProps) {
  const open = () => {
    context.openView(SESSION_VIEW, { worktree: worktree.id })
    if (worktree.unread) void setWorktree(context, worktree.id, { unread: false })
  }
  const className = ['worktree', selected && 'selected', worktree.removing && 'removing'].filter(Boolean).join(' ')
  const heimdall = heimdallStatusOf(worktree)
  return (
    <li
      className={className}
      style={{ '--depth': depth } as CSSProperties}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(worktree, event.clientX, event.clientY)
      }}
    >
      <button className="worktree-main" onClick={open} title={worktree.path}>
        {worktree.unread ? <UnreadBell /> : <StatusDot glyph={sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)} />}
        {heimdall && <HeimdallGlyph status={heimdall} now={now} />}
        <span className={worktree.unread ? 'worktree-name worktree-name-unread' : 'worktree-name'}>{worktree.name}</span>
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
export function Tree({ context, model, groups, sessions, selectedId, now, openDialog, requestDelete }: TreeProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const descendantsOf = new Map<string, number>()
  const everyRow = [...model.groups.flatMap((g) => [...g.projects.flatMap((p) => p.rows), ...g.rows]), ...model.projects.flatMap((p) => p.rows)]
  for (const row of everyRow) descendantsOf.set(row.worktree.id, row.descendants.length)

  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const openWorkspaceMenu = (worktree: Worktree, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: `Actions for ${worktree.name}`,
      items: workspaceMenu(worktree, descendantsOf.get(worktree.id) ?? 0, {
        setStatus: (w, status) => void setWorktree(context, w.id, { status }),
        setPinned: (w, pinned) => void setWorktree(context, w.id, { pinned }),
        setUnread: (w, unread) => void setWorktree(context, w.id, { unread }),
        removeParent: (w) => void setWorktree(context, w.id, { noParent: true }),
        copy: (text) => void copyText(context, text),
        openDialog,
        openDeleteDialog: requestDelete
      })
    })

  const openProjectMenu = (repo: Repo, x: number, y: number) =>
    setMenu({
      x,
      y,
      label: `Actions for ${repoLabel(repo)}`,
      items: projectMenu(repo, groups, {
        openDialog,
        openLedger: () => context.openView('view:quirky.ledger/ledger', { target: { owner: { tier: 'project', id: repo.id } } }),
        moveToGroup: (r, group) =>
          void changeGroup(context, 'Could not move project', () =>
            group ? context.call('quirky.repo/groupAdd', { group: group.id, repo: r.id }) : context.call('quirky.repo/groupRemove', { group: r.groupId, repo: r.id })
          )
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
      .map((row) => (
        <WorktreeCard
          key={row.worktree.id}
          context={context}
          worktree={row.worktree}
          depth={row.depth}
          childCount={row.childCount}
          collapsed={folded.has(row.worktree.id)}
          sessions={sessions}
          now={now}
          selected={row.worktree.id === selectedId}
          onToggle={() => toggleFold(row.worktree.id)}
          onMenu={openWorkspaceMenu}
        />
      ))

  const project = ({ repo, rows: list, pending }: ProjectNode) => (
    <section className="repo" key={repo.id}>
      <header
        className="repo-header"
        onContextMenu={(event) => {
          event.preventDefault()
          openProjectMenu(repo, event.clientX, event.clientY)
        }}
      >
        <span className="repo-name" title={repo.path}>
          {repoLabel(repo)}
        </span>
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
              const box = event.currentTarget.getBoundingClientRect()
              openProjectMenu(repo, box.left, box.bottom)
            }}
          >
            ⋯
          </button>
        </span>
      </header>
      <ul className="worktree-list">
        {rows(list)}
        {pending.map((create) => (
          <PendingCard key={create.name} name={create.name} />
        ))}
      </ul>
    </section>
  )

  const groupSection = ({ group, projects, rows: groupRows }: GroupNode) => (
    <section className="group" key={group.id}>
      <header
        className="group-header"
        onContextMenu={(event) => {
          event.preventDefault()
          openGroupMenu(group, event.clientX, event.clientY)
        }}
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
          <span className="group-chevron" aria-hidden>
            {group.collapsed ? '▸' : '▾'}
          </span>
          <span className="group-name">{group.name}</span>
        </button>
        <button
          className="icon-button group-menu"
          aria-label={`Actions for group ${group.name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            openGroupMenu(group, box.left, box.bottom)
          }}
        >
          ⋯
        </button>
      </header>
      {!group.collapsed && (
        <>
          {projects.map(project)}
          {groupRows.length > 0 && <ul className="worktree-list">{rows(groupRows)}</ul>}
        </>
      )}
    </section>
  )

  return (
    <>
      {model.pinned.length > 0 && (
        <section className="pinned">
          <header className="repo-header">
            <span className="section-title">Pinned</span>
          </header>
          <ul className="worktree-list">
            {model.pinned.map((worktree) => (
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
                onToggle={() => {}}
                onMenu={openWorkspaceMenu}
              />
            ))}
          </ul>
        </section>
      )}
      {model.groups.map(groupSection)}
      {model.projects.map(project)}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  )
}
