import type { Session } from '@quirky/protocol'

export type CatalogAgent = { id: string; label: string; command: string; aliases: string[] }
export type AgentCatalog = { byId: Map<string, CatalogAgent>; aliasIds: Map<string, Set<string>> }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validAgentId = (value: unknown): value is string =>
  typeof value === 'string' && value !== 'shell' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function commandAlias(value: string): string | null {
  const first = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(value)
  const command = first?.[1] ?? first?.[2] ?? first?.[3]
  if (!command) return null
  const basename = command.split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(basename)) return null
  if (/^(?:sh|bash|zsh|fish|env|node|nodejs|npm|npx|pnpm|yarn|bun|python(?:\d+(?:\.\d+)*)?|ruby|java|deno|tsx|ts-node|cmd|powershell)$/i.test(basename)) return null
  return basename
}

/** Builds the effective public catalog. Installed/enabled flags do not qualify a running agent. */
export function catalogFromListing(value: unknown): AgentCatalog | null {
  if (!isObject(value) || !Array.isArray(value.agents)) return null
  const byId = new Map<string, CatalogAgent>()
  const aliasIds = new Map<string, Set<string>>()
  for (const item of value.agents) {
    if (!isObject(item) || !validAgentId(item.id)) continue
    const id = item.id
    const label = typeof item.label === 'string' ? item.label : ''
    const command = typeof item.command === 'string' ? item.command : ''
    const executable = commandAlias(command)
    const aliases = new Set([id, label, ...(executable ? [executable] : [])])
    // Claude Code's native title and OSC app brand are public synonyms of the claude catalog entry.
    if (id === 'claude') aliases.add('Claude Code')
    const entry = { id, label, command, aliases: [...aliases] }
    byId.set(id, entry)
    for (const alias of entry.aliases) {
      const key = normalized(alias)
      if (!key) continue
      const ids = aliasIds.get(key) ?? new Set<string>()
      ids.add(id)
      aliasIds.set(key, ids)
    }
  }
  return { byId, aliasIds }
}

export function isCatalogAgent(agent: string, catalog: AgentCatalog): boolean {
  return agent !== 'shell' && catalog.byId.has(agent)
}

/** Exact public brand/app/command lookup; ambiguous aliases intentionally resolve to nothing. */
export function agentForAlias(value: unknown, catalog: AgentCatalog): string | null {
  if (typeof value !== 'string') return null
  const matches = catalog.aliasIds.get(normalized(value))
  return matches?.size === 1 ? matches.values().next().value ?? null : null
}


function titleHasAlias(title: string, alias: string): boolean {
  const parts = alias.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (parts.length === 0) return false
  const phrase = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]+')
  const text = title.trim().replace(/\s+/g, ' ')
  const visible = text.replace(/^(?:[\u2800-\u28ff\u2726\u23f2\u25c7\u270b\u2733]\s+)+/u, '').trimStart()
  const prefix = new RegExp(`^${phrase}(?=$|[\\s:|·])`, 'i')
  const match = prefix.exec(visible)
  if (match) {
    const remainder = visible.slice(match[0].length)
    const explicitSeparator = /^\s+(?:-|–|—|\||·)\s+|^\s*:\s+/.test(remainder)
    if (parts.length > 1 || explicitSeparator) return true
  }
  // A full multi-word catalog label is a brand even without a suffix.
  if (parts.length > 1 && normalized(text) === normalized(alias)) return true
  // Upstream terminal titles use an explicit separator before their trailing brand (e.g. task - grok).
  // Reject paths here: a shell's cwd title ending in /claude is not an agent title.
  const suffix = new RegExp(`(?:^|\\s(?:-|–|—|\\||·)\\s)${phrase}$`, 'i')
  return !/[\\/]/.test(text) && suffix.test(text)
}

/**
 * Resolves a title only when a public catalog brand is at the title edge. It deliberately does not
 * scan task text or paths: `working on codex docs` and `user@host:/repo/claude` stay shell titles.
 */
export function agentForTitle(title: unknown, catalog: AgentCatalog): string | null {
  if (typeof title !== 'string' || title.trim() === '') return null
  const matches = new Set<string>()
  for (const agent of catalog.byId.values()) {
    if (agent.aliases.some((alias) => alias && titleHasAlias(title, alias))) matches.add(agent.id)
  }
  if (matches.size === 1) return matches.values().next().value ?? null
  if (matches.size > 1) return null

  // Claude Code has three explicit upstream status frames that omit its brand name.
  if (isCatalogAgent('claude', catalog) && /^(?:✳(?:\s|$)|\.\s|\*\s)/u.test(title.trimStart())) return 'claude'
  return null
}

/** Returns only metadata explicitly attached to a managed terminal launch. */
export function agentForManagedLaunch(session: Session, catalog: AgentCatalog): string | null {
  if (session.kind !== 'terminal') return null
  const settingsAgent = session.launchSettings?.agent
  if (typeof settingsAgent === 'string' && isCatalogAgent(settingsAgent, catalog)) return settingsAgent
  if (session.agent !== 'shell' && isCatalogAgent(session.agent, catalog)) return session.agent
  return session.launch ? agentForAlias(commandAlias(session.launch.command), catalog) : null
}
