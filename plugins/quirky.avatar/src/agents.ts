export const HOOKED_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'pi', 'omp'])

export const NO_HOOKED_AGENT_REASON = 'no installed agent has a permission hook; install Claude, Codex, pi or omp'

/**
 * The agent the avatar may start when none was requested: the configured default if it has a
 * permission hook, else the first installed, enabled agent that does. Null when none qualifies or
 * the agent list can't be read, so callers refuse instead of starting an agent the gate can't see.
 */
export async function resolveHookedAgent(call: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<string | null> {
  try {
    const listing = (await call('quirky.agents/list', {})) as { defaultAgent?: unknown; agents?: unknown } | null
    const chosen = listing?.defaultAgent
    if (typeof chosen === 'string' && HOOKED_AGENTS.has(chosen)) return chosen
    const agents = Array.isArray(listing?.agents) ? (listing.agents as Record<string, unknown>[]) : []
    const found = agents.find((agent) => agent?.installed === true && agent.enabled !== false && typeof agent.id === 'string' && HOOKED_AGENTS.has(agent.id))
    return typeof found?.id === 'string' ? found.id : null
  } catch {
    return null
  }
}
