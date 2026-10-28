import type { OwnerHostIdentity, Worktree, WorktreeCreateResult } from '@quirky/protocol'

export type VmCheckoutMode = 'orca-worktree' | 'provisioned-root'

/** One canonical guest-create option set passed to the remote worktree owner. */
export type VmGuestCreateParams = Record<string, unknown>

/** Non-secret plan retained so a failed attachment can be retried without rerunning VM creation. */
export type VmAttachmentRequest =
  | { checkoutMode: 'provisioned-root'; workspaceSelector: string }
  | { checkoutMode: 'orca-worktree'; repo: string; name: string; createParams: VmGuestCreateParams }

/** The parsed repo environment recipe, before applying the default checkout mode. */
export type VmEnvironmentRecipe = {
  id: string
  name: string
  create: string
  checkoutMode?: VmCheckoutMode
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: true
}

/** Immutable normalized copy of every recipe field covered by the consent hash. */
export type VmRecipeSnapshot = {
  id: string
  name: string
  create: string
  checkoutMode: VmCheckoutMode
  description: string | null
  suspend: string | null
  resume: string | null
  destroy: string | null
  destroyDisabled: boolean
}

export type VmBackendState = 'running' | 'suspended' | 'stopped' | 'absent' | 'unknown'
export type VmLifecycleState = 'creating' | 'suspending' | 'resuming' | 'running' | 'suspended' | 'stopped' | 'failed' | 'interrupted' | 'destroying' | 'retiring' | 'destroyed'
export type VmOperationKind = 'create' | 'suspend' | 'resume' | 'destroy'
export type VmOperationState = 'running' | 'complete' | 'failed' | 'interrupted'

/** Public local projection of a guest worktree; its path is owner data, never a local path. */
export type VmRemoteWorkspace = {
  id: string
  hostId: string
  identity: OwnerHostIdentity
  worktree: Worktree
  connected: boolean
  fingerprint: string
}

export type VmEnvironment = {
  id: string
  name: string
  vmName: string
  repo: { id: string; name: string }
  recipe: { id: string; name: string; hash: string; checkoutMode: VmCheckoutMode }
  /** Exact Lima instance name generated for this durable VM record. */
  instanceId: string
  backend: 'lima'
  backendExecutable: string
  state: VmLifecycleState
  backendState: VmBackendState
  operation: {
    id: string
    kind: VmOperationKind
    state: VmOperationState
    startedAt: number
    updatedAt: number
  }
  error: string | null
  ownerHost: { id: string; identity: OwnerHostIdentity; connected: boolean } | null
  remoteWorkspace: VmRemoteWorkspace | null
  guestCreateResult: WorktreeCreateResult | null
  createdAt: number
  updatedAt: number
}

/**
 * Private create-script result protocol. Scripts run via `/bin/bash -c` in the selected local
 * repository directory with QUIRKY_VM_NAME, QUIRKY_VM_OPERATION_ID, and QUIRKY_VM_OUTPUT_PATH.
 * They must write at most 16 KiB of JSON to the pre-created mode-0600 output file, with no extra
 * keys: provisioned-root uses {pairingCode, workspaceSelector} where the selector is an exact
 * workspace ID; orca-worktree uses {pairingCode, repo, name}. The service consumes pairingCode
 * only through quirky.cli/runtimeAdd and never includes it or script stdout in public results.
 */
export type VmCreateOutput =
  | { pairingCode: string; workspaceSelector: string }
  | { pairingCode: string; repo: string; name: string }
