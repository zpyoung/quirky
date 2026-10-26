import type { ContributionInfo } from '@quirky/protocol'
import { validateEntry } from './entry'
import type { AgentEntry, Catalog, CatalogProblem } from './types'

/** The built-in agents in the order `pick` falls back on when the user has no usable default. */
export const AUTO_PICK_ORDER: readonly string[] = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'grok',
  'copilot',
  'opencode2',
  'opencode',
  'mimo-code',
  'ante',
  'trae',
  'muse',
  'dsh',
  'qoder',
  'qoder-cn',
  'zcode',
  'pi',
  'omp',
  'prime-agent',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'autohand',
  'cline',
  'codebuff',
  'freebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'devin',
  'openclaw',
  'codebuddy',
  'jcode'
]

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const isBuiltin = (plugin: string) => plugin.startsWith('quirky.')

/** Auto-pick position for the listed built-ins; unlisted built-ins follow them, then every other plugin's agents. */
function rank(entry: AgentEntry): number {
  if (!isBuiltin(entry.plugin)) return AUTO_PICK_ORDER.length + 1
  const index = AUTO_PICK_ORDER.indexOf(entry.id)
  return index === -1 ? AUTO_PICK_ORDER.length : index
}

const byAutoPick = (a: AgentEntry, b: AgentEntry) =>
  rank(a) - rank(b) || compare(a.plugin, b.plugin) || compare(a.id, b.id)

/** The entry kept when several plugins declare the same agent: a built-in, else the lower plugin ID. */
const byPrecedence = (a: AgentEntry, b: AgentEntry) =>
  Number(isBuiltin(b.plugin)) - Number(isBuiltin(a.plugin)) || compare(a.plugin, b.plugin)

/**
 * Turns the effective `agent` contributions into the catalog. A malformed entry becomes an
 * `invalid` problem; when several valid entries share a name the precedence rule keeps one and
 * the rest become `conflict` problems. An override arrives as a complete entry from the
 * overriding plugin, because the kernel does not merge it with the entry it replaces.
 */
export function buildCatalog(contributions: ContributionInfo[]): Catalog {
  const problems: CatalogProblem[] = []
  const byName = new Map<string, AgentEntry[]>()

  for (const contribution of contributions) {
    if (contribution.kind !== 'agent' || contribution.status !== 'effective') continue
    const result = validateEntry(contribution.plugin, contribution.name, contribution.data)
    if (!result.ok) {
      problems.push({ plugin: contribution.plugin, id: contribution.name, status: 'invalid', error: result.error })
      continue
    }
    byName.set(contribution.name, [...(byName.get(contribution.name) ?? []), result.entry])
  }

  const agents: AgentEntry[] = []
  for (const group of byName.values()) {
    const [winner, ...losers] = [...group].sort(byPrecedence)
    agents.push(winner!)
    for (const loser of losers) {
      problems.push({
        plugin: loser.plugin,
        id: loser.id,
        status: 'conflict',
        error: `agent ${loser.id} is already provided by ${winner!.plugin}; use overrides to replace a built-in agent`
      })
    }
  }

  problems.sort((a, b) => compare(a.plugin, b.plugin) || compare(a.id, b.id))
  return { agents: agents.sort(byAutoPick), problems }
}
