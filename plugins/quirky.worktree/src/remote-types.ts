import type { OwnerHostIdentity, OwnerRuntimeIdentity, Worktree } from '@quirky/protocol'
import type { CleanupCandidate } from './control-types'

/** Persisted projection of one exact owner worktree instance; its path is display data only. */
export type RemoteWorkspaceMirror = {
  id: string
  hostId: string
  identity: OwnerHostIdentity
  worktree: Worktree
  connected: boolean
  fingerprint: string
}


export type RemoteCleanupPreview = {
  workspace: string
  hostId: string
  identity: OwnerHostIdentity
  instanceId: string
  generatedAt: number
  candidate: CleanupCandidate | null
}

export type RemoteCallParams = {
  workspace: string
  operation: 'changes' | 'diff' | 'sessions' | 'terminalWorkspace' | 'terminalCreate' | 'terminalRead' | 'terminalWrite'
  path?: string
  source?: 'unstaged' | 'staged'
  session?: string
  lines?: number
  data?: string
  title?: string
}

export type RemoteHostRow = {
  id: string
  runtime_selector: string
  runtime_json: string
  identity_json: string
  connected: number
  error: string | null
  updated_at: number
}

export type RemoteMirrorRow = {
  id: string
  host_id: string
  identity_json: string
  runtime_json: string
  worktree_id: string
  instance_id: string
  worktree_json: string
  connected: number
  fingerprint: string
  updated_at: number
}

export type OwnerCallResult = { runtime: OwnerRuntimeIdentity; result: unknown }
