import type { OrchestrationSubmission, PluginCaller, PluginContext } from '@quirky/protocol'
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
import { PeerManager } from './src/peers'
import { federationMigrations } from './src/federation/binding-store'
import { federationMailMigrations } from './src/federation/mail-store'
import { createFederationEngine, type FederationEnginePort } from './src/federation/engine'
import { createFederationMail, type FederationMailComponent } from './src/federation/mail'
import { createFederationSurface } from './src/federation/surface'
import { fail } from './src/errors'
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
  'serviceSend',
  'serviceRegisterSubmissionPreflight'
] as const satisfies readonly OrchestrationMethod[]

let activeService: ComposedOrchestrationService | undefined
let activeWorkers: WorkerComponents | undefined
let activePeers: PeerManager | undefined
let activeFederation: FederationEnginePort | undefined
let activeMail: FederationMailComponent | undefined

export async function activate(context: PluginContext): Promise<void> {
  const store = context.openStore([
    ...migrations,
    ...workerMigrations,
    ...serviceMigrations,
    policyMigration,
    ...federationMigrations,
    ...federationMailMigrations,
  ])
  const service = createOrchestration(context, store)
  const peers = new PeerManager(context, store)
  let workers: WorkerComponents | undefined
  let engine: FederationEnginePort | undefined
  let mail: FederationMailComponent | undefined
  try {
    const workerCore = createWorkerCore(service.core, service.serviceCoordinator)
    workers = registerWorkers(
      workerCore,
      async (caller, aliases) => (await verifyCaller(context, caller, aliases)).evidence,
      (listener) => context.pty.onUserInput(listener),
    )
    service.serviceCoordinator.bindWorkers(workers)
    engine = createFederationEngine(context, store, service.core, workers, peers)
    mail = createFederationMail(context, service.core, service.messages, engine)
    engine.bindMail(mail)
    const surface = createFederationSurface(context, service.core, engine)
    workers.bindFederation(engine, surface)
    for (const method of methods) {
      context.provide(`method:${context.pluginId}/${method}`, service.methods[method])
    }
    for (const [method, handler] of Object.entries(peers.methods)) {
      context.provide(`method:${context.pluginId}/${method}`, handler)
    }
    const setup = createSetup(context, service.core)
    const navigation = createTaskNavigation(context, service.core, engine)
    for (const [method, handler] of Object.entries(setup)) {
      context.provide(`method:${context.pluginId}/${method}`, handler)
    }
    context.provide(`method:${context.pluginId}/taskTerminal`, navigation)
    context.provide(`method:${context.pluginId}/federationSubmissionPreflight`, async (
      params: Record<string, unknown>,
      caller: PluginCaller,
    ) => {
      if (caller.role !== 'plugin' || caller.pluginId !== context.pluginId) {
        fail(context, 'peer_plugin_only', 'federationSubmissionPreflight is available only to the orchestration plugin.')
      }
      return mail!.submissionPreflight(params as OrchestrationSubmission)
    })
    for (const [method, handler] of Object.entries(workers.methods)) {
      context.provide(`method:${context.pluginId}/${method}`, handler)
    }
    await peers.restore()
    activeService = service
    activeWorkers = workers
    activePeers = peers
    activeFederation = engine
    activeMail = mail
  } catch (error) {
    try { await engine?.dispose() } catch (cleanupError) { context.log(`activation cleanup failed: ${String(cleanupError)}`) }
    try { await peers.dispose() } catch (cleanupError) { context.log(`activation cleanup failed: ${String(cleanupError)}`) }
    try { await mail?.dispose() } catch (cleanupError) { context.log(`activation cleanup failed: ${String(cleanupError)}`) }
    try { await workers?.dispose() } catch (cleanupError) { context.log(`activation cleanup failed: ${String(cleanupError)}`) }
    try { await service.dispose() } catch (cleanupError) { context.log(`activation cleanup failed: ${String(cleanupError)}`) }
    throw error
  }
}

export async function deactivate(): Promise<void> {
  const service = activeService
  const workers = activeWorkers
  const peers = activePeers
  const engine = activeFederation
  const mail = activeMail
  activeService = undefined
  activeWorkers = undefined
  activePeers = undefined
  activeFederation = undefined
  activeMail = undefined
  try { await engine?.dispose() } catch (error) { service?.core.context.log(`deactivation cleanup failed: ${String(error)}`) }
  try { await peers?.dispose() } catch (error) { service?.core.context.log(`deactivation cleanup failed: ${String(error)}`) }
  try { await mail?.dispose() } catch (error) { service?.core.context.log(`deactivation cleanup failed: ${String(error)}`) }
  try { await workers?.dispose() } catch (error) { service?.core.context.log(`deactivation cleanup failed: ${String(error)}`) }
  try { await service?.dispose() } catch (error) { service?.core.context.log(`deactivation cleanup failed: ${String(error)}`) }
}
