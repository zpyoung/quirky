import type { Session, UiPluginContext } from '@quirky/protocol'

const SESSION_VIEW_ID = 'view:quirky.session/worktree'

/** Opens only the observed live session and acknowledges only the Activity turn that was clicked. */
export async function openActivityThread(context: UiPluginContext, args: unknown): Promise<void> {
  const input = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const sessionId = input.sessionId
  const worktreeId = input.worktreeId
  const turn = input.turn
  if (typeof sessionId !== 'string' || sessionId === '' || typeof worktreeId !== 'string' || worktreeId === '' || typeof turn !== 'string' || turn === '') {
    throw new Error('Activity destination is unavailable: its exact session, worktree or turn is missing')
  }

  let session: Session
  try {
    session = (await context.call('quirky.session/get', { session: sessionId })) as Session
    if (session.id !== sessionId || session.worktreeId !== worktreeId || session.kind !== 'terminal' || session.status === 'exited') {
      throw new Error('the exact terminal session is no longer available')
    }
    const worktree = (await context.call('quirky.worktree/resolve', { selector: `id:${worktreeId}` })) as { id?: unknown }
    if (worktree.id !== worktreeId) throw new Error('the exact worktree is no longer available')
  } catch (cause) {
    throw new Error(`Activity destination unavailable for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  context.openView(SESSION_VIEW_ID, { worktree: worktreeId, session: sessionId })
  try {
    await context.call('quirky.agent-status/acknowledge', { session: sessionId, turn })
  } catch (cause) {
    context.toast('Activity thread opened, but could not be marked read', cause instanceof Error ? cause.message : String(cause))
  }
}
