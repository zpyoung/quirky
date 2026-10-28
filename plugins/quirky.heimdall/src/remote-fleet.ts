import { randomUUID } from 'node:crypto'
import { validateValue, type PluginContext, type RuntimePeer, type RuntimePeerCall, type RuntimePeerStatus, type Schema } from '@quirky/protocol'
import type {
  CommandRequest,
  CommandResult,
  ControlPlane,
  DebugReport,
  FleetAction,
  FleetRow,
  FleetSnapshot,
  OwnerFence,
  WatcherDetail,
  WatcherTarget
} from './control-contracts'
import { fleetBucket, sortFleetRows } from './fleet-selectors'

const ORCHESTRATION = 'quirky.orchestration'
const PEER_LIST = `${ORCHESTRATION}/peerList`
const PEER_STATUS = `${ORCHESTRATION}/peerStatus`
const PEER_CALL = `${ORCHESTRATION}/peerCall`
const READ_TIMEOUT_MS = 15_000
const REMOTE_POLL_MS = 15_000
const REMOTE_RETRY_MS = 1_000
const FLEET_METHOD = 'quirky.heimdall/remoteFleet'
const DETAIL_METHOD = 'quirky.heimdall/remoteDetail'
const DEBUG_METHOD = 'quirky.heimdall/remoteDebugReport'
const COMMAND_METHOD = 'quirky.heimdall/remoteCommand'
const FLEET_EVENT = 'fleetChanged'

export interface LocalFleetApi {
  fleet(): Promise<FleetSnapshot>
  detail(target: WatcherTarget): Promise<WatcherDetail | null>
  debugReport(target: WatcherTarget): Promise<DebugReport | null>
}

export interface RemoteFleetTransport {
  fleet(): Promise<FleetSnapshot>
  detail(target: WatcherTarget): Promise<WatcherDetail | null>
  debugReport(target: WatcherTarget): Promise<DebugReport | null>
  command(request: CommandRequest, expectedIncarnation?: string): Promise<CommandResult>
  publish(watcherId?: string): Promise<void>
  dispose(): void
}

type PeerCache = {
  peer: RuntimePeer
  incarnation: string | null
  reachable: boolean
  rows: FleetRow[]
  actionHistory: FleetAction[]
  details: Map<string, WatcherDetail>
}

type PeerErrorReason = Extract<CommandResult, { kind: 'refused' }>['reason']
class PeerError extends Error {
  constructor(readonly reason: PeerErrorReason, message: string) {
    super(message)
    this.name = 'PeerError'
  }
}
const recordSchema: Schema = { type: 'object', additionalProperties: true }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const localTarget = (target: WatcherTarget): boolean =>
  (target.connectionId === undefined || target.connectionId === null) &&
  (target.pairingRevision === undefined || target.pairingRevision === null)

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (validateValue(recordSchema, value) !== null) return null
  return value as Record<string, unknown>
}

function targetAddress(target: WatcherTarget): { peerId: string; pairingRevision: number } | null {
  if (!nonEmpty(target.connectionId) || !Number.isSafeInteger(target.pairingRevision) || (target.pairingRevision as number) < 1) return null
  return { peerId: target.connectionId, pairingRevision: target.pairingRevision as number }
}

function peerValue(value: unknown): value is RuntimePeer {
  const peer = parseRecord(value)
  return peer !== null && nonEmpty(peer.id) && nonEmpty(peer.label) && nonEmpty(peer.endpoint) &&
    nonEmpty(peer.fingerprint) && Number.isSafeInteger(peer.pairingRevision) && (peer.pairingRevision as number) >= 1
}

function parsePeerList(value: unknown): RuntimePeer[] {
  const inventory = parseRecord(value)
  if (!inventory || !Array.isArray(inventory.peers) || !inventory.peers.every(peerValue)) {
    throw new PeerError('owner-unreachable', 'Orchestration returned an invalid paired-peer inventory.')
  }
  const peers = inventory.peers as RuntimePeer[]
  if (new Set(peers.map(peer => peer.id)).size !== peers.length) {
    throw new PeerError('owner-unreachable', 'Orchestration returned duplicate paired-peer identities.')
  }
  return peers
}

function validStatus(value: unknown, peer: RuntimePeer): value is RuntimePeerStatus {
  const status = parseRecord(value)
  return status !== null && status.fingerprint === peer.fingerprint && nonEmpty(status.incarnation) &&
    Array.isArray(status.capabilities) && status.capabilities.every(nonEmpty)
}

function runnerStatus(value: unknown): value is FleetRow['status'] {
  const status = parseRecord(value)
  return status !== null && ['watching', 'acting', 'held', 'escalated', 'parked', 'terminal', 'disabled', 'unreachable', 'malformed'].includes(String(status.state)) &&
    (status.reason === undefined || typeof status.reason === 'string') &&
    (status.detail === undefined || typeof status.detail === 'string') &&
    (status.nextPulseAtMs === null || finite(status.nextPulseAtMs)) &&
    Number.isSafeInteger(status.consecutiveErrors) && Number.isSafeInteger(status.consecutiveGateHolds)
}

function validOwnerFence(value: unknown): value is OwnerFence {
  const owner = parseRecord(value)
  return owner !== null && nonEmpty(owner.executionHostId) && nonEmpty(owner.schedulerOwner) && nonEmpty(owner.workspaceKey) &&
    Number.isSafeInteger(owner.revision) && (owner.revision as number) >= 0
}

function validEnrollment(value: unknown): value is FleetRow['enrollment'] {
  const enrollment = parseRecord(value)
  const budget = parseRecord(enrollment?.budget)
  const capabilities = parseRecord(enrollment?.capabilities)
  const coordinator = parseRecord(enrollment?.coordinator)
  if (!enrollment || !budget || !capabilities || !coordinator) return false
  return nonEmpty(enrollment.watcherId) && nonEmpty(enrollment.kind) && nonEmpty(enrollment.workspaceKey) && nonEmpty(enrollment.workspacePath) &&
    nonEmpty(enrollment.executionHostId) && nonEmpty(enrollment.schedulerOwner) && typeof enrollment.enabled === 'boolean' &&
    typeof enrollment.paused === 'boolean' && Number.isSafeInteger(enrollment.commandRevision) &&
    (budget.wallClockActiveMs === null || (finite(budget.wallClockActiveMs) && budget.wallClockActiveMs >= 0)) &&
    (budget.turns === null || (Number.isSafeInteger(budget.turns) && (budget.turns as number) >= 0)) &&
    nonEmpty(coordinator.handle) && nonEmpty(coordinator.paneKey) &&
    (enrollment.orchestrationRunId === null || typeof enrollment.orchestrationRunId === 'string') && finite(enrollment.createdAtMs) &&
    (enrollment.terminalAtMs === null || finite(enrollment.terminalAtMs)) &&
    (enrollment.parkReason === null || typeof enrollment.parkReason === 'string') &&
    (enrollment.haltReason === null || typeof enrollment.haltReason === 'string')
}

function isLocalWireTarget(value: unknown, watcherId: string): boolean {
  const target = parseRecord(value)
  return target !== null && target.watcherId === watcherId &&
    (target.connectionId === undefined || target.connectionId === null) &&
    (target.pairingRevision === undefined || target.pairingRevision === null)
}

function sameOwnerFence(left: OwnerFence, right: OwnerFence): boolean {
  return left.executionHostId === right.executionHostId && left.schedulerOwner === right.schedulerOwner &&
    left.workspaceKey === right.workspaceKey && left.revision === right.revision
}


function copyEnrollment(value: FleetRow['enrollment']): FleetRow['enrollment'] {
  return {
    watcherId: value.watcherId,
    kind: value.kind,
    workspaceKey: value.workspaceKey,
    workspacePath: value.workspacePath,
    executionHostId: value.executionHostId,
    schedulerOwner: value.schedulerOwner,
    ...(value.repoId === undefined ? {} : { repoId: value.repoId }),
    ...(value.worktreeId === undefined ? {} : { worktreeId: value.worktreeId }),
    kindPayload: value.kindPayload,
    ...(value.undo === undefined ? {} : { undo: value.undo }),
    ...(value.owner === undefined ? {} : { owner: value.owner }),
    ...(value.ownerInterventionCapability === undefined ? {} : { ownerInterventionCapability: value.ownerInterventionCapability }),
    enabled: value.enabled,
    paused: value.paused,
    commandRevision: value.commandRevision,
    capabilities: value.capabilities,
    budget: value.budget,
    coordinator: { handle: value.coordinator.handle, paneKey: value.coordinator.paneKey },
    orchestrationRunId: value.orchestrationRunId,
    createdAtMs: value.createdAtMs,
    terminalAtMs: value.terminalAtMs,
    parkReason: value.parkReason,
    haltReason: value.haltReason,
    ...(value.malformed === undefined ? {} : { malformed: value.malformed })
  }
}

function copyRunnerStatus(value: FleetRow['status']): FleetRow['status'] {
  return {
    state: value.state,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    nextPulseAtMs: value.nextPulseAtMs,
    consecutiveErrors: value.consecutiveErrors,
    consecutiveGateHolds: value.consecutiveGateHolds
  }
}

function validFleetRow(value: unknown): value is FleetRow {
  const row = parseRecord(value)
  if (!row) return false
  const enrollmentValue = row.enrollment
  const enrollmentRecord = parseRecord(enrollmentValue)
  const ownerFence = row.ownerFence
  const budget = parseRecord(row.budget)
  if (!enrollmentRecord || !nonEmpty(enrollmentRecord.watcherId)) return false
  if (!isLocalWireTarget(row.target, enrollmentRecord.watcherId) || !validEnrollment(enrollmentValue)) return false
  if (!validOwnerFence(ownerFence) || !runnerStatus(row.status) || !budget) return false
  const enrollment = enrollmentValue
  return ownerFence.executionHostId === enrollment.executionHostId && ownerFence.schedulerOwner === enrollment.schedulerOwner &&
    ownerFence.workspaceKey === enrollment.workspaceKey && ownerFence.revision === enrollment.commandRevision &&
    nonEmpty(row.name) && typeof row.workspaceName === 'string' && (row.branch === null || typeof row.branch === 'string') &&
    (row.phase === null || typeof row.phase === 'string') && (row.ownerContact === 'live' || row.ownerContact === 'unverifiable') &&
    finite(row.observedAtMs) && (row.lastSuccessfulTickAtMs === null || finite(row.lastSuccessfulTickAtMs)) &&
    finite(budget.activeMs) && finite(budget.turns) &&
    (budget.exhausted === null || typeof budget.exhausted === 'string') &&
    Number.isSafeInteger(row.runningWorkers) && (row.runningWorkers as number) >= 0 &&
    (row.maxConcurrency === null || (Number.isSafeInteger(row.maxConcurrency) && (row.maxConcurrency as number) >= 1)) &&
    Array.isArray(row.openEscalations) && row.openEscalations.every(value => parseRecord(value) !== null) && typeof row.pendingQuestion === 'boolean'
}

function copyFleetRow(row: FleetRow, peer: RuntimePeer, incarnation: string): FleetRow {
  return {
    target: { watcherId: row.enrollment.watcherId, connectionId: peer.id, pairingRevision: peer.pairingRevision },
    ownerFence: { ...row.ownerFence },
    enrollment: copyEnrollment(row.enrollment),
    status: copyRunnerStatus(row.status),
    name: row.name,
    workspaceName: row.workspaceName,
    branch: row.branch,
    phase: row.phase,
    ownerContact: row.ownerContact,
    observedAtMs: row.observedAtMs,
    lastSuccessfulTickAtMs: row.lastSuccessfulTickAtMs,
    budget: { ...row.budget },
    runningWorkers: row.runningWorkers,
    maxConcurrency: row.maxConcurrency,
    openEscalations: row.openEscalations.map(escalation => ({ ...escalation })),
    pendingQuestion: row.pendingQuestion,
    ownerLabel: peer.label,
    ownerIncarnation: incarnation
  }
}

function copyFleetAction(value: unknown, peer: RuntimePeer): FleetAction {
  const action = parseRecord(value)
  if (!action || !nonEmpty(action.watcherId) || !nonEmpty(action.watcherName) || !nonEmpty(action.attemptId) ||
    !finite(action.atMs) || !nonEmpty(action.actionKind) || !['attempted', 'running', 'settled'].includes(String(action.state)) ||
    (action.effect !== undefined && !['landed', 'not-landed', 'indeterminate'].includes(String(action.effect))) ||
    (action.reason !== undefined && typeof action.reason !== 'string')) {
    throw new PeerError('owner-unreachable', 'The peer returned an invalid fleet action projection.')
  }
  return {
    watcherId: action.watcherId,
    watcherName: action.watcherName,
    attemptId: action.attemptId,
    atMs: action.atMs,
    actionKind: action.actionKind,
    state: action.state as FleetAction['state'],
    ...(action.effect === undefined ? {} : { effect: action.effect as FleetAction['effect'] }),
    ...(action.reason === undefined ? {} : { reason: action.reason as string }),
    target: { watcherId: action.watcherId, connectionId: peer.id, pairingRevision: peer.pairingRevision },
    ownerLabel: peer.label
  }
}

function projectFleetSnapshot(value: unknown, peer: RuntimePeer, status: RuntimePeerStatus): { rows: FleetRow[]; actionHistory: FleetAction[] } {
  const snapshot = parseRecord(value)
  if (!snapshot || !finite(snapshot.generatedAtMs) || !Array.isArray(snapshot.rows) || !snapshot.rows.every(validFleetRow) ||
    !Array.isArray(snapshot.actionHistory)) {
    throw new PeerError('owner-unreachable', 'The peer returned an invalid Heimdall fleet snapshot.')
  }
  const rows = (snapshot.rows as FleetRow[]).map(row => copyFleetRow(row, peer, status.incarnation))
  const rowIds = new Set(rows.map(row => row.target.watcherId))
  if (rowIds.size !== rows.length) throw new PeerError('owner-unreachable', 'The peer returned duplicate local Heimdall watcher IDs.')
  const actionHistory = snapshot.actionHistory.map(action => copyFleetAction(action, peer))
  return { rows, actionHistory }
}

function validDetail(value: unknown, watcherId: string): value is WatcherDetail {
  const detail = parseRecord(value)
  if (!detail) return false
  const enrollment = detail.enrollment
  const ownerFence = detail.ownerFence
  const budget = parseRecord(detail.budget)
  if (!isLocalWireTarget(detail.target, watcherId) || !validEnrollment(enrollment)) return false
  if (!validOwnerFence(ownerFence) || !budget) return false
  return enrollment.watcherId === watcherId &&
    ownerFence.executionHostId === enrollment.executionHostId &&
    ownerFence.schedulerOwner === enrollment.schedulerOwner &&
    ownerFence.workspaceKey === enrollment.workspaceKey &&
    ownerFence.revision === enrollment.commandRevision &&
    typeof detail.readOnly === 'boolean' && (detail.ownerContact === 'live' || detail.ownerContact === 'unverifiable') &&
    (detail.status === null || runnerStatus(detail.status)) &&
    finite(budget.activeMs) && finite(budget.turns) &&
    (budget.exhausted === null || typeof budget.exhausted === 'string') &&
    finite(detail.observedAtMs) && nonEmpty(detail.name) && Array.isArray(detail.journal) && Array.isArray(detail.traces) &&
    Array.isArray(detail.workers) && Array.isArray(detail.openEscalations) && Array.isArray(detail.pendingControls)
}

function copyDetail(value: WatcherDetail, peer: RuntimePeer, incarnation: string): WatcherDetail {
  return {
    readOnly: value.readOnly,
    enrollment: copyEnrollment(value.enrollment),
    status: value.status === null ? null : copyRunnerStatus(value.status),
    journal: value.journal.map(entry => ({ ...entry })),
    traces: value.traces.map(trace => ({ ...trace })),
    summary: value.summary,
    budget: { ...value.budget },
    target: { watcherId: value.enrollment.watcherId, connectionId: peer.id, pairingRevision: peer.pairingRevision },
    ownerFence: { ...value.ownerFence },
    ownerContact: value.ownerContact,
    observedAtMs: value.observedAtMs,
    name: value.name,
    workers: value.workers.map(worker => ({ ...worker, identity: { ...worker.identity } })),
    openEscalations: value.openEscalations.map(escalation => ({ ...escalation })),
    pendingControls: [...value.pendingControls],
    ownerLabel: peer.label,
    ownerIncarnation: incarnation
  }
}

function validDebugReport(value: unknown, watcherId: string): value is DebugReport {
  const report = parseRecord(value)
  if (!report) return false
  const enrollment = report.enrollment
  const budget = parseRecord(report.budget)
  const pointers = parseRecord(report.pointers)
  return report.schemaVersion === 2 && finite(report.generatedAtMs) &&
    validEnrollment(enrollment) && enrollment.watcherId === watcherId &&
    (report.status === null || runnerStatus(report.status)) &&
    (report.runner === null || runnerStatus(report.runner)) &&
    budget !== null && finite(budget.activeMs) && finite(budget.turns) &&
    (budget.exhausted === null || typeof budget.exhausted === 'string') &&
    Array.isArray(report.ledger) && Array.isArray(report.traces) && Array.isArray(report.pendingControls) &&
    Array.isArray(report.workers) && pointers !== null &&
    typeof pointers.database === 'string' && typeof pointers.workspace === 'string' &&
    (report.openInterval === null || parseRecord(report.openInterval) !== null)
}
function copyDebugReport(report: DebugReport): DebugReport {
  return {
    schemaVersion: report.schemaVersion,
    generatedAtMs: report.generatedAtMs,
    enrollment: copyEnrollment(report.enrollment),
    status: report.status === null ? null : copyRunnerStatus(report.status),
    budget: { ...report.budget },
    openInterval: report.openInterval === null ? null : { ...report.openInterval },
    ledger: report.ledger.map(entry => ({ ...entry })),
    traces: report.traces.map(trace => ({ ...trace })),
    pendingControls: [...report.pendingControls],
    malformed: report.malformed,
    workers: report.workers.map(worker => ({ ...worker, identity: { ...worker.identity } })),
    runner: report.runner === null ? null : copyRunnerStatus(report.runner),
    pointers: {
      database: report.pointers.database,
      workspace: report.pointers.workspace,
      leaseHolder: report.pointers.leaseHolder
    }
  }
}
function refusal(reason: PeerErrorReason, detail: string): CommandResult {
  return { kind: 'refused', reason, detail }
}

function unreachableStatus(status: FleetRow['status']): FleetRow['status'] {
  return {
    ...status,
    state: 'unreachable',
    reason: 'owner-contact-unverifiable',
    detail: 'Remote owner contact is unverifiable; showing the last confirmed state.',
    nextPulseAtMs: null
  }
}

function staleRow(row: FleetRow): FleetRow {
  return { ...row, status: unreachableStatus(row.status), ownerContact: 'unverifiable' }
}

function staleDetail(detail: WatcherDetail): WatcherDetail {
  return {
    ...detail,
    status: detail.status === null ? unreachableStatus({ state: 'unreachable', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }) : unreachableStatus(detail.status),
    ownerContact: 'unverifiable'
  }
}

function validCommandResult(value: unknown): value is CommandResult {
  const result = parseRecord(value)
  if (!result) return false
  if (result.kind === 'applied') return finite(result.appliedAtMs)
  if (result.kind === 'indeterminate') return typeof result.detail === 'string'
  return result.kind === 'refused' && typeof result.reason === 'string' && typeof result.detail === 'string'
}


export function createRemoteFleetTransport(
  context: PluginContext,
  local: LocalFleetApi,
  controls: ControlPlane,
  now: () => number = Date.now
): RemoteFleetTransport {
  const caches = new Map<string, PeerCache>()
  let disposed = false
  let latestLocal: FleetSnapshot | null = null
  let lastGeneratedAtMs = -1
  let readInFlight: Promise<PeerCache[]> | null = null
  let publishRevision = 0
  let pollInFlight = false
  let peerInventoryUnreachable = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined

  const cacheFor = (peer: RuntimePeer): PeerCache => {
    const previous = caches.get(peer.id)
    if (previous && (previous.peer.pairingRevision !== peer.pairingRevision || previous.peer.fingerprint !== peer.fingerprint)) {
      caches.delete(peer.id)
    }
    const cache = caches.get(peer.id)
    if (cache) {
      cache.peer = peer
      return cache
    }
    const created: PeerCache = { peer, incarnation: null, reachable: false, rows: [], actionHistory: [], details: new Map() }
    caches.set(peer.id, created)
    return created
  }

  const currentPeers = async (): Promise<RuntimePeer[]> => {
    let inventory: unknown
    try {
      inventory = await withReadTimeout(() => context.call(PEER_LIST, {}), READ_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof PeerError) throw error
      throw new PeerError('owner-unreachable', errorDetail(error))
    }
    const peers = parsePeerList(inventory)
    const present = new Set(peers.map(peer => peer.id))
    for (const peerId of caches.keys()) if (!present.has(peerId)) caches.delete(peerId)
    for (const peer of peers) cacheFor(peer)
    return peers
  }

  const peerStatus = async (peer: RuntimePeer): Promise<RuntimePeerStatus> => {
    let value: unknown
    try {
      value = await context.call(PEER_STATUS, { peerId: peer.id, pairingRevision: peer.pairingRevision })
    } catch (error) {
      if (error instanceof PeerError) throw error
      throw new PeerError('owner-unreachable', errorDetail(error))
    }
    if (!validStatus(value, peer)) {
      const cache = caches.get(peer.id)
      if (cache) caches.delete(peer.id)
      throw new PeerError('owner-conflict', 'The peer fingerprint or status identity no longer matches the paired owner.')
    }
    return value
  }

  const requireCapability = (status: RuntimePeerStatus, method: string): void => {
    if (!status.capabilities.includes(method)) {
      throw new PeerError('unsupported-capability', `The paired owner does not advertise ${method}.`)
    }
  }

  const peerCall = async (peer: RuntimePeer, status: RuntimePeerStatus, method: string, params: Record<string, unknown>, requestId?: string): Promise<unknown> => {
    requireCapability(status, method)
    const call: RuntimePeerCall = {
      peerId: peer.id,
      pairingRevision: peer.pairingRevision,
      method,
      params,
      timeoutMs: READ_TIMEOUT_MS,
      ...(requestId === undefined ? {} : { requestId })
    }
    const callParams: Record<string, unknown> = {
      peerId: call.peerId,
      pairingRevision: call.pairingRevision,
      method: call.method,
      params: call.params,
      timeoutMs: call.timeoutMs,
      ...(call.requestId === undefined ? {} : { requestId: call.requestId })
    }
    let replyValue: unknown
    try {
      replyValue = await context.call(PEER_CALL, callParams)
    } catch (error) {
      if (error instanceof PeerError) throw error
      throw new PeerError('owner-unreachable', errorDetail(error))
    }
    const reply = parseRecord(replyValue)
    if (!reply || !peerValue(reply.peer)) {
      throw new PeerError('owner-conflict', 'The peer response could not be matched to the paired owner.')
    }
    if (reply.peer.id !== peer.id || reply.peer.pairingRevision !== peer.pairingRevision || reply.peer.fingerprint !== peer.fingerprint) {
      caches.delete(peer.id)
      throw new PeerError('owner-conflict', 'The peer pin or pairing revision changed during the read.')
    }
    if (!validStatus(reply.status, peer) || reply.status.incarnation !== status.incarnation) {
      throw new PeerError('owner-conflict', 'The peer response no longer matches the confirmed paired owner incarnation.')
    }
    return reply.result
  }

  const refreshOne = async (peer: RuntimePeer): Promise<PeerCache> => {
    const cache = cacheFor(peer)
    cache.reachable = false
    try {
      const fresh = await withReadTimeout(async () => {
        const status = await peerStatus(peer)
        requireCapability(status, FLEET_METHOD)
        const result = await peerCall(peer, status, FLEET_METHOD, {})
        return { status, projection: projectFleetSnapshot(result, peer, status) }
      }, READ_TIMEOUT_MS)
      if (disposed) return cache
      if (cache.incarnation !== null && cache.incarnation !== fresh.status.incarnation) cache.details.clear()
      cache.peer = peer
      cache.incarnation = fresh.status.incarnation
      cache.reachable = true
      cache.rows = fresh.projection.rows
      cache.actionHistory = fresh.projection.actionHistory
    } catch {
      const current = caches.get(peer.id)
      if (current) {
        current.reachable = false
        return current
      }
      return cacheFor(peer)
    }
    return cache
  }

  const refreshPeers = async (): Promise<PeerCache[]> => {
    if (readInFlight) return readInFlight
    const refresh = async (): Promise<PeerCache[]> => {
      let peers: RuntimePeer[]
      try {
        peers = await currentPeers()
        peerInventoryUnreachable = false
      } catch {
        peerInventoryUnreachable = true
        for (const cache of caches.values()) cache.reachable = false
        return [...caches.values()]
      }
      return Promise.all(peers.map(refreshOne))
    }
    const pending = refresh()
    readInFlight = pending
    try {
      return await pending
    } finally {
      if (readInFlight === pending) readInFlight = null
    }
  }

  const mergedSnapshot = (localSnapshot: FleetSnapshot, peers: PeerCache[]): FleetSnapshot => {
    const remoteRows = peers.flatMap(cache => cache.reachable ? cache.rows : cache.rows.map(staleRow))
    const remoteActions = peers.flatMap(cache => cache.actionHistory)
    const rows = sortFleetRows([...localSnapshot.rows, ...remoteRows])
    const actionHistory = [...localSnapshot.actionHistory, ...remoteActions].sort((left, right) =>
      right.atMs - left.atMs || left.watcherName.localeCompare(right.watcherName) ||
      left.watcherId.localeCompare(right.watcherId) || left.attemptId.localeCompare(right.attemptId)
    ).slice(0, 30)
    const buckets = { needsYou: 0, lostContact: 0, active: 0, inactive: 0 }
    let activeCount = 0
    for (const row of rows) {
      buckets[fleetBucket(row)]++
      if (row.enrollment.enabled && !row.enrollment.paused &&
        row.status.state !== 'parked' && row.status.state !== 'terminal' && row.status.state !== 'disabled') activeCount++
    }
    lastGeneratedAtMs = Math.max(now(), localSnapshot.generatedAtMs, lastGeneratedAtMs + 1)
    return {
      generatedAtMs: lastGeneratedAtMs,
      rows,
      actionHistory,
      buckets,
      activeCount,
      attentionCount: buckets.needsYou
    }
  }

  const readFleet = async (refreshLocal: boolean): Promise<FleetSnapshot> => {
    if (disposed) throw new Error('Heimdall remote fleet transport is disposed')
    if (refreshLocal || latestLocal === null) latestLocal = await local.fleet()
    return mergedSnapshot(latestLocal, await refreshPeers())
  }

  const resolvePeer = async (target: WatcherTarget): Promise<{ peer: RuntimePeer; cache: PeerCache }> => {
    const address = targetAddress(target)
    if (!address) throw new PeerError('invalid-command', 'A remote Heimdall target needs a paired connection and revision.')
    const peers = await currentPeers()
    const peer = peers.find(candidate => candidate.id === address.peerId)
    if (!peer) throw new PeerError('owner-unreachable', 'The paired Heimdall owner is no longer available.')
    if (peer.pairingRevision !== address.pairingRevision) {
      throw new PeerError('stale-revision', 'The paired Heimdall owner pairing revision changed; refresh the fleet.')
    }
    return { peer, cache: cacheFor(peer) }
  }


  const staleCachedDetail = (target: WatcherTarget): WatcherDetail | null => {
    const address = targetAddress(target)
    if (!address) return null
    const cache = caches.get(address.peerId)
    if (!cache || cache.peer.pairingRevision !== address.pairingRevision) return null
    const detail = cache.details.get(target.watcherId)
    return detail ? staleDetail(detail) : null
  }

  const remoteDetail = async (target: WatcherTarget): Promise<WatcherDetail | null> => {
    let peer: RuntimePeer
    let cache: PeerCache
    try {
      ({ peer, cache } = await resolvePeer(target))
    } catch (error) {
      const cached = staleCachedDetail(target)
      if (cached && error instanceof PeerError && error.reason === 'owner-unreachable') return cached
      throw error
    }
    try {
      const fresh = await withReadTimeout(async () => {
        const status = await peerStatus(peer)
        requireCapability(status, DETAIL_METHOD)
        const value = await peerCall(peer, status, DETAIL_METHOD, { target: { watcherId: target.watcherId } })
        return { status, value }
      }, READ_TIMEOUT_MS)
      const { status, value } = fresh
      if (value === null) return null
      if (!validDetail(value, target.watcherId)) throw new PeerError('owner-unreachable', 'The peer returned an invalid watcher detail projection.')
      if (cache.incarnation !== null && cache.incarnation !== status.incarnation) cache.details.clear()
      cache.incarnation = status.incarnation
      const result = copyDetail(value, peer, status.incarnation)
      cache.details.set(target.watcherId, result)
      return result
    } catch (error) {
      const cached = staleCachedDetail(target)
      if (cached) return cached
      throw error
    }
  }

  const remoteDebugReport = async (target: WatcherTarget): Promise<DebugReport | null> => {
    const { peer } = await resolvePeer(target)
    const fresh = await withReadTimeout(async () => {
      const status = await peerStatus(peer)
      requireCapability(status, DEBUG_METHOD)
      const value = await peerCall(peer, status, DEBUG_METHOD, { target: { watcherId: target.watcherId } })
      return { status, value }
    }, READ_TIMEOUT_MS)
    const { value } = fresh
    if (value === null) return null
    if (!validDebugReport(value, target.watcherId)) throw new PeerError('owner-unreachable', 'The peer returned an invalid debug report.')
    return copyDebugReport(value)
  }

  const remoteCommand = async (request: CommandRequest, expectedIncarnation?: string): Promise<CommandResult> => {
    const address = targetAddress(request.target)
    if (!address) return refusal('invalid-command', 'A remote Heimdall command needs a paired connection and revision.')
    if (!nonEmpty(expectedIncarnation)) return refusal('owner-conflict', 'A confirmed daemon incarnation is required for a remote control.')
    let peer: RuntimePeer
    let cache: PeerCache
    try {
      ({ peer, cache } = await resolvePeer(request.target))
      const confirmed = cache.rows.find(row => row.target.watcherId === request.target.watcherId) ?? cache.details.get(request.target.watcherId)
      if (!confirmed || !sameOwnerFence(confirmed.ownerFence, request.expectedOwner) || cache.incarnation !== expectedIncarnation) {
        return refusal('owner-conflict', 'The owner fence no longer matches the last confirmed remote snapshot.')
      }
      const status = await withReadTimeout(() => peerStatus(peer), READ_TIMEOUT_MS)
      if (status.incarnation !== expectedIncarnation) {
        return refusal('owner-conflict', 'The paired daemon incarnation changed; refresh the watcher before controlling it.')
      }
      requireCapability(status, COMMAND_METHOD)
      const requestId = randomUUID()
      const params = {
        target: { watcherId: request.target.watcherId },
        expectedOwner: request.expectedOwner,
        expectedIncarnation,
        command: request.command,
        requestId
      }
      const call: RuntimePeerCall = {
        peerId: peer.id,
        pairingRevision: peer.pairingRevision,
        method: COMMAND_METHOD,
        params,
        requestId
      }
      const callParams: Record<string, unknown> = {
        peerId: call.peerId,
        pairingRevision: call.pairingRevision,
        method: call.method,
        params: call.params,
        requestId: call.requestId
      }
      let replyValue: unknown
      try {
        replyValue = await context.call(PEER_CALL, callParams)
      } catch (error) {
        return { kind: 'indeterminate', detail: `The remote command reply could not be confirmed: ${errorDetail(error)}` }
      }
      const reply = parseRecord(replyValue)
      if (!reply || !peerValue(reply.peer) || !validStatus(reply.status, peer) ||
        reply.peer.id !== peer.id || reply.peer.pairingRevision !== peer.pairingRevision ||
        reply.peer.fingerprint !== peer.fingerprint || reply.status.incarnation !== expectedIncarnation ||
        !validCommandResult(reply.result)) {
        return { kind: 'indeterminate', detail: 'The remote command response could not be verified against the paired owner incarnation.' }
      }
      return reply.result
    } catch (error) {
      if (error instanceof PeerError) return refusal(error.reason, error.message)
      return refusal('owner-unreachable', errorDetail(error))
    }
  }

  const service: RemoteFleetTransport = {
    fleet: () => readFleet(true),
    detail: target => localTarget(target) ? local.detail(target) : remoteDetail(target),
    debugReport: target => localTarget(target) ? local.debugReport(target) : remoteDebugReport(target),
    command: (request, expectedIncarnation) => localTarget(request.target)
      ? controls.command(request)
      : remoteCommand(request, expectedIncarnation),
    async publish() {
      if (disposed) return
      const ticket = ++publishRevision
      try {
        const snapshot = await readFleet(true)
        if (!disposed && ticket === publishRevision) context.emit(FLEET_EVENT, snapshot)
      } catch (error) {
        if (!disposed && ticket === publishRevision) context.log(`Heimdall fleet publish failed: ${errorDetail(error)}`)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      publishRevision++
      clearTimeout(pollTimer)
      caches.clear()
      latestLocal = null
    }
  }

  const schedulePoll = (delayMs: number): void => {
    if (disposed) return
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      if (disposed) return
      if (pollInFlight) {
        schedulePoll(REMOTE_RETRY_MS)
        return
      }
      pollInFlight = true
      const ticket = ++publishRevision
      void readFleet(latestLocal === null).then(snapshot => {
        if (!disposed && ticket === publishRevision) context.emit(FLEET_EVENT, snapshot)
      }).catch(error => {
        if (!disposed && ticket === publishRevision) context.log(`Heimdall remote fleet poll failed: ${errorDetail(error)}`)
      }).finally(() => {
        pollInFlight = false
        if (disposed) return
        const hasUnreachablePeer = peerInventoryUnreachable || [...caches.values()].some(cache => !cache.reachable)
        schedulePoll(hasUnreachablePeer ? REMOTE_RETRY_MS : REMOTE_POLL_MS)
      })
    }, delayMs)
    if (typeof pollTimer === 'object' && pollTimer !== null && 'unref' in pollTimer) pollTimer.unref()
  }

  schedulePoll(REMOTE_POLL_MS)
  return service
}

async function withReadTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const { promise, reject } = Promise.withResolvers<T>()
  const timer = setTimeout(
    () => reject(new PeerError('owner-unreachable', `Remote Heimdall read timed out after ${timeoutMs} ms.`)),
    timeoutMs
  )
  try {
    return await Promise.race([operation(), promise])
  } finally {
    clearTimeout(timer)
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
