import type { QuickCommand } from '../../layout/types'

const NO_MATCH = Number.POSITIVE_INFINITY
const QUERY_MAX_BYTES = 2048
const AGENT_BASE = 200
const BODY_BASE = 400

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Lower is better: exact, prefix, word start, then anywhere, each tier after the base for the field. */
function score(query: string, candidate: string, base: number): number {
  if (!candidate) return NO_MATCH
  if (candidate === query) return base
  if (candidate.startsWith(query)) return base + 50
  const word = candidate.indexOf(` ${query}`)
  if (word !== -1) return base + 100 + word
  const anywhere = candidate.indexOf(query)
  return anywhere === -1 ? NO_MATCH : base + 200 + anywhere
}

function scoreOf(command: QuickCommand, query: string): number {
  let best = score(query, normalize(command.label), 0)
  if (best > AGENT_BASE && command.kind === 'agent' && command.agent) best = Math.min(best, score(query, normalize(command.agent), AGENT_BASE))
  if (best > BODY_BASE) best = Math.min(best, score(query, normalize(command.command), BODY_BASE))
  return best
}

/**
 * The commands matching `rawQuery` in the order the pickers show them: a label match first, then
 * an agent-name match, then the command text, ties in saved order. A blank query keeps everything
 * and a query over 2 KiB matches nothing, so pasting a megabyte into the box can't stall typing.
 */
export function searchQuickCommands(commands: readonly QuickCommand[], rawQuery: string): QuickCommand[] {
  if (new TextEncoder().encode(rawQuery).length > QUERY_MAX_BYTES) return []
  const query = normalize(rawQuery)
  if (!query) return [...commands]
  return commands
    .map((command, index) => ({ command, index, rank: scoreOf(command, query) }))
    .filter((entry) => entry.rank !== NO_MATCH)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command)
}
