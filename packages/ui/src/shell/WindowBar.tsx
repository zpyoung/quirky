import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import type { AgentDisplayState, Ask, Repo, Session, SessionStatus, Worktree } from '@quirky/protocol'
import { Badge, CONTEXT_MENU_SEPARATOR, ControlIcon, PopupMenu, ProjectTile, StatusDot, ToolIcon, type PopupItem, type UiStatus } from '../design-system'
import { useConnection, usePluginHost, usePluginState } from '../context'
import type { Connection } from '../connection'
import { useAttention, type ProjectIdentity } from './attention'

const NEW_WORKTREE = 'command:quirky.worktree/new-worktree'
const ADD_PROJECT = 'command:quirky.worktree/add-project'
const NEW_AGENT_TAB = 'command:quirky.agents/new-agent-tab'
const AGENT_SETTINGS_VIEW = 'view:quirky.agents/settings'
const NO_DRAG = 'electrobun-webkit-app-region-no-drag'
const STALE_AFTER_MS = 30 * 60 * 1000
const CLOCK_TICK_MS = 60_000

type WorktreeExtras = { sleeping?: boolean; archivedAt?: number | null }
type DisplayStatus = Exclude<SessionStatus, 'starting'>
type Glyph =
  | { kind: 'agent'; display: AgentDisplayState; label: string; percent: number | null }
  | { kind: 'coarse'; status: DisplayStatus }

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

const GLYPH_URGENCY: string[] = [
  'waiting', 'permission', 'blocked', 'failed', 'working', 'monitoring', 'unconfirmed',
  'unverifiable', 'interrupted', 'done', 'idle', 'running', 'exited'
]

const RING_STATES: AgentDisplayState[] = ['working', 'waiting', 'permission']

function semanticStatus(value: string): UiStatus {
  switch (value) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'waiting':
    case 'permission':
    case 'blocked':
      return 'needs-you'
    case 'failed':
      return 'failing'
    case 'done':
      return 'done'
    case 'running':
      return 'queued'
    default:
      return 'idle'
  }
}

function glyphOf(session: Session, now: number): Glyph {
  const summary = session.agentStatus
  if (!summary) return { kind: 'coarse', status: session.status === 'starting' ? 'running' : session.status }
  const sessionRunning = session.status !== 'exited'
  const stale = summary.state !== 'done' && !summary.restoredUnconfirmed && now - summary.evidenceAt > STALE_AFTER_MS
  const shown = stale
    ? sessionRunning ? { display: 'unverifiable' as const, label: 'No recent update' } : { display: 'idle' as const, label: 'Idle' }
    : { display: summary.display, label: summary.label }
  const hasRing = summary.progress !== null && Number.isFinite(summary.progress) && RING_STATES.includes(shown.display)
  const percent = hasRing ? Math.round(Math.min(100, Math.max(0, summary.progress!))) : null
  return { kind: 'agent', display: shown.display, label: shown.label, percent }
}

const rankOf = (glyph: Glyph) => GLYPH_URGENCY.indexOf(glyph.kind === 'agent' ? glyph.display : glyph.status)

function worktreeGlyph(sessions: Session[], worktreeId: string, now: number): Glyph | null {
  let best: Glyph | null = null
  for (const session of sessions) {
    if (session.worktreeId !== worktreeId) continue
    const glyph = glyphOf(session, now)
    if (best === null) best = glyph
    else if (rankOf(glyph) < rankOf(best) || (rankOf(glyph) === rankOf(best) && glyph.kind === 'agent' && best.kind === 'coarse')) best = glyph
  }
  return best
}

function sameGlyph(candidate: Glyph, expected: Glyph): boolean {
  if (candidate.kind !== expected.kind) return false
  if (candidate.kind === 'agent' && expected.kind === 'agent') {
    return candidate.display === expected.display && candidate.label === expected.label && candidate.percent === expected.percent
  }
  return candidate.kind === 'coarse' && expected.kind === 'coarse' && candidate.status === expected.status
}

function activityFor(sessions: Session[], worktreeId: string, now: number, glyph: Glyph): string {
  const session = sessions.find((item) => item.worktreeId === worktreeId && sameGlyph(worktreeGlyph([item], worktreeId, now)!, glyph))
  const activity = glyph.kind === 'agent'
    ? glyph.label.trim() || (ACTIVITY_LABELS[glyph.display] ?? glyph.display)
    : ACTIVITY_LABELS[glyph.status] ?? glyph.status
  if (!session) return activity
  const identity = session.title.trim() || session.agent || session.kind
  return [identity, activity].filter(Boolean).join(' · ')
}

export type WorktreeRowState = { status: UiStatus; activity: string; needsYou: number }

/**
 * The status dot and activity line a worktree row shows. It reproduces the Worktrees panel's row
 * mapping, which this host cannot import from the plugin; both are tested against the same cases.
 */
export function worktreeRowState(
  worktree: Worktree,
  sessions: Session[] | null,
  askCount: number,
  now: number
): WorktreeRowState {
  const { sleeping = false, archivedAt = null } = worktree as Worktree & WorktreeExtras
  const glyph = sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)
  const activity = worktree.removing
    ? 'Deleting…'
    : sleeping
      ? 'Sleeping'
      : glyph
        ? activityFor(sessions!, worktree.id, now, glyph)
        : archivedAt !== null
          ? 'Archived'
          : sessions === null
            ? 'Activity unavailable'
            : 'Idle'
  const status: UiStatus = askCount > 0
    ? 'needs-you'
    : worktree.removing
      ? 'queued'
      : sleeping
        ? 'idle'
        : glyph
          ? semanticStatus(glyph.kind === 'agent' ? glyph.display : glyph.status)
          : sessions === null
            ? 'queued'
            : 'idle'
  return { status, activity, needsYou: askCount }
}

export type ProjectCounts = { worktrees: number; working: number; needsYou: number }

/** Worktree, working-session and pending-question counts for each project and for all of them. */
export function projectCounts(
  repos: Repo[],
  worktrees: Worktree[],
  sessions: Session[] | null,
  asks: Ask[] | null
): { all: ProjectCounts; byRepo: Map<string, ProjectCounts> } {
  const repoOf = new Map(worktrees.map((worktree) => [worktree.id, worktree.repoId]))
  const byRepo = new Map(repos.map((repo) => [repo.id, { worktrees: 0, working: 0, needsYou: 0 }]))
  for (const worktree of worktrees) {
    const counts = byRepo.get(worktree.repoId)
    if (counts) counts.worktrees += 1
  }
  for (const session of sessions ?? []) {
    if (session.status !== 'working') continue
    const counts = byRepo.get(repoOf.get(session.worktreeId) ?? '')
    if (counts) counts.working += 1
  }
  for (const ask of asks ?? []) {
    const counts = ask.worktreeId === null ? undefined : byRepo.get(repoOf.get(ask.worktreeId) ?? '')
    if (counts) counts.needsYou += 1
  }
  const all: ProjectCounts = {
    worktrees: worktrees.length,
    working: (sessions ?? []).filter((session) => session.status === 'working').length,
    needsYou: asks?.length ?? 0
  }
  return { all, byRepo }
}

/** What the project switcher reads: All projects, the one narrowed project's name, or "N projects". */
export function scopeLabel(filterRepoIds: string[], repos: Repo[] | null): string {
  if (filterRepoIds.length === 0) return 'All projects'
  if (filterRepoIds.length > 1) return `${filterRepoIds.length} projects`
  const repo = repos?.find((candidate) => candidate.id === filterRepoIds[0])
  return repo ? repoName(repo) : 'Project unavailable'
}

const repoName = (repo: Repo) => repo.displayName ?? repo.name
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function countsLine(counts: ProjectCounts): string {
  return [plural(counts.worktrees, 'worktree'), counts.working > 0 ? `${counts.working} working` : null].filter(Boolean).join(' · ')
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function showError(connection: Connection, title: string, error: unknown): void {
  const body = error instanceof Error ? error.message : String(error)
  connection.store.dispatch({ type: 'toast', toast: { kind: 'error', title: `${title}: ${body}`, body } })
}

export type AgentChoice = { id: string; label: string; isDefault: boolean }

/**
 * The agents the New agent caret offers: installed, enabled and launchable by a
 * `new-<agent>-tab` command, the default first. This is the `+` tab menu's source with the
 * extra condition that the bar can only run what has a command.
 */
export function launchableAgents(listing: unknown, commands: ReadonlySet<string>): AgentChoice[] {
  if (typeof listing !== 'object' || listing === null || !('agents' in listing) || !Array.isArray(listing.agents)) return []
  const defaultAgent = 'defaultAgent' in listing && typeof listing.defaultAgent === 'string' ? listing.defaultAgent : null
  const choices: AgentChoice[] = []
  for (const candidate of listing.agents as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const agent = candidate as { id?: unknown; label?: unknown; installed?: unknown; enabled?: unknown; isDefault?: unknown }
    if (typeof agent.id !== 'string' || typeof agent.label !== 'string' || agent.installed !== true || agent.enabled !== true) continue
    if (!commands.has(`command:quirky.agents/new-${agent.id}-tab`)) continue
    choices.push({ id: agent.id, label: agent.label, isDefault: agent.isDefault === true || agent.id === defaultAgent })
  }
  return [...choices.filter((choice) => choice.isDefault), ...choices.filter((choice) => !choice.isDefault)]
}

function useAgentListing(connection: Connection): unknown {
  const [listing, setListing] = useState<unknown>(null)
  useEffect(() => {
    let mounted = true
    let version = 0
    const refresh = async () => {
      const mine = ++version
      try {
        const value = await connection.callAny('quirky.agents/list', {})
        if (mounted && mine === version) setListing(value)
      } catch {
        if (mounted && mine === version) setListing(null)
      }
    }
    const unsubscribe = connection.onEvent((event) => {
      if (event.type === 'quirky.agents/changed') void refresh()
    })
    const unsubscribeConnected = connection.onConnected(() => void refresh())
    void refresh()
    return () => {
      mounted = false
      version += 1
      unsubscribe()
      unsubscribeConnected()
    }
  }, [connection])
  return listing
}

function useAnchoredPopup() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return {
    ref,
    open,
    anchor: open ? ref.current : null,
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false)
  }
}

type BarButtonProps = {
  buttonRef?: Ref<HTMLButtonElement>
  label?: string
  empty?: boolean
  expanded?: boolean
  popup?: boolean
  icon?: boolean
  className?: string
  disabled?: boolean
  onClick(): void
  children: ReactNode
}

function BarButton({ buttonRef, label, empty, expanded, popup, icon, className, disabled, onClick, children }: BarButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={['window-bar__button', icon && 'window-bar__button--icon', className, NO_DRAG].filter(Boolean).join(' ')}
      aria-label={label}
      data-empty={empty ? '' : undefined}
      aria-haspopup={popup ? 'menu' : undefined}
      aria-expanded={popup ? expanded === true : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const Caret = () => <ControlIcon name="caret-down" size={12} />

function identityOf(identities: Record<string, ProjectIdentity>, repo: Repo): ProjectIdentity | undefined {
  return identities[repo.id]
}

function ProjectSwitcher() {
  const { snapshot, store } = useAttention()
  const connection = useConnection()
  const host = usePluginHost()
  const popup = useAnchoredPopup()
  const repos = snapshot.errors.repos ? null : snapshot.repos
  const worktrees = snapshot.errors.worktrees ? [] : (snapshot.worktrees ?? []).filter((worktree) => !worktree.removing)
  const { all, byRepo } = projectCounts(
    repos ?? [],
    worktrees,
    snapshot.errors.sessions ? null : snapshot.sessions,
    snapshot.errors.asks ? null : snapshot.asks
  )
  const scope = snapshot.filterRepoIds
  const label = scopeLabel(scope, repos)
  const single = scope.length === 1 ? repos?.find((repo) => repo.id === scope[0]) : undefined

  const choose = (repoId: string | null) => {
    void store.selectProject(repoId).then((error) => {
      if (error) showError(connection, 'Could not change project', error)
    })
  }
  const needsYouBadge = (count: number) => count > 0
    ? <Badge tone="needs-you" label={`${count} needs you`}>{count}</Badge>
    : undefined

  const items: PopupItem[] = [
    {
      label: 'All projects',
      subtitle: countsLine(all),
      lead: <ControlIcon name="squares-four" />,
      selected: scope.length === 0,
      onSelect: () => choose(null)
    },
    { label: 'Projects', heading: true },
    ...(repos ?? []).map((repo): PopupItem => {
      const counts = byRepo.get(repo.id) ?? { worktrees: 0, working: 0, needsYou: 0 }
      return {
        label: repoName(repo),
        subtitle: countsLine(counts),
        lead: <ProjectTile name={repoName(repo)} color={identityOf(snapshot.projectIdentities, repo)?.color} />,
        selected: scope.includes(repo.id),
        trailing: needsYouBadge(counts.needsYou),
        onSelect: () => choose(repo.id)
      }
    }),
    CONTEXT_MENU_SEPARATOR,
    {
      label: 'Add project…',
      lead: <ControlIcon name="plus" />,
      onSelect: () => void host.runCommand(ADD_PROJECT).catch((error) => showError(connection, 'Could not add a project', error))
    }
  ]

  return (
    <>
      <BarButton buttonRef={popup.ref} popup expanded={popup.open} className="window-bar__switcher" onClick={popup.toggle}>
        {single
          ? <ProjectTile name={repoName(single)} color={identityOf(snapshot.projectIdentities, single)?.color} />
          : <ControlIcon name="squares-four" />}
        <span className="window-bar__label">{label}</span>
        <Caret />
      </BarButton>
      {popup.anchor && (
        <PopupMenu anchor={popup.anchor} items={items} searchPlaceholder="Search projects" onClose={popup.close} />
      )}
    </>
  )
}

function WorktreeSwitcher({ newWorktree }: { newWorktree(): void }) {
  const { snapshot, store } = useAttention()
  const connection = useConnection()
  const popup = useAnchoredPopup()
  const now = useNow()
  const scope = snapshot.filterRepoIds
  const repos = snapshot.errors.repos ? [] : (snapshot.repos ?? [])
  const sessions = snapshot.errors.sessions ? null : snapshot.sessions
  const selected = snapshot.errors.worktrees ? undefined : snapshot.worktrees?.find((worktree) => worktree.id === snapshot.selectedWorktreeId)
  const label = selected?.name ?? (snapshot.selectedWorktreeId ?? 'No worktree selected')

  const open = (worktreeId: string) => {
    void store.openWorktree(worktreeId).then((error) => {
      if (error) showError(connection, 'Could not open worktree', error)
    })
  }

  const items = (() => {
    const askCounts = new Map<string, number>()
    for (const ask of snapshot.errors.asks ? [] : snapshot.asks ?? []) {
      if (ask.worktreeId !== null) askCounts.set(ask.worktreeId, (askCounts.get(ask.worktreeId) ?? 0) + 1)
    }
    const inScope = (snapshot.errors.worktrees ? [] : snapshot.worktrees ?? [])
      .filter((worktree) => !worktree.removing && (scope.length === 0 || scope.includes(worktree.repoId)))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    const row = (worktree: Worktree): PopupItem => {
      const state = worktreeRowState(worktree, sessions, askCounts.get(worktree.id) ?? 0, now)
      return {
        label: worktree.name,
        subtitle: state.activity,
        lead: <StatusDot status={state.status} label={state.activity} />,
        selected: worktree.id === snapshot.selectedWorktreeId,
        trailing: state.needsYou > 0 ? <Badge tone="needs-you" label={`${state.needsYou} needs you`}>{state.needsYou}</Badge> : undefined,
        onSelect: () => open(worktree.id)
      }
    }
    const rows: PopupItem[] = [
      { label: 'New worktree…', lead: <ControlIcon name="plus" />, key: '⌘N', onSelect: newWorktree },
      CONTEXT_MENU_SEPARATOR
    ]
    if (scope.length === 1) {
      rows.push(...inScope.map(row))
    } else {
      for (const repo of repos) {
        const members = inScope.filter((worktree) => worktree.repoId === repo.id)
        if (members.length === 0) continue
        rows.push({ label: repoName(repo), heading: true }, ...members.map(row))
      }
    }
    return rows
  })()

  return (
    <>
      <BarButton buttonRef={popup.ref} popup expanded={popup.open} className="window-bar__switcher" onClick={popup.toggle}>
        <ToolIcon name="git-branch" hue="blue" />
        <span className="window-bar__label">{label}</span>
        <Caret />
      </BarButton>
      {popup.anchor && (
        <PopupMenu anchor={popup.anchor} items={items} searchPlaceholder="Search worktrees and actions" onClose={popup.close} />
      )}
    </>
  )
}

function NewAgent() {
  const connection = useConnection()
  const host = usePluginHost()
  const { model } = usePluginState()
  const listing = useAgentListing(connection)
  const popup = useAnchoredPopup()
  const agents = launchableAgents(listing, new Set((model?.commands ?? []).map((command) => command.id)))

  const run = (command: string) => {
    void host.runCommand(command).catch((error) => showError(connection, 'Could not start an agent', error))
  }
  const items: PopupItem[] = [
    ...agents.map((agent): PopupItem => ({
      label: agent.label,
      subtitle: agent.isDefault ? 'Default' : undefined,
      onSelect: () => run(`command:quirky.agents/new-${agent.id}-tab`)
    })),
    CONTEXT_MENU_SEPARATOR,
    { label: 'Agent settings…', onSelect: () => host.openView(AGENT_SETTINGS_VIEW) }
  ]

  return (
    <>
      <BarButton className="window-bar__new-agent" onClick={() => run(NEW_AGENT_TAB)}>
        <ControlIcon name="plus" />
        <span>New agent</span>
      </BarButton>
      <BarButton buttonRef={popup.ref} popup expanded={popup.open} icon label="Choose agent" onClick={popup.toggle}>
        <Caret />
      </BarButton>
      {popup.anchor && <PopupMenu anchor={popup.anchor} items={items} title="New agent" onClose={popup.close} />}
    </>
  )
}

function Overflow({ onSettings }: { onSettings(): void }) {
  const popup = useAnchoredPopup()
  const items: PopupItem[] = [{ label: 'Settings', lead: <ControlIcon name="gear" />, onSelect: onSettings }]
  return (
    <>
      <BarButton buttonRef={popup.ref} popup expanded={popup.open} icon label="More" onClick={popup.toggle}>
        <ControlIcon name="dots-three-vertical" />
      </BarButton>
      {popup.anchor && <PopupMenu anchor={popup.anchor} items={items} onClose={popup.close} />}
    </>
  )
}

type WindowBarProps = { onSettings(): void }

/**
 * The 40-high bar that merges the Mac title bar with Quirky's own controls: project and worktree
 * switchers, history, New agent, the needs-you count, search and Overflow. Empty space drags the
 * window, so every control opts out of dragging. The bar shows no agent status because a worktree
 * can run several agents; tabs and worktree rows carry it.
 */
export function WindowBar({ onSettings }: WindowBarProps) {
  const { snapshot, store } = useAttention()
  const connection = useConnection()
  const host = usePluginHost()
  const scope = snapshot.filterRepoIds
  const needsYou = snapshot.errors.asks || snapshot.asks === null ? null : snapshot.asks.length

  const newWorktree = () => {
    const args = scope.length === 1 ? { repo: `id:${scope[0]}` } : undefined
    void host.runCommand(NEW_WORKTREE, args).catch((error) => showError(connection, 'Could not create a worktree', error))
  }
  const step = (direction: 'back' | 'forward') => {
    void store.navigateHistory(direction).then((error) => {
      if (error) showError(connection, 'Could not navigate', error)
    })
  }

  return (
    <header className="window-bar electrobun-webkit-app-region-drag" aria-label="Window bar">
      <div className="window-bar__group">
        <ProjectSwitcher />
        <WorktreeSwitcher newWorktree={newWorktree} />
        <BarButton icon label="New worktree" onClick={newWorktree}>
          <ControlIcon name="plus" />
        </BarButton>
      </div>
      <div className="window-bar__group">
        <BarButton icon label="Back" onClick={() => step('back')}>
          <ControlIcon name="caret-left" />
        </BarButton>
        <BarButton icon label="Forward" onClick={() => step('forward')}>
          <ControlIcon name="caret-right" />
        </BarButton>
        <NewAgent />
      </div>
      <div className="window-bar__group window-bar__group--end">
        {needsYou !== null && (
          <BarButton
            label={`${needsYou} pending ${needsYou === 1 ? 'question' : 'questions'}`}
            className="window-bar__needs-you"
            empty={needsYou === 0}
            onClick={() => store.openInbox()}
          >
            <StatusDot status={needsYou > 0 ? 'needs-you' : 'idle'} />
            <span>{needsYou}</span>
          </BarButton>
        )}
        <BarButton
          label="Search commands, tools, views, and worktrees"
          className="window-bar__search"
          onClick={() => host.setPalette(true)}
        >
          <ControlIcon name="magnifying-glass" />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </BarButton>
        <Overflow onSettings={onSettings} />
      </div>
    </header>
  )
}
