import type { PluginContext } from '@quirky/protocol'
import type { OrchestrationMethod } from './src/contracts'
import { createOrchestration, type ComposedOrchestrationService } from './src/service'
import { migrations, policyMigration } from './src/store'
import { createSetup } from './src/setup'
import { createTaskNavigation } from './src/navigation'
import { verifyCaller } from './src/identity'
import { createWorkerCore } from './src/workers/core-adapter'
import { registerWorkers, type WorkerComponents } from './src/workers/register'
import { workerMigrations } from './src/workers/store'
import { serviceMigrations } from './src/services/migrations'

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
  'reset',
  'serviceRunCreate',
  'serviceRunShow',
  'serviceWorkerStart',
  'serviceCheck',
  'serviceWorkerRelease',
  'serviceWorkerStop',
  'serviceReply',
  'serviceSend'
] as const satisfies readonly OrchestrationMethod[]

let activeService: ComposedOrchestrationService | undefined
let activeWorkers: WorkerComponents | undefined

export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore([...migrations, ...workerMigrations, ...serviceMigrations, policyMigration])
  const service = createOrchestration(context, store)
  let workers: WorkerComponents | undefined
  try {
    const workerCore = createWorkerCore(service.core, service.serviceCoordinator)
    workers = registerWorkers(
      workerCore,
      async (caller, aliases) => (await verifyCaller(context, caller, aliases)).evidence,
      (listener) => context.pty.onUserInput(listener)
    )
    service.serviceCoordinator.bindWorkers(workers)
    for (const method of methods) {
      context.provide(`method:${context.pluginId}/${method}`, service.methods[method])
    }
    const setup = createSetup(context, service.core)
    const navigation = createTaskNavigation(context, service.core)
    for (const [method, handler] of Object.entries(setup)) {
      context.provide(`method:${context.pluginId}/${method}`, handler)
    }
    context.provide(`method:${context.pluginId}/taskTerminal`, navigation)
    for (const [method, handler] of Object.entries(workers.methods)) {
      context.provide(`method:${context.pluginId}/${method}`, handler)
    }
    activeService = service
    activeWorkers = workers
  } catch (error) {
    const cleanup = await Promise.allSettled([workers?.dispose(), service.dispose()])
    for (const result of cleanup) if (result.status === 'rejected') context.log(`activation cleanup failed: ${String(result.reason)}`)
    throw error
  }
}

export async function deactivate(): Promise<void> {
  const service = activeService
  const workers = activeWorkers
  activeService = undefined
  activeWorkers = undefined
  try {
    await workers?.dispose()
  } finally {
    await service?.dispose()
  }
}
