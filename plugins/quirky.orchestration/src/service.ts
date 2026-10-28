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
import { runTaskMethods } from './runs'
import type { OrchestrationService } from './surface-contracts'

/** Compose the semantic core once around the caller-provided plugin store. */
export function createOrchestration(context: PluginContext, store: PluginStore): OrchestrationService {
  const core = new OrchestrationCore(context, store)
  const messages = new OrchestrationMessages(context, core)
  const gates = new OrchestrationGates(core)
  const runMethods = runTaskMethods(context, core, (mode: ResetMode) => messages.resetWaiters(mode))

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
    reset: runMethods.reset
  } satisfies Record<OrchestrationMethod, MethodHandler>

  let disposed = false
  return {
    core,
    methods,
    async dispose() {
      if (disposed) return
      disposed = true
      messages.dispose()
      await core.dispose()
    }
  }
}
