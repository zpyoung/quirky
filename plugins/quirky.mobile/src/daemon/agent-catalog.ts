import type { PluginContext } from '@quirky/protocol'

export type MobileAgentCatalog = {
  defaultAgent: string | null
  agents: {
    id: string
    label: string
    installed: boolean
    enabled: boolean
    isDefault: boolean
    resumable: boolean
  }[]
}

/** Project before serialization: the full agents catalog includes configured commands and credentials. */
export function registerMobileAgentCatalog(context: PluginContext): void {
  context.provide('method:quirky.mobile/agentCatalog', async (): Promise<MobileAgentCatalog> => {
    const value = await context.call('quirky.agents/list', {})
    if (value === null || typeof value !== 'object' || !('agents' in value) || !Array.isArray(value.agents)) {
      throw context.error('conflict', 'The agent catalog is unavailable')
    }
    const defaultAgent = 'defaultAgent' in value && typeof value.defaultAgent === 'string' ? value.defaultAgent : null
    const agents: MobileAgentCatalog['agents'] = []
    for (const entry of value.agents) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.label !== 'string' ||
        typeof entry.installed !== 'boolean' || typeof entry.enabled !== 'boolean') {
        throw context.error('conflict', 'The agent catalog returned invalid launcher metadata')
      }
      agents.push({ id: entry.id, label: entry.label, installed: entry.installed, enabled: entry.enabled,
        isDefault: entry.id === defaultAgent, resumable: entry.resumable === true })
    }
    return { defaultAgent, agents }
  })
}
