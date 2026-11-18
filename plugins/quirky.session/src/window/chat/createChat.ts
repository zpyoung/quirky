import type { Session, UiPluginContext } from '@quirky/protocol'
import type { Picks } from './controls'

/**
 * Creates a structured chat session for `agent` in `worktree` without starting its first turn,
 * applying whichever of the composer `picks` are set. A Plan or other non-default mode goes as
 * `permissionMode`, so the first turn already runs in it. Shared by every surface that starts a chat.
 */
export async function createChat(context: UiPluginContext, agent: string, worktree: string, picks: Picks): Promise<Session> {
  const options = picks.effort === null ? {} : { effort: picks.effort }
  return (await context.call('quirky.structured/create', {
    agent,
    worktree,
    deferStart: true,
    ...(picks.model === null ? {} : { model: picks.model }),
    ...(picks.mode === null || picks.mode === 'default' ? {} : { permissionMode: picks.mode }),
    ...(Object.keys(options).length === 0 ? {} : { options })
  })) as Session
}
