import { RpcErrorCode, type PluginErrorKind, type Session, type Worktree } from '@quirky/protocol'
import type { LineageStore } from './lineage'
import type { Call } from './source'

type JumpDeps = {
  call: Call
  lineage: LineageStore
  fail: (kind: PluginErrorKind, message: string, data?: Record<string, unknown>) => Error
}

const isNotFound = (error: unknown) => (error as { code?: number } | null)?.code === RpcErrorCode.NotFound

async function worktreeExists(call: Call, id: string): Promise<boolean> {
  try {
    return ((await call('quirky.worktree/list', {})) as Worktree[]).some((worktree) => worktree.id === id)
  } catch {
    return true
  }
}

/**
 * Focuses the pane of the other end of a handoff. With `lineage` it follows that record, else the
 * newest one naming `session` on either side. Fails with reason `no-lineage` when no record
 * names the session, `worktree-removed` when the other end's worktree no longer exists, and
 * `no-live-pane` when the other end is gone, exited or has no pane.
 */
export async function jump(deps: JumpDeps, session: string, lineageId?: string) {
  const { call, lineage, fail } = deps
  const record = lineageId === undefined ? lineage.list(session)[0] : lineage.get(lineageId)
  if (!record || (record.parent.session !== session && record.child.session !== session)) {
    throw fail('not-found', 'No handoff names this session.', { reason: 'no-lineage' })
  }
  const other = record.parent.session === session ? record.child : record.parent
  if (other.worktreeId !== null && !(await worktreeExists(call, other.worktreeId))) {
    throw fail('conflict', 'worktree removed', { reason: 'worktree-removed' })
  }
  const noPane = () => fail('conflict', 'No live pane is available.', { reason: 'no-live-pane' })
  if (other.session === null) throw noPane()
  try {
    const target = (await call('quirky.session/get', { session: other.session })) as Session
    if (target.status === 'exited') throw noPane()
    const pane = (await call('quirky.terminal/paneOf', { session: other.session })) as { pane: string }
    await call('quirky.terminal/focusPane', { session: other.session })
    return { focused: { session: other.session, pane: pane.pane }, lineageId: record.id }
  } catch (error) {
    if (isNotFound(error)) throw noPane()
    throw error
  }
}
