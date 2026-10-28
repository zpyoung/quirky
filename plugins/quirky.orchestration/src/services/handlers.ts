import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type { RunId } from '../contracts'
import type {
  ServiceCoordinatorPrincipal, ServiceHandler, ServiceMethod, ServiceMethodInputs, ServiceMethodResults
} from './contracts'

/**
 * The core implements this port using the existing Run store, mutation receipts, message service,
 * WorkerStarter, and WorkerLifecycle. It is intentionally explicit: services never fabricate a
 * RuntimeCallerEvidence or persist an owner as a session identity.
 */
type MaybePromise<T> = T | Promise<T>

/** Core operations revalidate owner and dispatch membership at their read/transaction boundary. */

export interface ServiceCoordinatorPort {
  readonly context: PluginContext
  /** Owner-only predicate; it does not return Run data to the caller. */
  requireOwnedRun(pluginId: string, runId: RunId): void
  serviceRunCreate(params: ServiceMethodInputs['serviceRunCreate'], pluginId: string): MaybePromise<ServiceMethodResults['serviceRunCreate']>
  /** Rechecks ownership before collecting or returning workers/questions. */
  serviceRunShow(params: ServiceMethodInputs['serviceRunShow'], pluginId: string): MaybePromise<ServiceMethodResults['serviceRunShow']>
  serviceWorkerStart(params: ServiceMethodInputs['serviceWorkerStart'], principal: ServiceCoordinatorPrincipal): MaybePromise<ServiceMethodResults['serviceWorkerStart']>
  serviceCheck(params: ServiceMethodInputs['serviceCheck'], principal: ServiceCoordinatorPrincipal): MaybePromise<ServiceMethodResults['serviceCheck']>
  serviceWorkerRelease(params: ServiceMethodInputs['serviceWorkerRelease'], principal: ServiceCoordinatorPrincipal): MaybePromise<ServiceMethodResults['serviceWorkerRelease']>
  serviceWorkerStop(params: ServiceMethodInputs['serviceWorkerStop'], principal: ServiceCoordinatorPrincipal): MaybePromise<ServiceMethodResults['serviceWorkerStop']>
  serviceReply(params: ServiceMethodInputs['serviceReply'], principal: ServiceCoordinatorPrincipal): MaybePromise<ServiceMethodResults['serviceReply']>
  serviceSend(params: ServiceMethodInputs['serviceSend'], principal: ServiceCoordinatorPrincipal): MaybePromise<ServiceMethodResults['serviceSend']>
}

export type ServiceMethodHandlers = {
  [M in ServiceMethod]: ServiceHandler<M>
}

function pluginOwner(context: PluginContext, caller: PluginCaller): string {
  if (caller.role !== 'plugin' || typeof caller.pluginId !== 'string' || caller.pluginId.trim().length === 0) {
    throw context.error('conflict', 'consumer_fenced: service orchestration methods require a kernel-authenticated plugin caller')
  }
  return caller.pluginId
}

function ownedCoordinator(
  port: ServiceCoordinatorPort,
  caller: PluginCaller,
  runId: RunId
): ServiceCoordinatorPrincipal {
  const pluginId = pluginOwner(port.context, caller)
  port.requireOwnedRun(pluginId, runId)
  return { kind: 'service', pluginId, runId, authority: 'kernel_plugin' }
}

export function createServiceHandlers(port: ServiceCoordinatorPort): ServiceMethodHandlers {
  return {
    serviceRunCreate: (params, caller) => port.serviceRunCreate(params, pluginOwner(port.context, caller)),
    serviceRunShow: (params, caller) => {
      const pluginId = pluginOwner(port.context, caller)
      port.requireOwnedRun(pluginId, params.runId)
      return port.serviceRunShow(params, pluginId)
    },
    serviceWorkerStart: (params, caller) => port.serviceWorkerStart(params, ownedCoordinator(port, caller, params.runId)),
    serviceCheck: (params, caller) => port.serviceCheck(params, ownedCoordinator(port, caller, params.runId)),
    serviceWorkerRelease: (params, caller) => port.serviceWorkerRelease(params, ownedCoordinator(port, caller, params.runId)),
    serviceWorkerStop: (params, caller) => port.serviceWorkerStop(params, ownedCoordinator(port, caller, params.runId)),
    serviceReply: (params, caller) => port.serviceReply(params, ownedCoordinator(port, caller, params.runId)),
    serviceSend: (params, caller) => port.serviceSend(params, ownedCoordinator(port, caller, params.runId))
  }
}
