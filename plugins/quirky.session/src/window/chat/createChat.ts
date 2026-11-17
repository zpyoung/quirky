import type { Session, UiPluginContext } from '@quirky/protocol'
import type { Picks } from './controls'
import { loadStartingPicks } from './startingPicks'

/**
 * Creates a structured chat session for `agent` in `worktree` without starting its first turn,
 * applying the composer `picks` and filling an unpicked model and effort from the agent's own settings
 * or the catalog default, so the session's launch settings name what it really runs on. Shared by
 * every surface that starts a chat.
 */
export async function createChat(context: UiPluginContext, agent: string, worktree: string, picks: Picks): Promise<Session> {
  const { model, effort } = (await loadStartingPicks(context, agent, worktree, picks)).picks
  const options = {
    ...(effort === null ? {} : { effort }),
    ...(picks.mode === null ? {} : { mode: picks.mode }),
    ...(picks.plan ? { plan: true } : {})
  }
  return (await context.call('quirky.structured/create', {
    agent,
    worktree,
    deferStart: true,
    ...(model === null ? {} : { model }),
    ...(Object.keys(options).length === 0 ? {} : { options })
  })) as Session
}
