import type { AskSpec } from '@quirky/protocol'

/** An inactive or unprovable exact owner is never replaced with another session/dispatch. */
export type AskHandoffIdentity = {
  runId: string
  dispatchId: string
  workerId: string
  sessionId: string
}

/** Public worker bridge input; the receiving owner must authenticate every supplied identity. */
export type AskHandoffRequest = {
  spec: AskSpec
  identity: AskHandoffIdentity
  requestId: string
  timeoutMs?: number
}
