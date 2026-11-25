import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat-types'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/structured-agent-session-subagent-roster'

export type DockAgent = {
  id: string
  name: string
  statusLine: string
  /** Null when the roster has no start time for the agent. */
  elapsed: string | null
}

export type DockSummary = {
  running: DockAgent[]
  failed: number
  /** Agents the host stopped hearing from; nothing proves they exited. */
  unverifiable: number
}

/** "12s" below a minute, then "1m 05s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

function statusLineOf(entry: NativeChatSubagentEntry): string {
  return entry.tokens === undefined
    ? entry.state
    : `${entry.state} · ${formatTokens(entry.tokens)} tokens`
}

/**
 * What the dock shows, or null when no subagent is running. The roster carries no per-agent
 * activity, so the status line is its state and token count, and nothing reads as quiet.
 */
export function dockSummary(
  roster: StructuredAgentSubagentRoster,
  now = Date.now()
): DockSummary | null {
  const entries = [...roster.values()].map((held) => held.entry)
  const running = entries
    .filter((entry) => entry.state === 'working')
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity))
    .map((entry): DockAgent => ({
      id: entry.id,
      name: entry.label,
      statusLine: statusLineOf(entry),
      elapsed: entry.startedAt === undefined ? null : formatElapsed(now - entry.startedAt)
    }))
  if (running.length === 0) {
    return null
  }
  return {
    running,
    failed: entries.filter((entry) => entry.state === 'failed').length,
    unverifiable: entries.filter((entry) => entry.state === 'unverifiable').length
  }
}
