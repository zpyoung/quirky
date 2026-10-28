import type { CSSProperties, ReactNode } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'

/** Minimal public workerList shape consumed through UiPluginContext; no orchestration module imports. */
export interface OrchestrationWorkerRow {
  dispatchId: string
  taskId: string
  runId: string
  workerState: string | null
  currentAssignment: boolean
  taskTitle: string
  displayName: string
  coordinatorSessionId: string | null
  parentSessionId: string | null
  dispatchStatus: string
  agentTerminalHandle: string | null
  terminalState: string
  resource: {
    ownerDispatchId: string
    ownershipState: string
    releaseState: string
    worktreeId: string
    sessionId: string
  } | null
  projection: {
    host?: { kind: 'local' | 'remote'; id: string }
    workspace: { id: string } | null
    liveness: { status: 'live' | 'exited' | 'unverifiable'; reason: string | null }
    evidence: { liveStatus: 'fresh' | 'stale' | 'unavailable' | 'redacted_restore'; lastObservedAt: string | null }
    stage: { activity: 'working' | 'blocked' | 'waiting' | 'done' | 'unknown' }
  }
}

type WorkerNode = {
  row: OrchestrationWorkerRow
  worktreeId: string
  sessionId: string | null
  order: number
  parent: WorkerNode | null
  children: WorkerNode[]
}

type CoordinatorGroup = {
  key: string
  coordinatorSessionId: string | null
  runId: string
  roots: WorkerNode[]
}

const SESSION_VIEW = 'view:quirky.session/worktree'
const LIST_STYLE: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }
const ROW_STYLE: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 0,
  color: 'inherit',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.4rem',
  font: 'inherit',
  minHeight: '1.45rem',
  padding: '0 0 0 0.75rem',
  textAlign: 'left',
  width: '100%'
}
const GROUP_STYLE: CSSProperties = { fontSize: '0.86em', margin: '0.12rem 0' }
const STATUS_STYLE: CSSProperties = { opacity: 0.72, whiteSpace: 'nowrap' }
const CUSTODY_STYLE: CSSProperties = { fontSize: '0.9em', opacity: 0.82 }

function coordinatorLabel(session: Session | undefined): string {
  if (!session) return 'Orphaned coordinator'
  const name = session.title.trim() || session.agent
  return `Coordinator · ${name}`
}

function workerLabel(row: OrchestrationWorkerRow, session: Session | undefined): string {
  if (row.currentAssignment) return row.displayName.trim() || row.taskTitle.trim()
  return session ? session.title.trim() || session.agent : 'Worker assignment unverified'
}

function activityLabel(row: OrchestrationWorkerRow, session: Session | undefined): string {
  if (session?.status === 'exited') return 'Exited'
  if (!row.currentAssignment) return 'Assignment unverified'
  if (row.projection.liveness.status === 'exited') return 'Exited'
  if (row.projection.evidence.liveStatus === 'stale') return 'Activity stale'
  if (row.projection.liveness.status !== 'live' || row.projection.evidence.liveStatus !== 'fresh') return 'Activity unknown'
  const activity = row.projection.stage.activity
  if (activity === 'unknown') return 'Activity unknown'
  return `${activity[0]!.toUpperCase()}${activity.slice(1)}`
}

function custodyLabel(row: OrchestrationWorkerRow): string | null {
  const resource = row.resource
  if (!resource) return null
  if (resource.ownershipState === 'user_owned') {
    return resource.releaseState === 'retained' ? 'User-owned · retained' : 'User-owned'
  }
  if (resource.releaseState === 'retained') return 'Retained'
  if (resource.releaseState === 'requested' || resource.releaseState === 'releasing') return 'Releasing'
  if (resource.releaseState === 'unknown') return 'Release unknown'
  if (resource.ownershipState === 'external') return 'External'
  if (resource.ownershipState === 'transferred') return 'Transferred'
  return null
}

function isRemote(row: OrchestrationWorkerRow): boolean {
  return row.projection.host?.kind === 'remote'
}

function latestCurrentNodes(workers: readonly OrchestrationWorkerRow[]): WorkerNode[] {
  const seenTasks = new Set<string>()
  const seenDispatches = new Set<string>()
  const candidates: WorkerNode[] = []

  for (const row of workers) {
    if (seenTasks.has(row.taskId) || seenDispatches.has(row.dispatchId)) continue
    seenTasks.add(row.taskId)
    seenDispatches.add(row.dispatchId)
    if (row.terminalState === 'released') continue
    const resource = row.resource
    if ((row.workerState === null && resource === null) || (resource && (
      resource.ownerDispatchId !== row.dispatchId ||
      resource.ownershipState === 'transferred' ||
      resource.ownershipState === 'released' ||
      resource.releaseState === 'released'
    ))) continue
    const worktreeId = resource?.worktreeId ?? row.projection.workspace?.id
    if (!worktreeId) continue
    const sessionId = resource?.ownerDispatchId === row.dispatchId ? resource.sessionId : row.agentTerminalHandle
    candidates.push({ row, worktreeId, sessionId, order: candidates.length, parent: null, children: [] })
  }

  const exactSessions = new Set(
    candidates.filter((node) => !isRemote(node.row) && node.row.currentAssignment && node.sessionId).map((node) => node.sessionId!)
  )
  const seenSessions = new Set<string>()
  const nodes: WorkerNode[] = []
  for (const node of candidates) {
    const key = node.sessionId ? `${isRemote(node.row) ? node.row.projection.host!.id : 'local'}:${node.sessionId}` : null
    if (!isRemote(node.row) && node.sessionId && !node.row.currentAssignment && exactSessions.has(node.sessionId)) continue
    if (key && seenSessions.has(key)) continue
    if (key) seenSessions.add(key)
    node.order = nodes.length
    nodes.push(node)
  }
  return nodes
}

export function hasInspectableWorkerRows(workers: readonly OrchestrationWorkerRow[]): boolean {
  return latestCurrentNodes(workers).length > 0
}

function breakLineageCycles(nodes: readonly WorkerNode[]): void {
  const settled = new Set<WorkerNode>()
  for (const start of nodes) {
    const path: WorkerNode[] = []
    const seenAt = new Map<WorkerNode, number>()
    let current: WorkerNode | null = start
    while (current && !settled.has(current)) {
      const cycleStart = seenAt.get(current)
      if (cycleStart !== undefined) {
        const root = path.slice(cycleStart).reduce((oldest, node) => node.order < oldest.order ? node : oldest)
        root.parent = null
        break
      }
      seenAt.set(current, path.length)
      path.push(current)
      current = current.parent
    }
    for (const node of path) settled.add(node)
  }
}

function groupsForWorktree(
  worktreeId: string,
  workers: readonly OrchestrationWorkerRow[],
  sessions: readonly Session[]
): { groups: CoordinatorGroup[]; representedSessions: Set<string> } {
  const allNodes = latestCurrentNodes(workers)
  const bySession = new Map<string, WorkerNode>()
  for (const node of allNodes) {
    if (!isRemote(node.row) && node.row.currentAssignment && node.sessionId && !bySession.has(node.sessionId)) bySession.set(node.sessionId, node)
  }
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const nodes = allNodes.filter((node) => isRemote(node.row)
    ? sessionById.get(node.row.coordinatorSessionId ?? '')?.worktreeId === worktreeId
    : node.worktreeId === worktreeId)
  const representedSessions = new Set<string>()
  for (const node of nodes) if (!isRemote(node.row) && node.sessionId) representedSessions.add(node.sessionId)

  for (const node of nodes) {
    const candidates = [node.row.parentSessionId, node.row.coordinatorSessionId]
    const parent = candidates
      .filter((id): id is string => id !== null && id !== node.sessionId)
      .map((id) => bySession.get(id))
      .find((candidate) => candidate !== undefined && candidate.worktreeId === worktreeId)
    node.parent = parent ?? null
  }
  breakLineageCycles(nodes)
  for (const node of nodes) node.children = []
  for (const node of nodes) if (node.parent) node.parent.children.push(node)
  for (const node of nodes) node.children.sort((left, right) => left.order - right.order)

  const groups = new Map<string, CoordinatorGroup>()
  for (const node of nodes) {
    if (node.parent) continue
    const coordinatorSessionId = node.row.coordinatorSessionId ?? node.row.parentSessionId
    const key = coordinatorSessionId ? `session:${coordinatorSessionId}` : `run:${node.row.runId}`
    let group = groups.get(key)
    if (!group) {
      group = { key, coordinatorSessionId, runId: node.row.runId, roots: [] }
      groups.set(key, group)
    }
    group.roots.push(node)
  }
  return { groups: [...groups.values()], representedSessions }
}

type TaskTarget =
  | { taskId: string; dispatchId: string; sessionId: string; worktreeId: string }
  | { kind: 'remote_output'; taskId: string; dispatchId: string; viewId: 'view:quirky.orchestration/remote-worker-output'; input: { dispatchId: string } }

function asTaskTerminal(value: unknown): TaskTarget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    !('taskId' in value) || !('dispatchId' in value)) return null
  const { taskId, dispatchId } = value
  if (typeof taskId !== 'string' || taskId === '' || typeof dispatchId !== 'string' || dispatchId === '') return null
  if ('kind' in value && value.kind === 'remote_output') {
    if (!('viewId' in value) || value.viewId !== 'view:quirky.orchestration/remote-worker-output' ||
      !('input' in value) || value.input === null || typeof value.input !== 'object' ||
      !('dispatchId' in value.input) || value.input.dispatchId !== dispatchId) return null
    return { kind: 'remote_output', taskId, dispatchId, viewId: value.viewId, input: { dispatchId } }
  }
  if (!('sessionId' in value) || !('worktreeId' in value)) return null
  const { sessionId, worktreeId } = value
  if (typeof sessionId !== 'string' || sessionId === '' || typeof worktreeId !== 'string' || worktreeId === '') return null
  return { taskId, dispatchId, sessionId, worktreeId }
}


type Props = {
  context: UiPluginContext
  workers: readonly OrchestrationWorkerRow[]
  sessions: readonly Session[] | null
  worktreeId: string
}

/** Compact worker lineage rows for the current workspace, using only public daemon/UI APIs. */
export function OrchestrationRows({ context, workers, sessions, worktreeId }: Props) {
  const { groups, representedSessions } = groupsForWorktree(worktreeId, workers, sessions ?? [])
  if (groups.length === 0) return null
  const sessionById = new Map((sessions ?? []).map((session) => [session.id, session]))

  const focusCoordinator = (session: Session) => {
    context.openView(SESSION_VIEW, { worktree: session.worktreeId, session: session.id })
  }

  const renderWorker = (node: WorkerNode, depth: number): ReactNode => {
    const { row } = node
    const remote = isRemote(row)
    const session = !remote && node.sessionId ? sessionById.get(node.sessionId) : undefined
    const label = workerLabel(row, session)
    const terminal = row.currentAssignment && row.resource !== null && row.resource.ownerDispatchId === row.dispatchId &&
      session?.kind === 'terminal' && session.worktreeId === row.resource.worktreeId && session.status !== 'exited'
    const status = activityLabel(row, session)
    const custody = custodyLabel(row)
    const children = node.children.length > 0
      ? <ul className="orchestration-worker-children" style={LIST_STYLE}>{node.children.map((child) => renderWorker(child, depth + 1))}</ul>
      : null
    const content = (
      <>
        <span>{label}</span>
        <span className="orchestration-worker-status" style={STATUS_STYLE}> · {status}</span>
        {remote && <span className="orchestration-worker-host" style={STATUS_STYLE}> · {row.projection.host!.id}</span>}
        {custody && <span className="orchestration-worker-custody" style={CUSTODY_STYLE}> · {custody}</span>}
      </>
    )
    return (
      <li className="orchestration-worker-item" key={row.dispatchId} data-lineage-depth={depth + 1} style={GROUP_STYLE}>
        {terminal || remote
          ? <button
              type="button"
              className="orchestration-worker-row"
              aria-label={`Open ${label} ${remote ? 'output' : 'terminal'}`}
              data-visual-depth="1"
              style={ROW_STYLE}
              onClick={() => {
                void context.call('quirky.orchestration/taskTerminal', { taskId: row.taskId }).then((result) => {
                  const target = asTaskTerminal(result)
                  if (!target || target.taskId !== row.taskId) {
                    context.toast('Could not open worker', 'The task no longer has a current inspectable assignment.')
                    return
                  }
                  if (target.dispatchId !== row.dispatchId) {
                    context.toast('Could not open worker terminal', 'The task assignment changed; refresh the sidebar before opening its terminal.')
                    return
                  }
                  if ('kind' in target && target.kind === 'remote_output') {
                    context.openView(target.viewId, target.input)
                  } else if ('sessionId' in target) {
                    context.openView(SESSION_VIEW, { worktree: target.worktreeId, session: target.sessionId })
                  }
                }).catch((error: unknown) => context.toast('Could not open worker terminal', error instanceof Error ? error.message : String(error)))
              }}
            >{content}</button>
          : <span className="orchestration-worker-label" data-visual-depth="1" style={{ ...ROW_STYLE, cursor: 'default' }}>{content}</span>}
        {children}
      </li>
    )
  }

  return (
    <div
      className="orchestration-rows"
      aria-label="Orchestration workers"
      style={{ display: 'block', flexBasis: '100%', fontSize: '0.88em', gridColumn: '1 / -1', margin: '0.08rem 0 0.2rem 1.65rem', width: '100%' }}
    >
      <ul className="orchestration-coordinator-groups" style={LIST_STYLE}>
        {groups.map((group) => {
          const coordinator = group.coordinatorSessionId ? sessionById.get(group.coordinatorSessionId) : undefined
          const coordinatorIsWorker = group.coordinatorSessionId !== null && representedSessions.has(group.coordinatorSessionId)
          const canFocusCoordinator = coordinator?.kind === 'terminal' && coordinator.status !== 'exited'
          return (
            <li className="orchestration-coordinator-group" key={group.key} style={GROUP_STYLE}>
              {!coordinatorIsWorker && (canFocusCoordinator
                ? <button
                    type="button"
                    className="orchestration-coordinator-row"
                    aria-label="Open coordinator terminal"
                    style={{ ...ROW_STYLE, paddingInlineStart: 0 }}
                    onClick={() => focusCoordinator(coordinator)}
                  >{coordinatorLabel(coordinator)}</button>
                : <span className="orchestration-coordinator-label" style={{ ...ROW_STYLE, cursor: 'default', paddingInlineStart: 0 }}>
                    {coordinator ? coordinatorLabel(coordinator) : group.coordinatorSessionId ? 'Orphaned coordinator' : 'Coordinator unavailable'}
                  </span>)}
              <ul className="orchestration-workers" style={LIST_STYLE}>{group.roots.map((node) => renderWorker(node, 0))}</ul>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
