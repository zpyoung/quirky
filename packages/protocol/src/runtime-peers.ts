/** Public, JSON-only peer transport contracts; credentials never occur in peer inventory. */
export interface RuntimePeer {
  id: string
  label: string
  endpoint: string
  fingerprint: string
  pairingRevision: number
}
export interface RuntimePeerStatus {
  fingerprint: string
  incarnation: string
  capabilities: string[]
}
export interface RuntimePeerCall {
  peerId: string
  pairingRevision: number
  method: string
  params: Record<string, unknown>
  requestId?: string
  timeoutMs?: number
}
export interface RuntimePeerReply {
  peer: RuntimePeer
  status: RuntimePeerStatus
  result: unknown
}
/** Peer transport methods are contributed by quirky.orchestration. */
export interface RuntimePeerMethods {
  peerList: { params: Record<string, never>; result: { peers: RuntimePeer[] } }
  peerStatus: { params: { peerId: string; pairingRevision?: number }; result: RuntimePeerStatus }
  peerCall: { params: RuntimePeerCall; result: RuntimePeerReply }
}
/** Report preflight is run before a report can settle an owned dispatch. */
export interface OrchestrationSubmission {
  runId: string
  taskId: string
  dispatchId: string
  type: 'worker_done' | 'status'
  subject: string
  body: string
  payload: Record<string, unknown> | null
}
export type OrchestrationSubmissionVerdict =
  | { kind: 'accepted' }
  | { kind: 'rejected'; code: string; reason: string }
