import type { RuntimePeer, RuntimePeerReply } from '@quirky/protocol'
import type { CoordinatorAuthority, DispatchId, JsonValue, MutationResult, RunId, RuntimeCallerEvidence, TaskId } from '../contracts'
import type { WorkerControlParams, WorkerControlResult, WorkerListParams, WorkerListResult, WorkerReadParams, WorkerReadResult, WorkerShowParams, WorkerShowResult, WorkerStartParams, WorkerStartReceipt } from '../worker-contracts'

/** Constructed by PeerManager from its authenticated credential lookup, never request JSON. */
export interface FederationPeerPrincipal {
  peerId: string
  fingerprint: string
  pairingRevision: number
  /** Source daemon incarnation verified against the pinned peer's live status. */
  incarnation: string
}

/** Distinct remote authority: it is never a RuntimeCallerEvidence. */
export interface FederationReportAuthority {
  kind: 'federated-worker'
  dispatchId: DispatchId
  peerId: string
  pairingRevision: number
  peerFingerprint: string
  hostIncarnation: string
  sessionId: string
  processIncarnation: string
  processRuntimeEpoch: string
}

export interface FederationBinding {
  id: string
  side: 'home' | 'host'
  homeRunId: RunId
  homeTaskId: TaskId
  homeDispatchId: DispatchId
  hostRunId: RunId | null
  hostTaskId: TaskId | null
  hostDispatchId: DispatchId | null
  peer: RuntimePeer
  peerIncarnation: string
  sessionId: string | null
  processIncarnation: string | null
  processRuntimeEpoch: string | null
  state: 'attaching' | 'active' | 'settled' | 'unknown'
}

export interface FederationRelayItem {
  sequence: number
  id: string
  bindingId: string
  direction: 'to_home' | 'to_worker'
  kind: 'message' | 'question' | 'reply' | 'lifecycle'
  payload: Record<string, JsonValue>
}

/** Direct internal transport handler; authenticated principal is out-of-band. */
export type FederationInboundHandler = (method: string, params: Record<string, unknown>, principal: FederationPeerPrincipal, requestId?: string) => Promise<unknown>

export interface FederationEngine {
  home(dispatchId: DispatchId): FederationBinding | null
  host(dispatchId: DispatchId): FederationBinding | null
  /** Rechecks persisted binding and returns distinct authority only after exact host attachment. */
  reportAuthority(binding: FederationBinding): FederationReportAuthority
  bindings(side?: 'home' | 'host'): readonly FederationBinding[]
  assertBinding(binding: FederationBinding): Promise<void>
  remote(binding: FederationBinding, method: string, params: Record<string, unknown>, requestId?: string, timeoutMs?: number): Promise<RuntimePeerReply>
  start(params: WorkerStartParams, caller: CoordinatorAuthority): Promise<MutationResult<WorkerStartReceipt>>
  /** Actual host worker pipelines, scoped by validated attachment and owning service Run. */
  hostShow(binding: FederationBinding): Promise<WorkerShowResult>
  hostList(binding: FederationBinding, params: WorkerListParams): Promise<WorkerListResult>
  hostRead(binding: FederationBinding, params: WorkerReadParams): Promise<WorkerReadResult>
  hostControl(binding: FederationBinding, action: 'stop' | 'release' | 'retain' | 'abandon', params: WorkerControlParams): Promise<MutationResult<WorkerControlResult>>
}

/** Bound once by the integration owner; public handlers still attest their real local caller. */
export interface FederationMail {
  inbound: FederationInboundHandler
  sync(binding: FederationBinding): Promise<void>
  dispose(): Promise<void>
}

export interface FederationSurface {
  show(params: WorkerShowParams): Promise<WorkerShowResult>
  read(params: WorkerReadParams): Promise<WorkerReadResult>
  list(params: WorkerListParams, caller: RuntimeCallerEvidence | null, local: WorkerListResult): Promise<WorkerListResult>
  control(action: 'stop' | 'release' | 'retain' | 'abandon', params: WorkerControlParams, caller: CoordinatorAuthority): Promise<MutationResult<WorkerControlResult>>
}

