import type { MethodHandler, PluginCaller, PluginContext, PluginStore } from '@quirky/protocol'
import type {
  GateCreateParams,
  GateListParams,
  GateResolveParams,
  OrchestrationMethod,
  ResetMode,
  SendParams,
  CheckParams,
  ReplyParams,
  InboxParams,
  AskParams
} from './contracts'
import { OrchestrationCore } from './core'
import { OrchestrationGates } from './gates'
import { verifyCaller } from './identity'
import { OrchestrationMessages } from './messaging'
import { OrchestrationPointers } from './pointers'
import { runTaskMethods } from './runs'
import type { OrchestrationService } from './surface-contracts'
import { createServiceCoordinator, type OrchestrationServiceCoordinator } from './services/coordinator'
import { createServiceHandlers } from './services/handlers'
import type { ServiceHandler, ServiceMethod, ServiceMethodInputs } from './services/contracts'

function adaptServiceHandler<M extends ServiceMethod>(handler: ServiceHandler<M>): MethodHandler {
  return (params, caller) => handler(params as unknown as ServiceMethodInputs[M], caller)
}

/** Compose the semantic core once around the caller-provided plugin store. */
export type ComposedOrchestrationService = OrchestrationService & {
  readonly serviceCoordinator: OrchestrationServiceCoordinator
  readonly messages: OrchestrationMessages
}
export function createOrchestration(context: PluginContext, store: PluginStore): ComposedOrchestrationService {
  const core = new OrchestrationCore(context, store)
  const messages = new OrchestrationMessages(context, core)
  const serviceCoordinator = createServiceCoordinator(context, core, messages)
  const pointers = new OrchestrationPointers(context, store, core, messages)
  const serviceHandlers = createServiceHandlers(serviceCoordinator)
  const serviceMethods: Record<ServiceMethod, MethodHandler> = {
    serviceRunCreate: adaptServiceHandler<'serviceRunCreate'>(serviceHandlers.serviceRunCreate),
    serviceRunShow: adaptServiceHandler<'serviceRunShow'>(serviceHandlers.serviceRunShow),
    serviceWorkerStart: adaptServiceHandler<'serviceWorkerStart'>(serviceHandlers.serviceWorkerStart),
    serviceCheck: adaptServiceHandler<'serviceCheck'>(serviceHandlers.serviceCheck),
    serviceWorkerRelease: adaptServiceHandler<'serviceWorkerRelease'>(serviceHandlers.serviceWorkerRelease),
    serviceWorkerStop: adaptServiceHandler<'serviceWorkerStop'>(serviceHandlers.serviceWorkerStop),
    serviceReply: adaptServiceHandler<'serviceReply'>(serviceHandlers.serviceReply),
    serviceSend: adaptServiceHandler<'serviceSend'>(serviceHandlers.serviceSend),
    serviceRegisterSubmissionPreflight: adaptServiceHandler<'serviceRegisterSubmissionPreflight'>(serviceHandlers.serviceRegisterSubmissionPreflight)
  }
  let disposed = false
  const removeMessageEvent = messages.onArrival(({ messageId, type }) => {
    if (disposed) return
    const row = store.get<{ run_id: string }>(`SELECT run_id FROM messages WHERE id = ?`, messageId)
    if (row && !disposed) context.emit('message-arrived', { runId: row.run_id, messageId, type })
  })
  const gates = new OrchestrationGates(core)
  const runMethods = runTaskMethods(
    context,
    core,
    (mode: ResetMode) => {
      messages.resetWaiters(mode)
      pointers.reset(mode)
    },
    (run) => pointers.scheduleMailbox({ kind: 'run', runId: run.id })
  )
  pointers.start()

  const methods = {
    runCreate: runMethods.runCreate,
    runUse: runMethods.runUse,
    runCurrent: runMethods.runCurrent,
    runList: runMethods.runList,
    runShow: runMethods.runShow,
    taskCreate: runMethods.taskCreate,
    taskList: runMethods.taskList,
    taskUpdate: runMethods.taskUpdate,
    dispatch: runMethods.dispatch,
    dispatchShow: runMethods.dispatchShow,
    send: (params, caller) => messages.send(params as unknown as SendParams, caller),
    check: (params, caller) => messages.check(params as unknown as CheckParams, caller),
    reply: (params, caller) => messages.reply(params as unknown as ReplyParams, caller),
    inbox: (params) => messages.inbox(params as unknown as InboxParams),
    ask: (params, caller) => messages.ask(params as unknown as AskParams, caller),
    gateCreate: async (raw: Record<string, unknown>, caller: PluginCaller) => {
      const params = raw as unknown as GateCreateParams
      const verified = await verifyCaller(context, caller, params)
      return core.mutate('gateCreate', params, verified.evidence, () => gates.create(params, verified.evidence))
    },
    gateResolve: async (raw: Record<string, unknown>, caller: PluginCaller) => {
      const params = raw as unknown as GateResolveParams
      const verified = await verifyCaller(context, caller, params)
      return core.mutate('gateResolve', params, verified.evidence, () => gates.resolve(params, verified.evidence))
    },
    gateList: async (raw: Record<string, unknown>, caller: PluginCaller) => {
      const params = raw as unknown as GateListParams
      if (params.runId !== undefined || params.taskId !== undefined) return gates.list(params)
      const verified = await verifyCaller(context, caller, params)
      return gates.list(params, verified.evidence)
    },
    requestShow: runMethods.requestShow,
    reset: runMethods.reset,
    ...serviceMethods
  } satisfies Record<OrchestrationMethod, MethodHandler>

  return {
    core,
    messages,
    serviceCoordinator,
    methods,
    async dispose() {
      if (disposed) return
      disposed = true
      await pointers.dispose()
      messages.dispose()
      await core.dispose()
    }
  }
}
