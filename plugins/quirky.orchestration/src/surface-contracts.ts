import type { MethodHandler } from '@quirky/protocol'
import type { OrchestrationMethod } from './contracts'
import type { OrchestrationWorkerCore } from './worker-integration'

/** Local composition boundary, not another RPC or store. */
export interface OrchestrationService {
  readonly core: OrchestrationWorkerCore
  readonly methods: Readonly<Record<OrchestrationMethod, MethodHandler>>
  dispose(): void | Promise<void>
}

/** src/service.ts exports createOrchestration(context, store): OrchestrationService.
 * main.ts alone opens the published migrations, calls the factory once, provides
 * each declared method and disposes it on deactivation. Core source owns all
 * identity, lifecycle, mail, wait, receipt and pointer-policy semantics. Surface
 * code owns only main/manifest/CLI/package declarations. Worker/service hubs
 * compose later through the same core/store, never a second authority engine.
 */
