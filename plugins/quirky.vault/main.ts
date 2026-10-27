import type { PluginContext } from '@quirky/protocol'
import { VaultService } from './src/service'
import { VaultWorkerClient } from './src/worker-client'

let service: VaultService | undefined

export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore([
    'CREATE TABLE IF NOT EXISTS vault_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)'
  ])
  const worker = new VaultWorkerClient(context.workerEntrypoint('scanner'), (event) => {
    context.emit(event.event, event.data)
  })
  const vault = new VaultService(context, store, worker)
  service = vault
  for (const [name, handler] of Object.entries(vault.methods)) {
    context.provide(`method:${context.pluginId}/${name}`, handler)
  }
}

export async function deactivate(): Promise<void> {
  const current = service
  service = undefined
  await current?.close()
}
