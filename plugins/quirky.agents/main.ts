import type { PluginContext } from '@quirky/protocol'
import { AgentsService } from './src/service'
import { AgentConfigStore, agentMigrations } from './src/store'

let service: AgentsService | undefined

/** Stops the generations still running; their agents would otherwise outlive the daemon. */
export function deactivate(): void {
  service?.stopGenerating()
  service = undefined
}

/**
 * Entry point of the Agents plugin, which owns the catalog of agent CLIs Quirky can launch:
 * their manifest data, detection on the machine, saved configuration, launch and resume plans,
 * workspace trust and first-prompt delivery. The pieces register themselves from here.
 */
export async function activate(context: PluginContext): Promise<void> {
  const created = new AgentsService(context, new AgentConfigStore(context.openStore(agentMigrations)))
  service = created

  const methods = {
    list: created.list,
    get: created.get,
    refresh: created.refresh,
    setEnabled: created.setEnabled,
    setDefault: created.setDefault,
    configure: created.configure,
    setPermissions: created.setPermissions,
    plan: created.plan,
    options: created.options,
    resolveLaunch: created.resolveLaunch,
    pick: created.pick,
    prepareLaunch: created.prepareLaunch,
    prepareResume: created.prepareResume,
    deliver: created.deliver,
    generate: created.generate,
    cancelGenerate: created.cancelGenerate
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:${context.pluginId}/${name}`, handler)

  await created.start()
}
