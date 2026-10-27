import type { UiPluginContext } from '@quirky/protocol'
import type { NewSessionRequest } from './PromptDialog'

/** The fields of a `quirky.agents/list` result the menu reads. */
export type AgentListing = { defaultAgent: string; agents: AgentInfo[] }
type AgentInfo = { id: string; label: string; installed: boolean; enabled: boolean; isDefault: boolean }

export const AGENTS_VIEW_ID = 'view:quirky.agents/settings'

export type MenuEntry =
  | { kind: 'terminal'; label: string }
  | { kind: 'agent'; label: string; request: NewSessionRequest }
  | { kind: 'manage'; label: string }

const TERMINAL: MenuEntry = { kind: 'terminal', label: 'New Terminal' }
const MANAGE: MenuEntry = { kind: 'manage', label: 'Agent settings…' }

/** What the menu shows before the agent list arrives, and when it cannot be read. */
export const TERMINAL_ONLY_MENU: MenuEntry[] = [TERMINAL, MANAGE]

const offered = (agent: AgentInfo) => agent.installed && agent.enabled

/**
 * The `+` menu for `listing`: New Terminal, the installed enabled agents (the default first, the
 * rest in listing order), "Claude (background)" when Claude is among them, then Agent settings.
 */
export function menuEntries(listing: AgentListing): MenuEntry[] {
  const agents = listing.agents.filter(offered)
  const isDefault = (agent: AgentInfo) => agent.isDefault || agent.id === listing.defaultAgent
  const ordered = [...agents.filter(isDefault), ...agents.filter((agent) => !isDefault(agent))]
  const entries: MenuEntry[] = ordered.map((agent) => ({
    kind: 'agent',
    label: agent.label,
    request: { agent: agent.id, background: false, label: agent.label }
  }))
  if (agents.some((agent) => agent.id === 'claude')) {
    entries.push({ kind: 'agent', label: 'Claude (background)', request: { agent: 'claude', background: true, label: 'Claude (background)' } })
  }
  return [TERMINAL, ...entries, MANAGE]
}

/** Reads the catalog and builds the menu; a failed read gives the terminal-only menu. */
export async function loadMenuEntries(context: Pick<UiPluginContext, 'call'>): Promise<MenuEntry[]> {
  try {
    return menuEntries((await context.call('quirky.agents/list')) as AgentListing)
  } catch {
    return TERMINAL_ONLY_MENU
  }
}

/** The entries whose label contains `query`, ignoring case; every entry for a blank query. */
export function filterEntries(entries: readonly MenuEntry[], query: string): MenuEntry[] {
  const needle = query.trim().toLowerCase()
  return needle === '' ? [...entries] : entries.filter((entry) => entry.label.toLowerCase().includes(needle))
}
