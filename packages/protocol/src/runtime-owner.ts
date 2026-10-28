/** Separate full-owner CLI grants share encryption, never mobile/federation authority. */
export type OwnerCliPairOffer = {
  v: 2
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  pairedDeviceId: string
  scope: 'owner-cli'
}

/** Safe exact saved-target identity; secret tokens and keys never appear in summaries. */
export type OwnerRuntimeIdentity = {
  id: string
  name: string
  endpoint: string
  grantId: string
}

/** Local owner resolves a saved owner grant; never accepts a phone/federation credential. */
export type OwnerRuntimeCallParams = {
  runtime: string
  method: string
  params?: Record<string, unknown>
}

export type OwnerRuntimeCallResult = {
  runtime: OwnerRuntimeIdentity
  result: unknown
}

/** A workspace view's selector is resolved by the worktree owner before lifecycle writes. */
export type WorkspaceViewOwner = {
  worktreeId: string
  instanceId: string
}
