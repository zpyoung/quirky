import type { PluginContext } from '@quirky/protocol'

/** Registers a structured session the way the real plugin does, without running an agent. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.structured/create', (params: Record<string, unknown>) =>
    context.call('quirky.session/register', {
      ...(params.worktree === undefined ? {} : { worktree: params.worktree }),
      agent: params.agent,
      kind: 'structured',
      title: 'Claude'
    })
  )
}
