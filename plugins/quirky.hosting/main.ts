import { formatContributionId, type PluginActivationDisposer, type PluginContext } from '@quirky/protocol'
import { createEnv, type Handler } from './src/env'
import { detailMethods } from './src/details'
import { prMethods } from './src/pr'
import { refreshMethods } from './src/refresh'
import { runtimeMethods } from './src/runtime'
import { workItemMethods } from './src/work-items'

/** Registers hosting methods and returns a disposer that releases this activation's environment. */
export function activate(context: PluginContext): PluginActivationDisposer {
  const env = createEnv(context)
  const prHandlers = prMethods(env)
  const tables = [
    runtimeMethods(env),
    prHandlers,
    detailMethods(env),
    workItemMethods(env),
    refreshMethods(env, prHandlers)
  ]
  const handlers: Record<string, Handler> = {}
  for (const table of tables) {
    for (const [name, handler] of Object.entries(table)) {
      if (Object.hasOwn(handlers, name)) throw new Error(`duplicate GitHub hosting method: ${name}`)
      handlers[name] = handler
    }
  }
  for (const [name, handler] of Object.entries(handlers)) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }
  return () => env.dispose()
}
