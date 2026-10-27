import { formatContributionId, type PluginContext } from '@quirky/protocol'
import { createEnv } from './src/daemon/env'
import { methodTable } from './src/daemon/methods'

/**
 * Source control for a worktree. The `worktree` param is a selector that `quirky.worktree/resolve`
 * turns into a path, using the caller's session or cwd when it is omitted; the handlers live in
 * `src/daemon/`.
 */
export function activate(context: PluginContext): void {
  for (const [name, handler] of Object.entries(methodTable(createEnv(context)))) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }
}
