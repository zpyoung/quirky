import { createHash, randomUUID } from 'node:crypto'
import type { PluginCaller, RuntimePeerReply } from '@quirky/protocol'
import type {
  CoordinatorAuthority, DispatchId, DispatchRow, MutationResult, RunId, TaskId,
  WorkerDoneReportInput, WorkerHeartbeatInput,
} from '../contracts'
import type { OrchestrationCore } from '../core'
import type {
  ServiceCoordinatorEvidence, WorkerControlParams, WorkerControlResult, WorkerListParams, WorkerListResult,
  WorkerReadParams, WorkerReadResult, WorkerRecord, WorkerShowResult, WorkerStartParams, WorkerStartReceipt,
} from '../worker-contracts'
import type { WorkerComponents } from '../workers/register'
import { createWorkerStore } from '../workers/store'
import { preflightFederatedWorkerStart } from '../workers/runtime'
import type {
  FederationBinding, FederationEngine, FederationInboundHandler, FederationMail, FederationPeerPrincipal,
  FederationReportAuthority,
} from './contracts'
import { FederationBindingStore } from './binding-store'
import type { PeerManager } from '../peers'
import { fail } from '../errors'

const DEFAULT_REMOTE_TIMEOUT_MS = 15_000
const ATTACH_TIMEOUT_MS = 180_000
const FEDERATION_METHODS = {
  attach: 'quirky.orchestration/federationAttachStart',
  show: 'quirky.orchestration/federationShow',
  read: 'quirky.orchestration/federationRead',
  fleet: 'quirky.orchestration/federationFleetSnapshot',
  stop: 'quirky.orchestration/federationStop',
  release: 'quirky.orchestration/federationRelease',
  retain: 'quirky.orchestration/federationRetain',
  abandon: 'quirky.orchestration/federationAbandon',
} as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type AttachHost = { runId: RunId; taskId: TaskId; dispatchId: DispatchId }
type StartPreparation = {
  peer: { id: string; label: string; endpoint: string; fingerprint: string; pairingRevision: number }
  peerIncarnation: string
  decision: WorkerStartReceipt['mode']
  worktreeId: string | null
  bindingId: string
  requestHash: string
  executionParams: WorkerStartParams
}
type StartRequest = {
  phase: 'start'
  bindingId: string
  requestId: string
  requestHash: string
  expectedIncarnation: string
  home: { runId: RunId; taskId: TaskId; dispatchId: DispatchId }
  task: { spec: string; taskTitle: string; displayName: string }
  preflight: { decision: WorkerStartReceipt['mode']; worktreeId: string | null }
  params: WorkerStartParams
}

type CodedError = Error & { code?: string; data?: unknown }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : null
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!isObject(value)) return JSON.stringify(value) ?? 'null'
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function startInputHash(params: WorkerStartParams): string {
  return createHash('sha256').update(canonical(params)).digest('hex')
}

function setupFor(params: WorkerStartParams): WorkerStartReceipt['setup'] {
  return {
    requested: params.setup ?? 'run',
    effective: 'not_started',
    source: 'federation_preflight',
    hookFound: false,
    startupPolicy: 'unknown',
    state: 'not_applicable',
  }
}

function acceptedReceipt(
  params: WorkerStartParams,
  runId: RunId,
  taskId: TaskId,
  dispatchId: DispatchId,
  mode: WorkerStartReceipt['mode'],
  timeoutMs: number,
): WorkerStartReceipt {
  return {
    runId,
    taskId,
    dispatchId,
    state: 'outcome_unknown',
    stage: 'federation_attaching',
    turnStart: 'unobserved',
    setup: setupFor(params),
    launch: {
      requested: { agent: params.agent ?? null, model: params.model ?? null, effort: params.effort ?? null },
      effective: { agent: params.agent ?? null, model: params.model ?? null, effort: params.effort ?? null },
    },
    mode,
    timeoutMs,
    effects: [],
    residualResources: [],
  }
}

function unknownReceipt(receipt: WorkerStartReceipt, reason: string): WorkerStartReceipt {
  return {
    ...receipt,
    state: 'outcome_unknown',
    stage: 'federation_outcome_unknown',
    lastError: reason,
    warning: 'The paired host may have accepted this worker. Inspect the federation binding before retrying; no local fallback was started.',
  }
}

function asReceipt(value: unknown): WorkerStartReceipt | null {
  if (!isObject(value) || typeof value.runId !== 'string' || typeof value.taskId !== 'string' ||
    typeof value.dispatchId !== 'string' ||
    (value.state !== 'ready' && value.state !== 'failed' && value.state !== 'outcome_unknown')) return null
  return value as unknown as WorkerStartReceipt
}

function asWorkerRecord(value: unknown, hostDispatchId: DispatchId): WorkerRecord | null {
  if (!isObject(value) || value.dispatchId !== hostDispatchId || typeof value.runtimeEpoch !== 'string' ||
    (value.mode !== 'terminal' && value.mode !== 'structured') ||
    (value.state !== 'starting' && value.state !== 'ready' && value.state !== 'start_unknown' &&
      value.state !== 'failed' && value.state !== 'succeeded' && value.state !== 'stopping' &&
      value.state !== 'stop_unknown' && value.state !== 'stopped' && value.state !== 'abandoned')) return null
  if (value.sessionId !== null && typeof value.sessionId !== 'string') return null
  if (value.processIncarnation !== null && typeof value.processIncarnation !== 'string') return null
  if (value.processRuntimeEpoch !== null && typeof value.processRuntimeEpoch !== 'string') return null
  if (!isObject(value.startOptions)) return null
  return value as unknown as WorkerRecord
}

function sameReportAuthority(left: FederationReportAuthority, right: FederationReportAuthority): boolean {
  return left.kind === right.kind && left.dispatchId === right.dispatchId && left.peerId === right.peerId &&
    left.pairingRevision === right.pairingRevision && left.peerFingerprint === right.peerFingerprint &&
    left.hostIncarnation === right.hostIncarnation && left.sessionId === right.sessionId &&
    left.processIncarnation === right.processIncarnation && left.processRuntimeEpoch === right.processRuntimeEpoch
}

function serviceEvidence(pluginId: string, runId: RunId): ServiceCoordinatorEvidence {
  return { kind: 'service', pluginId, runId, authority: 'kernel_plugin' }
}

export interface FederationEnginePort extends FederationEngine {
  bindMail(mail: FederationMail): void
  handle: FederationInboundHandler
  dispose(): Promise<void>
}

/** Real paired host execution and home-owned federation authority over the orchestration store. */
export function createFederationEngine(
  context: OrchestrationCore['context'],
  store: OrchestrationCore['store'],
  core: OrchestrationCore,
  workers: WorkerComponents,
  peers: PeerManager,
): FederationEnginePort {
  if (core.store !== store) throw new Error('Federation engine must use the orchestration core store.')
  const bindings = new FederationBindingStore(context, store)
  const workerStore = createWorkerStore(store)
  let mail: FederationMail | null = null
  let disposed = false
  const hostStarts = new Map<string, Promise<unknown>>()
  const now = (): string => new Date().toISOString()

  const requireActive = (): void => {
    if (disposed) fail(context, 'peer_listener_unavailable', 'Federation engine is deactivated.')
  }

  const requireBinding = (bindingId: unknown, side: FederationBinding['side']): FederationBinding => {
    if (typeof bindingId !== 'string' || bindingId.length === 0) {
      fail(context, 'invalid_argument', 'Federation request requires a bindingId.')
    }
    const binding = bindings.get(bindingId)
    if (!binding || binding.side !== side) {
      fail(context, 'lifecycle_not_found', `Federation binding ${bindingId} is not available on the ${side} side.`, { bindingId })
    }
    return binding
  }

  const assertPrincipal = (binding: FederationBinding, principal: FederationPeerPrincipal): void => {
    bindings.assertPrincipal(binding, principal)
  }

  const ensureBindingIdentity = (binding: FederationBinding): void => {
    if (!binding.hostRunId || !binding.hostTaskId || !binding.hostDispatchId || !binding.sessionId ||
      !binding.processIncarnation || !binding.processRuntimeEpoch) {
      fail(context, 'worker_identity_changed', `Federation binding ${binding.id} has no exact host worker attachment.`, { bindingId: binding.id })
    }
  }

  const mirrorWorker = (binding: FederationBinding, source: WorkerRecord, requireIdentity: boolean): void => {
    if (source.dispatchId !== binding.hostDispatchId || !binding.hostDispatchId || !binding.hostRunId || !binding.hostTaskId) {
      fail(context, 'worker_identity_changed', `Host WorkerRecord does not match federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    if (requireIdentity && (!source.sessionId || !source.processIncarnation || !source.processRuntimeEpoch)) {
      fail(context, 'worker_identity_changed', `Host WorkerRecord has no exact attached process for binding ${binding.id}.`, { bindingId: binding.id })
    }
    if (source.sessionId !== binding.sessionId || source.processIncarnation !== binding.processIncarnation ||
      source.processRuntimeEpoch !== binding.processRuntimeEpoch) {
      fail(context, 'worker_identity_changed', `Host WorkerRecord identity differs from federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    const mirror = { ...source, dispatchId: binding.homeDispatchId }
    const existing = workerStore.get(binding.homeDispatchId)
    if (!existing) {
      workerStore.insert(mirror)
      return
    }
    if ((existing.sessionId !== null && existing.sessionId !== mirror.sessionId) ||
      (existing.processIncarnation !== null && existing.processIncarnation !== mirror.processIncarnation) ||
      (existing.processRuntimeEpoch !== null && existing.processRuntimeEpoch !== mirror.processRuntimeEpoch) ||
      existing.runtimeEpoch !== mirror.runtimeEpoch) {
      fail(context, 'worker_identity_changed', `Home WorkerRecord identity changed for federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    const terminal = existing.state === 'succeeded' || existing.state === 'failed' || existing.state === 'stopped' || existing.state === 'abandoned'
    const incomingIsOlder = terminal && (mirror.state === 'starting' || mirror.state === 'ready' || mirror.state === 'start_unknown')
    if (!incomingIsOlder) workerStore.update(binding.homeDispatchId, mirror)
  }

  const mapHostReceipt = (binding: FederationBinding, receipt: WorkerStartReceipt): WorkerStartReceipt => ({
    ...receipt,
    runId: binding.homeRunId,
    taskId: binding.homeTaskId,
    dispatchId: binding.homeDispatchId,
  })

  const recordHostAttachment = (
    bindingId: string,
    side: FederationBinding['side'],
    host: AttachHost,
    worker: WorkerRecord,
    principal: FederationPeerPrincipal,
    requireIdentity: boolean,
  ): FederationBinding => {
    const binding = requireBinding(bindingId, side)
    const next = bindings.setHostReceipt(binding.id, host, side)
    const identity = {
      runId: host.runId,
      taskId: host.taskId,
      dispatchId: host.dispatchId,
      sessionId: worker.sessionId,
      processIncarnation: worker.processIncarnation,
      processRuntimeEpoch: worker.processRuntimeEpoch,
    }
    if (requireIdentity) {
      if (typeof identity.sessionId !== 'string' || typeof identity.processIncarnation !== 'string' ||
        typeof identity.processRuntimeEpoch !== 'string') {
        fail(context, 'worker_identity_changed', `Host worker identity is incomplete for federation binding ${binding.id}.`, { bindingId })
      }
      const attached = bindings.attach(binding.id, side, {
        runId: host.runId,
        taskId: host.taskId,
        dispatchId: host.dispatchId,
        sessionId: identity.sessionId,
        processIncarnation: identity.processIncarnation,
        processRuntimeEpoch: identity.processRuntimeEpoch,
      })
      mirrorWorker(attached, worker, true)
      if (side === 'home') core.attachFederatedWorkerAuthority(engine.reportAuthority(attached))
      return attached
    }
    mirrorWorker(next, worker, false)
    return next
  }

  const updateHomeStartState = (binding: FederationBinding, receipt: WorkerStartReceipt): void => {
    if (receipt.state === 'outcome_unknown') bindings.setState(binding.id, 'home', 'unknown')
    else if (receipt.state === 'failed') bindings.setState(binding.id, 'home', 'settled')
    else {
      const dispatch = core.getDispatch(binding.homeDispatchId)
      if (dispatch.status === 'pending') {
        core.transitionDispatch({
          dispatchId: dispatch.id, expectedState: 'pending', nextState: 'dispatched', at: now(),
        })
      }
      if (dispatch.status === 'pending' || dispatch.status === 'dispatched') {
        bindings.setState(binding.id, 'home', 'active')
      }
    }
  }

  const settleHomeStartFailure = (binding: FederationBinding): void => {
    const dispatch = core.getDispatch(binding.homeDispatchId)
    if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
      bindings.setState(binding.id, 'home', 'settled')
      return
    }
    core.store.transaction(() => {
      const current = core.getDispatch(binding.homeDispatchId)
      if (current.status === 'pending' || current.status === 'dispatched') {
        core.transitionDispatch({
          dispatchId: current.id,
          expectedState: current.status,
          nextState: 'failed',
          failureClass: 'infrastructure',
          failureReason: 'federated_host_start_failed',
          at: now(),
        })
      }
      bindings.setState(binding.id, 'home', 'settled')
    })
  }

  const hostWorkerShow = async (binding: FederationBinding): Promise<WorkerShowResult> => {
    requireActive()
    if (binding.side !== 'host') fail(context, 'worker_identity_changed', 'Host show requires a local host-side binding.', { bindingId: binding.id })
    ensureBindingIdentity(binding)
    const show = await context.call(`${context.pluginId}/workerShow`, { dispatchId: binding.hostDispatchId }) as WorkerShowResult
    if (!show || show.dispatch.id !== binding.hostDispatchId || show.dispatch.runId !== binding.hostRunId ||
      show.dispatch.taskId !== binding.hostTaskId) {
      fail(context, 'worker_identity_changed', `Host worker show did not match federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    if (!show.worker || show.worker.sessionId !== binding.sessionId || show.worker.processIncarnation !== binding.processIncarnation ||
      show.worker.processRuntimeEpoch !== binding.processRuntimeEpoch) {
      fail(context, 'worker_identity_changed', `Host worker identity changed for federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    return show
  }

  const hostReadLocal = async (binding: FederationBinding, params: WorkerReadParams): Promise<WorkerReadResult> => {
    const show = await hostWorkerShow(binding)
    const dispatchId = binding.hostDispatchId!
    const result = await context.call(`${context.pluginId}/workerRead`, {
      dispatchId,
      ...(params.source !== undefined ? { source: params.source } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    }) as WorkerReadResult
    if (!result || result.dispatchId !== dispatchId || result.sessionId !== binding.sessionId) {
      fail(context, 'worker_identity_changed', `Host output reader returned a different worker for federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    if (!show.worker) fail(context, 'worker_identity_changed', `Host WorkerRecord disappeared for federation binding ${binding.id}.`, { bindingId: binding.id })
    if (show.worker.processIncarnation !== binding.processIncarnation || show.worker.processRuntimeEpoch !== binding.processRuntimeEpoch) {
      fail(context, 'worker_identity_changed', `Host output source changed for federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    return result
  }

  const hostListLocal = async (binding: FederationBinding, params: WorkerListParams): Promise<WorkerListResult> => {
    if (binding.side !== 'host' || !binding.hostRunId) fail(context, 'worker_identity_changed', 'Host fleet snapshot requires a local host-side binding.', { bindingId: binding.id })
    const result = await context.call(`${context.pluginId}/workerList`, {
      ...params,
      runId: binding.hostRunId,
      includeRemote: false,
    }) as WorkerListResult
    if (!result || result.scope.runId !== binding.hostRunId) {
      fail(context, 'worker_identity_changed', `Host fleet snapshot escaped service Run ${binding.hostRunId}.`, { bindingId: binding.id })
    }
    return result
  }

  const hostControlLocal = async (
    binding: FederationBinding,
    action: 'stop' | 'release' | 'retain' | 'abandon',
    params: WorkerControlParams,
  ): Promise<MutationResult<WorkerControlResult>> => {
    if (binding.side !== 'host') fail(context, 'worker_identity_changed', 'Host control requires a local host-side binding.', { bindingId: binding.id })
    ensureBindingIdentity(binding)
    if (params.dispatchId !== binding.hostDispatchId || (params.runId !== undefined && params.runId !== binding.hostRunId)) {
      fail(context, 'worker_identity_changed', `Control identity does not match federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    if (params.expectedIdentity && (params.expectedIdentity.sessionId !== binding.sessionId ||
      params.expectedIdentity.processIncarnation !== binding.processIncarnation)) {
      fail(context, 'worker_identity_changed', `Control expected identity does not match federation binding ${binding.id}.`, { bindingId: binding.id })
    }
    core.requireOwnedRun(context.pluginId, binding.hostRunId!)
    const principal = serviceEvidence(context.pluginId, binding.hostRunId!)
    core.requireCoordinator(principal, binding.hostRunId!)
    const result = await workers.lifecycle[action]({
      ...params,
      runId: binding.hostRunId!,
      dispatchId: binding.hostDispatchId!,
      expectedIdentity: { sessionId: binding.sessionId!, processIncarnation: binding.processIncarnation! },
    }, principal)
    if (action === 'retain') {
      if (result.state === 'retained') bindings.setState(binding.id, 'host', 'active')
    } else if (result.state === 'stopped' || result.state === 'released' || result.state === 'abandoned') {
      bindings.setState(binding.id, 'host', 'settled')
    } else if (result.state === 'stop_unknown' || result.state === 'release_unknown' || result.state === 'release_pending') {
      bindings.setState(binding.id, 'host', 'unknown')
    }
    return result
  }

  const validateHostPreparation = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!isObject(params.params)) fail(context, 'invalid_argument', 'Host preflight requires worker start parameters.')
    try {
      const preflight = await preflightFederatedWorkerStart(context, params.params as unknown as WorkerStartParams)
      return { accepted: true, ...preflight }
    } catch (cause) {
      return { accepted: false, code: errorCode(cause) ?? 'invalid_argument', message: errorMessage(cause) }
    }
  }

  const acceptHomeAttachment = (
    params: Record<string, unknown>,
    principal: FederationPeerPrincipal,
    attached: boolean,
  ): { accepted: true; bindingId: string } => {
    if (typeof params.bindingId !== 'string' || !isObject(params.host) || !isObject(params.worker)) {
      fail(context, 'invalid_argument', 'Attachment receipt requires bindingId, host identities, and WorkerRecord.')
    }
    const binding = requireBinding(params.bindingId, 'home')
    assertPrincipal(binding, principal)
    const host = params.host
    if (typeof host.runId !== 'string' || typeof host.taskId !== 'string' || typeof host.dispatchId !== 'string') {
      fail(context, 'invalid_argument', 'Host attachment receipt identity is invalid.', { bindingId: binding.id })
    }
    const hostIds: AttachHost = {
      runId: host.runId as RunId,
      taskId: host.taskId as TaskId,
      dispatchId: host.dispatchId as DispatchId,
    }
    const worker = asWorkerRecord(params.worker, hostIds.dispatchId)
    if (!worker) fail(context, 'worker_identity_changed', `Host WorkerRecord is invalid for federation binding ${binding.id}.`, { bindingId: binding.id })
    if (attached) {
      if (!worker.sessionId || !worker.processIncarnation || !worker.processRuntimeEpoch) {
        fail(context, 'worker_identity_changed', `Host attachment has no exact process identity for binding ${binding.id}.`, { bindingId: binding.id })
      }
      store.transaction(() => recordHostAttachment(binding.id, 'home', hostIds, worker, principal, true))
    } else {
      store.transaction(() => recordHostAttachment(binding.id, 'home', hostIds, worker, principal, false))
    }
    return { accepted: true, bindingId: binding.id }
  }

  const hostBindingFromRequest = (params: Record<string, unknown>, principal: FederationPeerPrincipal): FederationBinding => {
    if (typeof params.bindingId !== 'string') fail(context, 'invalid_argument', 'Federation request requires a bindingId.')
    const binding = requireBinding(params.bindingId, 'host')
    assertPrincipal(binding, principal)
    return binding
  }

  const submitHostStart = async (
    params: StartRequest,
    principal: FederationPeerPrincipal,
  ): Promise<Record<string, unknown>> => {
    const existing = hostStarts.get(params.bindingId)
    if (existing) return existing as Promise<Record<string, unknown>>
    const work = performHostStart(params, principal).finally(() => hostStarts.delete(params.bindingId))
    hostStarts.set(params.bindingId, work)
    return work
  }

  const performHostStart = async (
    params: StartRequest,
    principal: FederationPeerPrincipal,
  ): Promise<Record<string, unknown>> => {
    if (!UUID_RE.test(params.requestId) || !isObject(params.home) || !isObject(params.task) ||
      !isObject(params.preflight) || !isObject(params.params)) {
      fail(context, 'invalid_argument', 'Federated host start request is incomplete.')
    }
    const hashedParams = params.params.taskId === undefined
      ? { ...params.params, spec: params.task.spec }
      : params.params
    if (params.params.requestId !== params.requestId || startInputHash(hashedParams) !== params.requestHash) {
      fail(context, 'request_mismatch', 'Federated host start input hash or request ID changed.', { bindingId: params.bindingId })
    }
    const peer = peers.getPeer(principal.peerId)
    const binding: FederationBinding = {
      id: params.bindingId,
      side: 'host',
      homeRunId: params.home.runId,
      homeTaskId: params.home.taskId,
      homeDispatchId: params.home.dispatchId,
      hostRunId: null,
      hostTaskId: null,
      hostDispatchId: null,
      peer,
      peerIncarnation: principal.incarnation,
      sessionId: null,
      processIncarnation: null,
      processRuntimeEpoch: null,
      state: 'attaching',
    }
    let localBinding = bindings.create(binding, params.requestId, params.requestHash)
    assertPrincipal(localBinding, principal)
    if (localBinding.hostDispatchId) return inspectHostStart(localBinding)

    try {
      const created = await core.serviceRunCreate({
        requestId: randomUUID(),
        contractVersion: 1,
        key: `federation:${localBinding.id}`,
        objective: `Federated worker for ${params.task.taskTitle}`,
      }, context.pluginId)
      const hostRunId = created.run.id
      localBinding = bindings.setHostRun(localBinding.id, hostRunId)
      await registerHostSubmissionPreflight(hostRunId)
      const hostStartParams = toHostStartParams(params.params, hostRunId, params.task)
      const service = serviceEvidence(context.pluginId, hostRunId)
      core.requireOwnedRun(context.pluginId, hostRunId)
      core.requireCoordinator(service, hostRunId)
      const result = await workers.starter.startFederated(hostStartParams, service, {
        accepted(receipt, worker) {
          if (receipt.runId !== hostRunId || worker.dispatchId !== receipt.dispatchId) {
            fail(context, 'worker_identity_changed', `Host starter receipt did not match binding ${localBinding.id}.`, { bindingId: localBinding.id })
          }
          localBinding = bindings.setHostReceipt(localBinding.id, {
            runId: receipt.runId,
            taskId: receipt.taskId,
            dispatchId: receipt.dispatchId,
          })
        },
        async beforeLaunch(receipt, worker) {
          if (!localBinding.hostTaskId || !localBinding.hostDispatchId) {
            fail(context, 'worker_identity_changed', `Host receipt was not durable before launch for binding ${localBinding.id}.`, { bindingId: localBinding.id })
          }
          await remote(localBinding, FEDERATION_METHODS.attach, {
            phase: 'accepted',
            bindingId: localBinding.id,
            host: { runId: receipt.runId, taskId: receipt.taskId, dispatchId: receipt.dispatchId },
            worker,
          }, params.requestId, ATTACH_TIMEOUT_MS)
        },
        async attached(worker, dispatch) {
          if (!localBinding.hostRunId || !localBinding.hostTaskId || !localBinding.hostDispatchId) {
            fail(context, 'worker_identity_changed', `Host attachment IDs were not durable for binding ${localBinding.id}.`, { bindingId: localBinding.id })
          }
          localBinding = bindings.attach(localBinding.id, 'host', {
            runId: dispatch.runId,
            taskId: dispatch.taskId,
            dispatchId: dispatch.id,
            sessionId: worker.sessionId!,
            processIncarnation: worker.processIncarnation!,
            processRuntimeEpoch: worker.processRuntimeEpoch!,
          })
          await remote(localBinding, FEDERATION_METHODS.attach, {
            phase: 'attached',
            bindingId: localBinding.id,
            host: { runId: dispatch.runId, taskId: dispatch.taskId, dispatchId: dispatch.id },
            worker,
          }, params.requestId, ATTACH_TIMEOUT_MS)
        },
      })
      const receipt = { ...result, runId: params.home.runId, taskId: params.home.taskId, dispatchId: params.home.dispatchId }
      if (result.state === 'ready') bindings.setState(localBinding.id, 'host', 'active')
      else if (result.state === 'failed') bindings.setState(localBinding.id, 'host', 'settled')
      else bindings.setState(localBinding.id, 'host', 'unknown')
      let worker: WorkerRecord | null = null
      if (localBinding.hostDispatchId) {
        try {
          worker = (await hostWorkerShow(localBinding)).worker
        } catch {
          worker = workerStore.get(localBinding.hostDispatchId)
        }
      }
      return {
        bindingId: localBinding.id,
        host: { runId: localBinding.hostRunId, taskId: localBinding.hostTaskId, dispatchId: localBinding.hostDispatchId },
        receipt,
        worker,
        hostIncarnation: peers.localIncarnation,
      }
    } catch (cause) {
      const current = bindings.get(localBinding.id) ?? localBinding
      if (!current.hostDispatchId) {
        bindings.setState(current.id, 'host', 'settled')
        const failure: WorkerStartReceipt = {
          ...acceptedReceipt(params.params, current.homeRunId, current.homeTaskId, current.homeDispatchId,
            params.preflight.decision, params.params.timeoutMs ?? 60_000),
          stage: 'host_acceptance_failed',
          failedStage: 'host_acceptance',
          lastError: errorMessage(cause),
        }
        return { bindingId: current.id, receipt: failure, hostIncarnation: peers.localIncarnation }
      }
      const uncertain = unknownReceipt(
        acceptedReceipt(params.params, current.homeRunId, current.homeTaskId, current.homeDispatchId,
          params.preflight.decision, params.params.timeoutMs ?? 60_000),
        errorMessage(cause),
      )
      bindings.setState(current.id, 'host', 'unknown')
      return { bindingId: current.id, host: { runId: current.hostRunId, taskId: current.hostTaskId, dispatchId: current.hostDispatchId }, receipt: uncertain, hostIncarnation: peers.localIncarnation }
    }
  }

  const inspectHostStart = async (binding: FederationBinding): Promise<Record<string, unknown>> => {
    const receipt = binding.hostDispatchId ? workerStore.get(binding.hostDispatchId)?.receipt ?? null : null
    const mappedReceipt = receipt ? mapHostReceipt(binding, receipt) : null
    let worker: WorkerRecord | null = binding.hostDispatchId ? workerStore.get(binding.hostDispatchId) : null
    if (binding.hostDispatchId) {
      try {
        worker = (await hostWorkerShow(binding)).worker
      } catch {
        // The durable host receipt remains inspectable while live output/control is unavailable.
      }
    }
    return {
      bindingId: binding.id,
      host: { runId: binding.hostRunId, taskId: binding.hostTaskId, dispatchId: binding.hostDispatchId },
      receipt: mappedReceipt,
      worker,
      hostIncarnation: peers.localIncarnation,
    }
  }

  const registerHostSubmissionPreflight = async (runId: RunId): Promise<void> => {
    const result = await context.call(`${context.pluginId}/serviceRegisterSubmissionPreflight`, {
      runId,
      requestId: randomUUID(),
      contractVersion: 1,
      method: `${context.pluginId}/federationSubmissionPreflight`,
    })
    if (!isObject(result) || result.registered !== true || result.runId !== runId ||
      result.method !== `${context.pluginId}/federationSubmissionPreflight`) {
      fail(context, 'lifecycle_conflict', `Could not register the federation lifecycle preflight for service Run ${runId}.`, { runId })
    }
  }

  const toHostStartParams = (
    homeParams: WorkerStartParams,
    hostRunId: RunId,
    task: StartRequest['task'],
  ): WorkerStartParams => {
    const { on: _on, from: _from, taskId: _homeTaskId, dependencyTaskIds: _dependencies, parentTaskId: _parent, ...rest } = homeParams
    return {
      ...rest,
      runId: hostRunId,
      taskId: undefined,
      spec: task.spec,
      taskTitle: task.taskTitle,
    }
  }

  const readStartRequest = (params: Record<string, unknown>): StartRequest => {
    if (params.phase !== 'start' || typeof params.bindingId !== 'string' || typeof params.requestId !== 'string' ||
      typeof params.requestHash !== 'string' || typeof params.expectedIncarnation !== 'string' ||
      !isObject(params.home) || !isObject(params.task) || !isObject(params.preflight) || !isObject(params.params)) {
      fail(context, 'invalid_argument', 'Federation attach-start request is invalid.')
    }
    if (!isObject(params.preflight.decision) || typeof params.preflight.decision.mode !== 'string' ||
      (params.preflight.worktreeId !== null && typeof params.preflight.worktreeId !== 'string')) {
      fail(context, 'invalid_argument', 'Federation host placement receipt is invalid.')
    }
    return params as unknown as StartRequest
  }

  const handleAttachStart = async (params: Record<string, unknown>, principal: FederationPeerPrincipal, requestId?: string): Promise<unknown> => {
    const phase = params.phase
    if (phase === 'preflight') return validateHostPreparation(params)
    if (phase === 'accepted') return acceptHomeAttachment(params, principal, false)
    if (phase === 'attached') return acceptHomeAttachment(params, principal, true)
    if (phase === 'start') {
      const input = readStartRequest(params)
      if (requestId !== input.requestId) fail(context, 'request_mismatch', 'Federation start request ID changed in transit.', { bindingId: input.bindingId })
      return submitHostStart(input, principal)
    }
    if (phase === 'inspect') {
      const binding = hostBindingFromRequest(params, principal)
      return inspectHostStart(binding)
    }
    fail(context, 'invalid_argument', 'Federation attach-start phase is not recognized.')
  }

  const handle: FederationInboundHandler = async (method, params, principal, requestId) => {
    requireActive()
    if (method === FEDERATION_METHODS.attach) return handleAttachStart(params, principal, requestId)
    const bindingId = params.bindingId
    if (method === 'quirky.orchestration/federationPull' || method === 'quirky.orchestration/federationAck' ||
      method === 'quirky.orchestration/federationImport') {
      if (!mail) fail(context, 'peer_method_forbidden', `Federation mail handler ${method} is not connected.`)
      const binding = bindings.get(typeof bindingId === 'string' ? bindingId : '')
      if (!binding) fail(context, 'lifecycle_not_found', 'Federation mail binding does not exist.', { bindingId })
      assertPrincipal(binding, principal)
      return mail.inbound(method, params, principal, requestId)
    }
    const binding = hostBindingFromRequest(params, principal)
    if (method === FEDERATION_METHODS.show) return hostWorkerShow(binding)
    if (method === FEDERATION_METHODS.read) {
      const read = isObject(params.read) ? params.read : {}
      return hostReadLocal(binding, {
        dispatchId: binding.hostDispatchId!,
        ...(read.source === 'transcript' || read.source === 'terminal' || read.source === 'auto' ? { source: read.source } : {}),
        ...(typeof read.cursor === 'string' ? { cursor: read.cursor } : {}),
        ...(Number.isSafeInteger(read.limit) ? { limit: read.limit as number } : {}),
      })
    }
    if (method === FEDERATION_METHODS.fleet) {
      return hostListLocal(binding, isObject(params.list) ? params.list as WorkerListParams : {})
    }
    const action = method === FEDERATION_METHODS.stop ? 'stop'
      : method === FEDERATION_METHODS.release ? 'release'
        : method === FEDERATION_METHODS.retain ? 'retain'
          : method === FEDERATION_METHODS.abandon ? 'abandon' : null
    if (action) {
      const control = isObject(params.control) ? params.control : {}
      return hostControlLocal(binding, action, {
        ...(control as unknown as WorkerControlParams),
        requestId: typeof requestId === 'string' ? requestId : (control.requestId as string),
        contractVersion: 1,
        runId: binding.hostRunId ?? undefined,
        dispatchId: binding.hostDispatchId ?? '' as DispatchId,
        expectedIdentity: { sessionId: binding.sessionId ?? '', processIncarnation: binding.processIncarnation ?? '' },
      })
    }
    fail(context, 'peer_method_forbidden', `Federation method ${method} is outside the engine handler ceiling.`, { method })
  }

  const remote = async (
    binding: FederationBinding,
    method: string,
    params: Record<string, unknown>,
    requestId?: string,
    timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS,
  ): Promise<RuntimePeerReply> => {
    requireActive()
    const current = bindings.assertPersisted(binding)
    try {
      const response = await peers.callFederation(
        current.peer.id,
        current.peer.pairingRevision,
        method,
        { ...params, expectedIncarnation: current.peerIncarnation },
        requestId,
        timeoutMs,
      )
      bindings.assertPeerIdentity(current)
      if (response.status.incarnation !== current.peerIncarnation) {
        fail(context, 'peer_incarnation_changed', `Peer incarnation changed during federation call for binding ${current.id}.`, {
          bindingId: current.id,
          expectedIncarnation: current.peerIncarnation,
          actualIncarnation: response.status.incarnation,
        })
      }
      return response
    } catch (cause) {
      const latest = bindings.get(current.id)
      if (current.side === 'home' && latest?.state !== 'settled') bindings.setState(current.id, 'home', 'unknown')
      throw cause
    }
  }

  const engine: FederationEnginePort = {
    home: dispatchId => bindings.home(dispatchId),
    host: dispatchId => bindings.host(dispatchId),
    reportAuthority(binding) {
      const current = bindings.assertPersisted(binding)
      if (current.side !== 'home' || !current.hostRunId || !current.hostTaskId || !current.hostDispatchId ||
        !current.sessionId || !current.processIncarnation || !current.processRuntimeEpoch ||
        (current.state !== 'active' && current.state !== 'unknown' && current.state !== 'settled')) {
        fail(context, 'worker_identity_changed', `Federation binding ${current.id} has no current report authority.`, { bindingId: current.id })
      }
      return {
        kind: 'federated-worker',
        dispatchId: current.homeDispatchId,
        peerId: current.peer.id,
        pairingRevision: current.peer.pairingRevision,
        peerFingerprint: current.peer.fingerprint,
        hostIncarnation: current.peerIncarnation,
        sessionId: current.sessionId,
        processIncarnation: current.processIncarnation,
        processRuntimeEpoch: current.processRuntimeEpoch,
      }
    },
    bindings: side => bindings.bindings(side),
    async assertBinding(binding) {
      const current = bindings.assertPersisted(binding)
      const status = await peers.remoteStatus(current.peer.id, current.peer.pairingRevision)
      if (status.status.incarnation !== current.peerIncarnation) {
        fail(context, 'peer_incarnation_changed', `Peer incarnation changed for federation binding ${current.id}.`, {
          bindingId: current.id,
          expectedIncarnation: current.peerIncarnation,
          actualIncarnation: status.status.incarnation,
        })
      }
    },
    remote,
    async start(params, caller) {
      requireActive()
      if (typeof params.on !== 'string' || params.on.trim().length === 0 || params.on.trim() !== params.on) {
        fail(context, 'invalid_argument', 'Federated worker start requires an exact saved peer ID in --on.')
      }
      const homeRun = core.requireCoordinator(caller, params.runId)
      const normalized: WorkerStartParams = { ...params, runId: homeRun.id }
      const readinessTimeout = normalized.timeoutMs ?? 60_000
      if (!Number.isSafeInteger(readinessTimeout) || readinessTimeout < 1 || readinessTimeout + 50_000 > 2_147_483_647) {
        fail(context, 'invalid_argument', 'Readiness timeout plus client grace exceeds the runtime timer limit.')
      }
      const launchTimeout = readinessTimeout + 40_000
      const { on: _on, from: _from, ...executionParams } = normalized
      let preparation: StartPreparation | null = null
      return core.mutateWorker('workerStart', normalized, caller, storeView => {
        if (storeView !== store) fail(context, 'lifecycle_conflict', 'Federated start must use the orchestration core store.')
        const prepared = preparation
        if (!prepared) fail(context, 'lifecycle_conflict', 'Federated worker acceptance ran before host placement preflight.')
        const run = core.requireCoordinator(caller, homeRun.id)
        let task
        if (normalized.taskId) {
          task = core.getTask(normalized.taskId)
          if (task.runId !== run.id) fail(context, 'task_not_found', `Task ${task.id} does not belong to home Run ${run.id}.`, { taskId: task.id })
        } else {
          task = core.createTask({
            runId: run.id,
            spec: normalized.spec!,
            ...(normalized.taskTitle !== undefined ? { taskTitle: normalized.taskTitle } : {}),
            ...(normalized.displayName !== undefined ? { displayName: normalized.displayName } : {}),
            ...(normalized.dependencyTaskIds !== undefined ? { dependencyTaskIds: normalized.dependencyTaskIds } : {}),
            ...(normalized.parentTaskId !== undefined ? { parentTaskId: normalized.parentTaskId } : {}),
          }, caller)
        }
        const dispatch = core.reserveWorkerDispatch({
          taskId: task.id,
          runId: run.id,
          ...(normalized.retryOfDispatchId ? { retryOfDispatchId: normalized.retryOfDispatchId } : {}),
        }, caller)
        const initial = acceptedReceipt(normalized, run.id, task.id, dispatch.id, prepared.decision, normalized.timeoutMs ?? 60_000)
        const binding: FederationBinding = {
          id: prepared.bindingId,
          side: 'home',
          homeRunId: run.id,
          homeTaskId: task.id,
          homeDispatchId: dispatch.id,
          hostRunId: null,
          hostTaskId: null,
          hostDispatchId: null,
          peer: prepared.peer,
          peerIncarnation: prepared.peerIncarnation,
          sessionId: null,
          processIncarnation: null,
          processRuntimeEpoch: null,
          state: 'attaching',
        }
        bindings.create(binding, normalized.requestId, prepared.requestHash)
        return initial
      }, {
        beforeAccept: async () => {
          const peer = await peers.remoteStatus(params.on!, undefined)
          if (!peer.status.capabilities.includes(FEDERATION_METHODS.attach)) {
            fail(context, 'peer_capability_missing', `Peer ${params.on} does not advertise ${FEDERATION_METHODS.attach}.`, {
              peerId: params.on,
              capability: FEDERATION_METHODS.attach,
            })
          }
          const bindingId = randomUUID()
          const requestHash = startInputHash(executionParams)
          const preflight = await peers.callFederation(
            params.on!,
            peer.peer.pairingRevision,
            FEDERATION_METHODS.attach,
            { phase: 'preflight', params: executionParams, expectedIncarnation: peer.status.incarnation },
            normalized.requestId,
            ATTACH_TIMEOUT_MS,
          )
          if (!isObject(preflight.result) || preflight.result.accepted !== true) {
            const response = isObject(preflight.result) ? preflight.result : {}
            const reason = typeof response.code === 'string' ? response.code : 'invalid_argument'
            fail(context, 'invalid_argument', `${reason}: ${typeof response.message === 'string' ? response.message : 'Host rejected federated worker placement.'}`)
          }
          if (!isObject(preflight.result.decision)) {
            fail(context, 'peer_invalid_response', 'Host placement preflight returned no worker mode decision.', { peerId: params.on })
          }
          const decision = preflight.result.decision
          if ((decision.mode !== 'terminal' && decision.mode !== 'structured') ||
            (decision.preferred !== 'terminal' && decision.preferred !== 'structured') ||
            typeof decision.reason !== 'string' || typeof decision.detail !== 'string') {
            fail(context, 'peer_invalid_response', 'Host placement preflight returned an invalid worker mode decision.', { peerId: params.on })
          }
          const worktreeId = preflight.result.worktreeId
          if (worktreeId !== null && typeof worktreeId !== 'string') {
            fail(context, 'peer_invalid_response', 'Host placement preflight returned an invalid worktree ID.', { peerId: params.on })
          }
          preparation = {
            peer: peer.peer,
            peerIncarnation: peer.status.incarnation,
            decision: {
              mode: decision.mode,
              preferred: decision.preferred,
              reason: decision.reason,
              detail: decision.detail,
            },
            worktreeId,
            bindingId,
            requestHash,
            executionParams,
          }
        },
        acceptedCheckpoint: accepted => ({
          state: 'accepted',
          accepted: true,
          runId: accepted.runId,
          taskId: accepted.taskId,
          dispatchId: accepted.dispatchId,
          bindingId: preparation?.bindingId ?? null,
        }),
        afterCommit: async accepted => {
          const prepared = preparation
          if (!prepared) return unknownReceipt(accepted, 'Host preflight did not remain available after acceptance.')
          let binding = bindings.home(accepted.dispatchId)
          if (!binding) return unknownReceipt(accepted, 'Durable home federation binding is unavailable after acceptance.')
          const homeTask = core.getTask(accepted.taskId)
          const { spec: _spec, ...hostParams } = prepared.executionParams
          const request: StartRequest = {
            phase: 'start',
            bindingId: binding.id,
            requestId: normalized.requestId,
            requestHash: prepared.requestHash,
            expectedIncarnation: binding.peerIncarnation,
            home: { runId: accepted.runId, taskId: accepted.taskId, dispatchId: accepted.dispatchId },
            task: { spec: homeTask.spec, taskTitle: homeTask.taskTitle, displayName: homeTask.displayName },
            preflight: { decision: prepared.decision, worktreeId: prepared.worktreeId },
            params: hostParams,
          }
          try {
            const response = await remote(binding, FEDERATION_METHODS.attach, request as unknown as Record<string, unknown>, normalized.requestId, launchTimeout)
            if (!isObject(response.result) || response.result.bindingId !== binding.id) {
              fail(context, 'peer_invalid_response', 'Host attachment response does not name the durable federation binding.')
            }
            binding = bindings.home(accepted.dispatchId) ?? binding
            if (isObject(response.result.host) && typeof response.result.host.runId === 'string' &&
              typeof response.result.host.taskId === 'string' && typeof response.result.host.dispatchId === 'string') {
              binding = bindings.setHostReceipt(binding.id, {
                runId: response.result.host.runId as RunId,
                taskId: response.result.host.taskId as TaskId,
                dispatchId: response.result.host.dispatchId as DispatchId,
              }, 'home')
            }
            const hostReceipt = asReceipt(response.result.receipt)
            if (!hostReceipt) fail(context, 'peer_invalid_response', 'Host attachment response has no worker receipt.')
            if (!binding.hostDispatchId) {
              bindings.setState(binding.id, 'home', 'unknown')
              return unknownReceipt(accepted, hostReceipt.lastError ?? 'Host did not commit a durable worker receipt before returning.')
            }
            if (hostReceipt.state === 'ready' &&
              (!binding.sessionId || !binding.processIncarnation || !binding.processRuntimeEpoch)) {
              bindings.setState(binding.id, 'home', 'unknown')
              return unknownReceipt(accepted, 'Host start receipt arrived before exact process attachment was durably mirrored.')
            }
            if (isObject(response.result.worker) && binding.hostDispatchId) {
              const mirror = asWorkerRecord(response.result.worker, binding.hostDispatchId)
              if (mirror) mirrorWorker(binding, mirror, binding.sessionId !== null)
            }
            updateHomeStartState(binding, hostReceipt)
            if (hostReceipt.state === 'failed') settleHomeStartFailure(binding)
            return mapHostReceipt(binding, hostReceipt)
          } catch (cause) {
            const current = bindings.home(accepted.dispatchId) ?? binding
            if (current.state !== 'settled') bindings.setState(current.id, 'home', 'unknown')
            return unknownReceipt(accepted, errorMessage(cause))
          }
        },
      })
    },
    async hostShow(binding) {
      if (binding.side === 'home') {
        const response = await remote(binding, FEDERATION_METHODS.show, { bindingId: binding.id })
        if (!isObject(response.result)) fail(context, 'peer_invalid_response', 'Remote worker show returned an invalid result.', { bindingId: binding.id })
        return response.result as unknown as WorkerShowResult
      }
      return hostWorkerShow(bindings.assertPersisted(binding))
    },
    async hostList(binding, params) {
      if (binding.side === 'home') {
        const response = await remote(binding, FEDERATION_METHODS.fleet, { bindingId: binding.id, list: params })
        if (!isObject(response.result)) fail(context, 'peer_invalid_response', 'Remote fleet snapshot returned an invalid result.', { bindingId: binding.id })
        return response.result as unknown as WorkerListResult
      }
      return hostListLocal(bindings.assertPersisted(binding), params)
    },
    async hostRead(binding, params) {
      if (binding.side === 'home') {
        const response = await remote(binding, FEDERATION_METHODS.read, {
          bindingId: binding.id,
          read: {
            ...(params.source !== undefined ? { source: params.source } : {}),
            ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          },
        })
        if (!isObject(response.result)) fail(context, 'peer_invalid_response', 'Remote output reader returned an invalid result.', { bindingId: binding.id })
        return response.result as unknown as WorkerReadResult
      }
      return hostReadLocal(bindings.assertPersisted(binding), params)
    },
    async hostControl(binding, action, params) {
      if (binding.side === 'home') {
        const method = action === 'stop' ? FEDERATION_METHODS.stop : action === 'release' ? FEDERATION_METHODS.release
          : action === 'retain' ? FEDERATION_METHODS.retain : FEDERATION_METHODS.abandon
        const response = await remote(binding, method, {
          bindingId: binding.id,
          control: {
            requestId: params.requestId,
            contractVersion: params.contractVersion,
            expectedIdentity: binding.sessionId && binding.processIncarnation
              ? { sessionId: binding.sessionId, processIncarnation: binding.processIncarnation }
              : params.expectedIdentity,
          },
        }, params.requestId, ATTACH_TIMEOUT_MS)
        if (!isObject(response.result)) fail(context, 'peer_invalid_response', 'Remote worker control returned an invalid result.', { bindingId: binding.id })
        const result = response.result as unknown as MutationResult<WorkerControlResult>
        const current = bindings.home(binding.homeDispatchId)
        if (current && result.state !== undefined) {
          if (action === 'retain') {
            if (result.state === 'retained') bindings.setState(current.id, 'home', 'active')
          } else if (result.state === 'stopped' || result.state === 'released' || result.state === 'abandoned') {
            bindings.setState(current.id, 'home', 'settled')
          } else if (result.state === 'stop_unknown' || result.state === 'release_unknown' || result.state === 'release_pending') {
            bindings.setState(current.id, 'home', 'unknown')
          }
        }
        return result
      }
      return hostControlLocal(bindings.assertPersisted(binding), action, params)
    },
    bindMail(value) {
      if (mail !== null) throw new Error('federation mail is already bound')
      mail = value
      peers.setFederationHandler(handle)
    },
    handle,
    async dispose() {
      if (disposed) return
      disposed = true
      peers.setFederationHandler(null)
      await Promise.allSettled([...hostStarts.values()])
      mail = null
      hostStarts.clear()
    },
  }

  core.registerFederationAuthorityValidator(authority => {
    const binding = bindings.home(authority.dispatchId)
    if (!binding) fail(context, 'worker_identity_changed', `No durable home federation binding exists for ${authority.dispatchId}.`, { dispatchId: authority.dispatchId })
    const current = engine.reportAuthority(binding)
    if (!sameReportAuthority(current, authority)) {
      fail(context, 'worker_identity_changed', `Federated report authority changed for ${authority.dispatchId}.`, { dispatchId: authority.dispatchId })
    }
  })
  core.onDispatchSettled(dispatchId => {
    const binding = bindings.home(dispatchId)
    if (binding) bindings.setState(binding.id, 'home', 'settled')
  })
  core.onReset(mode => bindings.reset(mode))
  return engine
}
