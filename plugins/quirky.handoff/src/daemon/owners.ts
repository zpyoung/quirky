import type {
  OwnerHostIdentity,
  OwnerRuntimeIdentity,
  OwnerRuntimePin,
  OwnerSessionHostRef,
  OwnerSessionWorkspaceRef,
  PluginErrorKind,
  RegisteredOwnerHost,
  Worktree
} from '@quirky/protocol'
import type { Candidate } from './types'
import type { Call } from './source'
import { hasExactKeys, isRecord, nonEmptyString } from './guards'

export type OwnerOperation =
  | 'quirky.vault/get'
  | 'quirky.handoff/ownerAgents'
  | 'quirky.handoff/ownerProbe'
  | 'quirky.handoff/ownerStart'
  | 'quirky.handoff/ownerResend'
  | 'quirky.handoff/ownerDiscard'
  | 'quirky.handoff/ownerJump'

const OWNER_OPERATIONS: readonly OwnerOperation[] = [
  'quirky.vault/get',
  'quirky.handoff/ownerAgents',
  'quirky.handoff/ownerProbe',
  'quirky.handoff/ownerStart',
  'quirky.handoff/ownerResend',
  'quirky.handoff/ownerDiscard',
  'quirky.handoff/ownerJump'
]
type MirrorWorktree = Pick<Worktree, 'id' | 'instanceId' | 'name' | 'path' | 'kind' | 'branch'>
type RemoteMirror = {
  id: string
  hostId: string
  identity: OwnerHostIdentity
  worktree: MirrorWorktree
  connected: boolean
  fingerprint: string
}

export type ResolvedOwnerWorkspace = {
  host: RegisteredOwnerHost
  mirror: RemoteMirror
  ref: OwnerSessionWorkspaceRef
}

type Fail = (kind: PluginErrorKind, message: string, data?: Record<string, unknown>) => Error


const identityOf = (value: unknown): OwnerHostIdentity | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['hostId', 'generation']) || !nonEmptyString(value.hostId, 256) || !nonEmptyString(value.generation, 256)) return null
  return { hostId: value.hostId, generation: value.generation }
}

const pinOf = (value: unknown): OwnerRuntimePin | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'endpoint', 'grantId']) || !nonEmptyString(value.id, 256) || !nonEmptyString(value.endpoint) || !nonEmptyString(value.grantId, 256)) return null
  return { id: value.id, endpoint: value.endpoint, grantId: value.grantId }
}

const runtimeIdentityOf = (value: unknown): OwnerRuntimeIdentity | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name', 'endpoint', 'grantId']) ||
    !nonEmptyString(value.id, 256) || !nonEmptyString(value.name, 512) ||
    !nonEmptyString(value.endpoint) || !nonEmptyString(value.grantId, 256)) return null
  return { id: value.id, name: value.name, endpoint: value.endpoint, grantId: value.grantId }
}

export function hostRefOf(value: unknown): OwnerSessionHostRef | null {
  if (!isRecord(value) || !hasExactKeys(value, ['hostId', 'identity', 'runtime']) || !nonEmptyString(value.hostId, 256)) return null
  const identity = identityOf(value.identity)
  const runtime = pinOf(value.runtime)
  if (!identity || !runtime || identity.hostId !== value.hostId) return null
  return { hostId: value.hostId, identity, runtime }
}

export function workspaceRefOf(value: unknown): OwnerSessionWorkspaceRef | null {
  if (!isRecord(value) || !hasExactKeys(value, ['owner', 'mirrorId', 'worktreeId', 'instanceId', 'fingerprint'])) return null
  const owner = hostRefOf(value.owner)
  if (!owner || !nonEmptyString(value.mirrorId, 512) || !nonEmptyString(value.worktreeId, 256) || !nonEmptyString(value.instanceId, 512) || !nonEmptyString(value.fingerprint, 256)) return null
  return {
    owner,
    mirrorId: value.mirrorId,
    worktreeId: value.worktreeId,
    instanceId: value.instanceId,
    fingerprint: value.fingerprint
  }
}

const sameIdentity = (left: OwnerHostIdentity, right: OwnerHostIdentity): boolean =>
  left.hostId === right.hostId && left.generation === right.generation

const samePin = (left: OwnerRuntimePin, right: OwnerRuntimePin): boolean =>
  left.id === right.id && left.endpoint === right.endpoint && left.grantId === right.grantId

const sameOwner = (left: OwnerSessionHostRef, right: OwnerSessionHostRef): boolean =>
  left.hostId === right.hostId && sameIdentity(left.identity, right.identity) && samePin(left.runtime, right.runtime)


export function sameWorkspaceRef(left: OwnerSessionWorkspaceRef, right: OwnerSessionWorkspaceRef): boolean {
  return sameOwner(left.owner, right.owner) && left.mirrorId === right.mirrorId && left.worktreeId === right.worktreeId &&
    left.instanceId === right.instanceId && left.fingerprint === right.fingerprint
}
function parseHost(value: unknown): RegisteredOwnerHost | null {
  if (!isRecord(value) || !nonEmptyString(value.id, 256) || typeof value.connected !== 'boolean') return null
  const identity = identityOf(value.identity)
  const runtime = value.runtime
  if (!identity || identity.hostId !== value.id || !isRecord(runtime)) return null
  if (!nonEmptyString(runtime.id, 256) || !nonEmptyString(runtime.name, 512) || !nonEmptyString(runtime.endpoint) || !nonEmptyString(runtime.grantId, 256)) return null
  if (value.error !== null && typeof value.error !== 'string') return null
  return {
    id: value.id,
    identity,
    runtime: { id: runtime.id, name: runtime.name, endpoint: runtime.endpoint, grantId: runtime.grantId },
    connected: value.connected,
    error: value.error,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
  }
}

function parseMirror(value: unknown): RemoteMirror | null {
  if (!isRecord(value) || !nonEmptyString(value.id, 512) || !nonEmptyString(value.hostId, 256) || typeof value.connected !== 'boolean' || !nonEmptyString(value.fingerprint, 256)) return null
  const identity = identityOf(value.identity)
  const worktree = value.worktree
  if (!identity || !isRecord(worktree)) return null
  if (
    !nonEmptyString(worktree.id, 256) || !nonEmptyString(worktree.name, 512) || !nonEmptyString(worktree.path) ||
    (worktree.kind !== 'git' && worktree.kind !== 'folder') ||
    (worktree.branch !== null && typeof worktree.branch !== 'string') ||
    !nonEmptyString(worktree.instanceId, 512)
  ) return null
  return {
    id: value.id,
    hostId: value.hostId,
    identity,
    worktree: {
      id: worktree.id as string,
      instanceId: worktree.instanceId as string,
      name: worktree.name as string,
      path: worktree.path as string,
      kind: worktree.kind as 'git' | 'folder',
      branch: worktree.branch as string | null
    },
    connected: value.connected,
    fingerprint: value.fingerprint
  }
}

function refFor(host: RegisteredOwnerHost, mirror: RemoteMirror): OwnerSessionWorkspaceRef {
  return {
    owner: {
      hostId: host.id,
      identity: { ...host.identity },
      runtime: { id: host.runtime.id, endpoint: host.runtime.endpoint, grantId: host.runtime.grantId }
    },
    mirrorId: mirror.id,
    worktreeId: mirror.worktree.id,
    instanceId: mirror.worktree.instanceId,
    fingerprint: mirror.fingerprint
  }
}

/** Resolves feature operations only through the current registered owner and its canonical mirror. */
export class OwnerRouter {
  constructor(private readonly call: Call, private readonly fail: Fail) {}

  async candidates(): Promise<Candidate[]> {
    let response: unknown
    try {
      response = await this.call('quirky.worktree/remoteHostList', {})
    } catch {
      return []
    }
    if (!isRecord(response) || !Array.isArray(response.hosts)) return []
    const candidates: Candidate[] = []
    for (const value of response.hosts) {
      const host = parseHost(value)
      if (!host) continue
      let listed: unknown
      try {
        listed = await this.call('quirky.worktree/remoteList', { host: host.id })
      } catch {
        continue
      }
      if (!isRecord(listed) || !Array.isArray(listed.workspaces)) continue
      for (const item of listed.workspaces) {
        const mirror = parseMirror(item)
        if (!mirror || mirror.hostId !== host.id || !sameIdentity(mirror.identity, host.identity)) continue
        candidates.push({
          id: mirror.id,
          name: mirror.worktree.name,
          path: mirror.worktree.path,
          kind: mirror.worktree.kind,
          branch: mirror.worktree.branch,
          remote: refFor(host, mirror),
          hostName: host.runtime.name,
          connected: host.connected && mirror.connected
        })
      }
    }
    return candidates
  }

  async resolveWorkspace(value: unknown): Promise<ResolvedOwnerWorkspace> {
    const ref = workspaceRefOf(value)
    if (!ref) throw this.fail('invalid-params', 'remote target must contain an exact owner workspace reference', { reason: 'invalid-target' })
    const host = await this.resolveHost(ref.owner)
    let listed: unknown
    try {
      listed = await this.call('quirky.worktree/remoteList', { host: host.id })
    } catch {
      throw this.fail('conflict', 'The selected remote workspace is unavailable. Refresh targets and choose again.', { reason: 'target-unavailable' })
    }
    const rows = isRecord(listed) && Array.isArray(listed.workspaces) ? listed.workspaces : []
    const mirror = rows.map(parseMirror).find((row): row is RemoteMirror => row !== null && row.id === ref.mirrorId)
    if (
      !mirror ||
      mirror.hostId !== ref.owner.hostId ||
      !sameIdentity(mirror.identity, ref.owner.identity) ||
      mirror.worktree.id !== ref.worktreeId ||
      mirror.worktree.instanceId !== ref.instanceId ||
      mirror.fingerprint !== ref.fingerprint
    ) {
      throw this.fail('conflict', 'The selected remote workspace changed. Refresh targets and choose it again.', { reason: 'target-stale' })
    }
    if (!host.connected || !mirror.connected) {
      throw this.fail('conflict', 'The selected remote workspace is unavailable. Refresh targets and choose again.', { reason: 'target-unavailable' })
    }
    return { host, mirror, ref }
  }

  async workspaceFor(identity: OwnerHostIdentity, worktreeId: string, instanceId: string | null): Promise<OwnerSessionWorkspaceRef> {
    const hosts = await this.hosts()
    const host = hosts.find((candidate) => candidate.id === identity.hostId)
    if (!host || !sameIdentity(host.identity, identity) || !host.connected) {
      throw this.fail('conflict', 'The lineage owner is no longer the registered host generation.', { reason: 'owner-changed' })
    }
    let listed: unknown
    try {
      listed = await this.call('quirky.worktree/remoteList', { host: host.id })
    } catch {
      throw this.fail('conflict', 'The lineage owner is unavailable.', { reason: 'owner-unavailable' })
    }
    const rows = isRecord(listed) && Array.isArray(listed.workspaces) ? listed.workspaces : []
    const mirror = rows.map(parseMirror).find((candidate): candidate is RemoteMirror =>
      candidate !== null && candidate.hostId === host.id && candidate.worktree.id === worktreeId &&
      (instanceId === null || candidate.worktree.instanceId === instanceId) && candidate.connected
    )
    if (!mirror) throw this.fail('conflict', 'The lineage workspace is no longer the registered instance.', { reason: 'target-stale' })
    return refFor(host, mirror)
  }

  async ownerCall(ownerValue: unknown, method: OwnerOperation, params: Record<string, unknown>): Promise<unknown> {
    if (!OWNER_OPERATIONS.includes(method)) {
      throw this.fail('invalid-params', 'the remote owner operation is not declared by Handoff', { reason: 'invalid-owner-operation' })
    }
    const owner = hostRefOf(ownerValue)
    if (!owner) throw this.fail('invalid-params', 'remote owner reference is invalid', { reason: 'invalid-owner' })
    const host = await this.resolveHost(owner)
    let raw: unknown
    try {
      raw = await this.call('quirky.cli/runtimeCall', {
        runtime: host.runtime.id,
        method,
        params,
        expectedHost: owner.identity,
        expectedRuntime: owner.runtime
      })
    } catch {
      throw this.fail('conflict', 'The selected remote owner is unavailable or its registration changed.', { reason: 'owner-unavailable' })
    }
    if (!isRecord(raw) || !('result' in raw) || !isRecord(raw.runtime)) {
      throw this.fail('conflict', 'The authenticated owner returned an incomplete feature response.', { reason: 'owner-unavailable' })
    }
    const returnedRuntime = runtimeIdentityOf(raw.runtime)
    if (!returnedRuntime || !samePin(returnedRuntime, owner.runtime)) {
      throw this.fail('conflict', 'The authenticated owner runtime changed during the operation.', { reason: 'owner-changed' })
    }
    return raw.result
  }

  private async resolveHost(owner: OwnerSessionHostRef): Promise<RegisteredOwnerHost> {
    const hosts = await this.hosts()
    const host = hosts.find((candidate) => candidate.id === owner.hostId)
    if (!host || !sameOwner(owner, {
      hostId: host.id,
      identity: host.identity,
      runtime: { id: host.runtime.id, endpoint: host.runtime.endpoint, grantId: host.runtime.grantId }
    })) {
      throw this.fail('conflict', 'The selected remote owner registration changed. Refresh targets and choose again.', { reason: 'owner-changed' })
    }
    if (!host.connected) throw this.fail('conflict', 'The selected remote owner is unavailable.', { reason: 'owner-unavailable' })
    return host
  }

  private async hosts(): Promise<RegisteredOwnerHost[]> {
    const value = await this.call('quirky.worktree/remoteHostList', {})
    if (!isRecord(value) || !Array.isArray(value.hosts)) {
      throw this.fail('conflict', 'Registered remote owner hosts could not be read.', { reason: 'owner-unavailable' })
    }
    return value.hosts.map(parseHost).filter((host): host is RegisteredOwnerHost => host !== null)
  }
}
