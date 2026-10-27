import { formatContributionId, type PluginContext } from '@quirky/protocol'
import { createEnv, type Handler, type HostingEnv } from './src/env'
import { detailMethods } from './src/details'
import { prMethods } from './src/pr'
import { refreshMethods } from './src/refresh'
import { runtimeMethods } from './src/runtime'
import { workItemMethods } from './src/work-items'

let activeEnv: HostingEnv | undefined

export function activate(context: PluginContext): void {
  const env = createEnv(context)
  activeEnv = env
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
}

export async function deactivate(): Promise<void> {
  const env = activeEnv
  activeEnv = undefined
  if (env) await env.dispose()
}
