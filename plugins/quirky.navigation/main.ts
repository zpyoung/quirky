import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { findTsServer, ServerPool, ServerPoolError, tsRuntime } from './src/servers'
import { NavigationService } from './src/service'
import { TsServer } from './src/tsserver'

const serverLimits = { typescript: 2 }
const idleMs = 600000

let pool: ServerPool | undefined

/** Makes disk-backed code navigation available without opening an editor. */
export async function activate(context: PluginContext): Promise<void> {
  pool = new ServerPool({
    factories: {
      typescript: async (worktree) => {
        const { executable } = tsRuntime()
        return new TsServer({ process: context.process, worktreePath: worktree.path, serverPath: findTsServer(worktree.path, context.dir), runtime: executable })
      }
    },
    limits: serverLimits, idleMs, requestTimeoutMs: 120000
  })
  const service = new NavigationService(context, pool)
  async function translate<T>(run: () => Promise<T>): Promise<T> {
    try { return await run() } catch (error) {
      if (error instanceof ServerPoolError) throw context.error(error.kind, error.message)
      throw error
    }
  }
  type Params = { worktree?: string; path: string; line: number; column: number }
  context.provide('method:quirky.navigation/definition', (params: Params, caller: PluginCaller) => translate(() => service.navigate('definition', params, caller)))
  context.provide('method:quirky.navigation/references', (params: Params, caller: PluginCaller) => translate(() => service.navigate('references', params, caller)))
  const activePool = pool
  context.provide('method:quirky.navigation/status', () => ({ servers: activePool.status(), limits: serverLimits, idleMs }))
  context.provide('method:quirky.navigation/stop', (params: { worktree?: string; language?: string }, caller: PluginCaller) => translate(() => service.stop(params, caller)))
}

/** Releases all servers owned by this plugin activation. */
export async function deactivate(): Promise<void> {
  const active = pool
  pool = undefined
  await active?.dispose()
}
