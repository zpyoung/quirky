import type { MethodHandler, PluginCaller } from '@quirky/protocol'
import type { DeclaredCallerAliases, RuntimeCallerEvidence } from '../contracts'
import type { FederationEngine, FederationSurface } from '../federation/contracts'
import type {
  WorkerControlParams, WorkerCore, WorkerLifecycle, WorkerListParams, WorkerListResult, WorkerReadParams, WorkerStarter,
  WorkerShowParams, WorkerStartParams, WorkerUserInputParams,
} from '../worker-contracts'
import { createWorkerFleet } from './fleet'
import { createWorkerLifecycle } from './lifecycle'
import { createWorkerOutput } from './output'
import { createWorkerRuntime } from './runtime'
import { createWorkerStarter } from './start'
import { createWorkerStore } from './store'

/** The kernel's synchronous user-input guard; ordinary plugin/query writes never call it. */
export type WorkerUserInputGuard = (listener: (input: WorkerUserInputParams) => void) => () => void
export type WorkerCallerResolver = (caller: PluginCaller, aliases?: Pick<DeclaredCallerAliases, 'from'>) => RuntimeCallerEvidence | Promise<RuntimeCallerEvidence>
export interface WorkerComponents {
  methods: Record<string, MethodHandler>
  starter: WorkerStarter
  lifecycle: WorkerLifecycle
  bindFederation(engine: FederationEngine, surface: FederationSurface): void
  dispose(): Promise<void>
}

/** Composes real worker components over the already-opened core store and public runtime. */
export function registerWorkers(core: WorkerCore, resolveCaller: WorkerCallerResolver, onUserInput: WorkerUserInputGuard): WorkerComponents {
  const repo = createWorkerStore(core.store)
  const runtime = createWorkerRuntime(core.context)
  const output = createWorkerOutput(core, repo, runtime)
  let federationEngine: FederationEngine | null = null
  let federationSurface: FederationSurface | null = null
  const getFederation = () => federationEngine
  const lifecycle = createWorkerLifecycle(core, repo, runtime, output, getFederation)
  const starter = createWorkerStarter(core, repo, runtime, lifecycle)
  const fleet = createWorkerFleet(core, repo, runtime, getFederation)
  let active = true
  const pending = new Set<Promise<void>>()
  const track = (work: Promise<void>) => {
    pending.add(work)
    void work.catch((error) => core.context.log(`worker reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => pending.delete(work))
  }
  const unsubscribeInput = onUserInput((input) => {
    if (active) lifecycle.userInput(input)
  })
  const unsubscribeReconnect = core.context.pty.onReconnect(() => {
    if (active) track(lifecycle.recoverReleases())
  })
  if (active) track(lifecycle.recoverReleases())

  const control = (method: 'stop' | 'abandon' | 'release' | 'retain'): MethodHandler => async (params, caller) => {
    const input = params as unknown as WorkerControlParams
    const evidence = await resolveCaller(caller, { from: params.from as string | undefined })
    const binding = federationEngine?.home(input.dispatchId)
    if (binding) {
      if (!federationSurface) throw core.context.error('conflict', 'Federation surface is unavailable.')
      return federationSurface.control(method, input, evidence)
    }
    return lifecycle[method](input, evidence)
  }
  const methods: Record<string, MethodHandler> = {
    workerStart: async (params, caller) => {
      const input = params as unknown as WorkerStartParams
      const evidence = await resolveCaller(caller, { from: params.from as string | undefined })
      if (Object.hasOwn(params, 'on')) {
        if (!federationEngine) throw core.context.error('conflict', 'Federated worker execution is unavailable.')
        return federationEngine.start(input, evidence)
      }
      return starter.start(input, evidence)
    },
    workerShow: (params) => {
      const input = params as unknown as WorkerShowParams
      const binding = federationEngine?.home(input.dispatchId)
      if (binding) {
        if (!federationSurface) throw core.context.error('conflict', 'Federation surface is unavailable.')
        return federationSurface.show(input)
      }
      return fleet.show(input)
    },
    workerRead: (params) => {
      const input = params as unknown as WorkerReadParams
      const binding = federationEngine?.home(input.dispatchId)
      if (binding) {
        if (!federationSurface) throw core.context.error('conflict', 'Federation surface is unavailable.')
        return federationSurface.read(input)
      }
      return output.read(input)
    },
    workerList: async (params, caller) => {
      // Read-only host inventory remains available to an unbound operator. A supplied
      // session still must authenticate rather than silently becoming an all-Runs query.
      const evidence = caller.role !== 'plugin' && caller.sessionId ? await resolveCaller(caller) : null
      const input = params as WorkerListParams
      if (!federationSurface || input.includeRemote !== true) {
        const local = await fleet.list(input, evidence)
        return federationSurface ? federationSurface.list(input, evidence, local) : local
      }
      if (input.cursor !== undefined) return federationSurface.list(input, evidence, {
        workers: [],
        scope: { runId: null, source: 'all' },
        page: { nextCursor: null, snapshotId: '', total: 0 },
        partialHostErrors: []
      })
      const local = await fleet.list({
        ...input,
        terminalState: undefined,
        includeRemote: false,
        cursor: undefined,
        limit: undefined
      }, evidence)
      return federationSurface.list(input, evidence, local)
    },
    workerStop: control('stop'),
    workerAbandon: control('abandon'),
    workerRelease: control('release'),
    workerRetain: control('retain'),
    workerTerminalUserInput: (params) => lifecycle.userInput(params as unknown as WorkerUserInputParams),
  }
  for (const [name, execute] of Object.entries(methods)) {
    methods[name] = async (params, caller) => {
      try {
        return await execute(params, caller)
      } catch (error) {
        // Worker domain refusals carry named reasons; the transport still uses
        // Quirky's numeric JSON-RPC errors and the core's data.reason convention.
        if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error
        const reason = error.code
        const kind = reason === 'invalid_argument' || reason === 'worker_prompt_too_large' || reason === 'cursor_invalid'
          ? 'invalid-params'
          : reason === 'task_not_found' || reason === 'dispatch_not_found' || reason === 'run_not_found' || reason === 'terminal_not_found'
            ? 'not-found' : 'conflict'
        const details = 'data' in error && error.data !== null && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : {}
        throw Object.assign(core.context.error(kind, `${reason}: ${error.message}`), { data: { ...details, reason } })
      }
    }
  }
  return {
    methods,
    // Service coordinators use these same typed pipelines through an owner-Run core
    // adapter; they do not re-enter the session-authenticated public handlers.
    starter,
    lifecycle,
    bindFederation(engine, surface) {
      federationEngine = engine
      federationSurface = surface
    },
    async dispose(): Promise<void> {
      active = false
      unsubscribeInput()
      unsubscribeReconnect()
      starter.dispose()
      fleet.dispose()
      lifecycle.dispose()
      runtime.dispose()
      await Promise.allSettled([...pending])
    },
  }
}
