import { RpcErrorCode, type OwnerHostIdentity, type OwnerSessionWorkspaceRef, type PluginErrorKind, type Session, type Worktree } from '@quirky/protocol'
import type { LineageStore } from './lineage'
import type { OwnerOperation } from './owners'
import type { Call } from './source'
import type { LineageEnd, LineageRecord } from './types'

type JumpDeps = {
  call: Call
  lineage: LineageStore
  localIdentity: () => Promise<OwnerHostIdentity>
  remoteWorkspace: (lineageId: string, end: LineageEnd) => Promise<OwnerSessionWorkspaceRef>
  ownerCall: (owner: unknown, method: OwnerOperation, params: Record<string, unknown>) => Promise<unknown>
  fail: (kind: PluginErrorKind, message: string, data?: Record<string, unknown>) => Error
}

const isNotFound = (error: unknown) => (error as { code?: number } | null)?.code === RpcErrorCode.NotFound
const sameHost = (left: OwnerHostIdentity, right: OwnerHostIdentity) => left.hostId === right.hostId && left.generation === right.generation

async function worktreeState(call: Call, id: string, instanceId: string | null): Promise<'present' | 'missing' | 'changed'> {
  try {
    const worktree = (await call('quirky.worktree/show', { worktree: `id:${id}` })) as Worktree
    if (worktree.id !== id) return 'missing'
    return instanceId === null || worktree.instanceId === instanceId ? 'present' : 'changed'
  } catch (error) {
    return isNotFound(error) ? 'missing' : 'present'
  }
}

function matchingEnds(record: LineageRecord, session: string, currentHost: OwnerHostIdentity): { other: LineageEnd } | null {
  const parentIsCurrent = record.parent.session === session &&
    (record.parent.executionHost === undefined || sameHost(record.parent.executionHost, currentHost))
  const childIsCurrent = record.child.session === session &&
    (record.child.executionHost === undefined || sameHost(record.child.executionHost, currentHost))
  if (parentIsCurrent && !childIsCurrent) return { other: record.child }
  if (childIsCurrent && !parentIsCurrent) return { other: record.parent }
  if (parentIsCurrent && childIsCurrent) return { other: record.child }
  return null
}

/**
 * Focuses the other host-qualified end of a handoff. Historical identities only select provenance;
 * the current registered owner and exact workspace instance authorize a remote jump.
 */
export async function jump(deps: JumpDeps, session: string, lineageId?: string) {
  const { call, lineage, fail } = deps
  const localIdentity = await deps.localIdentity()
  const candidates = lineageId === undefined ? lineage.list(session) : [lineage.get(lineageId)].filter((record): record is LineageRecord => record !== null)
  const match = candidates
    .map((record) => ({ record, ends: matchingEnds(record, session, localIdentity) }))
    .find((entry) => entry.ends !== null)
  if (!match || !match.ends) throw fail('not-found', 'No handoff names this session on this host.', { reason: 'no-lineage' })

  const { record } = match
  const other = match.ends.other
  if (other.session === null) throw fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
  if (other.executionHost && !sameHost(other.executionHost, localIdentity)) {
    if (other.worktreeId === null) throw fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
    const target = await deps.remoteWorkspace(record.id, other)
    const response = await deps.ownerCall(target.owner, 'quirky.handoff/ownerJump', {
      session: other.session,
      worktree: target.worktreeId,
      expectedInstanceId: target.instanceId
    })
    if (typeof response !== 'object' || response === null || !('focused' in response)) {
      throw fail('conflict', 'The remote owner could not focus the selected handoff session.', { reason: 'no-live-pane' })
    }
    const focused = response.focused
    if (typeof focused !== 'object' || focused === null || !('session' in focused) || !('pane' in focused) ||
      typeof focused.session !== 'string' || typeof focused.pane !== 'string') {
      throw fail('conflict', 'The remote owner returned an incomplete focus result.', { reason: 'no-live-pane' })
    }
    return { focused: { session: focused.session, pane: focused.pane }, lineageId: record.id }
  }

  if (other.worktreeId !== null) {
    const state = await worktreeState(call, other.worktreeId, other.instanceId ?? null)
    if (state !== 'present') {
      const missing = state === 'missing'
      throw fail('conflict', missing ? 'worktree removed' : 'The selected workspace instance changed or was removed.', {
        reason: missing ? 'worktree-removed' : 'target-stale'
      })
    }
  }
  try {
    const target = (await call('quirky.session/get', { session: other.session })) as Session
    if (target.status === 'exited') throw fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
    const pane = (await call('quirky.terminal/paneOf', { session: other.session })) as { pane: string }
    await call('quirky.terminal/focusPane', { session: other.session })
    return { focused: { session: other.session, pane: pane.pane }, lineageId: record.id }
  } catch (error) {
    if (isNotFound(error)) throw fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
    throw error
  }
}

