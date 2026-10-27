import type { UiPluginContext } from '@quirky/protocol'
import type { NewSessionRequest } from './PromptDialog'

/** The fields of a `quirky.agents/list` result the menu reads. */
export type AgentListing = { defaultAgent: string; agents: AgentInfo[] }
type AgentInfo = { id: string; label: string; installed: boolean; enabled: boolean; isDefault: boolean }

export const AGENTS_VIEW_ID = 'view:quirky.agents/settings'

export type MenuEntry = { kind: 'session'; label: string; request: NewSessionRequest } | { kind: 'manage'; label: string }

const SHELL: MenuEntry = { kind: 'session', label: 'Shell', request: { agent: 'shell', background: false, label: 'Shell' } }
const MANAGE: MenuEntry = { kind: 'manage', label: 'Manage agents' }

/** What the menu shows before the agent list arrives, and when it cannot be read. */
export const SHELL_ONLY_MENU: MenuEntry[] = [SHELL, MANAGE]

const offered = (agent: AgentInfo) => agent.installed && agent.enabled

/**
 * The menu for `listing`: Shell, the installed enabled agents (the default first, the rest in
 * listing order), "Claude (background)" when Claude is among them, then Manage agents.
 */
export function menuEntries(listing: AgentListing): MenuEntry[] {
  const agents = listing.agents.filter(offered)
  const isDefault = (agent: AgentInfo) => agent.isDefault || agent.id === listing.defaultAgent
  const ordered = [...agents.filter(isDefault), ...agents.filter((agent) => !isDefault(agent))]
  const entries: MenuEntry[] = ordered.map((agent) => ({
    kind: 'session',
    label: agent.label,
    request: { agent: agent.id, background: false, label: agent.label }
  }))
  if (agents.some((agent) => agent.id === 'claude')) {
    entries.push({ kind: 'session', label: 'Claude (background)', request: { agent: 'claude', background: true, label: 'Claude (background)' } })
  }
  return [SHELL, ...entries, MANAGE]
}

/** Reads the catalog and builds the menu; a failed read gives the shell-only menu. */
export async function loadMenuEntries(context: UiPluginContext): Promise<MenuEntry[]> {
  try {
    return menuEntries((await context.call('quirky.agents/list')) as AgentListing)
  } catch {
    return SHELL_ONLY_MENU
  }
}
