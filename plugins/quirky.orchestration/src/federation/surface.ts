import { randomUUID } from 'node:crypto'
import type { PluginContext } from '@quirky/protocol'
import type { CoordinatorAuthority, DispatchId, MutationResult, RuntimeCallerEvidence } from '../contracts'
import type { OrchestrationWorkerCore } from '../worker-integration'
import type {
  FederationBinding, FederationEngine, FederationSurface
} from './contracts'
import type {
  WorkerControlParams, WorkerControlResult, WorkerFleetRow, WorkerListParams, WorkerListResult,
  WorkerReadParams, WorkerReadResult, WorkerShowResult
} from '../worker-contracts'
import type { RuntimePeerReply } from '@quirky/protocol'
import { isRecord } from './guards'

const READ_CURSOR_PREFIX = 'owfr1_'
const FLEET_CURSOR_PREFIX = 'owff1_'
const MAX_READ_CURSOR_CHARS = 8_192
const MAX_FLEET_CURSOR_CHARS = 2_048
const DEFAULT_FLEET_PAGE_SIZE = 100
const HOST_FLEET_PAGE_SIZE = 50
const MAX_HOST_FLEET_PAGES = 6
const MAX_FLEET_SNAPSHOTS = 8
const FLEET_SNAPSHOT_TTL_MS = 5 * 60 * 1_000


type RemoteReadCursor = {
  version: 1
  bindingId: string
  homeDispatchId: string
  hostDispatchId: string
  peerId: string
  peerFingerprint: string
  pairingRevision: number
  hostIncarnation: string
  sessionId: string
  processIncarnation: string
  processRuntimeEpoch: string
  sourceIdentity: string
  cursor: string
}
type FleetCursor = { version: 1; snapshotId: string; offset: number }
type FleetFilter = {
  requestedRunId: string | null
  terminalState: WorkerListParams['terminalState'] | null
  callerSessionId: string | null
}
type FederationFleetSnapshot = {
  id: string
  filter: FleetFilter
  scope: WorkerListResult['scope']
  rows: readonly WorkerFleetRow[]
  bindings: ReadonlyMap<DispatchId, FederationBinding>
  partialHostErrors: readonly { host: string; reason: string }[]
  createdAt: number
  expiresAt: number
}


function federationError(context: PluginContext, kind: 'invalid-params' | 'not-found' | 'conflict', reason: string): Error {
  return Object.assign(context.error(kind, reason), { data: { reason } })
}

function decodeJson(value: string, prefix: string): unknown {
  return JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8')) as unknown
}

function remoteReadCursor(value: string | undefined, binding: FederationBinding, context: PluginContext): RemoteReadCursor | null {
  if (value === undefined) return null
  if (value.length > MAX_READ_CURSOR_CHARS || !value.startsWith(READ_CURSOR_PREFIX)) {
    throw federationError(context, 'invalid-params', 'cursor_invalid')
  }
  try {
    const decoded = decodeJson(value, READ_CURSOR_PREFIX)
    if (!isRecord(decoded) || decoded.version !== 1 || decoded.bindingId !== binding.id ||
      decoded.homeDispatchId !== binding.homeDispatchId || decoded.hostDispatchId !== binding.hostDispatchId ||
      decoded.peerId !== binding.peer.id || decoded.peerFingerprint !== binding.peer.fingerprint ||
      decoded.pairingRevision !== binding.peer.pairingRevision || decoded.hostIncarnation !== binding.peerIncarnation ||
      decoded.sessionId !== binding.sessionId || decoded.processIncarnation !== binding.processIncarnation ||
      decoded.processRuntimeEpoch !== binding.processRuntimeEpoch || typeof decoded.sourceIdentity !== 'string' ||
      decoded.sourceIdentity.length === 0 || typeof decoded.cursor !== 'string' || decoded.cursor.length === 0) {
      throw new Error('invalid cursor')
    }
    return decoded as unknown as RemoteReadCursor
  } catch {
    throw federationError(context, 'invalid-params', 'cursor_invalid')
  }
}

function encodeRemoteReadCursor(cursor: Omit<RemoteReadCursor, 'version'>): string {
  return `${READ_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ version: 1, ...cursor }), 'utf8').toString('base64url')}`
}

function encodeFleetCursor(snapshotId: string, offset: number): string {
  return `${FLEET_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ version: 1, snapshotId, offset }), 'utf8').toString('base64url')}`
}

function decodeFleetCursor(value: string, context: PluginContext): FleetCursor {
  if (value.length > MAX_FLEET_CURSOR_CHARS || !value.startsWith(FLEET_CURSOR_PREFIX)) {
    throw federationError(context, 'invalid-params', 'cursor_invalid')
  }
  try {
    const decoded = decodeJson(value, FLEET_CURSOR_PREFIX)
    if (!isRecord(decoded) || decoded.version !== 1 || typeof decoded.snapshotId !== 'string' ||
      typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error('invalid cursor')
    }
    return decoded as unknown as FleetCursor
  } catch {
    throw federationError(context, 'invalid-params', 'cursor_invalid')
  }
}

export function isFederationFleetCursor(value: string | undefined): boolean {
  return value !== undefined && value.startsWith(FLEET_CURSOR_PREFIX)
}

function bindingIdentityMatches(left: FederationBinding, right: FederationBinding): boolean {
  return left.id === right.id && left.side === right.side && left.homeDispatchId === right.homeDispatchId &&
    left.hostDispatchId === right.hostDispatchId && left.peer.id === right.peer.id &&
    left.peer.fingerprint === right.peer.fingerprint && left.peer.pairingRevision === right.peer.pairingRevision &&
    left.peerIncarnation === right.peerIncarnation && left.sessionId === right.sessionId &&
    left.processIncarnation === right.processIncarnation && left.processRuntimeEpoch === right.processRuntimeEpoch
}

function currentBinding(engine: FederationEngine, binding: FederationBinding): FederationBinding | null {
  const current = engine.home(binding.homeDispatchId)
  return current && bindingIdentityMatches(binding, current) ? current : null
}

function assertRemoteReply(binding: FederationBinding, reply: RuntimePeerReply, context: PluginContext): unknown {
  if (reply.peer.id !== binding.peer.id || reply.peer.fingerprint !== binding.peer.fingerprint ||
    reply.peer.pairingRevision !== binding.peer.pairingRevision || reply.status.fingerprint !== binding.peer.fingerprint ||
    reply.status.incarnation !== binding.peerIncarnation) {
    throw federationError(context, 'conflict', 'peer_incarnation_changed')
  }
  return reply.result
}

async function remoteCall(
  engine: FederationEngine,
  binding: FederationBinding,
  method: string,
  params: Record<string, unknown>,
  context: PluginContext,
  requestId?: string
): Promise<unknown> {
  await engine.assertBinding(binding)
  const current = currentBinding(engine, binding)
  if (!current) throw federationError(context, 'conflict', 'federation_binding_changed')
  const reply = await engine.remote(binding, method, params, requestId)
  const result = assertRemoteReply(binding, reply, context)
  if (!currentBinding(engine, binding)) throw federationError(context, 'conflict', 'federation_binding_changed')
  return result
}

function mapResource(resource: WorkerShowResult['terminalResource'] | WorkerFleetRow['resource'], binding: FederationBinding) {
  if (!resource) return null
  const hostDispatchId = binding.hostDispatchId
  const homeDispatchId = binding.homeDispatchId
  const remap = (id: DispatchId): DispatchId => id === hostDispatchId ? homeDispatchId : id
  return {
    ...resource,
    originDispatchId: remap(resource.originDispatchId),
    ownerDispatchId: remap(resource.ownerDispatchId),
    priorOwnerDispatchIds: resource.priorOwnerDispatchIds.map(remap)
  }
}

function homeOutcome(core: OrchestrationWorkerCore, binding: FederationBinding): WorkerShowResult['projection']['outcome'] {
  const dispatch = core.getDispatch(binding.homeDispatchId)
  const task = core.getTask(binding.homeTaskId)
  if (task.result?.kind === 'worker_report' && task.result.dispatchId === dispatch.id) return task.result.outcome
  if (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') return 'failed'
  if (dispatch.status === 'completed') return 'finished_unverified'
  return binding.state === 'unknown' ? 'outcome_unknown' : 'in_progress'
}

function mapShow(value: unknown, binding: FederationBinding, core: OrchestrationWorkerCore, context: PluginContext): WorkerShowResult {
  if (!isRecord(value) || !isRecord(value.dispatch) || value.dispatch.id !== binding.hostDispatchId ||
    !isRecord(value.projection) || !isRecord(value.projection.nextAction) ||
    !Array.isArray(value.projection.nextAction.argv) ||
    !value.projection.nextAction.argv.every((part) => typeof part === 'string') ||
    !isRecord(value.observation) || !isRecord(value.worker) || value.worker.dispatchId !== binding.hostDispatchId) {
    throw federationError(context, 'conflict', 'remote_worker_identity_mismatch')
  }
  const homeDispatch = core.getDispatch(binding.homeDispatchId)
  const homeTask = core.getTask(binding.homeTaskId)
  const hostWorker = value.worker as WorkerShowResult['worker']
  const worker = hostWorker ? {
    ...hostWorker,
    dispatchId: binding.homeDispatchId,
    startOptions: { ...hostWorker.startOptions, runId: binding.homeRunId, taskId: binding.homeTaskId },
    receipt: hostWorker.receipt ? {
      ...hostWorker.receipt,
      runId: binding.homeRunId,
      taskId: binding.homeTaskId,
      dispatchId: binding.homeDispatchId
    } : null
  } : null
  const projection = value.projection as WorkerShowResult['projection']
  const resource = mapResource(value.terminalResource as WorkerShowResult['terminalResource'], binding)
  const nextAction = projection.nextAction
  const argv = nextAction.argv.map((part) => part === binding.hostDispatchId ? binding.homeDispatchId : part)
  return {
    dispatch: homeDispatch,
    worker,
    projection: {
      ...projection,
      id: binding.homeDispatchId,
      parent: homeTask.parentTaskId ? { taskId: homeTask.parentTaskId } : null,
      host: { kind: 'remote', id: binding.peer.id },
      stage: { ...projection.stage, dispatch: homeDispatch.status },
      outcome: homeOutcome(core, binding),
      resource,
      nextAction: { ...nextAction, argv }
    },
    terminal: null,
    observation: {
      ...(value.observation as WorkerShowResult['observation']),
      session: null
    },
    terminalResource: resource
  }
}

function readResult(value: unknown, binding: FederationBinding, context: PluginContext): WorkerReadResult {
  if (!isRecord(value) || value.dispatchId !== binding.hostDispatchId ||
    typeof value.sourceIdentity !== 'string' || value.sourceIdentity.length === 0 ||
    typeof value.nextCursor !== 'string' && value.nextCursor !== null ||
    typeof value.sessionId !== 'string' && value.sessionId !== null) {
    throw federationError(context, 'conflict', 'remote_worker_identity_mismatch')
  }
  if (binding.sessionId !== value.sessionId) throw federationError(context, 'conflict', 'worker_identity_changed')
  return value as unknown as WorkerReadResult
}

function remoteReadResult(result: WorkerReadResult, binding: FederationBinding): WorkerReadResult {
  const nextCursor = result.nextCursor === null ? null : encodeRemoteReadCursor({
    bindingId: binding.id,
    homeDispatchId: binding.homeDispatchId,
    hostDispatchId: binding.hostDispatchId!,
    peerId: binding.peer.id,
    peerFingerprint: binding.peer.fingerprint,
    pairingRevision: binding.peer.pairingRevision,
    hostIncarnation: binding.peerIncarnation,
    sessionId: binding.sessionId!,
    processIncarnation: binding.processIncarnation!,
    processRuntimeEpoch: binding.processRuntimeEpoch!,
    sourceIdentity: result.sourceIdentity,
    cursor: result.nextCursor
  })
  return {
    ...result,
    dispatchId: binding.homeDispatchId,
    nextCursor,
    remote: {
      peerId: binding.peer.id,
      bindingId: binding.id,
      hostDispatchId: binding.hostDispatchId!,
      hostIncarnation: binding.peerIncarnation
    }
  }
}

function remoteUnknownRow(row: WorkerFleetRow, binding: FederationBinding): WorkerFleetRow {
  const resource = mapResource(row.resource, binding)
  return {
    ...row,
    dispatchId: binding.homeDispatchId,
    taskId: binding.homeTaskId,
    runId: binding.homeRunId,
    currentAssignment: false,
    terminalState: row.terminalState === 'released' || row.terminalState === 'retained' ||
      row.terminalState === 'release_pending' || row.terminalState === 'release_unknown'
      ? row.terminalState : 'release_unknown',
    resource,
    projection: {
      ...row.projection,
      id: binding.homeDispatchId,
      host: { kind: 'remote', id: binding.peer.id },
      liveness: { status: 'unverifiable', reason: 'remote_observation_not_requested' },
      evidence: { ...row.projection.evidence, liveStatus: 'unavailable' },
      resource,
      nextAction: { kind: 'none', argv: [] }
    }
  }
}

function remoteObservedRow(home: WorkerFleetRow, host: WorkerFleetRow, binding: FederationBinding): WorkerFleetRow {
  const resource = mapResource(host.resource, binding)
  const hostDispatchId = binding.hostDispatchId
  const homeDispatchId = binding.homeDispatchId
  const nextAction = host.projection.nextAction
  return {
    ...home,
    dispatchId: homeDispatchId,
    taskId: binding.homeTaskId,
    runId: binding.homeRunId,
    workerState: host.workerState,
    currentAssignment: host.currentAssignment,
    dispatchStatus: home.dispatchStatus,
    agentTerminalHandle: host.agentTerminalHandle,
    terminalState: host.terminalState,
    resource,
    projection: {
      ...host.projection,
      id: homeDispatchId,
      parent: home.projection.parent,
      host: { kind: 'remote', id: binding.peer.id },
      stage: { ...host.projection.stage, dispatch: home.dispatchStatus },
      outcome: home.projection.outcome,
      resource,
      nextAction: {
        ...nextAction,
        argv: nextAction.argv.map((part) => part === hostDispatchId ? homeDispatchId : part)
      },
      attention: home.projection.attention
    }
  }
}

function responseList(value: unknown, context: PluginContext): WorkerListResult {
  if (!isRecord(value) || !Array.isArray(value.workers) || !isRecord(value.scope) || !isRecord(value.page) ||
    typeof value.page.snapshotId !== 'string' || typeof value.page.total !== 'number' ||
    value.page.nextCursor !== null && typeof value.page.nextCursor !== 'string' ||
    !Array.isArray(value.partialHostErrors)) {
    throw federationError(context, 'conflict', 'remote_fleet_snapshot_invalid')
  }
  return value as unknown as WorkerListResult
}

function sameFleetFilter(left: FleetFilter, right: FleetFilter): boolean {
  return left.requestedRunId === right.requestedRunId && left.terminalState === right.terminalState &&
    left.callerSessionId === right.callerSessionId
}

function pageSize(params: WorkerListParams, context: PluginContext): number {
  if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
    throw federationError(context, 'invalid-params', 'invalid_limit')
  }
  return params.limit === undefined ? DEFAULT_FLEET_PAGE_SIZE : Math.min(DEFAULT_FLEET_PAGE_SIZE, params.limit)
}

function page(snapshot: FederationFleetSnapshot, offset: number, limit: number): WorkerListResult {
  const end = Math.min(snapshot.rows.length, offset + limit)
  return {
    workers: snapshot.rows.slice(offset, end),
    scope: { ...snapshot.scope },
    page: {
      nextCursor: end < snapshot.rows.length ? encodeFleetCursor(snapshot.id, end) : null,
      snapshotId: snapshot.id,
      total: snapshot.rows.length
    },
    partialHostErrors: [...snapshot.partialHostErrors]
  }
}

export function createFederationSurface(
  context: PluginContext,
  core: OrchestrationWorkerCore,
  engine: FederationEngine
): FederationSurface {
  const snapshots = new Map<string, FederationFleetSnapshot>()

  function pruneSnapshots(now = Date.now()): void {
    for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(id)
  }

  function storeSnapshot(snapshot: FederationFleetSnapshot): void {
    pruneSnapshots()
    if (snapshots.size >= MAX_FLEET_SNAPSHOTS) {
      let oldest: FederationFleetSnapshot | null = null
      for (const current of snapshots.values()) if (!oldest || current.createdAt < oldest.createdAt) oldest = current
      if (oldest) snapshots.delete(oldest.id)
    }
    snapshots.set(snapshot.id, snapshot)
  }

  const bindingFor = (dispatchId: DispatchId): FederationBinding => {
    const binding = engine.home(dispatchId)
    if (!binding || binding.side !== 'home' || binding.homeDispatchId !== dispatchId) {
      throw federationError(context, 'not-found', 'federation_binding_not_found')
    }
    return binding
  }

  async function show(params: { dispatchId: DispatchId }): Promise<WorkerShowResult> {
    const binding = bindingFor(params.dispatchId)
    if (!binding.hostDispatchId) throw federationError(context, 'conflict', 'remote_worker_not_attached')
    const value = await remoteCall(engine, binding, 'quirky.orchestration/federationShow', {
      bindingId: binding.id,
      expectedIncarnation: binding.peerIncarnation
    }, context)
    return mapShow(value, binding, core, context)
  }

  async function read(params: WorkerReadParams): Promise<WorkerReadResult> {
    const binding = bindingFor(params.dispatchId)
    if (!binding.hostDispatchId || !binding.sessionId || !binding.processIncarnation || !binding.processRuntimeEpoch) {
      throw federationError(context, 'conflict', 'remote_worker_not_attached')
    }
    const cursor = remoteReadCursor(params.cursor, binding, context)
    const read: Record<string, unknown> = {}
    if (params.source !== undefined) read.source = params.source
    if (cursor) read.cursor = cursor.cursor
    if (params.limit !== undefined) read.limit = params.limit
    const value = await remoteCall(engine, binding, 'quirky.orchestration/federationRead', {
      bindingId: binding.id,
      expectedIncarnation: binding.peerIncarnation,
      read
    }, context)
    const result = readResult(value, binding, context)
    if (cursor && (result.sourceIdentity !== cursor.sourceIdentity ||
      (params.source !== undefined && params.source !== 'auto' && result.source !== params.source))) {
      throw federationError(context, 'conflict', 'output_source_changed')
    }
    return remoteReadResult(result, binding)
  }

  async function hostRows(binding: FederationBinding): Promise<{ rows: WorkerFleetRow[]; truncated: boolean }> {
    if (!binding.hostRunId) throw federationError(context, 'conflict', 'remote_worker_not_attached')
    const rows: WorkerFleetRow[] = []
    let cursor: string | undefined
    let snapshotId: string | null = null
    let total: number | null = null
    for (let index = 0; index < MAX_HOST_FLEET_PAGES; index++) {
      const fleet: Record<string, unknown> = { runId: binding.hostRunId, limit: HOST_FLEET_PAGE_SIZE }
      if (cursor) fleet.cursor = cursor
      const value = await remoteCall(engine, binding, 'quirky.orchestration/federationFleetSnapshot', {
        bindingId: binding.id,
        expectedIncarnation: binding.peerIncarnation,
        fleet
      }, context)
      const result = responseList(value, context)
      if (snapshotId !== null && (snapshotId !== result.page.snapshotId || total !== result.page.total)) {
        throw federationError(context, 'conflict', 'remote_fleet_snapshot_changed')
      }
      snapshotId = result.page.snapshotId
      total = result.page.total
      rows.push(...result.workers)
      cursor = result.page.nextCursor ?? undefined
      if (!cursor) break
    }
    return { rows, truncated: cursor !== undefined }
  }

  async function list(
    params: WorkerListParams,
    caller: RuntimeCallerEvidence | null,
    local: WorkerListResult
  ): Promise<WorkerListResult> {
    if (params.includeRemote !== true) {
      const workers = local.workers.map((row) => {
        if (row.projection.host.kind === 'remote') {
          const binding = engine.home(row.dispatchId)
          return binding ? remoteUnknownRow(row, binding) : {
            ...row,
            currentAssignment: false,
            terminalState: row.terminalState === 'released' || row.terminalState === 'retained' ||
              row.terminalState === 'release_pending' || row.terminalState === 'release_unknown'
              ? row.terminalState : 'release_unknown',
            projection: {
              ...row.projection,
              liveness: { status: 'unverifiable' as const, reason: 'federation_binding_unavailable' },
              nextAction: { kind: 'none' as const, argv: [] }
            }
          }
        }
        return row
      })
      return { ...local, workers }
    }

    const limit = pageSize(params, context)
    const filter: FleetFilter = {
      requestedRunId: params.runId ?? null,
      terminalState: params.terminalState ?? null,
      callerSessionId: caller?.runtimeSessionId ?? null
    }
    if (params.cursor !== undefined) {
      const cursor = decodeFleetCursor(params.cursor, context)
      pruneSnapshots()
      const snapshot = snapshots.get(cursor.snapshotId)
      if (!snapshot) throw federationError(context, 'invalid-params', 'worker_list_cursor_expired')
      if (!sameFleetFilter(snapshot.filter, filter) || cursor.offset >= snapshot.rows.length) {
        throw federationError(context, 'invalid-params', 'cursor_invalid')
      }
      const rows = snapshot.rows.slice(cursor.offset, cursor.offset + limit).map((row) => {
        const binding = snapshot.bindings.get(row.dispatchId)
        if (!binding) return row
        const current = currentBinding(engine, binding)
        return current ? row : remoteUnknownRow(row, binding)
      })
      const end = Math.min(snapshot.rows.length, cursor.offset + limit)
      return {
        workers: rows,
        scope: { ...snapshot.scope },
        page: { nextCursor: end < snapshot.rows.length ? encodeFleetCursor(snapshot.id, end) : null, snapshotId: snapshot.id, total: snapshot.rows.length },
        partialHostErrors: [...snapshot.partialHostErrors]
      }
    }

    const bindings = engine.bindings('home').filter((binding) => binding.side === 'home' &&
      (local.scope.runId === null || binding.homeRunId === local.scope.runId))
    const bindingsByHome = new Map<DispatchId, FederationBinding>(bindings.map((binding) => [binding.homeDispatchId, binding]))
    const hostBindings = new Map<DispatchId, FederationBinding>()
    const errors = new Map<string, string>()
    const rows = local.workers.map((row) => {
      const binding = bindingsByHome.get(row.dispatchId)
      if (!binding) {
        if (row.projection.host.kind === 'remote') {
          errors.set(row.projection.host.id, 'federation_binding_unavailable')
          return {
            ...row,
            currentAssignment: false,
            terminalState: row.terminalState === 'released' || row.terminalState === 'retained' ||
              row.terminalState === 'release_pending' || row.terminalState === 'release_unknown'
              ? row.terminalState : 'release_unknown',
            projection: { ...row.projection, liveness: { status: 'unverifiable' as const, reason: 'federation_binding_unavailable' }, nextAction: { kind: 'none' as const, argv: [] } }
          }
        }
        return row
      }
      if (!binding.hostDispatchId) {
        errors.set(binding.peer.id, 'remote_worker_not_attached')
        return remoteUnknownRow(row, binding)
      }
      hostBindings.set(binding.hostDispatchId, binding)
      return remoteUnknownRow(row, binding)
    })

    const grouped = new Map<string, FederationBinding[]>()
    for (const binding of hostBindings.values()) {
      const key = `${binding.peer.id}\u0000${binding.hostRunId ?? ''}`
      const group = grouped.get(key) ?? []
      group.push(binding)
      grouped.set(key, group)
    }
    for (const group of grouped.values()) {
      const representative = group[0]
      if (!representative) continue
      try {
        const hostSnapshot = await hostRows(representative)
        if (hostSnapshot.truncated) errors.set(representative.peer.id, 'host_fleet_page_limit')
        const byHostDispatch = new Map(hostSnapshot.rows.map((row) => [row.dispatchId, row]))
        for (const binding of group) {
          const index = rows.findIndex((row) => row.dispatchId === binding.homeDispatchId)
          if (index < 0) continue
          const hostRow = byHostDispatch.get(binding.hostDispatchId!)
          if (!hostRow || hostRow.projection.host.kind !== 'local' ||
            hostRow.taskId !== binding.hostTaskId || hostRow.runId !== binding.hostRunId) {
            errors.set(binding.peer.id, 'host_worker_not_in_snapshot')
            continue
          }
          const current = currentBinding(engine, binding)
          if (!current) {
            errors.set(binding.peer.id, 'federation_binding_changed')
            continue
          }
          rows[index] = remoteObservedRow(rows[index]!, hostRow, binding)
        }
      } catch (error) {
        errors.set(representative.peer.id, error instanceof Error ? error.message : String(error))
      }
    }

    const filtered = params.terminalState === undefined
      ? rows
      : rows.filter((row) => row.projection.host.kind === 'remote' && row.projection.liveness.status === 'unverifiable'
        ? true : row.terminalState === params.terminalState)
    const partialHostErrors = [
      ...local.partialHostErrors,
      ...[...errors].map(([host, reason]) => ({ host, reason }))
    ]
    const uniqueErrors = [...new Map(partialHostErrors.map((error) => [`${error.host}\u0000${error.reason}`, error])).values()]
    const snapshot: FederationFleetSnapshot = {
      id: randomUUID(),
      filter,
      scope: { ...local.scope },
      rows: filtered,
      bindings: new Map([...bindingsByHome].filter(([, binding]) => filtered.some((row) => row.dispatchId === binding.homeDispatchId))),
      partialHostErrors: uniqueErrors,
      createdAt: Date.now(),
      expiresAt: Date.now() + FLEET_SNAPSHOT_TTL_MS
    }
    storeSnapshot(snapshot)
    return page(snapshot, 0, limit)
  }

  async function control(
    action: 'stop' | 'release' | 'retain' | 'abandon',
    params: WorkerControlParams,
    caller: CoordinatorAuthority
  ) {
    const binding = bindingFor(params.dispatchId)
    if (params.runId !== undefined && params.runId !== binding.homeRunId) {
      throw federationError(context, 'conflict', 'dispatch_run_mismatch')
    }
    core.requireCoordinator(caller, binding.homeRunId)
    if (!binding.hostDispatchId || !binding.sessionId || !binding.processIncarnation) {
      throw federationError(context, 'conflict', 'remote_worker_not_attached')
    }
    if (params.expectedIdentity && (params.expectedIdentity.sessionId !== binding.sessionId ||
      params.expectedIdentity.processIncarnation !== binding.processIncarnation)) {
      throw federationError(context, 'conflict', 'worker_identity_changed')
    }
    const value = await remoteCall(engine, binding, `quirky.orchestration/federation${action[0]!.toUpperCase()}${action.slice(1)}`, {
      bindingId: binding.id,
      expectedIncarnation: binding.peerIncarnation,
      control: {
        requestId: params.requestId,
        expectedIdentity: { sessionId: binding.sessionId, processIncarnation: binding.processIncarnation },
        expectedIncarnation: binding.peerIncarnation
      }
    }, context, params.requestId)
    if (!isRecord(value) || !isRecord(value.mutation) || value.dispatchId !== binding.hostDispatchId) {
      throw federationError(context, 'conflict', 'remote_control_result_invalid')
    }
    return { ...value, dispatchId: binding.homeDispatchId } as MutationResult<WorkerControlResult>
  }

  return { show, read, list, control }
}
