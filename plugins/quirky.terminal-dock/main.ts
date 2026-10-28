import type { PluginContext } from '@quirky/protocol'
import { createProviderBridge } from './src/providers'
import { DockService } from './src/service'
import { DockStore, migrations } from './src/store'

let service: DockService | undefined

export async function activate(context: PluginContext): Promise<void> {
  const active = new DockService(context, new DockStore(context.openStore(migrations)), createProviderBridge(context))
  service = active
  for (const [name, handler] of Object.entries(active.methods)) {
    context.provide(`method:${context.pluginId}/${name}`, handler)
  }
  try {
    await active.start()
  } catch (error) {
    active.shutdown()
    service = undefined
    throw error
  }
}

export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
