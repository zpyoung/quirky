import { formatContributionId, type PluginContext } from '@quirky/protocol'
import { createEnv } from './src/daemon/env'
import { methodTable } from './src/daemon/methods'
import { migrations } from './src/daemon/store'
let stopModelSnapshots: (() => void) | undefined
/**
 * Source control for a worktree. The `worktree` param is a selector that `quirky.worktree/resolve`
 * turns into a path, using the caller's session or cwd when it is omitted; the handlers live in
 * `src/daemon/`.
 */
export function activate(context: PluginContext): void {
  const env = createEnv(context, context.openStore(migrations))
  for (const [name, handler] of Object.entries(methodTable(env))) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }
  stopModelSnapshots = context.subscribe((event) => {
    if (event.type !== 'quirky.agents/modelSnapshot') return
    const data = 'data' in event ? event.data : undefined
    try {
      env.recipes.retireStaleModels(data)
    } catch (error) {
      context.log(`could not retire stale source-control model picks: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

export function deactivate(): void {
  stopModelSnapshots?.()
  stopModelSnapshots = undefined
}
