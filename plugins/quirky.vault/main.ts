import type { PluginContext } from '@quirky/protocol'
import { VaultService } from './src/service'
import { VaultWorkerClient } from './src/worker-client'


export async function activate(context: PluginContext): Promise<() => Promise<void>> {
  const store = context.openStore([
    'CREATE TABLE IF NOT EXISTS vault_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)'
  ])
  const worker = new VaultWorkerClient(
    context.workerEntrypoint('scanner'),
    (event) => context.emit(event.event, event.data),
    { ...process.env }
  )
  const vault = new VaultService(context, store, worker)
  try {
    for (const [name, handler] of Object.entries(vault.methods)) {
      context.provide(`method:${context.pluginId}/${name}`, handler)
    }
  } catch (error) {
    await vault.close()
    throw error
  }
  return () => vault.close()
}

