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

/** Issued by the authenticated remote daemon, never supplied by a host label or path. */
export type OwnerHostIdentity = {
  hostId: string
  generation: string
}

/** Saved credential identity checked before connecting, not after a remote side effect. */
export type OwnerRuntimePin = Pick<OwnerRuntimeIdentity, 'id' | 'endpoint' | 'grantId'>

/** Local owner resolves a saved owner grant; never accepts a phone/federation credential. */
export type OwnerRuntimeCallParams = {
  runtime: string
  method: string
  params?: Record<string, unknown>
  /** Checked on the same authenticated connection before dispatching the requested operation. */
  expectedHost?: OwnerHostIdentity
  expectedRuntime?: OwnerRuntimePin
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

export type RegisteredOwnerHost = {
  id: string
  runtime: OwnerRuntimeIdentity
  identity: OwnerHostIdentity
  connected: boolean
  error: string | null
  updatedAt: number
}

/** Captured feature scope; revalidate against the current registered host before dispatch. */
export type OwnerSessionHostRef = {
  hostId: string
  identity: OwnerHostIdentity
  runtime: OwnerRuntimePin
}

/** Paths are deliberately absent: only the canonical mirror and producer instance authorize work. */
export type OwnerSessionWorkspaceRef = {
  owner: OwnerSessionHostRef
  mirrorId: string
  worktreeId: string
  instanceId: string
  fingerprint: string
}
