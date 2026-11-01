import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { Ask, Repo, Session, Worktree } from '@quirky/protocol'
import {
  CONTEXT_MENU_SEPARATOR,
  ControlIcon,
  FileIcon,
  ProjectTile,
  StatusBarItem,
  StatusDot,
  ToolIcon,
  type PopupItem
} from '../design-system'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { PluginSlot } from '../plugins/PluginSlot'
import { useAttention } from './attention'
import { isAgentStatusStale, useNow } from './freshness'
import './chrome.css'

const WORKTREES_TOOL = 'sidebar-section:quirky.worktree/worktrees'
const ACTIVE_TAB_ICON = 'quirky.terminal/activeTabIcon'
const LAYOUT_EVENT = 'quirky.terminal/layout'

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', md: 'Markdown', mdx: 'MDX', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell', sql: 'SQL',
  css: 'CSS', scss: 'SCSS', html: 'HTML', xml: 'XML', svg: 'SVG', vue: 'Vue',
  yml: 'YAML', yaml: 'YAML', toml: 'TOML', txt: 'Plain text'
}

/** The language a file's extension names, else the uppercase extension, else "Plain text". */
export function languageName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'Plain text'
  const extension = name.slice(dot + 1).toLowerCase()
  return LANGUAGES[extension] ?? extension.toUpperCase()
}

/** `path` relative to `root` when it lies inside it; any other path is returned unchanged. */
export function relativeToWorktree(root: string, path: string): string {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

function fileOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const icon = (value as { icon?: unknown }).icon
  if (typeof icon !== 'object' || icon === null) return null
  const { kind, path } = icon as { kind?: unknown; path?: unknown }
  return kind === 'file' && typeof path === 'string' && path !== '' ? path : null
}

/** The file the active center tab of `worktreeId` shows, or null when that tab is not a file. */
function useActiveFile(worktreeId: string | null): string | null {
  const connection = useConnection()
  const [file, setFile] = useState<string | null>(null)
  useEffect(() => {
    setFile(null)
    if (worktreeId === null) return
    let mounted = true
    let version = 0
    const refresh = async () => {
      const mine = ++version
      try {
        const value = await connection.callAny(ACTIVE_TAB_ICON, { workspace: `id:${worktreeId}` })
        if (mounted && mine === version) setFile(fileOf(value))
      } catch {
        if (mounted && mine === version) setFile(null)
      }
    }
    const unsubscribe = connection.onEvent((event) => {
      if (event.type !== LAYOUT_EVENT) return
      const workspace = 'data' in event && typeof event.data === 'object' && event.data !== null
        ? (event.data as { workspace?: unknown }).workspace
        : undefined
      if (workspace === worktreeId) void refresh()
    })
    const unsubscribeConnected = connection.onConnected(() => void refresh())
    void refresh()
    return () => {
      mounted = false
      version += 1
      unsubscribe()
      unsubscribeConnected()
    }
  }, [connection, worktreeId])
  return file
}

const repoName = (repo: Repo) => repo.displayName ?? repo.name

function linkRow(label: string, lead: ReactNode, onSelect: () => void): PopupItem[] {
  return [CONTEXT_MENU_SEPARATOR, { label, lead, onSelect }]
}

const emptyRow = (label: string): PopupItem => ({ label, enabled: false })

function sessionActivity(session: Session, fallback = 'Working'): string {
  const identity = session.title.trim() || session.agent || session.kind
  const activity = session.agentStatus?.label.trim() || fallback
  return [identity, activity].filter(Boolean).join(' · ')
}

function sessionNeedsYou(session: Session, now: number): boolean {
  const summary = session.agentStatus
  if (!summary) return session.status === 'waiting'
  const stale = isAgentStatusStale(summary, now)
  if (stale) return false
  return summary.display === 'waiting' || summary.display === 'permission' || summary.display === 'blocked'
}

function Breadcrumb({ worktree, repo, color, file }: { worktree: Worktree; repo: Repo | undefined; color: string | null | undefined; file: string | null }) {
  const crumbs: { key: string; node: ReactNode }[] = []
  if (repo) {
    crumbs.push({
      key: 'project',
      node: (
        <>
          <ProjectTile name={repoName(repo)} color={color} />
          <span className="shell-statusbar__crumb-text">{repoName(repo)}</span>
        </>
      )
    })
  }
  crumbs.push({ key: 'worktree', node: <span className="shell-statusbar__crumb-text">{worktree.name}</span> })
  if (file !== null) {
    crumbs.push({ key: 'file', node: <span className="shell-statusbar__crumb-text">{relativeToWorktree(worktree.path, file)}</span> })
  }
  return (
    <nav className="shell-statusbar__breadcrumb" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.key}>
            {index > 0 && <li className="shell-statusbar__separator" aria-hidden="true"><ControlIcon name="caret-right" size={10} /></li>}
            <li className="shell-statusbar__crumb" aria-current={index === crumbs.length - 1 ? 'location' : undefined}>{crumb.node}</li>
          </Fragment>
        ))}
      </ol>
    </nav>
  )
}

/**
 * The bottom row: a breadcrumb of the selected project, worktree and open file on the left, and on
 * the right the working and needs-you counts, the plugin items in their declared order, then the
 * open file's type. Every value but the file type opens a titled popup that links to its panel.
 */
export function ShellStatusBar() {
  const { snapshot, store } = useAttention()
  const { model, windowRoute } = usePluginState()
  const host = usePluginHost()
  const connection = useConnection()
  const now = useNow()
  const selected = snapshot.errors.worktrees
    ? undefined
    : snapshot.worktrees?.find((worktree) => worktree.id === snapshot.selectedWorktreeId)
  const file = useActiveFile(selected?.id ?? null)
  if (windowRoute) return null

  const repo = selected ? snapshot.repos?.find((candidate) => candidate.id === selected.repoId) : undefined
  const worktrees = snapshot.errors.worktrees ? [] : snapshot.worktrees ?? []
  const sessions: Session[] | undefined = snapshot.errors.sessions || snapshot.sessions === null ? undefined : snapshot.sessions
  const asks: Ask[] | undefined = snapshot.errors.asks || snapshot.asks === null ? undefined : snapshot.asks
  const working = sessions?.filter((session) => session.status === 'working' && !asks?.some((ask) => ask.sessionId === session.id))
  const needsYouSessions = sessions === undefined || asks === undefined
    ? undefined
    : sessions.filter((session) => sessionNeedsYou(session, now)).filter((session) => !asks.some((ask) => ask.sessionId === session.id))
  const needsYouCount = needsYouSessions === undefined || asks === undefined
    ? undefined
    : needsYouSessions.length + asks.length
  const needsYouLabel = needsYouSessions === undefined || asks === undefined || needsYouCount === undefined
    ? undefined
    : needsYouSessions.length === 0
      ? `${asks.length} pending ${asks.length === 1 ? 'question' : 'questions'}`
      : `${needsYouCount} needs you`
  const statusBars = model?.statusBars ?? []

  const openWorktree = (worktreeId: string) => {
    void store.openWorktree(worktreeId).then((error) => {
      if (error) {
        connection.store.dispatch({ type: 'toast', toast: { kind: 'error', title: `Could not open worktree: ${error}`, body: error } })
      }
    })
  }
  const locationOf = (ask: Ask): string | undefined => {
    const worktree = ask.worktreeId === null ? undefined : worktrees.find((candidate) => candidate.id === ask.worktreeId)
    const project = worktree ? snapshot.repos?.find((candidate) => candidate.id === worktree.repoId) : undefined
    return [project ? repoName(project) : null, worktree?.name].filter(Boolean).join(' / ') || undefined
  }

  const workingItems: PopupItem[] = working === undefined ? [] : [
    ...(working.length === 0
      ? [emptyRow('No agents are working')]
      : working.map((session): PopupItem => ({
        label: worktrees.find((worktree) => worktree.id === session.worktreeId)?.name ?? session.worktreeId,
        subtitle: sessionActivity(session),
        lead: <StatusDot status="working" label="Working" />,
        onSelect: () => openWorktree(session.worktreeId)
      }))),
    ...linkRow('Open the Worktrees panel', <ToolIcon name="git-branch" hue="blue" />, () => host.openTool(WORKTREES_TOOL))
  ]
  const needsYouItems: PopupItem[] = needsYouCount === undefined || needsYouSessions === undefined || asks === undefined ? [] : [
    ...(needsYouCount === 0 ? [emptyRow('No pending questions')] : []),
    ...needsYouSessions.map((session): PopupItem => ({
      label: worktrees.find((worktree) => worktree.id === session.worktreeId)?.name ?? session.worktreeId,
      subtitle: sessionActivity(session, 'Needs you'),
      lead: <StatusDot status="needs-you" label="Needs you" />,
      onSelect: () => openWorktree(session.worktreeId)
    })),
    ...asks.map((ask): PopupItem => ({
      label: ask.spec.title ?? 'An agent has a question',
      subtitle: locationOf(ask),
      lead: <StatusDot status="needs-you" label="Needs you" />,
      onSelect: () => store.openInbox()
    })),
    ...linkRow('Open the Inbox', <ToolIcon name="tray" hue="violet" />, () => store.openInbox())
  ]

  return (
    <footer className="shell-statusbar" data-region="status-bar" aria-label="Status bar">
      <div className="shell-statusbar__start">
        {selected && <Breadcrumb worktree={selected} repo={repo} color={repo ? snapshot.projectIdentities[repo.id]?.color : null} file={file} />}
        {snapshot.errors.worktrees && <span className="shell-statusbar__unknown" role="status">Branch unavailable</span>}
      </div>
      <div className="shell-statusbar__values" aria-label="Workspace status">
        {snapshot.errors.sessions && <span className="shell-statusbar__unknown" role="status">Agent status unavailable</span>}
        {snapshot.errors.asks && <span className="shell-statusbar__unknown" role="status">Inbox status unavailable</span>}
        {working !== undefined && (
          <StatusBarItem label={`${working.length} ${working.length === 1 ? 'agent' : 'agents'} working`} popupTitle="Working" items={workingItems}>
            <StatusDot status={working.length > 0 ? 'working' : 'idle'} />
            <span>{working.length} working</span>
          </StatusBarItem>
        )}
        {needsYouCount !== undefined && needsYouLabel !== undefined && (
          <StatusBarItem label={needsYouLabel} popupTitle="Needs you" items={needsYouItems}>
            <StatusDot status={needsYouCount > 0 ? 'needs-you' : 'idle'} />
            <span className={needsYouCount > 0 ? 'shell-statusbar__needs-you' : undefined}>{needsYouCount} needs you</span>
          </StatusBarItem>
        )}
        {statusBars.map((entry) => <PluginSlot key={entry.id} id={entry.id} />)}
        {file !== null && (
          <StatusBarItem label="File type">
            <FileIcon path={file} size={14} />
            <span>{languageName(file)}</span>
          </StatusBarItem>
        )}
      </div>
    </footer>
  )
}
