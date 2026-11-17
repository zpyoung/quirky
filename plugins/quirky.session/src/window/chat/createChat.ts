import type { Session, UiPluginContext } from '@quirky/protocol'
import type { Picks } from './controls'

/**
 * Creates a structured chat session for `agent` in `worktree` without starting its first turn,
 * applying whichever of the composer `picks` are set. Shared by every surface that starts a chat.
 */
export async function createChat(context: UiPluginContext, agent: string, worktree: string, picks: Picks): Promise<Session> {
  return (await context.call('quirky.structured/create', {
    agent,
    worktree,
    deferStart: true,
    ...(picks.model === null ? {} : { model: picks.model }),
    ...(picks.effort === null ? {} : { options: { effort: picks.effort } }),
    ...(picks.mode === null ? {} : { permissionMode: picks.mode }),
    ...(picks.plan ? { planMode: true } : {})
  })) as Session
}
