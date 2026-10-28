import type { PluginContext } from '@quirky/protocol'
import type { OrchestrationMethod } from './src/contracts'
import { createOrchestration } from './src/service'
import { migrations } from './src/store'
import type { OrchestrationService } from './src/surface-contracts'

const methods = [
  'runCreate',
  'runUse',
  'runCurrent',
  'runList',
  'runShow',
  'taskCreate',
  'taskList',
  'taskUpdate',
  'dispatch',
  'dispatchShow',
  'send',
  'check',
  'reply',
  'inbox',
  'ask',
  'gateCreate',
  'gateResolve',
  'gateList',
  'requestShow',
  'reset'
] as const satisfies readonly OrchestrationMethod[]

let activeService: OrchestrationService | undefined

export function activate(context: PluginContext): void {
  const store = context.openStore(migrations)
  const service = createOrchestration(context, store)
  for (const method of methods) {
    context.provide(`method:${context.pluginId}/${method}`, service.methods[method])
  }
  activeService = service
}

export async function deactivate(): Promise<void> {
  const service = activeService
  activeService = undefined
  await service?.dispose()
}
