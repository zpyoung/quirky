import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../../shared/agent-session-turn-record'

/** How long Claude keeps a prompt cache warm after the turn that wrote it. */
export const CLAUDE_CACHE_TTL_MS = 300_000
const WARNING_MS = 60_000

/**
 * Milliseconds left on the cache of the newest turn of the session's own agent (subagent turns are skipped), or null when there is nothing to count:
 * not Claude, no settled turn, no cached tokens in its context usage, or the cache has expired.
 */
export function cacheMsRemaining(
  items: readonly AgentJournalRenderItem[],
  sessionAgent: string,
  now: number
): number | null {
  if (sessionAgent !== 'claude') {
    return null
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.agentId !== undefined || item?.parentAgentId !== undefined) {
      continue
    }
    const turn = readAgentJournalTurn(item?.body)
    if (!turn) {
      continue
    }
    const used = turn.contextUsage?.used
    if (turn.completedAt === undefined || used?.kind !== 'estimate') {
      return null
    }
    const cached = used.usage.cacheReadInputTokens + used.usage.cacheCreationInputTokens
    const left = turn.completedAt + CLAUDE_CACHE_TTL_MS - now
    return cached > 0 && left > 0 ? left : null
  }
  return null
}

/** "4:07" for the time left; the timer shows it in the header. */
export function formatCacheClock(leftMs: number): string {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The last minute is drawn as a warning. */
export function cacheExpiresSoon(leftMs: number): boolean {
  return leftMs <= WARNING_MS
}
