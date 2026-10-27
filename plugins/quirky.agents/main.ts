import type { PluginContext } from '@quirky/protocol'
import { AgentsService } from './src/service'
import { AgentConfigStore, agentMigrations } from './src/store'

/**
 * Entry point of the Agents plugin, which owns the catalog of agent CLIs Quirky can launch:
 * their manifest data, detection on the machine, saved configuration, launch and resume plans,
 * workspace trust and first-prompt delivery. The pieces register themselves from here.
 */
export async function activate(context: PluginContext): Promise<void> {
  const service = new AgentsService(context, new AgentConfigStore(context.openStore(agentMigrations)))

  const methods = {
    list: service.list,
    get: service.get,
    refresh: service.refresh,
    setEnabled: service.setEnabled,
    setDefault: service.setDefault,
    configure: service.configure,
    setPermissions: service.setPermissions,
    plan: service.plan,
    options: service.options,
    resolveLaunch: service.resolveLaunch,
    pick: service.pick,
    prepareLaunch: service.prepareLaunch,
    prepareResume: service.prepareResume,
    deliver: service.deliver
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:${context.pluginId}/${name}`, handler)

  await service.start()
}
