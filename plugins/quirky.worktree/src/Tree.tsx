import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { ProjectGroup, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { ActivityMark, Badge, Button, ContextMenu, HoverCard, IconButton, InlineError, NoticeLine, ProjectTile, SectionHeader, StatusDot as UiStatusDot, TagChips, type ContextMenuItem, type UiStatus } from '@quirky/ui'
import { DEFAULT_STOCK_OPTIONS, type StockWorktreeOptions, type WorktreeControl } from './control-types'
import { isAvatarWorktreeStatus, type AvatarWorktreeStatus, type HeimdallWorktreeStatus } from './useTree'
import { resolveMembershipTarget, type MembershipTarget } from './membership'
import { changeGroup, copyText, currentWindowId, setWorkspaceSleeping, setWorktree } from './actions'
import { groupMenu, NEW_SECTION, projectMenu, UNARCHIVE, WITH_DESCENDANTS, workspaceMenu, type RowAction } from './Menu'
import { registerUiControlScope, requestUiControl, UI_CONTROL_COMMAND, type ScopedUiControlArgs } from './ui-control'
import { canonicalDescendants, projectSeparatorBoundaries, repoLabel, type AutomationAvailabilitySnapshot, type DialogState, type PendingCreate } from './report'
import type { WorktreeProjectIdentity, WorktreeStatusDefinition } from './parity-types'
import { markLabel, UnreadDot } from './StatusDot'
import { worktreeGlyph, type WorktreeGlyph } from './status'
import { OrchestrationRows, type OrchestrationWorkerRow } from './OrchestrationRows'
import { useOrchestrationRows } from './useOrchestrationRows'
import { LoopGlyph } from './LoopGlyph'
import type { LoopProjection } from './loop-status'
import type { Attention, ChecksState, ViewGroup, ViewRow, ViewTree } from './view-model'
import type { GroupBy, RowFact, Tag } from './view-types'

export type { RowAction } from './Menu'
export type GroupAction = 'new-worktree' | 'new-section' | 'rename' | 'delete' | 'open-ledger'

type TreeBaseProps = {
  context: UiPluginContext
  model: ViewTree
  tagsById: ReadonlyMap<string, Tag>
  rowFact: RowFact
  repos: Repo[]
  groups: ProjectGroup[]
  sessions: Session[] | null
  selectedId: string | null
  multiSelected?: ReadonlySet<string>
  /** Pending question counts by worktree; null while unknown. */
  pendingAsks?: ReadonlyMap<string, number> | null
  checks?: ReadonlyMap<string, ChecksState | null>
  pending?: PendingCreate[]
  /** Draws a header for every project the model has no group for, so its `+` and menu stay reachable. */
  emptyProjects?: boolean
  /** How the model was grouped; headers, section nesting and drag-to-section follow it. */
  groupBy?: GroupBy
  /** Called after a plain click opens a worktree. */
  onOpen?(id: string): void
  /** `rendered` is the worktree ids on screen now, top to bottom; a range selects only those. */
  onSelectToggle?(id: string, mode: 'toggle' | 'range', rendered?: readonly string[]): void
  onRename?(id: string, name: string): void
  onTagsOpen?(ids: string[], anchor: HTMLElement): void
  /** Returning true claims the action, and the tree skips its own handling. */
  onMenuAction?(id: string, action: RowAction, arg?: string | null): boolean | void
  /** Shares the avatar hand-off command with the row menu. */
  onHandoffToAvatar?(worktreeIds: string[]): void
  /** Returning true claims the action, and the tree skips its own handling. */
  onGroupAction?(group: ViewGroup, action: GroupAction): boolean | void
  collapsed?: ReadonlySet<string>
  onToggleCollapsed?(key: string): void
  /** Every project id in the manual order; with `onReorderProjects` it enables Move up and Move down. */
  projectOrder?: readonly string[]
  onReorderProjects?(ids: string[]): void
  automationExpandedId: string | null
  automationAvailability: AutomationAvailabilitySnapshot | null
  onToggleAutomationDetails(worktreeId: string): void
  /** The clock agent glyphs are judged stale against. */
  now: number
  separatorEnabled: boolean
  options?: StockWorktreeOptions
  canShowSleeping(worktree: Worktree): boolean
  statusDefinitions: WorktreeStatusDefinition[]
  projectIdentities: Record<string, WorktreeProjectIdentity>
  allWorktrees?: WorktreeControl[]
  onReorder?(worktrees: string[]): void
  onDropPreviewChange(target: MembershipTarget | null): void
  onSeparatorStateChange(state: { enabled: boolean; eligibleBoundaries: string[] }): void
  loopsByWorktree?: ReadonlyMap<string, LoopProjection>
}

type DialogHandler = (dialog: DialogState) => void
/** Starts a delete of `worktree`, with the workspaces nested below it when `descendants` is above 0. */
type DeleteHandler = (worktree: Worktree, descendants: number) => void
export type TreeProps = TreeBaseProps & (
  | { openDialog: DialogHandler; requestDelete: DeleteHandler; onOpenDialog?: DialogHandler; onRequestDelete?: DeleteHandler }
  | { onOpenDialog: DialogHandler; onRequestDelete: DeleteHandler; openDialog?: DialogHandler; requestDelete?: DeleteHandler }
)

type OpenMenu = {
  x: number
  y: number
  label: string
  items: ContextMenuItem[]
  seq: number
  targetId: string
  returnFocusTo?: HTMLElement
  originRow?: HTMLElement
}

const HOVER_CARD_DELAY_MS = 400
const EMPTY_LOOP_PROJECTIONS: ReadonlyMap<string, LoopProjection> = new Map()
const EMPTY_SET: ReadonlySet<string> = new Set()
function isPlainPayload(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
  } catch {
    return false
  }
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}
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
const AVATAR_STATE_LABELS: Record<string, string> = {
  checking: 'Checking',
  'gate-failed': 'Gate failed',
  briefing: 'Briefing',
  working: 'Working',
  'waiting-on-you': 'Waiting on you',
  'checking-done': 'Checking done',
  'in-review': 'In review',
  'merge-ready': 'Merge ready',
  merged: 'Merged',
  'pr-ready': 'PR ready',
  committed: 'Committed',
  parked: 'Parked',
  done: 'Done'
}
const AVATAR_LEVEL_LABELS: Record<AvatarWorktreeStatus['level'], string> = {
  shadow: 'Shadow',
  local: 'Local',
  'own-branch': 'Own branch',
  full: 'Full'
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

function avatarStatusOf(worktree: Worktree): AvatarWorktreeStatus | null {
  if (!('avatarStatus' in worktree)) return null
  return isAvatarWorktreeStatus(worktree.avatarStatus) ? worktree.avatarStatus : null
}

function avatarStatusTitle(status: AvatarWorktreeStatus): string {
  const state = AVATAR_STATE_LABELS[status.state] ?? status.state
  const needsYou = status.needsYou > 0
    ? ` · ${status.needsYou} ${status.needsYou === 1 ? 'needs you' : 'need you'}`
    : ''
  return `Avatar: ${state}${needsYou} · ${AVATAR_LEVEL_LABELS[status.level]}`
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

function activityFor(sessions: Session[] | null, worktreeId: string, now: number, glyph: WorktreeGlyph | null, needsYou: boolean): string {
  if (sessions === null) return needsYou ? 'Needs you' : 'Activity unavailable'
  if (!glyph) return needsYou ? 'Needs you' : 'Idle'
  const session = sessions.find((item) =>
    item.worktreeId === worktreeId && sameGlyph(worktreeGlyph([item], worktreeId, now), glyph)
  )
  const activity = needsYou
    ? 'Needs you'
    : glyph.kind === 'agent'
      ? glyph.label.trim() || (ACTIVITY_LABELS[glyph.display] ?? glyph.display)
      : ACTIVITY_LABELS[glyph.status] ?? glyph.status
  if (!session) return activity
  const identity = session.title.trim() || session.agent || session.kind
  return [identity, activity].filter(Boolean).join(' · ')
}

/** The agent's state in words, as the hover card says it. */
function agentWords(worktree: WorktreeControl, sessions: Session[] | null, now: number, pendingAsks: number): string {
  const needsYou = pendingAsks > 0
  if (worktree.removing) return 'Deleting…'
  if (worktree.sleeping) return 'Sleeping'
  const glyph = sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)
  if (glyph || needsYou) return activityFor(sessions, worktree.id, now, glyph, needsYou)
  if (worktree.archivedAt !== null) return 'Archived'
  return sessions === null ? 'Activity unavailable' : 'Idle'
}

/** A compact age such as `now`, `5m`, `3h`, `2d`, `6w` or `4mo`. */
function formatAge(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}

function factOf(worktree: WorktreeControl, fact: RowFact, now: number, statusLabel: string): string {
  if (worktree.removing) return 'Deleting…'
  switch (fact) {
    case 'pr':
      return worktree.linkedPR ? `#${worktree.linkedPR.number}` : ''
    case 'branch':
      return worktree.branch ?? 'detached'
    case 'status':
      return statusLabel
    case 'last-activity':
      return worktree.lastActivityAt > 0 ? formatAge(now - worktree.lastActivityAt) : ''
  }
}

const CHECKS_WORDS: Record<ChecksState, string> = {
  pending: 'checks running',
  success: 'checks passing',
  failure: 'checks failing',
  neutral: 'checks neutral'
}

const attentionLabel = (attention: Attention, count: number) =>
  `${count} ${count === 1 ? 'worktree needs' : 'worktrees need'} you${attention === 'error' ? ', including errors' : ''}`

type HoverCardBodyProps = {
  worktree: WorktreeControl
  tags: Tag[]
  projectLabel: string
  statusLabel: string
  agent: string
  checks: ChecksState | null
  showNotes: boolean
  now: number
}

function HoverCardBody({ worktree, tags, projectLabel, statusLabel, agent, checks, now, showNotes }: HoverCardBodyProps) {
  const review = worktree.linkedPR
    ? [`#${worktree.linkedPR.number} ${worktree.linkedPR.title}`, checks ? CHECKS_WORDS[checks] : null].filter(Boolean).join(' · ')
    : checks
      ? CHECKS_WORDS[checks]
      : null
  return (
    <div className="worktree-hover">
      <strong className="worktree-hover__name">{worktree.name}</strong>
      <code className="worktree-hover__branch">{worktree.branch ?? 'detached HEAD'}</code>
      <dl className="worktree-hover__facts">
        <dt>Project</dt>
        <dd>{projectLabel}</dd>
        <dt>Status</dt>
        <dd>{worktree.archivedAt !== null ? `${statusLabel} · Archived` : statusLabel}</dd>
        <dt>Agent</dt>
        <dd>{agent}</dd>
        {showNotes && worktree.comment.trim() !== '' && (
          <>
            <dt>Notes</dt>
            <dd>{worktree.comment}</dd>
          </>
        )}
        {review !== null && (
          <>
            <dt>Review</dt>
            <dd>{review}</dd>
          </>
        )}
        {tags.length > 0 && (
          <>
            <dt>Tags</dt>
            <dd><TagChips tags={tags} max={tags.length} /></dd>
          </>
        )}
        <dt>Last activity</dt>
        <dd>{worktree.lastActivityAt > 0 ? `${formatAge(now - worktree.lastActivityAt)} ago` : 'None yet'}</dd>
      </dl>
    </div>
  )
}

type RowProps = {
  context: UiPluginContext
  row: ViewRow
  tags: Tag[]
  rowFact: RowFact
  selected: boolean
  multi: boolean
  collapsed: boolean
  renameDone: { current: boolean }
  renaming: boolean
  suspendHover: boolean
  pendingAsks: number
  checks: ChecksState | null
  sessions: Session[] | null
  statusLabel: string
  projectLabel: string
  orchestrationWorkers: readonly OrchestrationWorkerRow[]
  loop?: LoopProjection
  now: number
  showNotes: boolean
  automationExpanded: boolean
  automationAvailability: AutomationAvailabilitySnapshot | null
  onClick(event: MouseEvent<HTMLButtonElement>): void
  onToggleFold(): void
  onToggleAutomationDetails(): void
  onMenu(worktree: Worktree, x: number, y: number, returnFocusTo?: HTMLElement, originRow?: HTMLElement): void
  onRenameCommit(name: string): void
  onRenameCancel(): void
  onDragStart(worktree: Worktree, event: DragEvent<HTMLLIElement>): void
  onDragEnd(): void
}

function WorktreeRowView({
  context,
  row,
  tags,
  rowFact,
  selected,
  multi,
  collapsed,
  renaming,
  renameDone,
  suspendHover,
  pendingAsks,
  checks,
  sessions,
  statusLabel,
  projectLabel,
  orchestrationWorkers,
  loop,
  now,
  showNotes,
  automationExpanded,
  automationAvailability,
  onClick,
  onToggleFold,
  onToggleAutomationDetails,
  onMenu,
  onRenameCommit,
  onRenameCancel,
  onDragStart,
  onDragEnd
}: RowProps) {
  const { worktree, depth, mark, childCount, childAttention } = row
  const [rowElement, setRowElement] = useState<HTMLElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armHover = () => {
    if (hoverTimer.current !== null) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      setHovered(true)
    }, HOVER_CARD_DELAY_MS)
  }
  const disarmHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHovered(false)
  }
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
  }, [])

  const sleeping = worktree.sleeping
  const fact = row.inSectionFromProject ?? factOf(worktree, rowFact, now, statusLabel)
  const open = selected || multi
  const className = [
    'worktree',
    'ui-tree-item',
    'ui-indent',
    open && 'selected',
    worktree.removing && 'removing',
    sleeping && 'sleeping'
  ].filter(Boolean).join(' ')
  const heimdall = heimdallStatusOf(worktree)
  const avatar = avatarStatusOf(worktree)
  const provenance = worktree.automationProvenance?.kind === 'created-by-automation'
    ? worktree.automationProvenance
    : null
  const availability = provenance !== null &&
    automationAvailability?.worktreeId === worktree.id &&
    automationAvailability.automationId === provenance.automationId &&
    automationAvailability.runId === provenance.runId
      ? automationAvailability
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
  const childLabel = `${childCount} ${childCount === 1 ? 'child' : 'children'} of ${worktree.name}${childAttention === 'error' ? ', one errored' : childAttention === 'waiting' ? ', one waiting on you' : ''}`
  const onRowContextMenu = (event: MouseEvent<HTMLLIElement>) => {
    event.preventDefault()
    disarmHover()
    onMenu(worktree, event.clientX, event.clientY, undefined, event.currentTarget)
  }
  const onMenuButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    disarmHover()
    onMenu(
      worktree,
      bounds.left,
      bounds.bottom,
      event.currentTarget,
      event.currentTarget.closest<HTMLElement>('[data-worktree-id]') ?? undefined
    )
  }

  const finishRename = (value: string | null) => {
    if (renameDone.current) return
    renameDone.current = true
    if (value === null) onRenameCancel()
    else onRenameCommit(value)
  }

  return (
    <li
      className={className}
      data-worktree-id={worktree.id}
      data-parent-id={worktree.parentId ?? ''}
      data-project-group-id={worktree.projectGroupId ?? ''}
      style={{ '--depth': depth } as CSSProperties}
      draggable={worktree.kind === 'git' && !renaming}
      onDragStart={(event) => onDragStart(worktree, event)}
      onDragEnd={onDragEnd}
      onContextMenu={onRowContextMenu}
    >
      <div
        className="worktree-row"
        ref={setRowElement}
        onMouseEnter={armHover}
        onMouseLeave={disarmHover}
        onFocus={armHover}
        onBlur={disarmHover}
      >
        {renaming ? (
          <input
            className="worktree-rename"
            aria-label={`Rename ${worktree.name}`}
            defaultValue={worktree.name}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                finishRename(event.currentTarget.value)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                finishRename(null)
              }
            }}
            onBlur={(event) => finishRename(event.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="worktree-row__main"
            aria-label={`${sleeping ? 'Wake and open' : 'Open'} ${worktree.name}`}
            aria-pressed={selected}
            title={worktree.path}
            onClick={onClick}
          >
            <ActivityMark
              state={mark}
              label={markLabel(mark, pendingAsks)}
              ring={avatar === null ? undefined : avatar.needsYou > 0 ? 'needs-you' : 'accent'}
              title={avatar === null ? undefined : avatarStatusTitle(avatar)}
            />
            <span className="worktree-name ui-name-share ui-text-ellipsis" title={worktree.name}>{avatar ? `Avatar · ${worktree.name}` : worktree.name}</span>
            {worktree.unread ? <UnreadDot /> : loop ? <LoopGlyph label={loop.label} /> : null}
            {heimdall && <HeimdallGlyph status={heimdall} now={now} />}
            <TagChips tags={tags} max={2} nameShare={0.4} />
          </button>
        )}
        {!renaming && provenance && (
          <button
            type="button"
            className="worktree-automation"
            aria-label={`Automation details for ${worktree.id}`}
            aria-expanded={automationExpanded}
            title="Created by automation"
            onClick={onToggleAutomationDetails}
          >
            Auto
          </button>
        )}
        {!renaming && childCount > 0 && (
          <button
            type="button"
            className="worktree-child-toggle"
            data-attention={childAttention}
            aria-expanded={!collapsed}
            aria-label={childLabel}
            onClick={onToggleFold}
          >
            <span className="worktree-chevron" aria-hidden="true">›</span>
            <span className="worktree-child-count">{childCount}</span>
          </button>
        )}
        {!renaming && (
          <span className="worktree-trail">
            <span className="worktree-fact" title={fact}>{fact}</span>
            <span className="worktree-reveal">
              <IconButton
                className="worktree-menu"
                label={`Actions for ${worktree.name}`}
                aria-haspopup="menu"
                onClick={onMenuButtonClick}
              >
                ⋯
              </IconButton>
            </span>
          </span>
        )}
      </div>
      {renaming && <p className="worktree-rename-hint">Enter to save, Esc to cancel. The branch stays {worktree.branch ?? 'as it is'}.</p>}
      <HoverCard anchor={rowElement} open={hovered && !suspendHover && !renaming}>
        <HoverCardBody
          worktree={worktree}
          showNotes={showNotes}
          tags={tags}
          projectLabel={projectLabel}
          statusLabel={statusLabel}
          agent={agentWords(worktree, sessions, now, pendingAsks)}
          checks={checks}
          now={now}
        />
      </HoverCard>
      {provenance && automationExpanded && (
        <section className="automation-detail ui-stack ui-panel-content" role="group" aria-label="Automation details">
          <SectionHeader title="Automation" />
          <p><strong>Automation name:</strong> {provenance.automationName}</p>
          <p><strong>Run:</strong> {provenance.runTitle}</p>
          {(definitionStatus === 'checking' || runHistoryStatus === 'checking') && (
            <div role="status"><NoticeLine>Checking automation availability...</NoticeLine></div>
          )}
          {definitionStatus === 'available' && <p className="ui-text-muted" role="status">Automation available.</p>}
          {runHistoryStatus === 'available' && <p className="ui-text-muted" role="status">Run history available.</p>}
          {definitionStatus === 'missing' && (
            <div role="status"><NoticeLine>Automation no longer available.</NoticeLine></div>
          )}
          {runHistoryStatus === 'missing' && (
            <div role="status"><NoticeLine>Run history no longer available.</NoticeLine></div>
          )}
          {(definitionStatus === 'error' || runHistoryStatus === 'error') && (
            <InlineError message="Automation availability could not be checked." />
          )}
          {(definitionStatus === 'unavailable' || runHistoryStatus === 'unavailable') && (
            <div role="status"><NoticeLine>Automations plugin unavailable.</NoticeLine></div>
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
      <div className="worktree-row">
        <span className="worktree-row__main">
          <ActivityMark state="running" label="Creating" />
          <span className="worktree-name ui-text-ellipsis">{name}</span>
        </span>
        <span className="worktree-trail"><span className="worktree-fact">Creating…</span></span>
      </div>
    </li>
  )
}

type SectionEntry = { kind: 'section'; key: string; sectionId: string; group: ViewGroup | null; members: ViewGroup[]; children: SectionEntry[] }

type Entry =
  | { kind: 'pinned'; key: string; group: ViewGroup }
  | SectionEntry
  | { kind: 'project'; key: string; group: ViewGroup }
  | { kind: 'lane'; key: string; group: ViewGroup }

const projectKeyOf = (group: ViewGroup) => group.key.slice('project:'.length)

/**
 * The top-level blocks the tree draws, in model order. In section-and-project grouping a project
 * joins its section's block, even when the section has no rows of its own and so no group. A
 * section with a parent section nests inside the parent's block, so folding the parent folds it.
 */
function entriesOf(
  model: ViewTree,
  sectionMode: boolean,
  sectionOfRepo: (repoId: string) => string | null,
  emptyRepos: readonly Repo[],
  parentOfSection: (sectionId: string) => string | null
): Entry[] {
  const entries: Entry[] = []
  const sections = new Map<string, SectionEntry>()
  const building = new Set<string>()
  const section = (sectionId: string): SectionEntry => {
    const existing = sections.get(sectionId)
    if (existing) return existing
    building.add(sectionId)
    const parentId = parentOfSection(sectionId)
    // a parent cycle would recurse forever, so the section that closes it stays top-level
    const parent = parentId !== null && !building.has(parentId) ? section(parentId) : null
    building.delete(sectionId)
    const entry: SectionEntry = { kind: 'section', key: `group:${sectionId}`, sectionId, group: null, members: [], children: [] }
    sections.set(sectionId, entry)
    if (parent) parent.children.push(entry)
    else entries.push(entry)
    return entry
  }
  for (const group of model.groups) {
    if (group.kind === 'pinned') entries.push({ kind: 'pinned', key: 'pinned', group })
    else if (sectionMode && group.kind === 'section') section(group.key.slice('section:'.length)).group = group
    else if (group.kind === 'project') {
      const sectionId = sectionMode ? sectionOfRepo(projectKeyOf(group)) : null
      if (sectionId === null) entries.push({ kind: 'project', key: `repo:${projectKeyOf(group)}`, group })
      else section(sectionId).members.push(group)
    } else entries.push({ kind: 'lane', key: group.key, group })
  }
  for (const repo of emptyRepos) {
    const group: ViewGroup = { key: `project:${repo.id}`, kind: 'project', title: repoLabel(repo), attention: 'none', attentionCount: 0, rows: [] }
    const sectionId = sectionMode ? sectionOfRepo(repo.id) : null
    if (sectionId === null) entries.push({ kind: 'project', key: `repo:${repo.id}`, group })
    else section(sectionId).members.push(group)
  }
  return entries
}

const worse = (a: Attention, b: Attention): Attention => (a === 'error' || b === 'error' ? 'error' : a === 'waiting' || b === 'waiting' ? 'waiting' : 'none')

/** The worktree tree the sidebar section draws from a view's `ViewTree`; it never filters or sorts. */
export function Tree({
  context,
  model,
  tagsById,
  rowFact,
  repos,
  groups,
  sessions,
  selectedId,
  multiSelected = EMPTY_SET,
  pendingAsks = null,
  checks,
  pending = [],
  groupBy,
  emptyProjects = false,
  onOpen,
  onSelectToggle,
  onRename,
  onTagsOpen,
  onMenuAction,
  onHandoffToAvatar,
  onGroupAction,
  collapsed,
  onToggleCollapsed,
  projectOrder,
  onReorderProjects,
  automationExpandedId,
  automationAvailability,
  onToggleAutomationDetails,
  now,
  separatorEnabled,
  options = DEFAULT_STOCK_OPTIONS,
  canShowSleeping,
  statusDefinitions,
  projectIdentities,
  allWorktrees = [],
  onReorder = () => {},
  openDialog: legacyOpenDialog,
  requestDelete: legacyRequestDelete,
  onOpenDialog,
  onRequestDelete,
  onDropPreviewChange,
  onSeparatorStateChange,
  loopsByWorktree = EMPTY_LOOP_PROJECTIONS
}: TreeProps) {
  const openDialog = onOpenDialog ?? legacyOpenDialog!
  const requestDelete = onRequestDelete ?? legacyRequestDelete!
  const orchestrationWorkers = useOrchestrationRows(context)
  const showNotes = options.showComment && options.showProperties.includes('notes')
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dropPreview, setDropPreview] = useState<MembershipTarget | null>(null)
  const [stickySections, setStickySections] = useState<ReadonlySet<string>>(new Set())
  const [localCollapsed, setLocalCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const treeRoot = useRef<HTMLDivElement>(null)
  const menuActionFocus = useRef<{ worktreeId: string; allowPinned: boolean; skipRows: boolean; closed: boolean } | null>(null)
  const previousFocusOwner = useRef<HTMLElement | null>(null)
  const draggedWorktree = useRef<Worktree | null>(null)
  const previewRef = useRef<MembershipTarget | null>(null)
  const [renameSession, setRenameSession] = useState<{ worktreeId: string; seq: number } | null>(null)
  const menuRef = useRef<OpenMenu | null>(null)
  const menuSeqRef = useRef(0)
  const renameRef = useRef<{ worktreeId: string; seq: number } | null>(null)
  const renameSeqRef = useRef(0)
  const renameDone = useRef(false)
  const renameFocusRef = useRef<{ seq: number; input: HTMLInputElement } | null>(null)
  const renameFocusRowRef = useRef<HTMLElement | null>(null)
  const requestedMenuRef = useRef<{ targetId: string; trigger?: HTMLElement; originRow?: HTMLElement } | null>(null)
  const treeControlHandlerRef = useRef<{
    context: UiPluginContext
    handler: (args: ScopedUiControlArgs) => boolean
  }>({ context, handler: () => false })
  useEffect(() => {
    const registeredContext = context
    return registerUiControlScope(context, 'tree', (args) => {
      const controller = treeControlHandlerRef.current
      return controller.context === registeredContext ? controller.handler(args) : false
    })
  }, [context])
  useLayoutEffect(() => {
    if (!renameSession) {
      renameFocusRef.current = null
      return
    }
    const previous = renameFocusRef.current
    const newSession = previous?.seq !== renameSession.seq
    const preferred = renameFocusRowRef.current
    let input = renameInputFor(renameSession.worktreeId)
    if (input !== document.activeElement) {
      const previousInput = newSession ? null : previous?.input
      input = previousInput && treeRoot.current?.contains(previousInput)
        ? previousInput
        : preferred?.querySelector<HTMLInputElement>('.worktree-rename') ?? input
    }
    renameFocusRowRef.current = null
    if (!input) return
    if (newSession || previous?.input !== input) renameFocusRef.current = { seq: renameSession.seq, input }
    if (document.activeElement === input) {
      if (newSession) input.select()
      return
    }
    const { selectionStart, selectionEnd, selectionDirection } = input
    input.focus()
    if (newSession) input.select()
    else if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? 'none')
  }, [renameSession, model])
  const installMenu = (next: Omit<OpenMenu, 'seq'> | null) => {
    if (next === null) {
      menuRef.current = null
      setMenu(null)
      return
    }
    const opened = { ...next, seq: menuSeqRef.current + 1 }
    menuSeqRef.current = opened.seq
    menuRef.current = opened
    setMenu(opened)
  }
  const mode: GroupBy = groupBy ?? (options.groupBy === 'project' ? 'section-project' : options.groupBy === 'pr' ? 'pull-request' : options.groupBy)
  const sectionMode = mode === 'section-project'
  const folded = collapsed ?? localCollapsed
  const toggleFold = onToggleCollapsed ?? ((key: string) => {
    setLocalCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  })
  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  const descendantsOf = useMemo(() => canonicalDescendants(allWorktrees), [allWorktrees])
  const sectionOfRepo = useCallback((repoId: string): string | null => {
    const repo = repoById.get(repoId)
    if (!repo) return null
    if (repo.groupId !== null) return groupById.has(repo.groupId) ? repo.groupId : null
    return groups.find((group) => group.repoIds.includes(repo.id))?.id ?? null
  }, [repoById, groupById, groups])
  const emptyRepos = useMemo(() => {
    if (!emptyProjects || (mode !== 'section-project' && mode !== 'project')) return []
    const drawn = new Set(model.groups.filter((group) => group.key.startsWith('project:')).map(projectKeyOf))
    return repos.filter((repo) => !drawn.has(repo.id))
  }, [emptyProjects, mode, model, repos])
  const parentOfSection = useCallback((sectionId: string): string | null => {
    const parentId = groupById.get(sectionId)?.parentId ?? null
    return parentId !== null && parentId !== sectionId && groupById.has(parentId) ? parentId : null
  }, [groupById])
  const entries = useMemo(
    () => entriesOf(model, sectionMode, sectionOfRepo, emptyRepos, parentOfSection),
    [model, sectionMode, sectionOfRepo, emptyRepos, parentOfSection]
  )
  const eligibleBoundaries = useMemo(
    () => projectSeparatorBoundaries(
      entries.filter((entry) => entry.kind !== 'lane' || entry.group.kind !== 'flat').map((entry) => entry.key),
      stickySections,
      separatorEnabled
    ),
    [entries, separatorEnabled, stickySections]
  )

  const pendingHomes = useMemo(() => {
    const homes = new Set<string>()
    const addSection = (entry: SectionEntry) => {
      for (const member of entry.members) homes.add(projectKeyOf(member))
      for (const child of entry.children) addSection(child)
    }
    for (const entry of entries) {
      if (entry.kind === 'project') homes.add(projectKeyOf(entry.group))
      else if (entry.kind === 'section') addSection(entry)
      else if (entry.kind === 'lane' && entry.group.kind === 'flat') for (const create of pending) homes.add(create.repoId)
    }
    return homes
  }, [entries, pending])

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
    const rememberFocusOwner = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || treeRoot.current?.contains(target) || target.closest('[role="menu"]')) return
      previousFocusOwner.current = target
    }
    document.addEventListener('focusin', rememberFocusOwner)
    return () => document.removeEventListener('focusin', rememberFocusOwner)
  }, [])

  useLayoutEffect(() => {
    const pendingFocus = menuActionFocus.current
    if (menu !== null || pendingFocus === null) return
    if (renameSession !== null) {
      menuActionFocus.current = null
      return
    }
    const afterRefresh = pendingFocus.closed
    pendingFocus.closed = true
    if (afterRefresh || pendingFocus.skipRows) menuActionFocus.current = null
    const active = document.activeElement
    if (afterRefresh && active instanceof HTMLElement && active !== document.body && active.isConnected && treeRoot.current?.contains(active)) return

    let pinnedFallback: HTMLButtonElement | null = null
    if (!pendingFocus.skipRows) {
      for (const row of treeRoot.current?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? []) {
        if (row.dataset.worktreeId !== pendingFocus.worktreeId) continue
        const actions = row.querySelector<HTMLButtonElement>('.worktree-menu')
        if (!actions?.isConnected) continue
        if (row.closest('[data-top-level-section="pinned"]')) {
          pinnedFallback ??= actions
          continue
        }
        actions.focus()
        return
      }
      if (pendingFocus.allowPinned && pinnedFallback) {
        pinnedFallback.focus()
        return
      }
    }
    if (previousFocusOwner.current?.isConnected) previousFocusOwner.current.focus()
  }, [menu, model, renameSession])

  useEffect(() => {
    onSeparatorStateChange({ enabled: separatorEnabled, eligibleBoundaries })
  }, [eligibleBoundaries, onSeparatorStateChange, separatorEnabled])

  const updatePreview = (target: MembershipTarget | null) => {
    const previous = previewRef.current
    if (previous?.kind === target?.kind && previous?.id === target?.id) return
    previewRef.current = target
    setDropPreview(target)
    onDropPreviewChange(target)
  }
  useEffect(() => {
    if (sectionMode || previewRef.current === null) return
    previewRef.current = null
    setDropPreview(null)
    onDropPreviewChange(null)
  }, [onDropPreviewChange, sectionMode])

  const resolveAt = (clientX: number, clientY: number, worktree: Worktree): MembershipTarget | null => {
    const root = treeRoot.current
    if (!root || !sectionMode || worktree.kind !== 'git' || repoById.get(worktree.repoId)?.kind !== 'git') return null
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

  const rowElementOf = (worktreeId: string): HTMLElement | null => {
    for (const item of treeRoot.current?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? []) {
      if (item.dataset.worktreeId === worktreeId) return item.querySelector<HTMLElement>('.worktree-row') ?? item
    }
    return null
  }

  const runRowAction = (worktree: Worktree, action: RowAction, arg?: string | null, originRow?: HTMLElement) => {
    if (onMenuAction?.(worktree.id, action, arg) === true) return
    const repo = repoById.get(worktree.repoId)
    switch (action) {
      case 'rename':
        renameFocusRowRef.current = originRow ?? menuRef.current?.originRow ?? rowElementOf(worktree.id)
        void requestTreeControl(worktree.id, 'start-rename')
        break
      case 'tags': {
        const anchor = rowElementOf(worktree.id)
        if (anchor) onTagsOpen?.([worktree.id], anchor)
        break
      }
      case 'move-section': {
        const ownSection = worktree.kind === 'git' && repo?.kind === 'git'
        if (arg === NEW_SECTION) {
          if (ownSection) {
            openDialog({
              kind: 'group',
              action: 'new-worktree',
              worktreeId: worktree.id,
              initialName: `${worktree.name} section`,
              expectedInstanceId: worktree.instanceId,
              expectedProjectGroupId: worktree.projectGroupId
            })
          } else if (repo) {
            openDialog({ kind: 'group', action: 'new', repoId: repo.id })
          }
          break
        }
        const group = arg ? groupById.get(arg) ?? null : null
        if (ownSection) void changeMembership(worktree, group)
        else if (repo) moveProject(repo, group)
        break
      }
      case 'move-status':
        if (arg) void setWorktree(context, worktree.id, { status: arg as Worktree['status'] })
        break
      case 'sleep':
      case 'wake': {
        const sleeping = action === 'sleep'
        const rowRemainsVisible = !sleeping || canShowSleeping(worktree)
        menuActionFocus.current = { worktreeId: worktree.id, allowPinned: rowRemainsVisible, skipRows: !rowRemainsVisible, closed: false }
        void setWorkspaceSleeping(context, worktree.id, sleeping, arg === WITH_DESCENDANTS)
        break
      }
      case 'open-terminal':
      case 'open-changes': {
        const target = action === 'open-terminal' ? 'terminal' : 'changes'
        void currentWindowId(context).then((window) =>
          context.call('quirky.worktree/openIn', { worktree: worktree.id, target, window })
        ).catch((error: unknown) =>
          context.toast(`Could not open ${target}`, error instanceof Error ? error.message : String(error))
        )
        break
      }
      case 'copy-path':
        void requestTreeControl(worktree.id, 'copy-path')
        break
      case 'copy-name':
        void requestTreeControl(worktree.id, 'copy-name')
        break
      case 'set-parent':
        openDialog({ kind: 'parent', worktreeId: worktree.id })
        break
      case 'remove-parent':
        void setWorktree(context, worktree.id, { noParent: true })
        break
      case 'mark-unread':
      case 'mark-read':
        void setWorktree(context, worktree.id, { unread: action === 'mark-unread' })
        break
      case 'pin':
      case 'unpin':
        menuActionFocus.current = { worktreeId: worktree.id, allowPinned: action === 'pin', skipRows: false, closed: false }
        void setWorktree(context, worktree.id, { pinned: action === 'pin' })
        break
      case 'archive': {
        const archived = arg !== UNARCHIVE
        void context.call('quirky.worktree/archive', { worktree: worktree.id, archivedAt: archived ? Date.now() : null }).catch((error: unknown) =>
          context.toast(`Could not ${archived ? 'archive' : 'unarchive'} worktree`, error instanceof Error ? error.message : String(error))
        )
        break
      }
      case 'details':
        openDialog({ kind: 'update', worktreeId: worktree.id })
        break
      case 'delete':
        requestDelete(worktree, descendantsOf.get(worktree.id)?.length ?? 0)
        break
      case 'handoff-avatar':
        onHandoffToAvatar?.([worktree.id])
        break
    }
  }

  const runGroupAction = (group: ViewGroup, action: GroupAction) => {
    if (onGroupAction?.(group, action) === true) return
    const isSection = group.key.startsWith('section:')
    const sectionId = group.key.slice('section:'.length)
    switch (action) {
      case 'new-worktree':
        if (group.key.startsWith('project:')) openDialog({ kind: 'create', repoId: projectKeyOf(group) })
        break
      case 'new-section':
        openDialog({ kind: 'group', action: 'new-section' })
        break
      case 'rename':
        if (isSection) openDialog({ kind: 'group', action: 'rename', groupId: sectionId })
        break
      case 'delete':
        if (isSection) openDialog({ kind: 'group', action: 'delete', groupId: sectionId })
        break
      case 'open-ledger':
        if (isSection) void context.openView('view:quirky.ledger/ledger', { target: { owner: { tier: 'group', id: sectionId } } })
        break
    }
  }

  const openWorkspaceMenu = (
    worktree: Worktree,
    x: number,
    y: number,
    returnFocusTo?: HTMLElement,
    originRow?: HTMLElement
  ) => installMenu({
    targetId: worktree.id,
    x,
    y,
    returnFocusTo,
    originRow,
    label: `Actions for ${worktree.name}`,
    items: workspaceMenu(
      worktree,
      descendantsOf.get(worktree.id)?.length ?? 0,
      groups,
      repoById.get(worktree.repoId),
      (action, arg) => runRowAction(worktree, action, arg, originRow),
      statusDefinitions,
      { handoffToAvatar: onHandoffToAvatar !== undefined }
    )
  })

  const reorderOf = (repo: Repo) => {
    if (options.projectOrderBy !== 'manual' || !onReorderProjects || !projectOrder) return undefined
    const shown = model.groups.filter((group) => group.key.startsWith('project:')).map(projectKeyOf)
    const at = shown.indexOf(repo.id)
    const swap = (neighbor: string | undefined) => {
      if (neighbor === undefined) return null
      return () => {
        const from = projectOrder.indexOf(repo.id)
        const to = projectOrder.indexOf(neighbor)
        if (from < 0 || to < 0) return
        const next = projectOrder.map((id, index) =>
          index === from ? neighbor : index === to ? repo.id : id
        )
        onReorderProjects(next)
      }
    }
    return at < 0 ? undefined : { up: swap(shown[at - 1]), down: swap(shown[at + 1]) }
  }

  const openProjectMenu = (
    repo: Repo,
    x: number,
    y: number,
    returnFocusTo?: HTMLElement,
    originRow?: HTMLElement
  ) => {
    const reorder = reorderOf(repo)
    installMenu({
      targetId: repo.id,
      x,
      y,
      returnFocusTo,
      originRow,
      label: `Actions for ${repoLabel(repo)}`,
      items: projectMenu(repo, groups, {
        openDialog,
        openLedger: () => { void context.openView('view:quirky.ledger/ledger', { target: { owner: { tier: 'project', id: repo.id } } }) },
        moveToGroup: moveProject,
        reorder
      })
    })
  }

  const openGroupMenu = (
    group: ViewGroup,
    projectGroup: ProjectGroup,
    x: number,
    y: number,
    returnFocusTo?: HTMLElement,
    originRow?: HTMLElement
  ) => installMenu({
    targetId: projectGroup.id,
    x,
    y,
    returnFocusTo,
    originRow,
    label: `Actions for group ${projectGroup.name}`,
    items: groupMenu(
      projectGroup,
      (dialog) => {
        if (dialog.kind === 'group' && dialog.action === 'rename') runGroupAction(group, 'rename')
        else if (dialog.kind === 'group' && dialog.action === 'delete') runGroupAction(group, 'delete')
        else openDialog(dialog)
      },
      () => runGroupAction(group, 'open-ledger')
    )
  })

  const commitRename = (worktree: Worktree, name: string) => {
    renameDone.current = true
    if (renameRef.current?.worktreeId === worktree.id) {
      renameRef.current = null
      setRenameSession(null)
    }
    setRenamingId(null)
    const next = name.trim()
    if (next === '' || next === worktree.name) return
    if (onRename) onRename(worktree.id, next)
    else void setWorktree(context, worktree.id, { displayName: next })
  }

  const click = (worktree: Worktree, event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      const rendered = [...new Set([...(treeRoot.current?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? [])].map((row) => row.dataset.worktreeId!))]
      onSelectToggle?.(worktree.id, 'range', rendered)
      return
    }
    if (event.metaKey || event.ctrlKey) {
      onSelectToggle?.(worktree.id, 'toggle')
      return
    }
    onOpen?.(worktree.id)
    void (async () => {
      try {
        const window = await currentWindowId(context)
        await context.call('quirky.worktree/navigate', { worktree: worktree.id, window })
        if (worktree.unread) void setWorktree(context, worktree.id, { unread: false })
      } catch (error) {
        context.toast('Could not open worktree', error instanceof Error ? error.message : String(error))
      }
    })()
  }

  const rowList = (group: ViewGroup, pendingCreates: PendingCreate[] = []) => {
    const showProject = group.kind !== 'project' && group.kind !== 'section'
    const lineage = new Map<number, string>()
    const items = group.rows.flatMap((row): ReactNode[] => {
      const worktree = row.worktree
      for (const depth of lineage.keys()) {
        if (depth >= row.depth) lineage.delete(depth)
      }
      const hidden = [...lineage.values()].some((id) => folded.has(id))
      lineage.set(row.depth, worktree.id)
      if (hidden) return []
      const repo = repoById.get(worktree.repoId)
      const projectName = repo ? repoLabel(repo) : worktree.repoId
      const onRenameCommit = (name: string) => commitRename(worktree, name)
      const onRenameCancel = () => { void requestRenameCancel(worktree.id) }
      return [
        <WorktreeRowView
          key={worktree.id}
          context={context}
          row={showProject && row.inSectionFromProject === undefined ? { ...row, inSectionFromProject: projectName } : row}
          tags={worktree.tagIds.flatMap((id) => tagsById.get(id) ?? [])}
          rowFact={rowFact}
          selected={worktree.id === selectedId}
          multi={multiSelected.has(worktree.id)}
          collapsed={folded.has(worktree.id)}
          renameDone={renameDone}
          renaming={renamingId === worktree.id}
          suspendHover={menu !== null || draggedWorktree.current !== null}
          pendingAsks={pendingAsks?.get(worktree.id) ?? 0}
          checks={checks?.get(worktree.id) ?? null}
          sessions={sessions}
          statusLabel={statusDefinitions.find((status) => status.id === worktree.status)?.label ?? worktree.status}
          projectLabel={projectName}
          orchestrationWorkers={orchestrationWorkers}
          loop={loopsByWorktree.get(worktree.id)}
          now={now}
          showNotes={showNotes}
          automationExpanded={automationExpandedId === worktree.id}
          automationAvailability={automationAvailability?.worktreeId === worktree.id ? automationAvailability : null}
          onClick={(event) => click(worktree, event)}
          onToggleFold={() => requestTreeControl(worktree.id, 'toggle-fold')}
          onToggleAutomationDetails={() => onToggleAutomationDetails(worktree.id)}
          onMenu={(item, x, y, trigger, originRow) =>
            requestContextMenuAt('workspace', item.id, x, y, trigger !== undefined, trigger, originRow)
          }
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
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
      ]
    })
    return [...items, ...pendingCreates.map((create) => <PendingCard key={`pending:${create.repoId}:${create.name}`} name={create.name} />)]
  }

  const header = (props: {
    title: string
    lead?: ReactNode
    tooltip?: string
    className: string
    foldLabel: string
    folded: boolean
    onFold(): void
    attention: Attention
    count: number
    actions?: ReactNode
    repoTarget?: string
    groupTarget?: string
    onContextMenu?(event: MouseEvent<HTMLElement>): void
  }) => (
    <SectionHeader
      className={`repo-header ${props.className}`}
      title={
        <>
          <button
            type="button"
            className="worktree-fold"
            aria-expanded={!props.folded}
            aria-label={`${props.folded ? 'Expand' : 'Collapse'} ${props.foldLabel}`}
            onClick={props.onFold}
          >
            <span className="worktree-chevron" aria-hidden="true">›</span>
          </button>
          {props.lead}
          <span className="project-name ui-text-ellipsis">{props.title}</span>
          {props.count > 0 && (
            <span
              className="worktree-attention"
              data-attention={props.attention}
              role="img"
              aria-label={attentionLabel(props.attention, props.count)}
            >
              {props.count}
            </span>
          )}
        </>
      }
      titleTooltip={props.tooltip}
      onContextMenu={props.onContextMenu}
      actions={props.actions}
      data-repo-target={props.repoTarget}
      data-group-target={props.groupTarget}
    />
  )

  const projectBlock = (group: ViewGroup, topLevel: boolean) => {
    const repoId = projectKeyOf(group)
    const repo = repoById.get(repoId)
    const identity = projectIdentities[repoId]
    const label = repo ? repoLabel(repo) : group.title
    const sectionKey = `repo:${repoId}`
    const isFolded = folded.has(group.key)
    const previewing = dropPreview?.kind === 'repo' && dropPreview.id === repoId
    const className = ['repo', 'ui-stack', 'ui-indent', topLevel && eligibleBoundaries.includes(sectionKey) && 'ui-section-separated'].filter(Boolean).join(' ')
    return (
      <section
        className={className}
        key={group.key}
        data-top-level-section={topLevel ? sectionKey : undefined}
        style={{ '--depth': topLevel ? 0 : 1 } as CSSProperties}
      >
        {header({
          title: `${identity?.icon ? `${identity.icon} ` : ''}${label}`,
          lead: <ProjectTile name={label} color={identity?.color} />,
          tooltip: repo?.path,
          className: 'project-header',
          foldLabel: `project ${label}`,
          folded: isFolded,
          onFold: () => requestTreeControl(group.key, 'toggle-fold'),
          attention: group.attention,
          count: group.attentionCount,
          repoTarget: repoId,
          onContextMenu: repo
            ? (event) => {
                event.preventDefault()
                requestContextMenuAt('project', repo.id, event.clientX, event.clientY, false)
              }
            : undefined,
          actions: (
            <span className="ui-cluster repo-actions">
              {previewing && <Badge tone="accent">Drop worktree here</Badge>}
              {identity?.trackerProject && <Badge>{identity.trackerProject}</Badge>}
              <IconButton
                className="worktree-header-button"
                label={`New worktree in ${label}`}
                title="New worktree"
                onClick={() => requestTreeControl(repoId, 'new-worktree')}
              >
                +
              </IconButton>
              {repo && (
                <IconButton
                  className="worktree-header-button project-menu"
                  label={`Actions for ${label}`}
                  aria-haspopup="menu"
                  onClick={(event) => requestMenuFromButton('project', repo.id, event.currentTarget)}
                >
                  ⋯
                </IconButton>
              )}
            </span>
          )
        })}
        {!isFolded && (
          <ul className="worktree-list ui-tree">{rowList(group, pending.filter((create) => create.repoId === repoId))}</ul>
        )}
      </section>
    )
  }

  const isFolderProject = (member: ViewGroup) => repoById.get(projectKeyOf(member))?.kind === 'folder'

  const sectionAttention = (entry: SectionEntry): { attention: Attention; count: number } => {
    let attention: Attention = entry.group?.attention ?? 'none'
    let count = entry.group?.attentionCount ?? 0
    for (const member of entry.members) {
      attention = worse(attention, member.attention)
      count += member.attentionCount
    }
    for (const child of entry.children) {
      const nested = sectionAttention(child)
      attention = worse(attention, nested.attention)
      count += nested.count
    }
    return { attention, count }
  }
  const sectionViewGroup = (
    entry: SectionEntry,
    title: string,
    attention: Attention,
    count: number
  ): ViewGroup => entry.group ?? {
    key: `section:${entry.sectionId}`,
    kind: 'section',
    title,
    attention,
    attentionCount: count,
    rows: []
  }

  const sectionBlock = (entry: SectionEntry, depth = 0) => {
    const projectGroup = groupById.get(entry.sectionId)
    const title = projectGroup?.name ?? entry.group?.title ?? entry.sectionId
    const { attention, count } = sectionAttention(entry)
    const topLevel = depth === 0
    const isFolded = projectGroup?.collapsed ?? false
    const previewing = dropPreview?.kind === 'group' && dropPreview.id === entry.sectionId
    const className = ['group', 'ui-stack', 'ui-indent', topLevel && eligibleBoundaries.includes(entry.key) && 'ui-section-separated'].filter(Boolean).join(' ')
    const syntheticGroup = sectionViewGroup(entry, title, attention, count)
    return (
      <section className={className} key={entry.key} data-top-level-section={topLevel ? entry.key : undefined} style={{ '--depth': topLevel ? 0 : 1 } as CSSProperties}>
        {header({
          title,
          className: `group-header${previewing ? ' ui-drop-target--active' : ''}`,
          foldLabel: `group ${title}`,
          folded: isFolded,
          onFold: () => {
            void context.call('quirky.repo/groupCollapse', { group: entry.sectionId, collapsed: !isFolded }).catch((error: unknown) => {
              context.toast('Could not collapse group', error instanceof Error ? error.message : String(error))
            })
          },
          attention,
          count,
          groupTarget: entry.sectionId,
          onContextMenu: projectGroup
            ? (event) => {
                event.preventDefault()
                requestContextMenuAt('group', entry.sectionId, event.clientX, event.clientY, false)
              }
            : undefined,
          actions: (
            <span className="ui-cluster">
              {previewing && <Badge tone="accent">Drop worktree here</Badge>}
              <IconButton
                className="worktree-header-button"
                label="New section"
                title="New section"
                onClick={() => requestTreeControl(entry.sectionId, 'new-section')}
              >
                +
              </IconButton>
              {projectGroup && (
                <IconButton
                  className="worktree-header-button group-menu"
                  label={`Actions for group ${projectGroup.name}`}
                  aria-haspopup="menu"
                  onClick={(event) => requestMenuFromButton('group', projectGroup.id, event.currentTarget)}
                >
                  ⋯
                </IconButton>
              )}
            </span>
          )
        })}
        {!isFolded && (
          <>
            {entry.members.filter(isFolderProject).map((member) => projectBlock(member, false))}
            {entry.group && entry.group.rows.length > 0 && <ul className="worktree-list ui-tree">{rowList(entry.group)}</ul>}
            {entry.members.filter((member) => !isFolderProject(member)).map((member) => projectBlock(member, false))}
            {entry.children.map((child) => sectionBlock(child, depth + 1))}
          </>
        )}
      </section>
    )
  }

  const runTreeControl = async (
    target: string,
    operation: string,
    payload: Record<string, unknown> = {}
  ): Promise<boolean> => {
    try {
      const result = await requestUiControl(context, {
        action: 'control',
        scope: 'tree',
        target,
        operation,
        payload
      })
      return result.delivered > 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (operation === 'close-menu') context.log(`${UI_CONTROL_COMMAND} close-menu failed: ${message}`)
      else context.toast('Could not update tree control', message)
      return false
    }
  }

  const requestTreeControl = (
    target: string,
    operation: string,
    payload: Record<string, unknown> = {}
  ) => {
    void runTreeControl(target, operation, payload)
  }

  type MenuKind = 'workspace' | 'project' | 'group'
  const requestContextMenuAt = (
    kind: MenuKind,
    target: string,
    x: number,
    y: number,
    focus: boolean,
    trigger?: HTMLElement,
    originRow?: HTMLElement
  ) => {
    requestedMenuRef.current = { targetId: target, trigger, originRow }
    const operation = kind === 'workspace' ? 'open-workspace-menu' : kind === 'project' ? 'open-project-menu' : 'open-group-menu'
    void runTreeControl(target, operation, { x, y, focus }).then((accepted) => {
      if (!accepted && requestedMenuRef.current?.targetId === target) requestedMenuRef.current = null
    })
  }

  const requestMenuFromButton = (kind: MenuKind, target: string, button: HTMLElement) => {
    const bounds = button.getBoundingClientRect()
    const originRow = button.closest<HTMLElement>('[data-worktree-id]') ?? undefined
    requestContextMenuAt(kind, target, bounds.left, bounds.bottom, true, button, originRow)
  }

  const renameInputFor = (target: string): HTMLInputElement | null => {
    const active = document.activeElement
    const root = treeRoot.current
    if (active instanceof HTMLInputElement && root?.contains(active) &&
      active.classList.contains('worktree-rename') &&
      active.closest<HTMLElement>('[data-worktree-id]')?.dataset.worktreeId === target) return active
    for (const input of root?.querySelectorAll<HTMLInputElement>('.worktree-rename') ?? []) {
      if (input.closest<HTMLElement>('[data-worktree-id]')?.dataset.worktreeId === target) return input
    }
    return null
  }

  const requestRenameCancel = (target: string): Promise<boolean> => {
    const session = renameRef.current
    if (!session || session.worktreeId !== target) return Promise.resolve(false)
    const input = renameInputFor(target)
    renameDone.current = true
    return runTreeControl(target, 'cancel-rename', { seq: session.seq }).then((accepted) => {
      if (!accepted && renameRef.current?.seq === session.seq) {
        if (input?.isConnected) input.focus()
        else renameInputFor(target)?.focus()
        renameDone.current = false
      }
      return accepted
    })
  }

  const visibleTreeEntries = () => {
    const root = treeRoot.current
    const visibleWorktrees = new Set<string>()
    const visibleRepos = new Set<string>()
    const visibleSections = new Set<string>()
    const visibleFoldKeys = new Set<string>()
    if (!root) return { visibleWorktrees, visibleRepos, visibleSections, visibleFoldKeys }

    for (const row of root.querySelectorAll<HTMLElement>('[data-worktree-id]')) {
      if (row.dataset.worktreeId) visibleWorktrees.add(row.dataset.worktreeId)
    }
    for (const header of root.querySelectorAll<HTMLElement>('[data-repo-target]')) {
      if (header.dataset.repoTarget) visibleRepos.add(header.dataset.repoTarget)
    }
    for (const header of root.querySelectorAll<HTMLElement>('[data-group-target]')) {
      if (header.dataset.groupTarget) visibleSections.add(header.dataset.groupTarget)
    }

    const collapsibleWorktrees = new Set<string>()
    for (const group of model.groups) {
      for (const row of group.rows) {
        if (row.childCount > 0) collapsibleWorktrees.add(row.worktree.id)
      }
    }
    for (const target of visibleWorktrees) {
      if (collapsibleWorktrees.has(target)) visibleFoldKeys.add(target)
    }
    if (root.querySelector('[data-top-level-section="pinned"]')) visibleFoldKeys.add('pinned')
    for (const target of visibleRepos) visibleFoldKeys.add(`project:${target}`)
    for (const lane of root.querySelectorAll<HTMLElement>('.worktree-status-lane[data-top-level-section]')) {
      const key = lane.dataset.topLevelSection
      if (key) visibleFoldKeys.add(key)
    }
    return { visibleWorktrees, visibleRepos, visibleSections, visibleFoldKeys }
  }

  const worktreeFor = (target: string): Worktree | null => {
    const current = allWorktrees.find((worktree) => worktree.id === target)
    if (current) return current
    for (const group of model.groups) {
      const row = group.rows.find((item) => item.worktree.id === target)
      if (row) return row.worktree
    }
    return null
  }

  const projectGroupFor = (target: string, source: readonly Entry[] = entries): ViewGroup | null => {
    for (const entry of source) {
      if (entry.kind === 'project' && projectKeyOf(entry.group) === target) return entry.group
      if (entry.kind !== 'section' || groupById.get(entry.sectionId)?.collapsed) continue
      const member = entry.members.find((group) => projectKeyOf(group) === target)
      if (member) return member
      const nested = projectGroupFor(target, entry.children)
      if (nested) return nested
    }
    return null
  }

  const sectionEntryFor = (target: string, source: readonly Entry[] = entries): SectionEntry | null => {
    for (const entry of source) {
      if (entry.kind !== 'section') continue
      if (entry.sectionId === target) return entry
      if (groupById.get(entry.sectionId)?.collapsed) continue
      const nested = sectionEntryFor(target, entry.children)
      if (nested) return nested
    }
    return null
  }

  const menuSourceFor = (
    kind: MenuKind,
    target: string,
    requested: { targetId: string; trigger?: HTMLElement; originRow?: HTMLElement } | null
  ): { anchor: HTMLElement; trigger: HTMLElement | null; originRow?: HTMLElement } | null => {
    const root = treeRoot.current
    if (!root) return null
    if (kind === 'workspace') {
      const rows = [...root.querySelectorAll<HTMLElement>('[data-worktree-id]')].filter((row) => row.dataset.worktreeId === target)
      const requestedRow = requested?.originRow && root.contains(requested.originRow) ? requested.originRow : null
      const anchor = requestedRow ?? rows[0]
      if (!anchor) return null
      const requestedTrigger = requested?.trigger && root.contains(requested.trigger) ? requested.trigger : null
      return {
        anchor,
        trigger: requestedTrigger ?? anchor.querySelector<HTMLElement>('.worktree-menu'),
        originRow: anchor
      }
    }
    const selector = kind === 'project' ? '[data-repo-target]' : '[data-group-target]'
    const attribute = kind === 'project' ? 'repoTarget' : 'groupTarget'
    const anchor = [...root.querySelectorAll<HTMLElement>(selector)].find((item) => item.dataset[attribute] === target)
    if (!anchor) return null
    const action = kind === 'project' ? '.project-menu' : '.group-menu'
    return {
      anchor,
      trigger: anchor.querySelector<HTMLElement>(action),
      originRow: requested?.originRow && root.contains(requested.originRow) ? requested.originRow : undefined
    }
  }

  const parseMenuPayload = (payload: Record<string, unknown>) => {
    if (!hasOnlyKeys(payload, ['x', 'y', 'focus'])) return null
    const hasX = Object.prototype.hasOwnProperty.call(payload, 'x')
    const hasY = Object.prototype.hasOwnProperty.call(payload, 'y')
    const hasFocus = Object.prototype.hasOwnProperty.call(payload, 'focus')
    if (hasX !== hasY) return null
    const xValue = payload.x
    const yValue = payload.y
    if (hasX && (typeof xValue !== 'number' || !Number.isFinite(xValue))) return null
    if (hasY && (typeof yValue !== 'number' || !Number.isFinite(yValue))) return null
    const focusValue = hasFocus ? payload.focus : true
    if (typeof focusValue !== 'boolean') return null
    return {
      focus: focusValue,
      x: typeof xValue === 'number' ? xValue : undefined,
      y: typeof yValue === 'number' ? yValue : undefined,
      hasCoordinates: hasX
    }
  }

  const openMenuControl = (args: ScopedUiControlArgs, kind: MenuKind): boolean => {
    const parsed = parseMenuPayload(args.payload)
    if (!parsed) return false
    const visible = visibleTreeEntries()
    const eligible = kind === 'workspace'
      ? visible.visibleWorktrees.has(args.target)
      : kind === 'project'
        ? visible.visibleRepos.has(args.target)
        : visible.visibleSections.has(args.target)
    if (!eligible) return false
    const requested = requestedMenuRef.current?.targetId === args.target ? requestedMenuRef.current : null
    const source = menuSourceFor(kind, args.target, requested)
    if (!source) return false
    const requestedTrigger = requested?.trigger && treeRoot.current?.contains(requested.trigger) ? requested.trigger : null
    const trigger = parsed.focus ? requestedTrigger ?? source.trigger ?? undefined : undefined
    if (!parsed.hasCoordinates && parsed.focus && !trigger) return false
    let x = parsed.x
    let y = parsed.y
    if (!parsed.hasCoordinates) {
      const bounds = (trigger ?? source.anchor).getBoundingClientRect()
      if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.bottom)) return false
      x = bounds.left
      y = bounds.bottom
    }
    if (x === undefined || y === undefined) return false
    if (requested) requestedMenuRef.current = null
    const originRow = source.originRow
    if (kind === 'workspace') {
      const worktree = worktreeFor(args.target)
      if (!worktree) return false
      openWorkspaceMenu(worktree, x, y, trigger, originRow)
      return true
    }
    if (kind === 'project') {
      const repo = repoById.get(args.target)
      if (!repo) return false
      openProjectMenu(repo, x, y, trigger, originRow)
      return true
    }
    const projectGroup = groupById.get(args.target)
    const entry = sectionEntryFor(args.target)
    if (!projectGroup || !entry) return false
    const title = projectGroup.name ?? entry.group?.title ?? entry.sectionId
    const { attention, count } = sectionAttention(entry)
    openGroupMenu(sectionViewGroup(entry, title, attention, count), projectGroup, x, y, trigger, originRow)
    return true
  }

  const handleTreeControl = (args: ScopedUiControlArgs): boolean => {
    const payload = args.payload
    if (!isPlainPayload(payload)) return false

    if (args.operation === 'close-menu') {
      if (!hasOnlyKeys(payload, ['seq'])) return false
      const hasSeq = Object.prototype.hasOwnProperty.call(payload, 'seq')
      if (hasSeq && !isSequence(payload.seq)) return false
      const current = menuRef.current
      if (!current || current.targetId !== args.target || (hasSeq && current.seq !== payload.seq)) return false
      installMenu(null)
      return true
    }

    if (args.operation === 'open-workspace-menu') return openMenuControl(args, 'workspace')
    if (args.operation === 'open-project-menu') return openMenuControl(args, 'project')
    if (args.operation === 'open-group-menu') return openMenuControl(args, 'group')

    if (args.operation === 'cancel-rename') {
      if (!hasOnlyKeys(payload, ['seq'])) return false
      const hasSeq = Object.prototype.hasOwnProperty.call(payload, 'seq')
      if (hasSeq && !isSequence(payload.seq)) return false
      const session = renameRef.current
      if (!session || session.worktreeId !== args.target) return false
      if (hasSeq && session.seq !== payload.seq) return false
      if (!visibleTreeEntries().visibleWorktrees.has(args.target)) return false
      renameDone.current = true
      renameRef.current = null
      setRenameSession(null)
      setRenamingId(null)
      return true
    }

    if (!hasOnlyKeys(payload, [])) return false
    if (args.operation === 'start-rename') {
      if (!visibleTreeEntries().visibleWorktrees.has(args.target)) return false
      const preferred = renameFocusRowRef.current
      const preferredId = preferred?.closest<HTMLElement>('[data-worktree-id]')?.dataset.worktreeId
      if (!preferred?.isConnected || preferredId !== args.target) renameFocusRowRef.current = rowElementOf(args.target)
      const session = { worktreeId: args.target, seq: renameSeqRef.current + 1 }
      renameSeqRef.current = session.seq
      renameRef.current = session
      renameDone.current = false
      setRenameSession(session)
      setRenamingId(args.target)
      return true
    }

    if (args.operation === 'copy-path' || args.operation === 'copy-name') {
      if (!visibleTreeEntries().visibleWorktrees.has(args.target)) return false
      const worktree = worktreeFor(args.target)
      if (!worktree) return false
      void copyText(context, args.operation === 'copy-path' ? worktree.path : worktree.name)
      return true
    }

    if (args.operation === 'new-worktree') {
      if (!visibleTreeEntries().visibleRepos.has(args.target)) return false
      const group = projectGroupFor(args.target)
      if (!group) return false
      runGroupAction(group, 'new-worktree')
      return true
    }

    if (args.operation === 'new-section') {
      if (!visibleTreeEntries().visibleSections.has(args.target)) return false
      const entry = sectionEntryFor(args.target)
      if (!entry) return false
      const projectGroup = groupById.get(args.target)
      const title = projectGroup?.name ?? entry.group?.title ?? entry.sectionId
      const { attention, count } = sectionAttention(entry)
      runGroupAction(sectionViewGroup(entry, title, attention, count), 'new-section')
      return true
    }

    if (args.operation === 'toggle-fold') {
      if (!visibleTreeEntries().visibleFoldKeys.has(args.target)) return false
      toggleFold(args.target)
      return true
    }

    return false
  }
  const pinnedBlock = (group: ViewGroup) => {
    const isFolded = folded.has('pinned')
    return (
      <section
        className={['pinned', 'ui-stack', eligibleBoundaries.includes('pinned') && 'ui-section-separated'].filter(Boolean).join(' ')}
        key="pinned"
        data-top-level-section="pinned"
      >
        {header({
          title: 'Pinned',
          className: 'pinned-header',
          foldLabel: 'Pinned',
          folded: isFolded,
          onFold: () => requestTreeControl('pinned', 'toggle-fold'),
          attention: group.attention,
          count: group.attentionCount
        })}
        {!isFolded && <ul className="worktree-list ui-tree">{rowList(group)}</ul>}
      </section>
    )
  }

  const laneBlock = (entry: Extract<Entry, { kind: 'lane' }>) => {
    const group = entry.group
    if (group.kind === 'flat') {
      return (
        <ul className="worktree-list ui-tree" key={entry.key}>
          {rowList(group, pending)}
        </ul>
      )
    }
    const isFolded = folded.has(group.key)
    return (
      <section
        className={['worktree-status-lane', 'ui-stack', eligibleBoundaries.includes(entry.key) && 'ui-section-separated'].filter(Boolean).join(' ')}
        key={entry.key}
        data-top-level-section={entry.key}
      >
        {header({
          title: group.title,
          className: 'lane-header',
          foldLabel: group.title,
          folded: isFolded,
          onFold: () => requestTreeControl(group.key, 'toggle-fold'),
          attention: group.attention,
          count: group.attentionCount
        })}
        {!isFolded && <ul className="worktree-list ui-tree">{rowList(group)}</ul>}
      </section>
    )
  }

  const pendingElsewhere = pending.filter((create) => !pendingHomes.has(create.repoId))

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
      if (group) void changeMembership(worktree, group)
    } else {
      void changeMembership(worktree, null)
    }
    updatePreview(null)
  }

  treeControlHandlerRef.current = { context, handler: handleTreeControl }
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
      {pendingElsewhere.length > 0 && (
        <ul className="worktree-list ui-tree">
          {pendingElsewhere.map((create) => <PendingCard key={`pending:${create.repoId}:${create.name}`} name={create.name} />)}
        </ul>
      )}
      {entries.map((entry) => {
        switch (entry.kind) {
          case 'pinned':
            return pinnedBlock(entry.group)
          case 'section':
            return sectionBlock(entry)
          case 'project':
            return projectBlock(entry.group, true)
          case 'lane':
            return laneBlock(entry)
        }
      })}
      {menu && (
        <ContextMenu
          items={menu.items}
          label={menu.label}
          x={menu.x}
          y={menu.y}
          returnFocusTo={menu.returnFocusTo}
          onClose={() => requestTreeControl(menu.targetId, 'close-menu', { seq: menu.seq })}
        />
      )}
    </div>
  )
}
